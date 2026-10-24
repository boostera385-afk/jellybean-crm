import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NUMBER_NAMES, quoNameKey } from "../../supabase/functions/_shared/quo-number-names";

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
    assigned_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
    cs_status public.cs_status NOT NULL DEFAULT 'new',
    is_important boolean DEFAULT false, service text, post_text text, context text, created_by uuid,
    number_name text,
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
  "quo_ai_scope_and_rules",
  "quo_ai_lead_inbox",
  "quo_ai_inbox_keys",
  "quo_ai_no_caps",
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

  it("has no daily limit for the sweep or the Refresh button", async () => {
    // 600 runs already today, more than the old 400 and 500 ceilings.
    await db.exec(`INSERT INTO public.lead_ai_status_runs(lead_id,actor_id,source_key,
      manual_status,outcome,started_at,finished_at)
      SELECT '${lead(3)}',NULL,'k','new','classified',now()-interval '2 hours',now()-interval '2 hours'
      FROM generate_series(1,600)`);
    expect(await sweep(2)).toBe(2);
    expect(
      await call<number>(
        `public.enqueue_quo_ai_batch('${ADMIN}'::uuid,'${INBOX}'::text[],NULL,NULL,'${lead(3)}'::uuid)`,
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
    await seedDelivered(lead(1), "7 hours");
    await seedDelivered(lead(2), "5 hours");
    expect(await call<number>("public.flip_quo_ai_no_reply()")).toBe(1);
    expect(await statusOf(lead(1))).toEqual({
      ai_status: "cx_didnt_replied",
      reason_code: "no_reply_after_6h",
    });
    // Not yet 6 hours, so it stays as it was.
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

describe("the AI applies to leads from five days ago onward", () => {
  const OLD = "30000000-0000-4000-8000-000000000001";
  const addOldLead = () =>
    db.exec(`SET ROLE postgres;
      INSERT INTO public.qualified_leads(id,customer_name,customer_number,assigned_at,created_at,service)
        VALUES ('${OLD}','Old','(910) 555-7777',now()-interval '6 days',now()-interval '6 days','Painting');
      SET ROLE service_role;`);

  it("starts five days before the rules were switched on", async () => {
    const start = await call<string>("public.quo_ai_scope_start()");
    const days = (Date.now() - Date.parse(start)) / 86_400_000;
    expect(days).toBeGreaterThan(4.99);
    expect(days).toBeLessThan(5.01);
  });

  it("leaves a lead created before that alone, in the sweep and the webhook", async () => {
    await addOldLead();
    expect(await sweep(5)).toBe(3);
    expect(await queuedLeadIds()).not.toContain(OLD);
    expect(await accept("wh_old", "message.received", "+19105557777")).toMatchObject({
      matched: 0,
    });
  });

  it("hands the worker the lead's creation time, for 'already received before'", async () => {
    await call<number>(
      `public.enqueue_quo_ai_batch(NULL,'${INBOX}'::text[],NULL,NULL,'${lead(1)}'::uuid)`,
    );
    const job = await call<{ createdAt: string; assignedAt: string }>("public.claim_quo_ai_job()");
    expect(Number.isFinite(Date.parse(job.createdAt))).toBe(true);
  });

  it("keeps a result as it is when no rules version is given", async () => {
    await db.exec(
      `SELECT public.test_seed_status('${lead(1)}','classified','cx_interested','customer_intent',
         now() - interval '2 hours', interval '2 hours')`,
    );
    // No version given: an up-to-date-looking result has no reason to be re-read.
    expect(await sweep(1)).toBe(1);
    expect(await queuedLeadIds()).not.toContain(lead(1));
  });

  it("re-reads results decided under older rules once the version is passed", async () => {
    await db.exec(
      `SELECT public.test_seed_status('${lead(1)}','classified','cx_interested','customer_intent',
         now() - interval '2 hours', interval '2 hours');
       SELECT public.test_seed_status('${lead(2)}','classified','cx_interested','customer_intent',
         now() - interval '2 hours', interval '2 hours');
       SELECT public.test_seed_status('${lead(3)}','classified','cx_interested','customer_intent',
         now() - interval '2 hours', interval '2 hours');`,
    );
    expect(
      await call<number>(`public.enqueue_quo_ai_due('${INBOX}'::text[], 5, 'quo-shadow-v4')`),
    ).toBe(3);
  });

  it("reports only leads in the window, with 'not contacted yet' apart from review", async () => {
    await addOldLead();
    await db.exec(
      `SELECT public.test_seed_status('${lead(1)}','unmatched',NULL,'no_contact_yet',
         NULL, interval '1 hour');
       SELECT public.test_seed_status('${lead(2)}','review',NULL,'delivery_not_confirmed',
         NULL, interval '1 hour');`,
    );
    const report = await call<Record<string, unknown>>("public.report_lead_ai_status()");
    expect(report).toMatchObject({ total: 3, untouched: 1, review: 1 });
    expect(Number.isFinite(Date.parse(String(report.scopeStart)))).toBe(true);
  });
});

describe("switching the rules on", () => {
  it("clears earlier results outside the window and keeps the audit of them", async () => {
    // Its own database: the data has to exist BEFORE the migration runs.
    const fresh = new PGlite();
    try {
      await fresh.exec(BASE);
      // Everything up to, but not including, the migration under test.
      const cleanup = "quo_ai_scope_and_rules";
      for (const name of CHAIN.slice(0, CHAIN.indexOf(cleanup))) {
        const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(`_${name}.sql`));
        await fresh.exec(readFileSync(`supabase/migrations/${files[0]}`, "utf8"));
      }
      await fresh.exec(SEED_HELPER);
      await fresh.exec(`
        INSERT INTO public.qualified_leads(id,customer_number,created_at) VALUES
          ('${lead(1)}','(910) 555-1234',now()-interval '6 days'),
          ('${lead(2)}','(910) 555-5678',now()-interval '1 day');
        SELECT public.test_seed_status('${lead(1)}','classified','new','no_contact_for_current_assignment',
          NULL, interval '6 days');
        SELECT public.test_seed_status('${lead(2)}','classified','converted','delivery_confirmed',
          now() - interval '1 hour', interval '1 hour');`);
      const last = readdirSync("supabase/migrations").filter((f) => f.endsWith(`_${cleanup}.sql`));
      await fresh.exec(readFileSync(`supabase/migrations/${last[0]}`, "utf8"));
      const rows = await fresh.query<{ lead_id: string }>(
        "SELECT lead_id FROM public.lead_ai_status ORDER BY lead_id",
      );
      expect(rows.rows.map((r) => r.lead_id)).toEqual([lead(2)]);
      const audit = await fresh.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.lead_ai_status_runs WHERE lead_id='${lead(1)}'`,
      );
      expect(audit.rows[0].n).toBe(1);
    } finally {
      await fresh.close();
    }
  });
});

describe("each lead is read from the inbox it names", () => {
  const BOTH = "{PNhouston,PNmiami}";
  const record = (names: Record<string, string>) =>
    // What the quo-ai-status function sends: quoNameKey(name) -> inbox id.
    call<number>(
      `public.sync_quo_inbox_keys('${JSON.stringify(
        Object.fromEntries(Object.entries(names).map(([id, name]) => [quoNameKey(name), id])),
      )}'::jsonb)`,
    );
  const jobInboxes = async () =>
    (
      await db.query<{ lead_id: string; inbox_ids: string[] }>(
        `SELECT r.lead_id, j.inbox_ids FROM private.quo_ai_sync_jobs j
           JOIN public.lead_ai_status_runs r ON r.id = j.run_id ORDER BY r.lead_id`,
      )
    ).rows;
  const name = (id: string, value: string | null) =>
    db.exec(`SET ROLE postgres;
      UPDATE public.qualified_leads SET number_name = ${value === null ? "NULL" : `'${value}'`}
       WHERE id = '${id}'; SET ROLE service_role;`);

  it("reads only the named inbox, matching past case, spaces and punctuation", async () => {
    await record({ PNhouston: "Houston Handyman OP1", PNmiami: "Miami Handyman" });
    await name(lead(1), "houston handyman  op1");
    await name(lead(2), "Miami - Handyman");
    await call<number>(`public.enqueue_quo_ai_due('${BOTH}'::text[], 2)`);
    expect(await jobInboxes()).toEqual([
      { lead_id: lead(1), inbox_ids: ["PNhouston"] },
      { lead_id: lead(2), inbox_ids: ["PNmiami"] },
    ]);
  });

  it("falls back to every inbox when the lead names none, or one we do not have", async () => {
    await record({ PNhouston: "Houston Handyman OP1", PNmiami: "Miami Handyman" });
    await name(lead(1), null);
    await name(lead(2), "Dallas Garage Door");
    await call<number>(`public.enqueue_quo_ai_due('${BOTH}'::text[], 2)`);
    for (const job of await jobInboxes()) expect(job.inbox_ids).toEqual(["PNhouston", "PNmiami"]);
  });

  it("never reads an inbox outside the allowed set, even when the lead names it", async () => {
    await record({ PNhouston: "Houston Handyman OP1", PNmiami: "Miami Handyman" });
    await name(lead(1), "Miami Handyman");
    await call<number>(
      `public.enqueue_quo_ai_batch(NULL,'{PNhouston}'::text[],NULL,NULL,'${lead(1)}'::uuid)`,
    );
    expect(await jobInboxes()).toEqual([{ lead_id: lead(1), inbox_ids: ["PNhouston"] }]);
  });

  it("tells the worker whether the lead was read from its own inbox only", async () => {
    await record({ PNhouston: "Houston Handyman OP1" });
    await name(lead(1), "Houston Handyman OP1");
    await name(lead(2), null);
    await call<number>(`public.enqueue_quo_ai_due('${BOTH}'::text[], 2)`);
    const claim = async () => {
      const job = await call<{ runId: string; leadId: string; inboxMatched: boolean }>(
        "public.claim_quo_ai_job()",
      );
      // One job is leased at a time; finish this one so the next can be claimed.
      await db.exec(`DELETE FROM private.quo_ai_sync_jobs WHERE run_id = '${job.runId}'`);
      return job;
    };
    const claimed = [await claim(), await claim()];
    const matched = Object.fromEntries(claimed.map((job) => [job.leadId, job.inboxMatched]));
    expect(matched).toEqual({ [lead(1)]: true, [lead(2)]: false });
  });

  it("keeps the recorded names when Quo's list comes back empty", async () => {
    await record({ PNhouston: "Houston Handyman OP1" });
    expect(await record({})).toBe(0);
    const kept = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM private.quo_inbox_keys",
    );
    expect(kept.rows[0].n).toBe(1);
  });
});

describe("the inbox name key is the same in TypeScript and SQL", () => {
  it("for every lead-card name and the names Quo has changed", async () => {
    const names = [
      ...NUMBER_NAMES.map((entry) => entry.name),
      "Dallas Garage Door (HOLD OUTBOUND)",
      "Chicago Facebook (No Outbound)",
      "Los Angeles - Handyman (HOLD OUTBOUND)",
    ];
    for (const name of names)
      expect(await call<string>(`public.quo_name_key('${name.replace(/'/g, "''")}')`)).toBe(
        quoNameKey(name),
      );
  });
});
