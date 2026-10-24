import { classifyQuoHistory, emptyResult, safeAiError, type AiResult } from "./quo-ai-status.ts";
import {
  advanceQuoCheckpoint,
  createQuoCheckpoint,
  decryptQuoCheckpoint,
  encryptQuoCheckpoint,
  type QuoCheckpoint,
} from "./quo-sync.ts";

export type QuoWorkerDb = {
  rpc: (
    name: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
  from: (table: string) => {
    select: (fields: string) => {
      eq: (
        column: string,
        value: string,
      ) => {
        maybeSingle: () => PromiseLike<{ data: Record<string, unknown> | null; error: unknown }>;
      };
    };
  };
};
type SyncJob = {
  runId: string;
  leaseToken: string;
  leadId: string;
  checkpoint: string | null;
  inboxIds: string[];
  snapshot: string;
  failures: number;
  customerNumber: string | null;
  customerNumber2: string | null;
  extraNumbers: string[] | null;
  assignedAt: string;
  createdAt?: string | null;
  /** The job reads exactly the inbox the lead's number_name maps to. */
  inboxMatched?: boolean;
  service: string | null;
};

export async function processQuoJob(
  db: QuoWorkerDb,
  quoKey: string,
  modelKey: string,
  options: { wait?: () => Promise<void> } = {},
) {
  const { data: claimed, error: claimError } = await db.rpc("claim_quo_ai_job");
  if (claimError) throw new Error("Could not claim queued analysis");
  if (!claimed)
    return {
      processed: 0,
      results: [],
      message: "Queue idle, waiting for retry, or another worker is active.",
    };
  const job = claimed as SyncJob;
  let checkpoint: QuoCheckpoint | null = null;
  let result: AiResult | null = null;
  // The createdAt of the newest message the verdict was actually based on.
  // transportResult's 24-hour no-reply rule measures from exactly this, so
  // persisting it lets a cron advance that rule in SQL rather than re-reading
  // the whole Quo history just to learn that a day has passed. Left null
  // unless the history completed, because a partial thread's last message is
  // not the thread's last message.
  let lastMessageAt: string | null = null;
  try {
    checkpoint = job.checkpoint
      ? await decryptQuoCheckpoint(job.checkpoint, quoKey, job.runId)
      : createQuoCheckpoint(job.snapshot, [
          job.customerNumber,
          job.customerNumber2,
          ...(job.extraNumbers ?? []),
        ]);
    for (const phone of checkpoint.phones) {
      const { data: unique, error } = await db.rpc("lead_ai_phone_is_unique", {
        p_lead_id: job.leadId,
        p_phone: phone,
      });
      if (error) throw new Error("identity_check_unavailable");
      if (unique !== true) {
        result = emptyResult("review", "phone_shared_between_leads");
        break;
      }
    }
    if (!result) {
      const deadline = AbortSignal.timeout(70_000);
      const advanced = await advanceQuoCheckpoint(checkpoint, {
        apiKey: quoKey,
        inboxIds: job.inboxIds,
        signal: deadline,
        reserveRequest:
          options.wait ??
          (async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }),
      });
      checkpoint = advanced.checkpoint;
      if (!advanced.complete) {
        const { data: saved, error } = await db.rpc("checkpoint_quo_ai_job", {
          p_run_id: job.runId,
          p_lease_token: job.leaseToken,
          p_checkpoint: await encryptQuoCheckpoint(checkpoint, quoKey, job.runId),
          p_done: advanced.done,
          p_total: advanced.total,
        });
        if (error || !saved) throw new Error("checkpoint_not_saved");
        return {
          processed: 0,
          results: [],
          advanced: true,
          workDone: advanced.done,
          workTotal: advanced.total,
          message: "Complete history still syncing. No partial status has been published.",
        };
      }
      const { data: previous } = await db
        .from("lead_ai_status")
        .select("*")
        .eq("lead_id", job.leadId)
        .maybeSingle();
      const cached = previous
        ? ({
            ...previous,
            status: previous.ai_status,
            reasonCode: previous.reason_code,
            evidenceIds: previous.evidence_ids,
            messageCount: previous.message_count,
            historyHash: previous.history_hash,
            policyVersion: previous.policy_version,
          } as AiResult)
        : null;
      result = await classifyQuoHistory({
        messages: checkpoint.messages,
        assignedAt: job.assignedAt,
        createdAt: job.createdAt,
        // Strict: a job from before the claim reported it does not qualify.
        checkPriorContact: job.inboxMatched === true,
        service: job.service,
        apiKey: modelKey,
        previous: cached,
        signal: deadline,
      });
      lastMessageAt = checkpoint.messages.at(-1)?.createdAt ?? null;
    }
  } catch (error) {
    const code = safeAiError(error);
    const terminalReview = [
      "invalid_or_excess_customer_numbers",
      "history_too_large",
      "invalid_checkpoint",
      "ambiguous_conversation",
      "incomplete_history",
      "invalid_quo_response",
    ].includes(code);
    if (!terminalReview && checkpoint && job.failures < 2) {
      const { data: saved, error: saveError } = await db.rpc("checkpoint_quo_ai_job", {
        p_run_id: job.runId,
        p_lease_token: job.leaseToken,
        p_checkpoint: await encryptQuoCheckpoint(checkpoint, quoKey, job.runId),
        p_done: checkpoint.phoneIndex * job.inboxIds.length + checkpoint.inboxIndex,
        p_total: checkpoint.phones.length * job.inboxIds.length,
        p_retry: true,
      });
      if (!saveError && saved)
        return {
          processed: 0,
          results: [],
          retrying: true,
          message: "Temporary provider failure; queued for bounded retry.",
        };
    }
    result = emptyResult(terminalReview ? "review" : "error", code);
  }
  const { data: saved, error } = await db.rpc("finish_quo_ai_job", {
    p_run_id: job.runId,
    p_lease_token: job.leaseToken,
    p_result: { ...result!, lastMessageAt },
  });
  return {
    processed: 1,
    results: [
      {
        leadId: job.leadId,
        state: saved && !error ? result!.state : "stale",
        reasonCode: saved && !error ? result!.reasonCode : "result_not_published",
      },
    ],
    message: "Manual statuses unchanged.",
  };
}
