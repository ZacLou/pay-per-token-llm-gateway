/**
 * Shared React Query configuration.
 *
 * Both rules below exist because a *signed-out* response is not an application
 * failure, and treating it as one broke the dashboard for every visitor without
 * a session:
 *
 *  - A 401 is deterministic, so `retry: 3` re-issued each page's request four
 *    times and logged a console error per attempt. A visitor who simply had not
 *    signed in got a retry storm — seven requests on the home page alone.
 *  - `throwOnError: true` rethrew that 401 into React, where the App Router
 *    error boundary (`app/error.tsx`) rendered "Something went wrong". Every
 *    page already implements an `unauthenticated` ErrorState with a Connect
 *    Wallet CTA (see `components/error-state.tsx`), and the boundary made all of
 *    them unreachable — the console shows the boundary catching
 *    `Gateway error 401: {"message":"Missing session token",…}`.
 *
 * Real failures keep both behaviours: transient errors are still retried, and
 * an unexpected one still surfaces as the error boundary.
 */
import { QueryClient } from '@tanstack/react-query';
import { isUnauthenticatedError } from './api';

/** How many times a transient query failure is retried. */
export const QUERY_RETRY_LIMIT = 3;

/** Retry transient failures; never a deterministic auth failure. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return !isUnauthenticatedError(error) && failureCount < QUERY_RETRY_LIMIT;
}

/** Let pages render their own auth state; keep the boundary for real errors. */
export function shouldThrowQueryError(error: unknown): boolean {
  return !isUnauthenticatedError(error);
}

/** Build a query client with those rules applied to every query. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: shouldRetryQuery,
        throwOnError: shouldThrowQueryError,
      },
    },
  });
}
