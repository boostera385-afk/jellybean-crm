import { useQuery } from "@tanstack/react-query";

import { getCrispVisitorOverview, type CrispVisitorOverview } from "@/lib/crisp.functions";

const EMPTY_OVERVIEW: CrispVisitorOverview = {
  ok: true,
  liveVisitors: [],
  todayVisitors: [],
  liveCount: 0,
  activeCount: 0,
  todayCount: 0,
  limited: false,
  fetchedAt: "",
};

// Single shared query key so every consumer (the chat rail, the header alerts,
// the message notifier) reads from ONE polling loop instead of each firing its
// own request. React Query dedupes by key, so mounting the hook in several
// places still results in just one fetch every refetch interval.
export const CRISP_VISITORS_QUERY_KEY = ["crisp-visitor-overview"] as const;
// Live-visitor changes are pushed over Supabase Realtime (see CrispVisitorAlerts),
// so this interval is only a safety net for when the realtime channel drops.
// Queries also refresh on focus/reconnection. Kept short so a dropped channel
// still recovers quickly; this reads Supabase only; it never calls Crisp or
// sends greetings, even if the worker is unavailable.
const CRISP_VISITORS_REFETCH_MS = 10_000;

export function useCrispVisitors(enabled = true) {
  return useQuery({
    queryKey: CRISP_VISITORS_QUERY_KEY,
    queryFn: async () => getCrispVisitorOverview({ data: {} }),
    enabled,
    // Short staleTime so a realtime-triggered invalidation always refetches.
    staleTime: 2_000,
    refetchInterval: CRISP_VISITORS_REFETCH_MS,
    // Don't poll while the browser tab is hidden — the next refetch on focus
    // (refetchOnWindowFocus) catches the operator up instantly.
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    // The interval/focus refresh recovers a failed database read.
    retry: false,
    placeholderData: EMPTY_OVERVIEW,
  });
}
