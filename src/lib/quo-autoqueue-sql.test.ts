import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The event queue, the demand-driven sweep, and the 24-hour rule.
 *
 * Before this, the only thing that ever queued Quo work was an administrator
 * pressing Refresh, and the sweep it replaces re-scanned the whole catalogue
 * in last-run order at up to (inboxes x numbers) paged requests per lead. So
 * the behaviour worth pinning down is mostly about what does NOT happen: a
 * lead with no reason to be looked at is not queued, a redelivered event does
 * not queue twice, and silence is not read as "no reply" unless replies are
 * demonstrably still arriving.
 */

const INBOX = "{PNtestinbox1}";
const ADMIN = "10000000-0000-4000-8000-000000000001";
const lead = (n: number) => `20000000-0000-4000-8000-00000000000${n}`;

const BASE = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$SELECT nullif(current_setting('request.jwt.claim.sub', true),'')::uuid$$;
  CREATE TABLE public.user_roles(user_id uuid, role text);
  CREATE FUNCTION public.current_user_has_role_text(p_role text) RETURNS boolean LANGUAGE sql STABLE AS
    $$SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=auth.uid() AND role=p_role)$$;
  CREATE TYPE public.cs_status AS ENUM ('new','converted','cx_interested','cx_not_interested',
    'cx_didnt_replied','need_follow_up','undeliver','wrong_number','wrong_lead','wrong_person',
    'wrong_service','small_service','already_got_someone','already_received_before',
    'service_provider_himself','out_of_base');
  CREATE TABLE public.qualified_leads(id uuid PRIMARY KEY, customer_name text, customer_number text,
    customer_number_2 text, extra_numbers text[] NOT NULL DEFAULT '{}',
    assigned_at timestamptz NOT NULL DEFAULT now(), cs_status public.cs_status NOT NULL DEFAULT 'new',
    is_important boolean DEFAULT false, service text, post_text text, context text, created_by uuid,
    assigned_to uuid, called_at timestamptz);
  ALTER TABLE public.qualified_leads ENABLE ROW LEVEL SECURITY;
  GRANT USAGE ON SCHEMA public,auth TO authenticated,service_role;
  GRANT SELECT ON public.qualified_leads, public.user_roles TO authenticated,service_role;
  GRANT UPDATE ON public.qualified_leads TO service_role;
`;

/** Every migration that shapes these objects, in the order Supabase runs them. */
const CHAIN = [
  "quo_ai_status_beta",
  "index_lead_ai_status_run",
  "allow_staff_phone_index_evaluation",
  "quo_resumable_sync",
  "optimize_quo_phone_identity",
  "admin_only_lead_ai_status",
  "consolidate_cs_statuses",
  "quo_webhook_and_autoqueue",
];

/** Seeds a finished comparison, so the sweep and the flip have state to read. */
const SEED_HELPER = `
  CREATE FUNCTION public.test_seed_status(p_lead uuid, p_state text, p_status text,
    p_reason text, p_last_message_at timestamptz, p_age interval, p_source_key text DEFAULT NULL)
  RETURNS void LANGUAGE plpgsql AS $$
  DECLARE r uuid; sk text; manual public.cs_status;
  BEGIN
    SELECT public.lead_ai_source_key(q), q.cs_status INTO sk, manual
      FROM public.qualified_leads q WHERE q.id = p_lead;
    INSERT INTO public.lead_ai_status_runs(lead_id,actor_id,source_key,manual_status,outcome,
      started_at,finished_at)
      VALUES (p_lead,NULL,sk,manual,'classified',now()-p_age,now()-p_age) RETURNING id INTO r;
    INSERT INTO public.lead_ai_status(lead_id,run_id,source_key,state,ai_status,confidence,
      reason_code,message_count,model,policy_version,analyzed_at,last_message_at)
      VALUES (p_lead,r,coalesce(p_source_key,sk),p_state,
        CASE WHEN p_status IS NULL THEN NULL ELSE p_status::public.cs_status END,
        CASE WHEN p_state='classified' THEN 1 ELSE NULL END,
        p_reason,1,'test-model','test-policy',now()-p_age,p_last_message_at);
  END $$;
