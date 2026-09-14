import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

const logger = new Logger('DistributedLock');

/**
 * Cross-instance mutual exclusion for scheduled jobs.
 *
 * The gateway is deployed with more than one replica
 * (`infrastructure/kubernetes/gateway.yaml` runs 2, and its README tells
 * operators to scale by raising that number). NestJS `@Cron` handlers fire in
 * *every* replica at the same wall-clock instant, so anything a scheduled job
 * does must either be idempotent or be elected to a single runner.
 *
 * The payout automation job is neither: two replicas both read the same
 * "pending confirmed revenue" and both propose it through the multisig
 * contract. With a threshold-1 wallet each proposal auto-executes, so the
 * provider is paid twice and the second transfer is uncovered revenue. No
 * per-instance guard (a `private` boolean, an in-memory `Set`) can prevent
 * this — the exclusion has to live outside the process, and Redis is already a
 * hard dependency of the gateway.
 *
 * The claim is a single `SET key <token> NX EX <ttl>`: atomic on the Redis
 * server, so exactly one replica wins. The token makes the lock *releasable
 * only by its owner*, so a slow runner that overran its TTL can never delete
 * the lock a later runner legitimately holds (the compare-and-delete is a Lua
 * script, so the check and the delete cannot be interleaved).
 */
export interface LockHandle {
  key: string;
  /** Unique per acquisition — proof of ownership for the release. */
  token: string;
}

/**
 * Build a namespaced lock key so unrelated jobs cannot collide:
 * `lockKey('payout-propose', providerId)` →
 * `x402:lock:payout-propose:<providerId>`.
 */
export function lockKey(...parts: string[]): string {
  return ['x402', 'lock', ...parts].join(':');
}

/**
 * Outcome of an acquisition attempt. The two failure modes are kept distinct
 * because they call for different operator responses: `held` is normal
 * (`another replica got there first`), `unavailable` means Redis did not
 * answer and the caller is being refused.
 */
export type LockAcquisition =
  { acquired: true; handle: LockHandle } | { acquired: false; reason: 'held' | 'unavailable' };

/**
 * Delete a key only when it still holds `token`. Doing this as a Lua script
 * keeps the GET and the DEL in one atomic step on the server.
 */
const COMPARE_AND_DELETE = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

/**
 * Try to claim `key` for `ttlSeconds`.
 *
 * Never throws: a Redis error is reported as
 * `{ acquired: false, reason: 'unavailable' }` so a caller can fail closed on
 * one clear code path instead of wrapping every call site in a `try`.
 */
export async function tryAcquireLock(
  redis: Redis,
  key: string,
  ttlSeconds: number,
): Promise<LockAcquisition> {
  const handle: LockHandle = { key, token: randomUUID() };

  try {
    const result = await redis.set(key, handle.token, 'EX', ttlSeconds, 'NX');
    return result === 'OK' ? { acquired: true, handle } : { acquired: false, reason: 'held' };
  } catch (error) {
    logger.warn(`Cannot acquire lock ${key} — Redis unavailable: ${String(error)}`);
    return { acquired: false, reason: 'unavailable' };
  }
}

/**
 * Release a held lock. Best-effort: the TTL is the backstop, so a failure here
 * degrades to "the next run waits out the TTL" rather than to a stuck lock.
 */
export async function releaseLock(redis: Redis, handle: LockHandle): Promise<void> {
  try {
    await redis.eval(COMPARE_AND_DELETE, 1, handle.key, handle.token);
  } catch (error) {
    logger.warn(`Failed to release lock ${handle.key}: ${String(error)}`);
  }
}
