/** @jest-environment node */

import { GatewayRequestError } from './api';
import {
  createQueryClient,
  shouldRetryQuery,
  shouldThrowQueryError,
  QUERY_RETRY_LIMIT,
} from './query-client';

const authError = new GatewayRequestError(401, '{"message":"Missing session token"}');
const serverError = new GatewayRequestError(500, 'boom');

describe('query client auth-vs-failure rules', () => {
  it('never retries a 401 — it can only fail the same way again', () => {
    // Retrying re-issued every page's request four times and logged a console
    // error per attempt, turning "not signed in" into a retry storm.
    expect(shouldRetryQuery(0, authError)).toBe(false);
    expect(shouldRetryQuery(QUERY_RETRY_LIMIT, authError)).toBe(false);
  });

  it('still retries transient failures, up to the limit', () => {
    expect(shouldRetryQuery(0, serverError)).toBe(true);
    expect(shouldRetryQuery(QUERY_RETRY_LIMIT - 1, serverError)).toBe(true);
    expect(shouldRetryQuery(QUERY_RETRY_LIMIT, serverError)).toBe(false);
    expect(shouldRetryQuery(0, new Error('network down'))).toBe(true);
  });

  it('does not throw a 401 into React, so pages render their Connect Wallet state', () => {
    // `throwOnError: true` sent this to app/error.tsx ("Something went wrong"),
    // which made the `unauthenticated` ErrorState every page already has
    // unreachable for a signed-out visitor.
    expect(shouldThrowQueryError(authError)).toBe(false);
  });

  it('still lets unexpected failures reach the error boundary', () => {
    expect(shouldThrowQueryError(serverError)).toBe(true);
    expect(shouldThrowQueryError(new Error('boom'))).toBe(true);
  });

  it('wires those rules into every query of the client it builds', () => {
    const defaults = createQueryClient().getDefaultOptions().queries;

    expect(defaults?.retry).toBe(shouldRetryQuery);
    expect(defaults?.throwOnError).toBe(shouldThrowQueryError);
  });
});
