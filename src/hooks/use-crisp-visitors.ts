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
const CRISP_VISITORS_QUERY_KEY = ["crisp-visitor-overview"] as const;
const CRISP_VISITORS_REFETCH_MS = 4_000;

export function useCrispVisitors(enabled = true) {
  return useQuery({
    queryKey: CRISP_VISITORS_QUERY_KEY,
    queryFn: async () => getCrispVisitorOverview({ data: {} }),
    enabled,
    // Keep staleTime just under the poll interval so background remounts reuse
    // the cached snapshot instead of kicking off an extra fetch.
    staleTime: CRISP_VISITORS_REFETCH_MS - 500,
    refetchInterval: CRISP_VISITORS_REFETCH_MS,
    // Don't hammer the Crisp API while the browser tab is hidden — the next
    // refetch on focus (refetchOnWindowFocus) catches the operator up instantly.
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    // A 4s cadence already retries constantly; an extra retry on failure just
    // doubles the request rate against Crisp, so let the next tick recover.
    retry: false,
    placeholderData: EMPTY_OVERVIEW,
  });
}