`;

let db: PGlite;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(BASE);
  for (const name of CHAIN) {
    const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(`_${name}.sql`));
    expect(files, `expected one migration named ${name}`).toHaveLength(1);
    await db.exec(readFileSync(`supabase/migrations/${files[0]}`, "utf8"));
  }
  await db.exec(SEED_HELPER);
  await db.exec(`
    INSERT INTO public.user_roles VALUES ('${ADMIN}','cs_admin');
    INSERT INTO public.qualified_leads(id,customer_name,customer_number,assigned_at,service) VALUES
      ('${lead(1)}','Newest','(910) 555-1234','2026-10-22T09:00:00Z','Painting'),
      ('${lead(2)}','Older','9105555678','2026-10-20T09:00:00Z','Drywall'),
      ('${lead(3)}','Oldest','+1 910 555 9012','2026-10-01T09:00:00Z','Roofing');
    SET ROLE service_role;`);
});

afterEach(async () => {
  await db?.close();
});

const call = async <T>(sql: string): Promise<T> =>
  (await db.query<{ result: T }>(`SELECT ${sql} AS result`)).rows[0].result;

const accept = (id: string, type: string, phone: string) =>
  call<{ duplicate: boolean; matched: number }>(
    `public.accept_quo_webhook_event('${id}','${type}','${phone}')`,
  );

const sweep = (limit = 5) =>
  call<number>(`public.enqueue_quo_ai_due('${INBOX}'::text[], ${limit})`);

const queuedLeadIds = async (): Promise<string[]> =>
  (
    await db.query<{ lead_id: string }>(
      `SELECT r.lead_id FROM private.quo_ai_sync_jobs j
         JOIN public.lead_ai_status_runs r ON r.id = j.run_id ORDER BY j.created_at, r.lead_id`,
    )
  ).rows.map((row) => row.lead_id);

describe("Quo webhook events", () => {
  it("deduplicates a redelivered event instead of queueing the work twice", async () => {
    expect(await accept("wh_1", "message.received", "+19105551234")).toMatchObject({
      duplicate: false,
      matched: 1,
    });
    // Quo redelivers anything it did not see accepted.
    expect(await accept("wh_1", "message.received", "+19105551234")).toEqual({
      duplicate: true,
      matched: 0,
    });
    expect(
      (
        await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM private.lead_ai_recheck_queue`,
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("matches a formatted stored number, and queues nothing for an unknown one", async () => {
    // Stored as "(910) 555-1234"; Quo reports "+19105551234". The event is
    // useless if those two do not meet, which is why matching is done by the
    // same indexed lead_ai_phone() the worker's identity guard uses.
    expect(await accept("wh_a", "message.received", "+19105551234")).toMatchObject({ matched: 1 });
    // A real number that belongs to no lead: recorded, matched to nothing.
    expect(await accept("wh_b", "message.delivered", "+15550000000")).toMatchObject({
      duplicate: false,
      matched: 0,
      reason: "delivery_confirmed",
    });
    // Not a number at all: said so plainly rather than counted as a match.
    expect(await accept("wh_c", "message.received", "not-a-phone")).toEqual({
      duplicate: false,
      matched: 0,
      reason: "unparseable_phone",
    });
  });

  it("records the reason the event gives, so the queue says why", async () => {
    await accept("wh_u", "message.undelivered", "9105555678");
    expect(
      (
        await db.query<{ reason: string }>(
          `SELECT reason FROM private.lead_ai_recheck_queue WHERE lead_id='${lead(2)}'`,
        )
      ).rows[0].reason,
    ).toBe("delivery_failed");
  });

  it("queues every lead holding a shared number rather than guessing one", async () => {
    await db.exec(
      `UPDATE public.qualified_leads SET customer_number_2='910-555-1234' WHERE id='${lead(2)}'`,
    );
    expect(await accept("wh_s", "message.received", "+19105551234")).toMatchObject({ matched: 2 });
  });

  it("will not drag a manual follow-up lead back into comparison", async () => {
    await db.exec(
      `SET ROLE postgres; UPDATE public.qualified_leads SET cs_status='need_follow_up'
         WHERE id='${lead(1)}'; SET ROLE service_role;`,
    );
    expect(await accept("wh_f", "message.received", "+19105551234")).toMatchObject({ matched: 0 });
  });
});

