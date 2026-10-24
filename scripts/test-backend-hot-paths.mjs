// Offline Postgres regression: real RPC bodies, RLS predicates and migration.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const db = new PGlite();
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE TYPE public.app_role AS ENUM ('admin','cs_admin','cs','scraping','sub_admin');
    CREATE TABLE public.user_roles(user_id uuid, role public.app_role);
    CREATE FUNCTION public.current_user_has_role_text(text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS
      $$ SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=auth.uid() AND role::text=$1) $$;
    CREATE FUNCTION public.has_role(uuid,public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS
      $$ SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=$1 AND role=$2) $$;
    CREATE TABLE public.crisp_workspaces(crisp_website_id text PRIMARY KEY,enabled boolean);
    CREATE TABLE public.crisp_conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),crisp_website_id text,crisp_session_id text,customer_name text,customer_email text,customer_phone text,customer_avatar text,status text,last_message text,last_message_at timestamptz,last_customer_unread_at timestamptz,unread_count int,metadata jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz);
    CREATE TABLE public.crisp_messages(id uuid DEFAULT gen_random_uuid(),conversation_id uuid,sent_at timestamptz,direction text,sender_type text,content text);
    CREATE TABLE public.crisp_conversation_notes(id int,created_by uuid);
    CREATE TABLE public.crisp_webhook_events(id int);
    CREATE TABLE public.service_area_bases(id int);
    CREATE FUNCTION public.crisp_messages_ignore_duplicates_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
    CREATE FUNCTION public.tg_raw_lead_cache_route_duplicates() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
    CREATE FUNCTION public.refresh_lead_counter_materialized_views() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT $$;
    CREATE FUNCTION public.refresh_mv_qualified_leads_status_counts() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT $$;
    CREATE FUNCTION public.refresh_mv_raw_lead_cache_counts() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO anon,authenticated,service_role;
  `);
  for (const table of ["crisp_workspaces", "crisp_conversations", "crisp_messages"]) {
    await db.exec(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY access ON public.${table} FOR SELECT TO authenticated USING (
        (SELECT public.current_user_has_role_text('admin')) OR
        (SELECT public.current_user_has_role_text('cs_admin')) OR
        (SELECT public.current_user_has_role_text('cs')));`);
  }
  const member =
    "EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=auth.uid() AND role IN ('admin','cs_admin','cs'))";
  const manager =
    "EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=auth.uid() AND role IN ('admin','cs_admin'))";
  await db.exec(`
    ALTER TABLE public.crisp_conversation_notes ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.crisp_webhook_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.service_area_bases ENABLE ROW LEVEL SECURITY;
    CREATE POLICY notes_read ON public.crisp_conversation_notes FOR SELECT TO authenticated USING (${member});
    CREATE POLICY notes_insert ON public.crisp_conversation_notes FOR INSERT TO authenticated WITH CHECK (created_by=auth.uid() AND ${member});
    CREATE POLICY notes_update ON public.crisp_conversation_notes FOR UPDATE TO authenticated USING (${member} AND (created_by=auth.uid() OR ${manager})) WITH CHECK (${member} AND (created_by=auth.uid() OR ${manager}));
    CREATE POLICY notes_delete ON public.crisp_conversation_notes FOR DELETE TO authenticated USING (${member} AND (created_by=auth.uid() OR ${manager}));
    CREATE POLICY events_read ON public.crisp_webhook_events FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'cs_admin') OR public.has_role(auth.uid(),'cs'));
    CREATE POLICY bases_read ON public.service_area_bases FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=auth.uid()));
  `);
  // No application data is present when the historical backfill executes.
  await db.exec(read("supabase/migrations/20260820100000_crisp_exclude_masked_from_unread.sql"));
  await db.exec(read("supabase/migrations/20260827130000_crisp_today_visitors_rpc.sql"));
  const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-0000-0000-00000000000${i + 1}`);
  const roles = ["admin", "cs_admin", "cs", "scraping", "sub_admin"];
  for (const [i, role] of roles.entries()) {
    await db.query("INSERT INTO public.user_roles VALUES ($1,$2)", [ids[i], role]);
    await db.query("INSERT INTO public.crisp_conversation_notes VALUES ($1,$2)", [i, ids[i]]);
  }
  await db.exec(`
    INSERT INTO public.crisp_workspaces VALUES ('one',true),('empty',true),('disabled',false);
    INSERT INTO public.crisp_conversations(crisp_website_id,crisp_session_id,last_message,unread_count,last_customer_unread_at,last_message_at)
      VALUES ('one','real','Hello',1,now(),now()),('one','masked','xxxxx',1,now(),now()),('one','read','Answered',0,null,now()),('disabled','hidden','Hi',1,now(),now());
    INSERT INTO public.crisp_webhook_events VALUES (1);
    INSERT INTO public.service_area_bases VALUES (1);
  `);
  const policyResults = async () => {
    const { rows: policies } = await db.query(
      "SELECT * FROM pg_policies WHERE tablename IN ('crisp_conversation_notes','crisp_webhook_events','service_area_bases') ORDER BY policyname",
    );
    const results = [];
    for (const uid of [...ids, ""]) {
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [uid]);
      for (const p of policies) {
        for (const predicate of [p.qual, p.with_check]) {
          if (predicate)
            results.push(
              (
                await db.query(
                  `SELECT id,(${predicate}) AS allowed FROM public.${p.tablename} ORDER BY id`,
                )
              ).rows,
            );
        }
      }
    }
    return results;
  };
  const rpcResults = async (uid, role = "authenticated") => {
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [uid]);
    await db.exec(`SET ROLE ${role}`);
    try {
      return await Promise.all([
        db.query("SELECT * FROM public.get_crisp_workspace_summaries() ORDER BY crisp_website_id"),
        db.query(
          "SELECT * FROM public.get_crisp_conversations_page(ARRAY['one'],30,0,null) ORDER BY crisp_session_id",
        ),
        db.query(
          "SELECT * FROM public.get_crisp_today_visitors_summary(date_trunc('day',now())) ORDER BY crisp_website_id",
        ),
      ]).then((results) => results.map((r) => r.rows));
    } finally {
      await db.exec("RESET ROLE");
    }
  };
  const beforePolicies = await policyResults();
  const beforeRpcs = await rpcResults(ids[0]);
  await db.exec(read("supabase/migrations/20261024085221_optimize_backend_hot_paths.sql"));
  assert.deepEqual(
    await policyResults(),
    beforePolicies,
    "All six policy predicates must preserve access for every role/owner",
  );
  for (const uid of ids.slice(0, 3))
    assert.deepEqual(await rpcResults(uid), beforeRpcs, "Crisp role results must be unchanged");
  assert.deepEqual(await rpcResults("", "service_role"), beforeRpcs, "Workers retain access");
  for (const uid of ids.slice(3))
    assert.deepEqual(await rpcResults(uid), [[], [], []], "Non-Crisp roles must not bypass RLS");
  const { rows: grants } = await db.query(`SELECT proname,
    has_function_privilege('anon',oid,'EXECUTE') AS anon,
    has_function_privilege('authenticated',oid,'EXECUTE') AS authenticated,
    has_function_privilege('service_role',oid,'EXECUTE') AS service
    FROM pg_proc WHERE proname IN ('refresh_lead_counter_materialized_views','refresh_mv_qualified_leads_status_counts','refresh_mv_raw_lead_cache_counts')`);
  assert.equal(grants.length, 3);
  for (const grant of grants)
    assert.deepEqual([grant.anon, grant.authenticated, grant.service], [false, false, true]);
  console.log(
    "PASS: backend hot paths — six policy equivalence checks, three RPCs across all roles, maintenance permissions",
  );
} finally {
  await db.close();
}
