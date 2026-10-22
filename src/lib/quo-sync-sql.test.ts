import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("resumable Quo job contracts", () => {
  it("fences workers, resumes older runs, deletes content, preserves statuses and restricts staging", async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
        CREATE TYPE public.cs_status AS ENUM ('new','converted');
        CREATE TABLE public.user_roles(user_id uuid,role text);
        CREATE FUNCTION public.current_user_has_role_text(text) RETURNS boolean LANGUAGE sql STABLE AS 'SELECT true';
        CREATE TABLE public.qualified_leads(id uuid PRIMARY KEY,customer_name text,customer_number text,
          customer_number_2 text,extra_numbers text[],assigned_at timestamptz DEFAULT now(),
          cs_status public.cs_status DEFAULT 'new',is_important boolean DEFAULT false,service text,post_text text,context text);
        GRANT USAGE ON SCHEMA public TO authenticated,service_role;
        GRANT SELECT,UPDATE ON public.qualified_leads TO service_role;
        GRANT SELECT ON public.qualified_leads,public.user_roles TO authenticated;
        GRANT SELECT ON public.user_roles TO service_role;
      `);
      for (const name of [
        "quo_ai_status_beta",
        "index_lead_ai_status_run",
        "allow_staff_phone_index_evaluation",
        "quo_resumable_sync",
        "optimize_quo_phone_identity",
      ]) {
        const file = readdirSync("supabase/migrations").find((f) => f.endsWith(`_${name}.sql`));
        if (!file) throw new Error(`Migration missing: ${name}`);
        await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
      }
      const actor = "10000000-0000-4000-8000-000000000001";
      const lead = "20000000-0000-4000-8000-000000000001";
      await db.exec(`INSERT INTO user_roles VALUES('${actor}','admin');
        INSERT INTO qualified_leads(id,customer_number) VALUES('${lead}','9105551234'); SET ROLE service_role;`);
      const queued = (
        await db.query<{ n: number }>(
          `SELECT enqueue_quo_ai_batch('${actor}',ARRAY['PN1','PN2'],NULL,NULL,'${lead}') AS n`,
        )
      ).rows[0].n;
      expect(queued).toBe(1);
      expect(
        (
          await db.query<{ n: number }>(
            `SELECT enqueue_quo_ai_batch('${actor}',ARRAY['PN1'],NULL,NULL,'${lead}') AS n`,
          )
        ).rows[0].n,
      ).toBe(0);
      const first = (
        await db.query<{ j: { runId: string; leaseToken: string; checkpoint: null } }>(
          "SELECT claim_quo_ai_job() AS j",
        )
      ).rows[0].j;
      expect(first.checkpoint).toBeNull();
      expect(
        (await db.query<{ j: unknown }>("SELECT claim_quo_ai_job() AS j")).rows[0].j,
      ).toBeNull();
      const checkpoint = "v1.aA==.ZGF0YQ==";
      expect(
        (
          await db.query<{ ok: boolean }>(
            "SELECT checkpoint_quo_ai_job($1,gen_random_uuid(),$2,1,2) AS ok",
            [first.runId, checkpoint],
          )
        ).rows[0].ok,
      ).toBe(false);
      expect(
        (
          await db.query<{ ok: boolean }>("SELECT checkpoint_quo_ai_job($1,$2,$3,1,2) AS ok", [
            first.runId,
            first.leaseToken,
            checkpoint,
          ])
        ).rows[0].ok,
      ).toBe(true);
      await db.exec(`RESET ROLE; UPDATE private.quo_ai_sync_jobs SET next_attempt_at=now() WHERE run_id='${first.runId}';
        UPDATE lead_ai_status_runs SET started_at=now()-interval '1 hour' WHERE id='${first.runId}'; SET ROLE service_role;`);
      const next = (
        await db.query<{ j: { runId: string; leaseToken: string; checkpoint: string } }>(
          "SELECT claim_quo_ai_job() AS j",
        )
      ).rows[0].j;
      expect(next.checkpoint).toBe(checkpoint);
      expect(next.leaseToken).not.toBe(first.leaseToken);
      const result = {
        state: "classified",
        status: "converted",
        confidence: 1,
        reasonCode: "delivery_confirmed",
        evidenceIds: ["AC1"],
        messageCount: 1,
        historyHash: "hash",
        model: "test",
        policyVersion: "v2",
      };
      expect(
        (
          await db.query<{ ok: boolean }>("SELECT finish_quo_ai_job($1,$2,$3) AS ok", [
            first.runId,
            first.leaseToken,
            JSON.stringify(result),
          ])
        ).rows[0].ok,
      ).toBe(false);
      expect(
        (
          await db.query<{ ok: boolean }>("SELECT finish_quo_ai_job($1,$2,$3) AS ok", [
            next.runId,
            next.leaseToken,
            JSON.stringify(result),
          ])
        ).rows[0].ok,
      ).toBe(true);
      expect((await db.query("SELECT * FROM private.quo_ai_sync_jobs")).rows).toHaveLength(0);
      expect(
        (
          await db.query<{ s: string }>(
            `SELECT cs_status AS s FROM qualified_leads WHERE id='${lead}'`,
          )
        ).rows[0].s,
      ).toBe("new");
      expect(
        (
          await db.query<{ s: string }>(
            `SELECT ai_status AS s FROM lead_ai_status WHERE lead_id='${lead}'`,
          )
        ).rows[0].s,
      ).toBe("converted");
      await db.exec(
        `RESET ROLE; UPDATE lead_ai_status_runs SET started_at=now()-interval '20 minutes' WHERE id='${first.runId}'`,
      );
      expect(
        (
          await db.query<{ n: number }>(
            `SELECT enqueue_quo_ai_batch(NULL,ARRAY['PN1'],NULL,NULL,'${lead}') AS n`,
          )
        ).rows[0].n,
      ).toBe(1);
      const management = (
        await db.query<{ j: { runId: string; leaseToken: string } }>(
          "SELECT claim_quo_ai_job() AS j",
        )
      ).rows[0].j;
      expect(
        (
          await db.query<{ via: string; actor_id: null }>(
            "SELECT requested_via AS via,actor_id FROM lead_ai_status_runs WHERE id=$1",
            [management.runId],
          )
        ).rows[0],
      ).toEqual({ via: "management", actor_id: null });
      await db.exec(`UPDATE qualified_leads SET service='changed' WHERE id='${lead}'`);
      expect(
        (
          await db.query<{ ok: boolean }>("SELECT finish_quo_ai_job($1,$2,$3) AS ok", [
            management.runId,
            management.leaseToken,
            JSON.stringify(result),
          ])
        ).rows[0].ok,
      ).toBe(false);
      expect((await db.query("SELECT * FROM private.quo_ai_sync_jobs")).rows).toHaveLength(0);
      await db.exec("SET ROLE authenticated");
      await expect(db.query("SELECT * FROM private.quo_ai_sync_jobs")).rejects.toThrow(
        /permission denied/,
      );
      await expect(db.query("SELECT claim_quo_ai_job()")).rejects.toThrow(/permission denied/);
      await expect(db.query("SELECT enqueue_quo_ai_batch(NULL,ARRAY['PN1'])")).rejects.toThrow(
        /permission denied/,
      );
      expect(
        (await db.query<{ p: { pending: number } }>("SELECT report_quo_ai_progress() AS p")).rows[0]
          .p.pending,
      ).toBe(0);
      await db.exec("RESET ROLE; SET ROLE anon");
      await expect(db.query("SELECT report_quo_ai_progress()")).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await db.close();
    }
  }, 30_000);
});
