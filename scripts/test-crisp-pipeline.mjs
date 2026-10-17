// Offline Postgres regression harness. Stubs only pre-existing platform objects;
// the real checked-in pipeline migrations and transactional suites run in PGlite.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(new URL(path, new URL("../", import.meta.url)), "utf8");
const db = new PGlite();
try {
  await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA vault;
CREATE TABLE vault.decrypted_secrets(id uuid DEFAULT gen_random_uuid(),created_at timestamptz DEFAULT now(),name text,decrypted_secret text);
CREATE SCHEMA cron;
CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS 'SELECT 1::bigint';
CREATE TABLE crisp_workspaces(id uuid DEFAULT gen_random_uuid(),crisp_website_id text UNIQUE,workspace_name text,enabled boolean DEFAULT true,credential_secret_id uuid,auto_greet_enabled boolean DEFAULT false,auto_greet_message text,auto_greet_delay_seconds integer DEFAULT 0,visitor_synced_at timestamptz,live_visitor_count integer DEFAULT 0,active_visitor_count integer DEFAULT 0,visitors_limited boolean DEFAULT false,last_seen_at timestamptz,updated_at timestamptz DEFAULT now());
CREATE FUNCTION claim_crisp_visitor_sync(text,timestamptz) RETURNS boolean LANGUAGE sql AS 'SELECT false';
CREATE TABLE crisp_visitors(id uuid DEFAULT gen_random_uuid(),crisp_website_id text,crisp_session_id text,nickname text,email text,avatar text,user_agent text,initiated boolean DEFAULT false,active boolean DEFAULT false,is_online boolean DEFAULT false,last_page_title text,last_page_url text,country text,region text,city text,latitude float8,longitude float8,timezone_minutes integer,capabilities text[] DEFAULT '{}',locales text[] DEFAULT '{}',first_seen_at timestamptz DEFAULT now(),last_seen_at timestamptz DEFAULT now(),last_online_at timestamptz,updated_at timestamptz DEFAULT now(),auto_greeted_at timestamptz,auto_greet_due_at timestamptz,UNIQUE(crisp_website_id,crisp_session_id));
CREATE TABLE crisp_visitor_daily_visits(crisp_website_id text,crisp_session_id text,visit_date date,last_seen_at timestamptz,updated_at timestamptz DEFAULT now(),UNIQUE(crisp_website_id,crisp_session_id,visit_date));
CREATE TABLE crisp_conversations(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,crisp_website_id text,crisp_session_id text,customer_name text,customer_email text,customer_phone text,customer_avatar text,status text DEFAULT 'unresolved',last_message text,last_message_at timestamptz DEFAULT now(),unread_count integer DEFAULT 0,last_customer_unread_at timestamptz,updated_at timestamptz DEFAULT now(),UNIQUE(crisp_website_id,crisp_session_id));
CREATE TABLE crisp_messages(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,conversation_id uuid,crisp_website_id text,crisp_session_id text,crisp_message_id text,sender_type text,direction text,content text,message_type text,sent_at timestamptz,raw_payload jsonb,delivery_state text DEFAULT 'sent',UNIQUE(crisp_website_id,crisp_message_id));
CREATE TABLE crisp_webhook_events(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,crisp_website_id text,event_fingerprint text UNIQUE,event_type text,payload jsonb,processed boolean DEFAULT true,error text,received_at timestamptz DEFAULT now());
CREATE FUNCTION public.current_user_has_role_text(p_role text) RETURNS boolean LANGUAGE sql AS 'SELECT true';
ALTER TABLE public.crisp_visitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crisp_visitor_daily_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crisp_workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Crisp visitors select for cs roles" ON public.crisp_visitors USING (true);
CREATE POLICY "Crisp daily visitors select for cs roles" ON public.crisp_visitor_daily_visits USING (true);
CREATE POLICY "Crisp workspaces select access for cs roles" ON public.crisp_workspaces USING (true);
CREATE TYPE public.cs_status AS ENUM ('new','contacted','qualified','rejected','won','out_of_base');
CREATE TABLE public.qualified_leads(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),cs_status public.cs_status DEFAULT 'new',pinned_important boolean DEFAULT false,updated_at timestamptz DEFAULT now());
CREATE FUNCTION public.tg_noop_touch() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
CREATE TRIGGER trg_qualified_leads_updated_at BEFORE UPDATE ON public.qualified_leads FOR EACH ROW EXECUTE FUNCTION public.tg_noop_touch();
`);
  const names = [
    "crisp_reliable_visitor_pipeline",
    "crisp_pipeline_cutover",
    "crisp_history_summary_ordering",
    "crisp_state_event_ordering",
    "crisp_event_driven_live_counts",
    "fix_live_visitor_latency",
    "unpin_important_on_cs_status_change",
    "cs_compose_sender_rotation",
    "crisp_count_tripwire",
    "crisp_identity_presence",
    "crisp_revisit_greeting",
    "crisp_revisit_backlog_gate",
    "crisp_plugin_signing_secret",
    "crisp_name_free_greeting_templates",
    "crisp_wordpress_presence_bridge",
    "crisp_verified_visit_boundaries",
    "crisp_arrival_verification_recovery",
    "crisp_compact_greeting_messages",
  ];
  const files = readdirSync(`${root}/supabase/migrations`);
  for (const name of names) {
    const matches = files.filter((file) => file.endsWith(`_${name}.sql`));
    if (matches.length !== 1) throw new Error(`Expected one migration: ${name}`);
    await db.exec(read(`supabase/migrations/${matches[0]}`));
  }
  for (const test of [
    "crisp-pipeline.sql",
    "crisp-identity-presence.sql",
    "crisp-site-bridge.sql",
    "crisp-arrival-recovery.sql",
    "crisp-compact-greetings.sql",
  ]) {
    await db.exec(read(`supabase/tests/${test}`));
    console.log(`PASS: ${test}`);
  }
} finally {
  await db.close();
}
