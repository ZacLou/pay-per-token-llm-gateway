-- Credit-escrow settlement transactions.
--
-- `Payment.txHash` names the payment (or the synthetic `escrow:<quoteId>` for
-- an escrow draw). These columns name the on-chain settlement that follows it:
-- `settlementTxHash` is the `charge` transaction for the metered actual cost,
-- and `refundTxHash` is the `refund` of any unused surplus. Both are NULL for
-- per-request payments, which settle inside the payment transfer itself.

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "settlementTxHash" TEXT;
ALTER TABLE "Payment" ADD COLUMN "refundTxHash" TEXT;

-- CreateIndex
CREATE INDEX "Payment_settlementTxHash_idx" ON "Payment"("settlementTxHash");
