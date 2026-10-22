import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The CS status chips are fed by cs_leads_status_counts_filtered(), called over
 * PostgREST, which matches an RPC by argument NAME. A function whose parameter
 * names drift from the object the client sends is simply not found, and the
 * client's fallback then serves all-time counts next to a filtered list -- the
 * bug the function exists to fix, wearing the fix's clothes.
 *
 * That is exactly what happened: the function shipped with p_garage_patterns,
 * was applied, and was later rewritten in place to take p_important when the
 * garage-door toggle gave way to the important filter. An applied migration
 * never re-runs, so the database kept the old signature for days.
 *
 * So these tests read the argument names out of the route itself and check them
 * against a database built from the migrations, rather than against a hand-kept
 * list that could drift the same way.
 */

const ROUTE = "src/routes/app.cs-leads.tsx";
const FUNCTION = "cs_leads_status_counts_filtered";

/** Argument names the pipeline actually sends, read from the call site. */
function clientArgumentNames(): string[] {
  const source = readFileSync(ROUTE, "utf8");
  const call = source.indexOf(`"${FUNCTION}" as never`);
  expect(call, `${FUNCTION} is not called in ${ROUTE}`).toBeGreaterThan(-1);
  const payload = source.slice(call, source.indexOf("} as never", call));
  const names = [...payload.matchAll(/^\s*(p_[a-z_]+):/gm)].map((match) => match[1]);
  expect(names.length).toBeGreaterThan(0);
  return names;
}

function migration(name: string): string {
  const files = readdirSync("supabase/migrations").filter((file) => file.endsWith(`_${name}.sql`));
  expect(files, `expected exactly one migration named ${name}`).toHaveLength(1);
  return readFileSync(`supabase/migrations/${files[0]}`, "utf8");
}

/** Minimal shape of the columns the counts function reads. */
const SCHEMA = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$SELECT nullif(current_setting('request.jwt.claim.sub', true),'')::uuid$$;
  CREATE TABLE public.user_roles(user_id uuid, role text);
  CREATE TYPE public.cs_status AS ENUM ('new','converted','cx_interested','need_follow_up');
  CREATE TABLE public.qualified_leads(
    id uuid PRIMARY KEY,
    cs_status public.cs_status NOT NULL DEFAULT 'new',
    assigned_at timestamptz NOT NULL,
    assigned_to uuid, created_by uuid, called_at timestamptz,
    is_important boolean NOT NULL DEFAULT false,
    customer_name text NOT NULL DEFAULT '', customer_number text NOT NULL DEFAULT '',
    customer_number_2 text, number_name text, main_area text, sub_area text,
    pass_it_to text, requirement_1 text, requirement_2 text);
  GRANT USAGE ON SCHEMA public, auth TO authenticated, service_role;
  GRANT SELECT ON public.qualified_leads, public.user_roles TO authenticated, service_role;
`;

const ADMIN = "10000000-0000-4000-8000-000000000001";

async function migratedDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(migration("cs_leads_status_counts_filtered"));
  await db.exec(migration("cs_leads_status_counts_filtered_important"));
  return db;
}

/** Parameter names of every overload of the function, per signature. */
async function deployedArgumentNames(db: PGlite): Promise<string[][]> {
  const rows = await db.query<{ names: string[] }>(
    `SELECT coalesce(p.proargnames, '{}') AS names
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = '${FUNCTION}'
      ORDER BY p.oid`,
  );
  return rows.rows.map((row) => row.names);
}

describe("CS filtered status counts", () => {
  it("accepts exactly the arguments the pipeline sends, in one overload", async () => {
    const db = await migratedDb();
    try {
      const deployed = await deployedArgumentNames(db);
      // More than one overload and PostgREST has to disambiguate; it may pick
      // the wrong one, or refuse the call outright.
      expect(deployed).toHaveLength(1);
      expect([...deployed[0]].sort()).toEqual([...clientArgumentNames()].sort());
    } finally {
      await db.close();
    }
  });

  it("drops a signature that was applied earlier, leaving no dead overload", async () => {
    const db = new PGlite();
    try {
      await db.exec(SCHEMA);
      // The signature actually in production before this fix: same name, a
      // text[] of garage-door patterns where p_important now sits.
      await db.exec(`
        CREATE FUNCTION public.${FUNCTION}(
          p_date_from timestamptz DEFAULT NULL, p_date_to timestamptz DEFAULT NULL,
          p_owner uuid DEFAULT NULL, p_unassigned boolean DEFAULT false,
          p_not_called boolean DEFAULT false, p_search text DEFAULT NULL,
          p_phone text DEFAULT NULL, p_garage_patterns text[] DEFAULT NULL)
        RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT '{}'::jsonb$$;`);
      await db.exec(migration("cs_leads_status_counts_filtered_important"));
      const deployed = await deployedArgumentNames(db);
      expect(deployed).toHaveLength(1);
      expect(deployed[0]).not.toContain("p_garage_patterns");
    } finally {
      await db.close();
    }
  });

  it("counts only the filtered set, not every lead", async () => {
    const db = await migratedDb();
    try {
      await db.exec(`
        INSERT INTO public.user_roles VALUES ('${ADMIN}','cs_admin');
        INSERT INTO public.qualified_leads(id, cs_status, assigned_at, customer_name) VALUES
          ('20000000-0000-4000-8000-000000000001','new','2026-10-22T09:00:00Z','Today A'),
          ('20000000-0000-4000-8000-000000000002','new','2026-10-22T10:00:00Z','Today B'),
          ('20000000-0000-4000-8000-000000000003','converted','2026-10-22T11:00:00Z','Today C'),
          ('20000000-0000-4000-8000-000000000004','new','2026-10-01T10:00:00Z','Old A'),
          ('20000000-0000-4000-8000-000000000005','converted','2026-09-15T10:00:00Z','Old B');
        SET ROLE authenticated;
        SELECT set_config('request.jwt.claim.sub','${ADMIN}',false);`);

      const call = async (args: string) =>
        (
          await db.query<{ result: { all: number; statuses: Record<string, number> } }>(
            `SELECT public.${FUNCTION}(${args}) AS result`,
          )
        ).rows[0].result;

      const allTime = await call("");
      expect(allTime.all).toBe(5);

      // The whole point: a date range must shrink both the total and each status.
      const today = await call(
        `p_date_from => '2026-10-22T00:00:00Z', p_date_to => '2026-10-23T00:00:00Z'`,
      );
      expect(today.all).toBe(3);
      expect(today.statuses).toEqual({ new: 2, converted: 1 });

      // p_important is the argument that went missing, so exercise it directly.
      await db.exec(`SET ROLE postgres;
        UPDATE public.qualified_leads SET is_important = true
         WHERE customer_name = 'Today A';
        SET ROLE authenticated;`);
      expect((await call("p_important => true")).all).toBe(1);
      expect((await call("p_search => 'Today'")).all).toBe(3);
    } finally {
      await db.close();
    }
  });
});
