import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Quo AI shadow database contracts", () => {
  it("enforces leases, RLS, comparison ranges, stale fencing and immutable manual status", async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
        CREATE SCHEMA auth;
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
          $$SELECT nullif(current_setting('request.jwt.claim.sub', true),'')::uuid$$;
        CREATE TABLE public.user_roles(user_id uuid, role text);
        CREATE FUNCTION public.current_user_has_role_text(p_role text) RETURNS boolean
          LANGUAGE sql STABLE AS $$SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role=p_role)$$;
        CREATE TYPE public.cs_status AS ENUM ('new','converted','cx_interested','need_follow_up','undeliver');
        CREATE TABLE public.qualified_leads(id uuid PRIMARY KEY, customer_name text, customer_number text, customer_number_2 text,
          extra_numbers text[], assigned_at timestamptz DEFAULT now(), cs_status public.cs_status NOT NULL DEFAULT 'new',
          is_important boolean DEFAULT false, service text, post_text text, context text, created_by uuid);
        ALTER TABLE public.qualified_leads ENABLE ROW LEVEL SECURITY;
        CREATE POLICY lead_owner ON public.qualified_leads FOR SELECT TO authenticated
          USING (created_by = auth.uid() OR public.current_user_has_role_text('admin'));
        CREATE POLICY lead_owner_update ON public.qualified_leads FOR UPDATE TO authenticated
          USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
        GRANT USAGE ON SCHEMA public,auth TO authenticated,service_role;
        GRANT SELECT ON public.qualified_leads, public.user_roles TO authenticated,service_role;
        GRANT UPDATE ON public.qualified_leads TO service_role;
        GRANT UPDATE ON public.qualified_leads TO authenticated;
      `);
      for (const name of [
        "quo_ai_status_beta",
        "index_lead_ai_status_run",
        "allow_staff_phone_index_evaluation",
        "optimize_quo_phone_identity",
      ]) {
        const files = readdirSync("supabase/migrations").filter((file) =>
          file.endsWith(`_${name}.sql`),
        );
        expect(files).toHaveLength(1);
        await db.exec(readFileSync(`supabase/migrations/${files[0]}`, "utf8"));
      }
      const actor = "10000000-0000-4000-8000-000000000001";
      const owner = "10000000-0000-4000-8000-000000000002";
      const lead = "20000000-0000-4000-8000-000000000001";
      const otherLead = "20000000-0000-4000-8000-000000000002";
      await db.exec(`INSERT INTO user_roles VALUES ('${actor}','admin');
        INSERT INTO qualified_leads(id,customer_number,created_by,assigned_at,service) VALUES
          ('${lead}','(910) 555-1234','${owner}','2026-10-20T12:00:00Z','Painting'),
          ('${otherLead}','9105556789','${actor}','2026-10-21T12:00:00Z','Drywall');`);
      expect(
        (
          await db.query<{ ok: boolean }>(
            `SELECT lead_ai_phone_is_unique('${lead}','+19105551234') AS ok`,
          )
        ).rows[0].ok,
      ).toBe(true);
      await db.exec(
        `UPDATE qualified_leads SET customer_number_2 = '+1 910 555 1234' WHERE id='${otherLead}'`,
      );
      expect(
        (
          await db.query<{ ok: boolean }>(
            `SELECT lead_ai_phone_is_unique('${lead}','+19105551234') AS ok`,
          )
        ).rows[0].ok,
      ).toBe(false);
      await db.exec(`UPDATE qualified_leads SET customer_number_2 = NULL WHERE id='${otherLead}'`);
      await db.exec("SET ROLE service_role");
      const reserved = await db.query<{ batch: Array<{ runId: string }> }>(
        `SELECT claim_lead_ai_batch('${actor}',NULL,NULL,'${lead}') AS batch`,
      );
      const run = reserved.rows[0].batch[0].runId;
      const again = await db.query<{ batch: unknown[] }>(
        `SELECT claim_lead_ai_batch('${actor}',NULL,NULL,'${lead}') AS batch`,
      );
      expect(again.rows[0].batch).toEqual([]);
      const result = {
        state: "classified",
        status: "converted",
        confidence: 1,
        reasonCode: "delivery_confirmed",
        evidenceIds: ["AC1"],
        messageCount: 1,
        historyHash: "hash",
        model: "test",
        policyVersion: "test",
      };
      expect(
        (
          await db.query<{ saved: boolean }>(`SELECT finish_lead_ai_run($1,$2) AS saved`, [
            run,
            JSON.stringify(result),
          ])
        ).rows[0].saved,
      ).toBe(true);
      expect(
        (
          await db.query<{ saved: boolean }>(`SELECT finish_lead_ai_run($1,$2) AS saved`, [
            run,
            JSON.stringify(result),
          ])
        ).rows[0].saved,
      ).toBe(false);
      expect(
        (
          await db.query<{ cs_status: string }>(
            `SELECT cs_status FROM qualified_leads WHERE id='${lead}'`,
          )
        ).rows[0].cs_status,
      ).toBe("new");
      const report = (
        await db.query<{
          report: {
            counts: Record<string, number>;
            classified: number;
            disagreements: number;
            stale: number;
            total: number;
          };
        }>(`SELECT report_lead_ai_status('2026-10-20T00:00:00Z','2026-10-21T00:00:00Z') AS report`)
      ).rows[0].report;
      expect(report.total).toBe(1);
      expect(report.counts.converted).toBe(1);
      expect(report.disagreements).toBe(1);
      await db.exec("RESET ROLE");
      await db.exec(`UPDATE qualified_leads SET cs_status='converted' WHERE id='${lead}'`);
      expect(
        (await db.query<{ r: { disagreements: number } }>("SELECT report_lead_ai_status() AS r"))
          .rows[0].r.disagreements,
      ).toBe(0);
      await db.exec(`UPDATE qualified_leads SET customer_number='9105559999' WHERE id='${lead}'`);
      const stale = (
        await db.query<{ r: { classified: number; stale: number } }>(
          "SELECT report_lead_ai_status() AS r",
        )
      ).rows[0].r;
      expect(stale.classified).toBe(0);
      expect(stale.stale).toBe(1);
      const batch2 = (
        await db.query<{ batch: Array<{ runId: string }> }>(
          `SELECT claim_lead_ai_batch('${actor}',NULL,NULL,'${otherLead}') AS batch`,
        )
      ).rows[0].batch;
      await db.exec(`UPDATE qualified_leads SET service='Plumbing' WHERE id='${otherLead}'`);
      expect(
        (
          await db.query<{ saved: boolean }>(`SELECT finish_lead_ai_run($1,$2) AS saved`, [
            batch2[0].runId,
            JSON.stringify(result),
          ])
        ).rows[0].saved,
      ).toBe(false);
      await db.exec(
        `UPDATE lead_ai_status_runs SET started_at=now()-interval '20 minutes' WHERE id='${batch2[0].runId}'`,
      );
      const leased = (
        await db.query<{ batch: Array<{ runId: string }> }>(
          `SELECT claim_lead_ai_batch('${actor}',NULL,NULL,'${otherLead}') AS batch`,
        )
      ).rows[0].batch[0];
      await db.exec(
        `UPDATE lead_ai_status_runs SET started_at=now()-interval '5 minutes' WHERE id='${leased.runId}'`,
      );
      expect(
        (
          await db.query<{ saved: boolean }>(`SELECT finish_lead_ai_run($1,$2) AS saved`, [
            leased.runId,
            JSON.stringify(result),
          ])
        ).rows[0].saved,
      ).toBe(false);
      await expect(db.query(`SELECT claim_lead_ai_batch('${owner}')`)).rejects.toThrow(
        /AI reporting access required/,
      );
      await db.exec(
        `SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${owner}',false)`,
      );
      expect((await db.query("SELECT * FROM lead_ai_status")).rows).toHaveLength(1);
      // The new phone-expression indexes must not break ordinary staff edits.
      await db.query(`UPDATE qualified_leads SET customer_number='9105559876' WHERE id='${lead}'`);
      expect((await db.query("SELECT * FROM lead_ai_status_runs")).rows).toHaveLength(0);
      await expect(db.query(`SELECT claim_lead_ai_batch('${actor}')`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(db.query("UPDATE lead_ai_status SET confidence=0")).rejects.toThrow(
        /permission denied/,
      );
      await db.exec(
        `SELECT set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000001',false)`,
      );
      expect((await db.query("SELECT * FROM lead_ai_status")).rows).toHaveLength(0);
      await db.exec("RESET ROLE; SET ROLE anon");
      await expect(db.query("SELECT * FROM lead_ai_status")).rejects.toThrow(/permission denied/);
      await expect(db.query("SELECT report_lead_ai_status() ")).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await db.close();
    }
  }, 30_000);
});
