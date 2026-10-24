type Change = {
  eventType: string;
  old: Record<string, unknown>;
  new: Record<string, unknown>;
};

function fieldsChanged(change: Change, fields: string[]) {
  // Old rows may contain only the primary key without REPLICA IDENTITY FULL.
  // Missing fields must trigger a refresh rather than silently dropping it.
  return (
    change.eventType !== "UPDATE" ||
    fields.some((field) => !(field in change.old) || change.old[field] !== change.new[field])
  );
}

export function conversationSummaryChanged(change: Change) {
  return fieldsChanged(change, [
    "crisp_website_id",
    "unread_count",
    "last_message",
    "last_customer_unread_at",
  ]);
}

export function workspaceSummaryChanged(change: Change) {
  // Leases, budgets, and presence timestamps never change conversation totals.
  return fieldsChanged(change, ["crisp_website_id", "enabled"]);
}

/** Merge bursts, allow one in-flight read, and retain one trailing refresh. */
export function createCoalescedRefresh(refresh: () => Promise<void>, delayMs = 150) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let pending = false;
  let disposed = false;
  const schedule = () => {
    if (disposed) return;
    pending = true;
    if (running || timer !== undefined) return;
    timer = setTimeout(async () => {
      timer = undefined;
      pending = false;
      running = true;
      try {
        await refresh();
      } catch {
        // Background reads are non-fatal; the heartbeat/next event retries.
      } finally {
        running = false;
        if (pending) schedule();
      }
    }, delayMs);
  };
  return {
    schedule,
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
