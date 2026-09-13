-- The `Wallet` and `PrepaidCredit` models were never read or written by any
-- gateway, dashboard, or SDK code. Escrow balances live on-chain in the
-- credit-escrow Soroban contract (read via `getEscrowBalance()`), so the
-- off-chain mirror was dead schema that would only drift. Drop both tables
-- (PrepaidCredit first — it holds the foreign key to Wallet).

-- DropForeignKey
ALTER TABLE IF EXISTS "PrepaidCredit" DROP CONSTRAINT IF EXISTS "PrepaidCredit_walletId_fkey";
ALTER TABLE IF EXISTS "PrepaidCredit" DROP CONSTRAINT IF EXISTS "PrepaidCredit_providerId_fkey";

-- DropTable
DROP TABLE IF EXISTS "PrepaidCredit";

-- DropTable
DROP TABLE IF EXISTS "Wallet";
