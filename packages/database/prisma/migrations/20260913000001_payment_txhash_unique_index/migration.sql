-- Reconcile the Payment single-use constraint with the Prisma schema.
--
-- Migration 20260811000000 enforced single-use with a PARTIAL unique index
-- ("Payment_txHash_unique_key" ... WHERE "txHash" IS NOT NULL). Postgres
-- already treats NULLs as distinct in a regular unique index, so the partial
-- predicate adds nothing — but Prisma cannot represent a partial index in
-- `schema.prisma`, which left `prisma migrate diff` permanently reporting
-- drift: the declared `@@unique([txHash])` was never materialised under its
-- canonical name, and `prisma db push` (the quickstart path) created a
-- different index than `prisma migrate deploy`.
--
-- Replace the partial index with the canonical full unique index so both
-- setup paths produce the same database and a clean `migrate deploy`
-- reproduces the declared schema exactly. The single-use invariant (at most
-- one confirmed payment per transaction hash) is unchanged.

DROP INDEX IF EXISTS "Payment_txHash_unique_key";

CREATE UNIQUE INDEX IF NOT EXISTS "Payment_txHash_key" ON "Payment"("txHash");
