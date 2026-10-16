import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { handleAuthExpired, isAuthExpiredError } from "./lib/auth-errors";

export const getRouter = () => {
  const queryClient = new QueryClient({
    // A stale session makes every protected server function answer 500, and the
    // app shell keeps polling, so the failure reaches the error boundary and
    // blanks the page. One sign-in prompt replaces that; other query errors
    // still surface to the component that made them.
    queryCache: new QueryCache({
      onError: (error) => {
        if (isAuthExpiredError(error)) handleAuthExpired();
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        if (isAuthExpiredError(error)) handleAuthExpired();
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        gcTime: 10 * 60_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        retry: 1,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // Preload on hover so heavy lazy chunks (Raw Leads, CS, Analytics) start
    // downloading before the user clicks — makes route switches feel instant.
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
  });

  return router;
};
