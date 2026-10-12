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

export function useCrispVisitors(enabled = true) {
  return useQuery({
    queryKey: ["crisp-visitor-overview"],
    queryFn: async () => getCrispVisitorOverview({ data: {} }),
    enabled,
    staleTime: 5_000,
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    retry: 1,
    placeholderData: EMPTY_OVERVIEW,
  });
}
