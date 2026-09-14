import { lockKey } from '../../common/distributed-lock';

/**
 * The lock that serialises "read pending revenue → reserve it → propose it"
 * for a single provider.
 *
 * Two places write payout proposals, and both can run more than once:
 *
 * - `PayoutsService` on a daily `@Cron`, which NestJS fires in **every**
 *   replica, so on a multi-replica deployment N instances reach the loop at
 *   the same instant;
 * - `AdminService.proposePayout`, reachable from the admin API, where a
 *   double-submitted or client-retried request performs the same
 *   read-modify-write twice.
 *
 * Pending revenue is `sum(confirmed payments) − sum(reserving proposals)`, and
 * the write that reserves it lands several awaited steps after the read — a
 * Soroban round-trip away. Without exclusion both writers observe the same
 * `alreadyReserved`, both propose the full balance, and a threshold-1 multisig
 * wallet executes both transfers.
 *
 * The key is per provider rather than per run so the two callers exclude each
 * other (they are not aware of one another otherwise), while unrelated
 * providers stay fully independent.
 */
export function payoutProposeLockKey(providerId: string): string {
  return lockKey('payout-propose', providerId);
}

/**
 * TTL for {@link payoutProposeLockKey}. It only has to outlive one proposal
 * round-trip — a couple of indexed reads plus one Soroban call that carries its
 * own timeout. The TTL is the backstop that frees the lock if the holder dies
 * before its `finally` runs.
 */
export const PAYOUT_LOCK_TTL_SECONDS = 120;
