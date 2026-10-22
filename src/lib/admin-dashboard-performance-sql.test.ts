import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("admin dashboard summary", () => {
  it("uses stored category totals and preserves the existing response shape", async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
        CREATE TABLE public.raw_lead_cache_counts (
          category_key text, assigned_to uuid, total bigint
        );
        CREATE TABLE public.raw_lead_cache (
          category text, captured_at timestamptz
        );
        CREATE TABLE public.qualified_leads (
          cs_status text, assigned_at timestamptz
        );
        INSERT INTO public.raw_lead_cache_counts (category_key, total) VALUES
          ('new', 9), ('assigned_myself', 2), ('forwarded', 4),
          ('not_found', 3), ('wrong', 1), ('duplicate', 5);
        INSERT INTO public.raw_lead_cache VALUES
          (NULL, '2026-10-21 23:59+00'),
          ('forwarded', '2026-10-22 00:00+00'),
          ('wrong', '2026-10-22 12:00+00');
        INSERT INTO public.qualified_leads VALUES
          ('new', '2026-10-21 12:00+00'),
          ('new', '2026-10-22 12:00+00'),
          ('converted', '2026-10-22 13:00+00');
      `);
      await db.exec(
        readFileSync(
          "supabase/migrations/20261022130000_optimize_admin_dashboard_stats.sql",
          "utf8",
        ),
      );
      const result = await db.query<{ stats: Record<string, unknown> }>(
        "SELECT public.get_admin_dashboard_stats($1) AS stats",
        ["2026-10-22T00:00:00Z"],
      );
      expect(result.rows[0].stats).toEqual({
        rawCounts: { new: 11, forwarded: 4, notFound: 3, wrong: 1 },
        csCounts: { new: 2, converted: 1 },
        todayRaw: 2,
        todayForwarded: 2,
      });
    } finally {
      await db.close();
    }
  }, 15_000);
});
