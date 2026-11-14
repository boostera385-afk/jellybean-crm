import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useAuth } from "@/hooks/use-auth";
import { queryLeadExplorer } from "@/lib/lead-explorer.functions";
import {
  canExplore,
  type ExplorerCursor,
  type ExplorerFilters,
  type ExplorerGroup,
  type ExplorerRequest,
} from "@/lib/lead-explorer";

export function useExplorerQuery(
  action: Exclude<ExplorerRequest["action"], "results">,
  group: ExplorerGroup,
  path: string[],
  filters: ExplorerFilters,
  enabled = true,
  leadId: string | null = null,
) {
  const request = useServerFn(queryLeadExplorer);
  const auth = useAuth();
  return useQuery({
    queryKey: ["lead-explorer", auth.user?.id, action, group, path, filters, leadId],
    queryFn: () => request({ data: { action, group, path, filters, leadId, cursor: null } }),
    enabled: enabled && canExplore(auth.primaryRole),
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: 1,
  });
}

export function useExplorerResults(group: ExplorerGroup, path: string[], filters: ExplorerFilters) {
  const request = useServerFn(queryLeadExplorer);
  const auth = useAuth();
  return useInfiniteQuery({
    queryKey: ["lead-explorer", auth.user?.id, "results", group, path, filters],
    initialPageParam: null as ExplorerCursor | null,
    queryFn: async ({ pageParam }) => {
      const response = await request({
        data: { action: "results", group, path, filters, cursor: pageParam, leadId: null },
      });
      if (response.action !== "results") throw new Error("Invalid explorer response");
      return response.value;
    },
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled: canExplore(auth.primaryRole),
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: 1,
  });
}
