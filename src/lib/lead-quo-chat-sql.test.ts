import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * cs_lead_quo_chat: the CX quick chat on Need Review leads. It must show a
 * lead's saved Quo messages only to people who can already read that lead.
 */

const ADMIN = "10000000-0000-4000-8000-000000000001";
const CS_A = "10000000-0000-4000-8000-000000000002";
const CS_B = "10000000-0000-4000-8000-000000000003";
const OTHER = "10000000-0000-4000-8000-000000000004";
const LEAD = "20000000-0000-4000-8000-000000000001";
const LEAD_2 = "20000000-0000-4000-8000-000000000002";

const BASE = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA auth; CREATE SCHEMA private;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$SELECT nullif(current_setting('request.jwt.claim.sub', true),'')::uuid$$;
  CREATE TABLE public.user_roles(user_id uuid, role text);
  CREATE FUNCTION public.current_user_has_role_text(p_role text) RETURNS boolean LANGUAGE sql STABLE AS
    $$SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=auth.uid() AND role=p_role)$$;
  CREATE TABLE public.qualified_leads(id uuid PRIMARY KEY, assigned_to uuid, created_by uuid,
    submitted_by_role text);
  GRANT USAGE ON SCHEMA public,auth TO authenticated,service_role;
`;

const migration = (suffix: string) => {
  const dir = "supabase/migrations";
  const file = readdirSync(dir).find((f) => f.endsWith(`_${suffix}.sql`));
  if (!file) throw new Error(`missing migration ${suffix}`);
  return readFileSync(`${dir}/${file}`, "utf8");
};

const msg = (id: string, direction: string, text: string, createdAt: string) => ({
  id,
  direction,
  text,
  status: direction === "outgoing" ? "delivered" : "received",
  createdAt,
  conversationId: "CN1",
  phoneNumberId: "PNinbox",
  from: "+19105551234",
  to: ["+19105559999"],
});

describe("cs_lead_quo_chat", () => {
  let db: PGlite;

  const as = async (user: string) => {
    await db.exec(`RESET ROLE; SET request.jwt.claim.sub = '${user}'; SET ROLE authenticated;`);
  };
  const chat = (lead: string, limit = 40) =>
    db.query<{ id: string; direction: string; body: string }>(
      `SELECT id, direction, body FROM public.cs_lead_quo_chat('${lead}'::uuid, ${limit})`,
    );

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(BASE);
    await db.exec(migration("store_quo_messages"));
    await db.exec(migration("cs_lead_quo_chat"));
    await db.exec(`
      INSERT INTO public.user_roles VALUES ('${ADMIN}','admin'),('${CS_A}','cs'),('${CS_B}','cs');
      INSERT INTO public.qualified_leads(id, assigned_to) VALUES ('${LEAD}','${CS_A}'),('${LEAD_2}',NULL);
    `);
    const messages = [
      msg("M1", "outgoing", "Hi, still need a painter?", "2026-11-20T10:00:00Z"),
      msg("M2", "incoming", "Maybe, how much?", "2026-11-20T11:00:00Z"),
      msg("M3", "outgoing", "Depends on the size", "2026-11-20T12:00:00Z"),
    ];
    await db.query(`SELECT public.store_quo_messages($1::uuid, $2::jsonb)`, [
      LEAD,
      JSON.stringify(messages),
    ]);
  });

  afterEach(async () => {
    await db.close();
  });

  it("returns the lead's messages oldest first to an admin", async () => {
    await as(ADMIN);
    expect((await chat(LEAD)).rows.map((r) => r.id)).toEqual(["M1", "M2", "M3"]);
  });

  it("keeps only the latest messages when limited", async () => {
    await as(ADMIN);
    expect((await chat(LEAD, 2)).rows.map((r) => r.id)).toEqual(["M2", "M3"]);
  });

  it("follows the lead read rule for CS", async () => {
    await as(CS_A);
    expect((await chat(LEAD)).rows).toHaveLength(3);
    await as(CS_B);
    await expect(chat(LEAD)).rejects.toThrow(/Forbidden/);
    // Unassigned leads are readable by any CS, and have no saved messages here.
    expect((await chat(LEAD_2)).rows).toHaveLength(0);
  });

  it("refuses users without access and anonymous callers", async () => {
    await as(OTHER);
    await expect(chat(LEAD)).rejects.toThrow(/Forbidden/);
    await db.exec("RESET ROLE; SET ROLE anon;");
    await expect(chat(LEAD)).rejects.toThrow();
  });
});
