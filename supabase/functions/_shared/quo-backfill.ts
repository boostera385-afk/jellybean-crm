import { safeAiError } from "./quo-ai-status.ts";
import { advanceQuoCheckpoint, createQuoCheckpoint } from "./quo-sync.ts";

/** The one database call the backfill makes, kept local so this module and
 *  its function bundle do not pull in the AI status worker. */
export type BackfillDb = {
  rpc: (
    name: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

type BackfillLead = {
  leadId: string;
  attempts: number;
  inboxIds: string[];
  inboxMatched: boolean;
  customerNumber: string | null;
  customerNumber2: string | null;
  extraNumbers: string[] | null;
};

/** Errors that a retry cannot fix: record them instead of re-queueing. */
const FINAL_ERRORS = new Set([
  "invalid_or_excess_customer_numbers",
  "history_too_large",
  "invalid_checkpoint",
  "ambiguous_conversation",
  "incomplete_history",
  "invalid_quo_response",
]);

/**
 * Drain the one-off Quo conversation backfill queue until it is empty or the
 * time budget is spent. Reads each lead's complete history the same way the AI
 * status worker does and saves it through store_quo_messages. Never classifies
 * a lead or changes its status. A lead that cannot finish in the time left is
 * returned to the queue, so a partial conversation is never saved.
 */
export async function backfillQuoMessages(
  db: BackfillDb,
  quoKey: string,
  inboxIds: string[],
  options: {
    budgetMs?: number;
    leadBudgetMs?: number;
    wait?: () => Promise<void>;
    now?: () => number;
  } = {},
) {
  const now = options.now ?? Date.now;
  // New leads are claimed for budgetMs; a claimed lead then gets its own
  // leadBudgetMs, so one claimed late is not cut short and charged an attempt.
  // The call ends within budgetMs + leadBudgetMs, inside the 150s function limit.
  const deadline = now() + (options.budgetMs ?? 40_000);
  const leadBudgetMs = options.leadBudgetMs ?? 60_000;
  const wait = options.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 200)));
  const counts = { done: 0, skipped: 0, error: 0, requeued: 0, messages: 0 };
  while (now() < deadline) {
    const { data, error } = await db.rpc("claim_quo_message_backfill", {
      p_inbox_ids: inboxIds,
    });
    if (error) throw new Error("backfill_claim_failed");
    if (!data) return { ...counts, idle: true };
    const lead = data as BackfillLead;
    const finish = (state: string, messageCount: number | null, reason: string | null) =>
      db.rpc("finish_quo_message_backfill", {
        p_lead_id: lead.leadId,
        p_state: state,
        p_message_count: messageCount,
        p_reason: reason,
      });
    try {
      let checkpoint = createQuoCheckpoint(new Date().toISOString(), [
        lead.customerNumber,
        lead.customerNumber2,
        ...(lead.extraNumbers ?? []),
      ]);
      // Read across every inbox, a number another lead also has cannot be
      // attributed to this one -- the same guard the AI status worker applies.
      if (!lead.inboxMatched) {
        for (const phone of checkpoint.phones) {
          const { data: unique, error: uniqueError } = await db.rpc("lead_ai_phone_is_unique", {
            p_lead_id: lead.leadId,
            p_phone: phone,
          });
          if (uniqueError) throw new Error("identity_check_unavailable");
          if (unique !== true) throw new Error("phone_shared_between_leads");
        }
      }
      const leadDeadline = now() + leadBudgetMs;
      let complete = false;
      while (!complete) {
        if (now() >= leadDeadline) throw new Error("backfill_time_budget");
        const advanced = await advanceQuoCheckpoint(checkpoint, {
          apiKey: quoKey,
          inboxIds: lead.inboxIds,
          signal: AbortSignal.timeout(Math.max(1_000, leadDeadline - now())),
          reserveRequest: wait,
        });
        checkpoint = advanced.checkpoint;
        complete = advanced.complete;
      }
      if (checkpoint.messages.length) {
        const { error: storeError } = await db.rpc("store_quo_messages", {
          p_lead_id: lead.leadId,
          p_messages: checkpoint.messages,
        });
        if (storeError) throw new Error("store_failed");
      }
      await finish("done", checkpoint.messages.length, null);
      counts.done++;
      counts.messages += checkpoint.messages.length;
    } catch (caught) {
      const reason =
        caught instanceof Error &&
        ["phone_shared_between_leads", "backfill_time_budget", "store_failed"].includes(
          caught.message,
        )
          ? caught.message
          : safeAiError(caught);
      if (reason === "phone_shared_between_leads") {
        await finish("skipped", null, reason);
        counts.skipped++;
      } else if (FINAL_ERRORS.has(reason)) {
        await finish("error", null, reason);
        counts.error++;
      } else {
        // Out of time or a temporary provider failure: back in the queue
        // (recorded as an error by the database after three attempts).
        await finish("pending", null, reason);
        counts.requeued++;
      }
    }
  }
  return { ...counts, idle: false };
}
