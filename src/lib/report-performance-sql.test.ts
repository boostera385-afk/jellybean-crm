import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("grouped report queries", () => {
  it("preserves counts and caller RLS across summaries", async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
        CREATE TABLE public.raw_lead_cache (
          category text, captured_at timestamptz, owner text
        );
        CREATE TABLE public.raw_lead_cache_counts (
          category_key text, assigned_to uuid, total bigint, owner text
        );
        CREATE TABLE public.qualified_leads (
          cs_status text, assigned_at timestamptz, submitted_by_role text,
          service text, state_code text, main_area text, owner text
        );
        ALTER TABLE public.raw_lead_cache ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.raw_lead_cache_counts ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.qualified_leads ENABLE ROW LEVEL SECURITY;
        CREATE POLICY visible_raw ON public.raw_lead_cache TO authenticated
          USING (owner = 'visible');
        CREATE POLICY visible_raw_counts ON public.raw_lead_cache_counts TO authenticated
          USING (owner = 'visible');
        CREATE POLICY visible_cs ON public.qualified_leads TO authenticated
          USING (owner = 'visible');
        GRANT USAGE ON SCHEMA public TO authenticated, service_role;
        GRANT SELECT ON public.raw_lead_cache, public.raw_lead_cache_counts,
          public.qualified_leads TO authenticated, service_role;
        INSERT INTO public.raw_lead_cache VALUES
          (NULL, '2026-10-01 12:00+00', 'visible'),
          (NULL, '2026-10-02 12:00+00', 'visible'),
          ('forwarded', '2026-10-02 13:00+00', 'visible'),
          ('duplicate', '2026-10-02 14:00+00', 'hidden');
        INSERT INTO public.raw_lead_cache_counts VALUES
          ('new', NULL, 1, 'visible'),
          ('assigned_myself', NULL, 1, 'visible'),
          ('forwarded', NULL, 1, 'visible'),
          ('duplicate', NULL, 1, 'hidden');
        INSERT INTO public.qualified_leads VALUES
          ('new', '2026-10-01 12:00+00', 'seo', 'Plumbing', 'OH', 'Cleveland', 'visible'),
          ('converted', '2026-10-02 12:00+00', 'seo', 'Plumbing', 'OH', 'Cleveland', 'visible'),
          ('new', '2026-10-02 13:00+00', 'facebook', 'Roofing', 'NY', 'Albany', 'hidden');
      `);
      await db.exec(
        readFileSync("supabase/migrations/20261022120000_group_report_counts.sql", "utf8"),
      );
      await db.exec("SET ROLE authenticated");

      const rawAll = await db.query<{ counts: Record<string, number> }>(
        "SELECT public.report_raw_status_counts() AS counts",
      );
      expect(rawAll.rows[0].counts).toEqual({ new: 2, forwarded: 1 });

      const rawDay = await db.query<{ counts: Record<string, number> }>(
        "SELECT public.report_raw_status_counts($1, $2) AS counts",
        ["2026-10-02T00:00:00Z", "2026-10-03T00:00:00Z"],
      );
      expect(rawDay.rows[0].counts).toEqual({ new: 1, forwarded: 1 });

      const cs = await db.query<{ counts: Record<string, number> }>(
        "SELECT public.report_cs_status_counts() AS counts",
      );
      expect(cs.rows[0].counts).toEqual({ new: 1, converted: 1 });

      const days = await db.query<{
        counts: Array<{ day_key: string; submitted_by_role: string; lead_count: number }>;
      }>("SELECT public.report_cs_department_daily($1, $2) AS counts", [
        "2026-10-01T00:00:00Z",
        "2026-10-03T00:00:00Z",
      ]);
      expect(
        days.rows[0].counts
          .sort((a, b) => a.day_key.localeCompare(b.day_key))
          .map((row) => [row.day_key, row.submitted_by_role, Number(row.lead_count)]),
      ).toEqual([
        ["2026-10-01", "seo", 1],
        ["2026-10-02", "seo", 1],
      ]);

      const services = await db.query<{
        counts: Array<{
          service: string;
          state_code: string;
          main_area: string;
          submitted_by_role: string;
          lead_count: number;
        }>;
      }>("SELECT public.report_cs_service_state_counts($1, $2) AS counts", [
        "2026-10-01T00:00:00Z",
        "2026-10-03T00:00:00Z",
      ]);
      expect(services.rows[0].counts).toEqual([
        {
          service: "Plumbing",
          state_code: "OH",
          main_area: "Cleveland",
          submitted_by_role: "seo",
          lead_count: 2,
        },
      ]);
    } finally {
      await db.close();
    }
  }, 30_000);
});
