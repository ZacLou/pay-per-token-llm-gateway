// ──────────────────────────────────────────────
// @x402/database — Prisma client and helpers
// ──────────────────────────────────────────────

import { PrismaClient } from '@prisma/client';

/** Singleton Prisma client */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export { Prisma } from '@prisma/client';
export type { PrismaClient } from '@prisma/client';

/**
 * `PayoutProposal.status` values that count as revenue already spoken for.
 *
 * A provider's pending payout amount is confirmed revenue MINUS every
 * proposal that is in flight or already paid. Counting only `executed`
 * proposals would re-propose the same revenue on every daily run while an
 * M-of-N proposal is still awaiting signer approvals — and if two proposals
 * for the same revenue both reached quorum the provider would be paid twice.
 * Only `failed`/`cancelled` proposals release their reservation.
 */
export const PAYOUT_RESERVING_STATUSES = ['pending', 'proposed', 'approved', 'executed'] as const;
