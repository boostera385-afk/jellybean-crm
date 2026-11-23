import {
  classifyQuoHistory,
  customerRepliedSince,
  emptyResult,
  fetchQuoCalls,
  normalizeQuoPhone,
  safeAiError,
  type AiResult,
  type QuoMessage,
} from "./quo-ai-status.ts";
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
  // Whether the customer said anything since assignment. A lead the AI cannot
  // classify must then not keep showing "didn't reply" in Need Review.
  let customerReplied = false;
  try {
    checkpoint = job.checkpoint
      ? await decryptQuoCheckpoint(job.checkpoint, quoKey, job.runId)
      : createQuoCheckpoint(job.snapshot, [
          job.customerNumber,
          job.customerNumber2,
          ...(job.extraNumbers ?? []),
        ]);
    // When the job reads exactly the lead's own inbox -- its number_name maps to
    // a single Quo inbox (inboxMatched) -- the history is confined to THAT inbox,
    // so a number shared across leads on different inboxes cannot be confused.
    // Otherwise the shared-phone guard below runs on the number the chat is on.
    {
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
      // Keep the conversation itself, not only the verdict, so chats can be
      // reviewed and used to improve the rules. Best effort: a failed save
      // never holds up or changes the status decision.
      try {
        const { error: storeError } = await db.rpc("store_quo_messages", {
          p_lead_id: job.leadId,
          p_messages: checkpoint.messages,
        });
        if (storeError) console.warn("Could not save Quo messages", { leadId: job.leadId });
      } catch {
        console.warn("Could not save Quo messages", { leadId: job.leadId });
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
      // The customer-words fingerprint lives in the saved run result, not in
      // lead_ai_status. Best effort: without it only an identical chat is reused.
      if (cached && typeof previous?.run_id === "string") {
        try {
          const { data: lastRun } = await db
            .from("lead_ai_status_runs")
            .select("result")
            .eq("id", previous.run_id)
            .maybeSingle();
          const saved = (lastRun?.result as { customerHash?: unknown } | null)?.customerHash;
          if (typeof saved === "string") cached.customerHash = saved;
        } catch {
          /* keep the full-chat comparison only */
        }
      }
      // Phone calls too: many outcomes are only said on a call. Best effort --
      // without them the lead is judged from its texts, as before.
      let calls: QuoMessage[] = [];
      const callPhone = new Map<string, string>();
      // On unless the QUO_AI_CALLS secret is "off".
      const callsOn =
        (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(
          "QUO_AI_CALLS",
        ) !== "off";
      if (callsOn && job.inboxIds.length <= 3) {
        try {
          for (const phone of checkpoint.phones)
            for (const inbox of job.inboxIds) {
              const found = await fetchQuoCalls({
                apiKey: quoKey,
                phoneNumberId: inbox,
                participant: phone,
                snapshot: checkpoint.snapshot,
                signal: deadline,
                reserveRequest:
                  options.wait ??
                  (async () => {
                    await new Promise((resolve) => setTimeout(resolve, 200));
                  }),
              });
              for (const call of found) callPhone.set(call.id, phone);
              calls.push(...found);
            }
        } catch {
          calls = [];
          callPhone.clear();
        }
      }
      const allHistory = [...checkpoint.messages, ...calls].sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
      // A lead with several numbers is judged only on the number the
      // conversation happened on: the customer's latest message, else ours.
      const phoneOf = (m: QuoMessage) =>
        callPhone.get(m.id) ?? normalizeQuoPhone(m.direction === "incoming" ? m.from : m.to[0]);
      let chatPhone = checkpoint.phones[0];
      if (checkpoint.phones.length > 1) {
        const newestFirst = [...allHistory].reverse();
        const spoke = (m: QuoMessage) => (m.call ? m.call.answered : m.direction === "incoming");
        const pick = newestFirst.find(spoke) ?? newestFirst[0];
        chatPhone = (pick && phoneOf(pick)) || chatPhone;
      }
      const history =
        checkpoint.phones.length > 1
          ? allHistory.filter((m) => phoneOf(m) === chatPhone)
          : allHistory;
      // Read across every inbox, a number shared with another lead cannot be
      // attributed to this one. Only the number the chat is on is checked.
      if (job.inboxMatched !== true) {
        const { data: unique, error } = await db.rpc("lead_ai_phone_is_unique", {
          p_lead_id: job.leadId,
          p_phone: chatPhone,
        });
        if (error) throw new Error("identity_check_unavailable");
        if (unique !== true) result = emptyResult("review", "phone_shared_between_leads");
      }
      customerReplied = customerRepliedSince(history, job.assignedAt);
      if (!result) {
        result = await classifyQuoHistory({
          messages: history,
          assignedAt: job.assignedAt,
          createdAt: job.createdAt,
          checkPriorContact: job.inboxMatched === true,
          service: job.service,
          apiKey: modelKey,
          previous: cached,
          signal: deadline,
        });
        // Nothing at all for this number on the lead's own inbox: the lead's
        // number name most likely points at the wrong inbox.
        if (job.inboxMatched === true && result.reasonCode === "no_matching_quo_history")
          result = { ...result, reasonCode: "check_number_name" };
      }
      lastMessageAt = history.filter((m) => !m.call).at(-1)?.createdAt ?? null;
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
    p_result: { ...result!, lastMessageAt, customerReplied },
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
    message: "AI status automation completed.",
  };
}
