// Offline PostgreSQL/RLS regression for the actual additive Explorer migration.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const roles = ["admin", "cs_admin", "cs", "scraping", "maturing", "sub_admin", "facebook", "seo"];
const ids = roles.map((_, i) => `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`);
const catalog = {
  "general plumbing repair": "Plumbing",
  "roof repair": "Roofing",
  "electrical inspection": "Electrical",
};
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE TYPE public.cs_status AS ENUM ('new','converted','need_follow_up');
    CREATE TABLE public.user_roles(user_id uuid, role text);
    CREATE TABLE public.qualified_leads (
      id uuid PRIMARY KEY,customer_name text,customer_number text,customer_number_2 text,
      service text,state_code text,main_area text,sub_area text,cs_status public.cs_status,
      created_at timestamptz NOT NULL,followup_at timestamptz,is_important boolean,
      assigned_to uuid,created_by uuid,extra_numbers text[],context text,post_text text,cs_notes jsonb
    );
    CREATE FUNCTION public.current_user_has_role_text(text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS
      $$ SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=auth.uid() AND role=$1) $$;
    ALTER TABLE public.qualified_leads ENABLE ROW LEVEL SECURITY;
    CREATE POLICY existing_read ON public.qualified_leads FOR SELECT TO authenticated USING (
      (SELECT current_user_has_role_text('admin')) OR
      (SELECT current_user_has_role_text('cs_admin')) OR
      (SELECT current_user_has_role_text('sub_admin')) OR
      ((SELECT current_user_has_role_text('cs')) AND (assigned_to=auth.uid() OR assigned_to IS NULL)) OR created_by=auth.uid());
    GRANT USAGE ON SCHEMA public,auth TO authenticated,anon;
    GRANT SELECT ON public.user_roles,public.qualified_leads TO authenticated;
  `);
  for (const [index, role] of roles.entries())
    await db.query("INSERT INTO public.user_roles VALUES ($1,$2)", [ids[index], role]);
  const policyBefore = await db.query("SELECT * FROM pg_policies ORDER BY policyname");
  const sql = readFileSync(
    new URL("../supabase/migrations/20261114102019_lead_explorer.sql", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    sql,
    /CREATE\s+(?:UNIQUE\s+)?INDEX|CREATE\s+POLICY|ALTER\s+TABLE|ALTER\s+TYPE/i,
  );
  await db.exec(sql);
  await db.exec(
    readFileSync(
      new URL(
        "../supabase/migrations/20261114103055_lead_explorer_whitespace.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.exec(
    readFileSync(
      new URL(
        "../supabase/migrations/20261114103357_lead_explorer_trim_inline.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.exec(
    readFileSync(
      new URL(
        "../supabase/migrations/20261114120000_lead_explorer_followup_due.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(
    (await db.query("SELECT * FROM pg_policies ORDER BY policyname")).rows,
    policyBefore.rows,
  );
  for (let i = 0; i < 126; i++) {
    const services = [
      null,
      "General Plumbing Repair",
      "\t GENERAL   plumbing repair \n",
      "Roof Repair",
      "custom O'Brien_%\\",
      "Electrical Inspection",
    ];
    await db.query(
      `INSERT INTO public.qualified_leads
      (id,customer_name,customer_number,service,state_code,main_area,sub_area,cs_status,created_at,followup_at,is_important,assigned_to,created_by)
      VALUES ($1,$2,'+1 (555) 123-4567',$3,$4,$5,$6,$7,'2026-11-14T10:00:00Z',now()-interval '1 hour',true,$8,$9)`,
      [
        `10000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
        i === 0 ? "O'Brien_%\\" : `Customer ${i}`,
        services[i % services.length],
        [null, "TX", "CA", "NY", "\t\n "][i % 5],
        i % 7 ? `Main ${i % 3}` : null,
        i % 11 ? `Sub ${i % 2}` : null,
        i % 2 ? "new" : i % 4 === 2 ? "need_follow_up" : "converted",
        i % 4 === 0 ? ids[2] : i % 4 === 1 ? null : ids[0],
        i % 9 === 0 ? ids[2] : ids[0],
      ],
    );
  }
  async function asUser(index, work) {
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [ids[index] ?? ""]);
    await db.exec("SET ROLE authenticated");
    try {
      return await work();
    } finally {
      await db.exec("RESET ROLE");
    }
  }
  async function rpc(
    action,
    group = "area",
    path = [],
    filters = {},
    cursor = null,
    leadId = null,
  ) {
    const response = await db.query(
      "SELECT public.lead_explorer_query($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::uuid) AS result",
      [
        action,
        group,
        JSON.stringify(path),
        JSON.stringify(filters),
        JSON.stringify(catalog),
        cursor ? JSON.stringify(cursor) : null,
        leadId,
      ],
    );
    return response.rows[0].result;
  }
  for (const index of [0, 1, 2])
    await asUser(index, async () => {
      const direct = (await db.query("SELECT count(*)::int AS total FROM public.qualified_leads"))
        .rows[0].total;
      assert.equal((await rpc("summary")).total, direct);
      for (const group of ["area", "service"]) {
        const nodes = await rpc("nodes", group);
        assert(nodes.some((node) => node.key === "missing"));
        if (group === "service") assert(nodes.some((node) => node.key === "unmapped"));
        for (const node of nodes) {
          const path = [node.key];
          assert.equal((await rpc("summary", group, path)).total, node.total);
          let cursor = null;
          const seen = new Set();
          do {
            const page = await rpc("results", group, path, {}, cursor);
            for (const row of page.rows) {
              assert(!seen.has(row.id));
              seen.add(row.id);
            }
            cursor = page.next_cursor;
          } while (cursor);
          assert.equal(seen.size, node.total);
          for (const child of await rpc("nodes", group, path)) {
            assert.equal((await rpc("summary", group, [...path, child.key])).total, child.total);
          }
        }
      }
    });
  for (const index of [3, 4, 5, 6, 7])
    await asUser(index, async () => {
      await assert.rejects(() => rpc("summary"), /Forbidden/);
      await assert.rejects(
        () => rpc("detail", "area", [], {}, null, "10000000-0000-0000-0000-000000000000"),
        /Forbidden/,
      );
    });
  // Existing sub_admin table access remains unchanged despite Explorer being denied.
  await asUser(5, async () =>
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM public.qualified_leads")).rows[0].n,
      126,
    ),
  );
  await asUser(2, async () => {
    assert.equal(
      await rpc("detail", "area", [], {}, null, "10000000-0000-0000-0000-000000000002"),
      null,
    );
    assert((await rpc("detail", "area", [], {}, null, "10000000-0000-0000-0000-000000000001"))?.id);
    assert((await rpc("detail", "area", [], {}, null, "10000000-0000-0000-0000-000000000018"))?.id);
  });
  await db.query("INSERT INTO public.user_roles VALUES ($1,'sub_admin')", [ids[2]]);
  await asUser(2, async () => {
    await assert.rejects(() => rpc("summary"), /Forbidden/);
  });
  await db.query("DELETE FROM public.user_roles WHERE user_id=$1 AND role='sub_admin'", [ids[2]]);
  await db.exec("SET ROLE anon");
  await assert.rejects(() => rpc("summary"), /permission denied/);
  await db.exec("RESET ROLE");
  await asUser(0, async () => {
    const categories = await rpc("nodes", "service");
    assert.equal(categories.find((node) => node.key === "v:Plumbing").total, 42);
    assert.equal((await rpc("nodes", "area")).find((node) => node.key === "missing").total, 51);
    const nodes = await rpc("nodes", "area", [], { query: "does not exist" });
    assert.deepEqual(nodes, [{ key: "missing", total: 0, new_count: 0 }]);
    assert.equal((await rpc("summary", "area", [], { query: "O'Brien_%\\" })).total, 22);
    assert.equal((await rpc("summary", "area", [], { query: "' OR true --" })).total, 0);
    assert.equal((await rpc("summary", "area", [], { query: "5551234567" })).total, 126);
    assert.equal((await rpc("summary", "area", [], { query: "Main 1" })).total, 36);
    // Follow-up due matches CS Pipeline: past follow-up time AND Need Follow Up status.
    const dueSummary = await rpc("summary", "area", [], { due: true });
    const all = await rpc("summary", "area", []);
    assert.ok(dueSummary.total > 0 && dueSummary.total < all.total);
    assert.equal(dueSummary.total, all.followup_due);
    assert.equal(
      dueSummary.total,
      (await rpc("summary", "area", [], { status: "need_follow_up" })).followup_due,
    );
    for (const filters of [
      { status: "new" },
      { owner: "mine" },
      { owner: "unassigned" },
      { important: true, due: true },
      { date_from: "2026-11-14T00:00:00Z", date_to: "2026-11-15T00:00:00Z" },
      { date_from: "2026-11-15T00:00:00Z" },
    ]) {
      for (const group of ["area", "service"]) {
        const nodes = await rpc("nodes", group, [], filters);
        assert.equal(
          nodes.reduce((sum, node) => sum + node.total, 0),
          (await rpc("summary", group, [], filters)).total,
        );
        for (const node of nodes) {
          assert.equal(node.total, (await rpc("summary", group, [node.key], filters)).total);
        }
      }
    }
    let cursor = null;
    const seen = new Set();
    do {
      const page = await rpc("results", "area", [], {}, cursor);
      assert(page.rows.length <= 50);
      for (const row of page.rows) {
        assert(!seen.has(row.id));
        seen.add(row.id);
      }
      cursor = page.next_cursor;
    } while (cursor);
    assert.equal(seen.size, 126);
    await assert.rejects(() => rpc("nodes", "bad"), /Invalid/);
    await assert.rejects(() => rpc("nodes", "service", ["v:a", "v:b", "v:c"]), /Invalid/);
    const existing = await rpc(
      "detail",
      "area",
      [],
      {},
      null,
      "10000000-0000-0000-0000-000000000000",
    );
    assert.equal(existing.customer_name, "O'Brien_%\\");
  });
  console.log(
    "PASS: actual migration; unchanged RLS; eight roles; all branch counts/pages; fallbacks; literal/injection/phone search; stable cursor; detail access.",
  );
} catch (error) {
  console.error(error.message, error.where ?? "", error.internalQuery ?? "");
  process.exitCode = 1;
} finally {
  await db.close();
}
