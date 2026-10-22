import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canShowAiSuggestion, STATUS_LABEL } from "./lead-statuses";

describe("consolidated lead statuses", () => {
  it("keeps follow-up manual-only, including legacy suggestions", () => {
    expect(canShowAiSuggestion("need_follow_up", "converted")).toBe(false);
    expect(canShowAiSuggestion("need_follow_up", null)).toBe(false);
    for (const status of ["need_follow_up", "wrong_person", "wrong_service", "small_service"])
      expect(canShowAiSuggestion("new", status)).toBe(false);
    expect(canShowAiSuggestion("new", "wrong_number")).toBe(true);
    expect(canShowAiSuggestion("new", null)).toBe(true);
    expect(STATUS_LABEL.wrong_person).toBe(STATUS_LABEL.wrong_number);
    expect(STATUS_LABEL.wrong_service).toBe(STATUS_LABEL.wrong_lead);
    expect(STATUS_LABEL.small_service).toBe(STATUS_LABEL.wrong_lead);
  });

  it("migrates without losing lead data, normalizes old writes and fences follow-up jobs", async () => {
    const db = new PGlite();
    const migration = async (name: string) => {
      const file = readdirSync("supabase/migrations").find((f) => f.endsWith(`_${name}.sql`));
      if (!file) throw new Error(`Missing migration: ${name}`);
      await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
    };
    const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    try {
      await db.exec(`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
        CREATE TYPE public.cs_status AS ENUM ('new','wrong_number','wrong_lead','wrong_person',
          'wrong_service','small_service','need_follow_up','converted');
        CREATE TABLE public.user_roles(user_id uuid,role text);
        CREATE FUNCTION public.current_user_has_role_text(text) RETURNS boolean
          LANGUAGE sql STABLE AS 'SELECT true';
        CREATE TABLE public.qualified_leads(id uuid PRIMARY KEY,customer_name text,customer_number text,
          customer_number_2 text,extra_numbers text[],assigned_at timestamptz DEFAULT now(),
          cs_status public.cs_status NOT NULL DEFAULT 'new',is_important boolean DEFAULT false,
          service text,post_text text,context text,notes jsonb DEFAULT '[]');
        GRANT USAGE ON SCHEMA public TO authenticated,service_role;
        GRANT SELECT,UPDATE ON public.qualified_leads TO authenticated,service_role;
        GRANT SELECT ON public.user_roles TO authenticated,service_role;
      `);
      await migration("quo_ai_status_beta");
      await migration("quo_resumable_sync");
      const statuses = ["wrong_person", "wrong_service", "small_service", "need_follow_up", "new"];
      for (const [i, status] of statuses.entries()) {
        await db.query(
          `INSERT INTO qualified_leads(id,cs_status,customer_number,notes)
          VALUES($1,$2,'9105551234','[{"text":"Keep the full lead"}]')`,
          [id(i + 1), status],
        );
        await db.query(
          `WITH r AS (
          INSERT INTO lead_ai_status_runs(lead_id,source_key,manual_status,started_at,outcome,result)
            VALUES($1,'old',$2::public.cs_status,now()-interval '2 days','classified',jsonb_build_object('status',($2::public.cs_status)::text))
          RETURNING id
        ) INSERT INTO lead_ai_status(lead_id,run_id,source_key,state,ai_status,confidence,reason_code,model,policy_version)
            SELECT q.id,r.id,lead_ai_source_key(q),'classified',$2::public.cs_status,0.99,'customer_intent','test','v2'
          FROM qualified_leads q CROSS JOIN r WHERE q.id=$1`,
          [id(i + 1), status === "new" ? "need_follow_up" : status],
        );
      }
      const before = (
        await db.query(`SELECT to_jsonb(q)-'cs_status' AS lead FROM qualified_leads q ORDER BY id`)
      ).rows;
      const audit = (await db.query("SELECT * FROM lead_ai_status_runs ORDER BY id")).rows;
      await migration("consolidate_cs_statuses");
      expect((await db.query(`SELECT cs_status FROM qualified_leads ORDER BY id`)).rows).toEqual(
        ["wrong_number", "wrong_lead", "wrong_lead", "need_follow_up", "new"].map((cs_status) => ({
          cs_status,
        })),
      );
      expect(
        (
          await db.query(
            `SELECT to_jsonb(q)-'cs_status' AS lead FROM qualified_leads q ORDER BY id`,
          )
        ).rows,
      ).toEqual(before);
      expect((await db.query("SELECT * FROM lead_ai_status_runs ORDER BY id")).rows).toEqual(audit);
      expect(
        (await db.query("SELECT ai_status FROM lead_ai_status ORDER BY lead_id")).rows,
      ).toEqual(
        ["wrong_number", "wrong_lead", "wrong_lead", null, null].map((ai_status) => ({
          ai_status,
        })),
      );
      await db.exec("SET ROLE authenticated");
      await db.query("UPDATE qualified_leads SET cs_status='wrong_person' WHERE id=$1", [id(5)]);
      expect(
        (await db.query("SELECT cs_status FROM qualified_leads WHERE id=$1", [id(5)])).rows[0],
      ).toEqual({ cs_status: "wrong_number" });
      await expect(db.query("SELECT enqueue_quo_ai_batch(NULL,ARRAY['PN1'])")).rejects.toThrow(
        /permission denied/,
      );
      await db.exec("RESET ROLE; SET ROLE service_role");
      expect(
        (
          await db.query("SELECT enqueue_quo_ai_batch(NULL,ARRAY['PN1'],NULL,NULL,$1) AS n", [
            id(4),
          ])
        ).rows[0],
      ).toEqual({ n: 0 });
      expect((await db.query("SELECT report_lead_ai_status() AS r")).rows[0]).toMatchObject({
        r: { total: 4, counts: { wrong_number: 1, wrong_lead: 2 } },
      });

      const enqueue = async (n: number) => {
        await db.query("SELECT enqueue_quo_ai_batch(NULL,ARRAY['PN1'],NULL,NULL,$1)", [id(n)]);
        return (
          await db.query<{ j: { runId: string; leaseToken: string } }>(
            "SELECT claim_quo_ai_job() AS j",
          )
        ).rows[0].j;
      };
      const job = await enqueue(5);
      const result = {
        state: "classified",
        status: "wrong_person",
        confidence: 0.99,
        reasonCode: "customer_intent",
        evidenceIds: ["AC1"],
        messageCount: 1,
        historyHash: "hash",
        model: "test",
        policyVersion: "v2",
      };
      expect(
        (
          await db.query("SELECT finish_quo_ai_job($1,$2,$3) AS ok", [
            job.runId,
            job.leaseToken,
            JSON.stringify(result),
          ])
        ).rows[0],
      ).toEqual({ ok: true });
      expect(
        (await db.query("SELECT ai_status FROM lead_ai_status WHERE lead_id=$1", [id(5)])).rows[0],
      ).toEqual({ ai_status: "wrong_number" });
      const late = await enqueue(1);
      await db.query("UPDATE qualified_leads SET cs_status='need_follow_up' WHERE id=$1", [id(1)]);
      expect(
        (
          await db.query("SELECT finish_quo_ai_job($1,$2,$3) AS ok", [
            late.runId,
            late.leaseToken,
            JSON.stringify(result),
          ])
        ).rows[0],
      ).toEqual({ ok: false });
      expect((await db.query("SELECT * FROM private.quo_ai_sync_jobs")).rows).toHaveLength(0);

      const followup = await enqueue(2);
      expect(
        (
          await db.query("SELECT finish_quo_ai_job($1,$2,$3) AS ok", [
            followup.runId,
            followup.leaseToken,
            JSON.stringify({ ...result, status: "need_follow_up" }),
          ])
        ).rows[0],
      ).toEqual({ ok: true });
      expect(
        (await db.query("SELECT state,ai_status FROM lead_ai_status WHERE lead_id=$1", [id(2)]))
          .rows[0],
      ).toEqual({ state: "review", ai_status: null });
    } finally {
      await db.close();
    }
  }, 30_000);
});