describe("the demand-driven sweep", () => {
  it("queues a lead that has a reason and skips one that has none", async () => {
    // Lead 1 is freshly classified with nothing outstanding; 2 and 3 have never
    // been looked at. The old sweep ordered by last run and would have taken
    // lead 1 again on the next pass. This one must never pick it.
    await db.exec(
      `SELECT public.test_seed_status('${lead(1)}','classified','cx_interested',
         'customer_intent', now() - interval '2 hours', interval '2 hours')`,
    );
    expect(await sweep()).toBe(2);
    expect(await queuedLeadIds()).toEqual([lead(2), lead(3)]);

    // Everything now has a run inside the cooldown, so a second pass is a no-op
    // rather than another lap of the catalogue.
    expect(await sweep()).toBe(0);
  });

  it("takes the newest unseen lead first, so the back catalogue trickles behind", async () => {
    expect(await sweep(1)).toBe(1);
    expect(await queuedLeadIds()).toEqual([lead(1)]);
  });

  it("puts an event ahead of leads that have merely never been looked at", async () => {
    await accept("wh_p", "message.received", "+1 910 555 9012");
    expect(await sweep(1)).toBe(1);
    // Lead 3 is the OLDEST lead, so only the event can explain picking it.
    expect(await queuedLeadIds()).toEqual([lead(3)]);
    // Claiming it spends the event.
    expect(
      (
        await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM private.lead_ai_recheck_queue`,
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("re-reads a delivery that had not confirmed yet, but not one just looked at", async () => {
    await db.exec(
      `SELECT public.test_seed_status('${lead(1)}','review',NULL,'delivery_not_confirmed',
         now() - interval '30 minutes', interval '30 minutes');
       SELECT public.test_seed_status('${lead(2)}','review',NULL,'delivery_not_confirmed',
         now() - interval '1 minute', interval '1 minute');`,
    );
    expect(await sweep()).toBe(2);
    // Lead 2 was looked at a minute ago: inside the 10-minute settle window and
    // inside the 15-minute per-lead cooldown, so it waits. Lead 3 is unseen.
    expect(await queuedLeadIds()).toEqual([lead(1), lead(3)]);
  });

  it("re-reads a lead whose own details were edited since the comparison", async () => {
    await db.exec(
      `SELECT public.test_seed_status('${lead(1)}','classified','cx_interested','customer_intent',
         now() - interval '2 hours', interval '2 hours', 'a-stale-source-key')`,
    );
    expect(await sweep(5)).toBe(3);
    expect(await queuedLeadIds()).toContain(lead(1));
  });

  it("leaves the last fifth of the daily budget for a person pressing Refresh", async () => {
    // 400 runs already today: the sweep's own ceiling, with the full 500 still
    // open to the manual batch.
    await db.exec(`INSERT INTO public.lead_ai_status_runs(lead_id,actor_id,source_key,
      manual_status,outcome,started_at,finished_at)
      SELECT '${lead(3)}',NULL,'k','new','classified',now()-interval '2 hours',now()-interval '2 hours'
      FROM generate_series(1,400)`);
    expect(await sweep()).toBe(0);
    // The button still works, which is the point of stopping at 400.
    expect(
      await call<number>(
        `public.enqueue_quo_ai_batch('${ADMIN}'::uuid,'${INBOX}'::text[],NULL,NULL,'${lead(1)}'::uuid)`,
      ),
    ).toBe(1);
  });
});

describe("the 24-hour no-reply rule", () => {
  const seedDelivered = (id: string, age: string) =>
    db.exec(
      `SELECT public.test_seed_status('${id}','classified','converted','delivery_confirmed',
         now() - interval '${age}', interval '${age}')`,
    );
  const liveWebhook = () =>
    db.exec(
      `INSERT INTO private.quo_webhook_deliveries(webhook_id,event_type)
         VALUES ('wh_live','message.delivered')`,
    );
  const statusOf = async (id: string) =>
    (
      await db.query<{ ai_status: string; reason_code: string }>(
        `SELECT ai_status::text AS ai_status, reason_code FROM public.lead_ai_status WHERE lead_id='${id}'`,
      )
    ).rows[0];

  it("settles in SQL, with no Quo request and no model call", async () => {
    await liveWebhook();
    await seedDelivered(lead(1), "25 hours");
    await seedDelivered(lead(2), "23 hours");
    expect(await call<number>("public.flip_quo_ai_no_reply()")).toBe(1);
    expect(await statusOf(lead(1))).toEqual({
      ai_status: "cx_didnt_replied",
      reason_code: "no_reply_after_24h",
    });
    // Not yet 24 hours, so it stays as it was.
    expect(await statusOf(lead(2))).toMatchObject({ reason_code: "delivery_confirmed" });
  });

  it("refuses to read silence as no reply when no webhook has arrived for a day", async () => {
    await seedDelivered(lead(1), "25 hours");
    // Nothing in quo_webhook_deliveries: replies may simply not be reaching us,
    // in which case silence is not evidence of anything.
    expect(await call<number>("public.flip_quo_ai_no_reply()")).toBe(0);
    expect(await statusOf(lead(1))).toMatchObject({ reason_code: "delivery_confirmed" });
    // It must not be stranded either: the sweep re-reads it from Quo instead.
    expect(await sweep(5)).toBeGreaterThan(0);
    expect(await queuedLeadIds()).toContain(lead(1));
  });

  it("yields to a queued event, which knows more than the clock does", async () => {
    await liveWebhook();
    await seedDelivered(lead(1), "25 hours");
    await accept("wh_r", "message.received", "+19105551234");
    expect(await call<number>("public.flip_quo_ai_no_reply()")).toBe(0);
  });

  it("will not advance a comparison whose lead was edited since", async () => {
    await liveWebhook();
    await db.exec(
      `SELECT public.test_seed_status('${lead(1)}','classified','converted','delivery_confirmed',
         now() - interval '25 hours', interval '25 hours', 'a-stale-source-key')`,
    );
    expect(await call<number>("public.flip_quo_ai_no_reply()")).toBe(0);
  });

  it("persists the last message time a verdict was based on", async () => {
    // The whole rule rests on this column, so prove the worker's result lands
    // in it through the fenced completion path rather than a direct insert.
    expect(
      await call<number>(
        `public.enqueue_quo_ai_batch(NULL,'${INBOX}'::text[],NULL,NULL,'${lead(1)}'::uuid)`,
      ),
    ).toBe(1);
    const job = await call<{ runId: string; leaseToken: string }>("public.claim_quo_ai_job()");
    expect(
      await call<boolean>(
        `public.finish_quo_ai_job('${job.runId}'::uuid,'${job.leaseToken}'::uuid, '${JSON.stringify(
          {
            state: "classified",
            status: "converted",
            confidence: 1,
            reasonCode: "delivery_confirmed",
            evidenceIds: ["ACone"],
            messageCount: 3,
            historyHash: "hash",
            model: "test-model",
            policyVersion: "test-policy",
            lastMessageAt: "2026-10-21T08:00:00Z",
          },
        )}'::jsonb)`,
      ),
    ).toBe(true);
    expect(
      (
        await db.query<{ last_message_at: Date | null }>(
          `SELECT last_message_at FROM public.lead_ai_status WHERE lead_id='${lead(1)}'`,
        )
      ).rows[0].last_message_at,
    ).toEqual(new Date("2026-10-21T08:00:00Z"));
  });
});
