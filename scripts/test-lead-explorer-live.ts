// Read-only live audit. Never imports this management credential into application code.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { serviceCatalog } from "../src/lib/lead-explorer";

const ref = "fjscqsatzsmfivpczaud";
const token =
  process.env.SUPABASE_ACCESS_TOKEN ??
  readFileSync(join(homedir(), ".config/opencode/secrets", `supabase-${ref}.token`), "utf8").trim();
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const catalog = literal(JSON.stringify(serviceCatalog()));
async function sql(query: string): Promise<Record<string, unknown>[]> {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    // The API's read_only account cannot SET ROLE. Actual impersonation checks
    // below are explicitly wrapped in BEGIN READ ONLY ... ROLLBACK instead.
    body: JSON.stringify({ query }),
  });
  if (!response.ok) {
    const body = (await response.json()) as { message?: string };
    throw new Error(body.message ?? `Database audit HTTP ${response.status}`);
  }
  return (await response.json()) as Record<string, unknown>[];
}
const users = await sql(
  "SELECT DISTINCT ON (role) role::text,user_id::text FROM public.user_roles ORDER BY role,user_id",
);
async function asUser(user: Record<string, unknown>, query: string) {
  assert.match(String(user.user_id), /^[0-9a-f-]{36}$/);
  return sql(
    `BEGIN READ ONLY; SELECT set_config('request.jwt.claim.sub',${literal(String(user.user_id))},true); SET LOCAL ROLE authenticated; ${query}; ROLLBACK;`,
  );
}
function rpc(action: string, group: string, path = "'[]'::jsonb") {
  return `public.lead_explorer_query(${literal(action)},${literal(group)},${path},'{}'::jsonb,${catalog}::jsonb)`;
}
for (const role of ["admin", "cs_admin", "cs"]) {
  const user = users.find((user) => user.role === role);
  assert(user, `No live ${role} user`);
  const totals = await asUser(
    user,
    `SELECT (SELECT count(*) FROM public.qualified_leads) AS visible,(${rpc("summary", "area")}->>'total')::bigint AS explorer`,
  );
  assert.equal(totals[0].visible, totals[0].explorer);
  console.log(
    `${role}: Explorer total matches existing RLS-visible table total (${totals[0].visible})`,
  );
  for (const group of ["area", "service"]) {
    const category = `CASE WHEN q.service IS NULL OR public.lead_explorer_trim(q.service)='' THEN 'missing' WHEN ${catalog}::jsonb ? lower(regexp_replace(public.lead_explorer_trim(q.service),'\\s+',' ','g')) THEN 'v:'||(${catalog}::jsonb->>lower(regexp_replace(public.lead_explorer_trim(q.service),'\\s+',' ','g'))) ELSE 'unmapped' END`;
    const key =
      group === "area"
        ? "CASE WHEN q.state_code IS NULL OR public.lead_explorer_trim(q.state_code)='' THEN 'missing' ELSE 'v:'||q.state_code END"
        : category;
    const comparison = await asUser(
      user,
      `
      WITH chosen AS MATERIALIZED (
        SELECT n->>'key' AS key,(n->>'total')::bigint AS total
        FROM jsonb_array_elements(${rpc("nodes", group)}) n
        ORDER BY (n->>'key' IN ('missing','unmapped')) DESC,(n->>'total')::bigint DESC LIMIT 5
      )
      SELECT key,total,
        (${rpc("summary", group, "jsonb_build_array(c.key)")}->>'total')::bigint AS summary,
        (SELECT count(*) FROM public.qualified_leads q WHERE (${key})=c.key) AS direct,
        jsonb_array_length(${rpc("results", group, "jsonb_build_array(c.key)")}->'rows') AS first_page
      FROM chosen c`,
    );
    assert.equal(comparison.length, 5);
    for (const row of comparison) {
      assert.equal(row.total, row.summary);
      assert.equal(row.total, row.direct);
      assert.equal(Number(row.first_page), Math.min(Number(row.total), 50));
    }
    assert(comparison.some((row) => row.key === "missing"));
    if (group === "service") assert(comparison.some((row) => row.key === "unmapped"));
    console.log(
      `${role}/${group}: 5 branches agree (node = summary = direct RLS count; first page = min(total,50)); fallbacks included`,
    );
  }
  for (const [name, action, group, path] of [
    ["states", "nodes", "area", "'[]'::jsonb"],
    ["TX main areas", "nodes", "area", `'["v:TX"]'::jsonb`],
    ["Houston sub-areas", "nodes", "area", `'["v:TX","v:Houston, TX"]'::jsonb`],
    ["service categories", "nodes", "service", "'[]'::jsonb"],
    ["Plumbing services", "nodes", "service", `'["v:Plumbing"]'::jsonb`],
    ["TX page", "results", "area", `'["v:TX"]'::jsonb`],
  ]) {
    const result = await asUser(
      user,
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT ${rpc(action, group, path)}`,
    );
    const plan = (
      result[0]["QUERY PLAN"] as { "Execution Time": number; "Planning Time": number }[]
    )[0];
    console.log(
      `${role}/${name}: ${plan["Execution Time"].toFixed(2)} ms execution (${plan["Planning Time"].toFixed(2)} ms planning)`,
    );
  }
}
for (const role of ["scraping", "maturing", "sub_admin", "facebook", "seo"]) {
  const user = users.find((user) => user.role === role);
  if (!user) {
    console.log(`${role}: no live user; covered by offline real-Postgres fixture`);
    continue;
  }
  await assert.rejects(() => asUser(user, `SELECT ${rpc("summary", "area")}`), /Forbidden/);
  console.log(`${role}: Explorer RPC denied; existing table policies unchanged`);
}
const definition = await sql(
  "SELECT p.prosecdef,p.provolatile,p.proconfig FROM pg_proc p WHERE p.oid='public.lead_explorer_query(text,text,jsonb,jsonb,jsonb,jsonb,uuid)'::regprocedure",
);
assert.equal(definition[0].prosecdef, false);
assert.equal(definition[0].provolatile, "s");
console.log(
  "PASS: live RPC is STABLE SECURITY INVOKER; all audits rolled back; no application data changed.",
);
