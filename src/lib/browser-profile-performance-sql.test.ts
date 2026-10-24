import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const previousMigration =
  "supabase/migrations/20261010140000_optimize_browser_profile_performance.sql";
const optimizedMigration =
  "supabase/migrations/20261022140000_optimize_browser_profile_performance_matching.sql";

describe("browser profile performance matching", () => {
  it("preserves profile priority, tie breaks, and qualified lead totals", async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE ROLE anon; CREATE ROLE authenticated;
        CREATE SCHEMA auth;
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
          $$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $$;
        CREATE TABLE public.user_roles (user_id uuid, role text);
        INSERT INTO public.user_roles VALUES
          ('00000000-0000-0000-0000-000000000001', 'admin');
        CREATE TABLE public.incogniton_profiles (
          id uuid PRIMARY KEY, profile_name text, incogniton_profile_id text,
          account_area text, profile_priority text, launch_history jsonb,
          last_launched_at timestamptz
        );
        CREATE TABLE public.raw_lead_cache (
          id uuid PRIMARY KEY, category text, canonical_post_id text,
          canonical_lead_link text, data jsonb, captured_at timestamptz
        );
        CREATE TABLE public.qualified_leads (
          id uuid PRIMARY KEY, raw_lead_cache_id uuid,
          canonical_post_id text, canonical_lead_link text,
          cs_status text, service text, pass_it_to text
        );
        INSERT INTO public.incogniton_profiles VALUES
          ('10000000-0000-0000-0000-000000000001', 'Shared', 'Alpha ID', NULL, NULL, '[]', '2026-10-20'),
          ('10000000-0000-0000-0000-000000000002', 'Shared', 'Beta ID', NULL, NULL, '[]', '2026-10-20'),
          ('10000000-0000-0000-0000-000000000003', 'Gamma', 'Shared', NULL, NULL, '[]', '2026-10-20');
        INSERT INTO public.raw_lead_cache VALUES
          ('20000000-0000-0000-0000-000000000001', 'forwarded', 'post-1', NULL,
           '{"Incog Account":" SHARED ","Service / Category":"Cleaning"}', '2026-10-20'),
          ('20000000-0000-0000-0000-000000000002', NULL, NULL, NULL,
           '{"Incog Account":"Alpha ID","Service / Category":"Plumbing"}', '2026-10-20'),
          ('20000000-0000-0000-0000-000000000003', NULL, NULL, NULL,
           '{"Incog Account":"shared","Account Name":"Beta ID"}', '2026-10-20'),
          ('20000000-0000-0000-0000-000000000004', NULL, NULL, 'link-4',
           '{"Incog Account":"unknown","Account Name":" SHARED "}', '2026-10-20'),
          ('20000000-0000-0000-0000-000000000005', NULL, NULL, NULL,
           '{"Incog Account":"unknown"}', '2026-10-20');
        INSERT INTO public.qualified_leads VALUES
          ('30000000-0000-0000-0000-000000000001',
           '20000000-0000-0000-0000-000000000001', NULL, NULL,
           'converted', 'Cleaning', NULL),
          ('30000000-0000-0000-0000-000000000002',
           NULL, NULL, 'link-4', 'cx_interested', 'Plumbing', NULL);
      `);
      await db.exec(readFileSync(previousMigration, "utf8"));
      const sql = `SELECT * FROM public.browser_profile_performance(
        '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z')`;
      type PerformanceRow = {
        profile_id: string;
        scraped_posts: number | string;
        forwarded: number | string;
      };
      const before = await db.query<PerformanceRow>(sql);
      await db.exec(readFileSync(optimizedMigration, "utf8"));
      const after = await db.query<PerformanceRow>(sql);
      expect(after.rows).toEqual(before.rows);
      expect(
        after.rows.map((row) => ({
          id: row.profile_id,
          scraped: Number(row.scraped_posts),
          forwarded: Number(row.forwarded),
        })),
      ).toEqual([
        { id: "10000000-0000-0000-0000-000000000003", scraped: 2, forwarded: 1 },
        { id: "10000000-0000-0000-0000-000000000001", scraped: 2, forwarded: 1 },
        { id: "10000000-0000-0000-0000-000000000002", scraped: 0, forwarded: 0 },
      ]);
    } finally {
      await db.close();
    }
  }, 30_000);
});
