// Author: RawNuke
// Copyright (c) 2026 RawNuke. All rights reserved.

import { Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@x402/database';
import { logger } from '@x402/logger';
import { quoteIdPrefixFromMemo } from '@x402/x402-core';
import type {
  Quote,
  PaymentVerification,
  PaymentReceipt,
  RouteConfig,
  PaymentRecord,
} from '@x402/types';

/** Serialized payment response with amount as string (for JSON-safe responses) */
export interface PaymentResponse {
  id: string;
  quoteId: string;
  txHash: string | null;
  payerAddress: string | null;
  amount: string;
  asset: string;
  status: string;
  verifiedAt: Date | null;
  routeId: string;
  providerId: string;
  createdAt: Date;
}

@Injectable()
export class PaymentsService {
  /**
   * Create a pending payment record when a quote is generated.
   */
  async createPendingPayment(quote: Quote, route: RouteConfig): Promise<void> {
    await prisma.payment.create({
      data: {
        quoteId: quote.id,
        routeId: route.id,
        providerId: route.providerId,
        txHash: null,
        payerAddress: null,
        amount: BigInt(quote.amount),
        asset: quote.asset,
        status: 'pending',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        receiptJson: quote as any,
      },
    });

    logger.info('Pending payment created', { quoteId: quote.id });
  }

  /**
   * Atomically confirm a payment after successful verification.
   *
   * Single-use guarantee: the update only touches rows that are still
   * un-consumed (`txHash IS NULL`) AND the schema enforces a partial unique
   * index on `Payment.txHash`. Concurrent requests for the same transaction
   * hash race here — exactly one claim wins; losers receive `null` and must
   * reject the request as a replay.
   *
   * Returns the receipt when THIS caller won the claim, or `null` when the
   * quote/hash was already consumed by another request.
   */
  async confirmPayment(
    quoteId: string,
    verification: PaymentVerification,
  ): Promise<PaymentReceipt | null> {
    const receipt: PaymentReceipt = {
      id: quoteId,
      quoteId,
      txHash: verification.txHash,
      payerAddress: verification.payerAddress,
      amount: verification.amount,
      asset: verification.asset,
      route: '', // resolved from the payment's route before the claim
      status: 'confirmed',
      verifiedAt: new Date(verification.timestamp * 1000).toISOString(),
      ledger: verification.ledger,
    };

    // Resolve the route path from the pending payment before the claim.
    const payment = await prisma.payment.findFirst({
      where: { quoteId },
      include: { route: true },
    });

    if (!payment) {
      // The row never existed — this caller lost the claim.
      logger.warn('Payment claim lost (payment not found)', { quoteId });
      return null;
    }

    receipt.route = payment.route?.path ?? '';

    try {
      const result = await prisma.payment.updateMany({
        where: { quoteId, txHash: null },
        data: {
          txHash: verification.txHash,
          payerAddress: verification.payerAddress,
          status: 'confirmed',
          verifiedAt: new Date(verification.timestamp * 1000),
          ledger: verification.ledger,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          receiptJson: receipt as any,
        },
      });

      if (result.count === 0) {
        // Already consumed (or the row never existed) — this caller lost the claim.
        logger.warn('Payment claim lost (already consumed)', {
          quoteId,
          txHash: verification.txHash,
        });
        return null;
      }

      logger.info('Payment confirmed', { quoteId, txHash: verification.txHash });
      return receipt;
    } catch (error) {
      // A unique-constraint violation on Payment.txHash means a concurrent
      // request claimed this hash first — single-use holds.
      const message = String(error instanceof Error ? error.message : error);
      if (/unique|constraint|duplicate/i.test(message)) {
        logger.warn('Payment claim lost (concurrent unique violation)', {
          quoteId,
          txHash: verification.txHash,
        });
        return null;
      }
      throw error;
    }
  }

  /**
   * Find a payment by quote ID.
   */
  async findByQuoteId(quoteId: string): Promise<PaymentRecord | null> {
    return prisma.payment.findFirst({ where: { quoteId } });
  }

  /**
   * Find a payment by transaction hash.
   */
  async findByTxHash(txHash: string): Promise<PaymentRecord | null> {
    return prisma.payment.findFirst({
      where: { txHash },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Find the still-pending quote behind an on-chain payment, using the
   * transaction's memo.
   *
   * A first-time payment has no row carrying its hash yet — the quote's
   * `Payment` row is still `pending` with `txHash = NULL`. The quote memo is
   * derived deterministically from the quote id, so re-inserting the UUID
   * dashes turns the memo into a `quoteId` prefix. Scoping to the requested
   * route and to `txHash IS NULL` guarantees we only ever bind a payment to
   * an unconsumed quote on the route it paid for.
   */
  async findPendingByQuoteMemo(memo: string, routeId: string): Promise<PaymentRecord | null> {
    const prefix = quoteIdPrefixFromMemo(memo);
    if (!prefix) return null;

    return prisma.payment.findFirst({
      where: { routeId, status: 'pending', txHash: null, quoteId: { startsWith: prefix } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Find all payments belonging to the authenticated wallet's providers,
   * with pagination and filtering. Payments whose provider is not owned by
   * the caller are never returned (cross-tenant isolation).
   */
  async findAll(
    options: {
      providerId?: string;
      status?: string;
      payerAddress?: string;
      page?: number;
      limit?: number;
    } = {},
    ownerAddress: string,
  ): Promise<{
    data: PaymentResponse[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = options.page || 1;
    const limit = options.limit || 20;
    const { providerId, status, payerAddress } = options;

    // Only payments flowing to providers owned by the authenticated wallet.
    // Note: unlike getStats (which 404s on foreign providers), a foreign
    // providerId filter here silently returns an empty page — both are
    // leak-free, the difference is deliberate.
    const where: Record<string, unknown> = {
      provider: { walletAddress: ownerAddress },
    };
    if (providerId) where.providerId = providerId;
    if (status) where.status = status;
    if (payerAddress) where.payerAddress = payerAddress;

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.payment.count({ where }),
    ]);

    // Serialize BigInt amounts to strings for JSON response
    const serialized: PaymentResponse[] = payments.map((p: PaymentRecord) => ({
      id: p.id,
      quoteId: p.quoteId,
      txHash: p.txHash,
      payerAddress: p.payerAddress,
      amount: p.amount.toString(),
      asset: p.asset,
      status: p.status,
      verifiedAt: p.verifiedAt,
      routeId: p.routeId,
      providerId: p.providerId,
      createdAt: p.createdAt,
    }));

    return {
      data: serialized,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Record the actual per-token cost after the LLM response.
   * For flat-rate routes this is a no-op (amount matches the quote).
   * For per-token routes this updates the receipt with actual cost and token count.
   */
  async recordActualCost(quoteId: string, actualCost: string, tokensUsed: number): Promise<void> {
    const payment = await prisma.payment.findFirst({ where: { quoteId } });
    if (!payment) return;

    const receiptJson = (payment.receiptJson as Record<string, unknown>) || {};
    const updatedReceipt = {
      ...receiptJson,
      actualCost,
      tokensUsed,
    };

    await prisma.payment.updateMany({
      where: { quoteId },
      data: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        receiptJson: updatedReceipt as any,
      },
    });

    logger.info('Actual cost recorded', {
      quoteId,
      actualCost,
      tokensUsed,
      paidAmount: payment.amount.toString(),
    });
  }

  /**
   * Record the on-chain escrow settlement transactions for a quote.
   *
   * `Payment.txHash` names the payment — for an escrow draw that is the
   * synthetic `escrow:<quoteId>`. These columns name the settlement that
   * followed it: the `charge` for the metered actual cost and the `refund` of
   * any unused surplus. Without them a settlement is traceable only from the
   * gateway log, which is not auditable after a log rotation.
   *
   * Best-effort: the LLM response has already been delivered and the funds have
   * already moved, so a bookkeeping failure must never propagate.
   */
  async recordEscrowSettlement(
    quoteId: string,
    settlement: { chargeTxHash?: string; refundTxHash?: string },
  ): Promise<void> {
    const data: { settlementTxHash?: string; refundTxHash?: string } = {};
    if (settlement.chargeTxHash) data.settlementTxHash = settlement.chargeTxHash;
    if (settlement.refundTxHash) data.refundTxHash = settlement.refundTxHash;
    // Nothing settled on-chain (settlement disabled, or the charge failed).
    if (Object.keys(data).length === 0) return;

    try {
      await prisma.payment.updateMany({ where: { quoteId }, data });
      logger.info('Escrow settlement recorded', { quoteId, ...data });
    } catch (err) {
      logger.warn(
        `Failed to record escrow settlement for quote ${quoteId} — ` +
          `Error: ${(err as Error).message}`,
      );
    }
  }

  // ── Underpayment debt ledger (per-token enforcement) ─

  /**
   * Record an underpayment deficit as open debt for a payer on a provider.
   *
   * Idempotent per quote: the schema enforces a unique `quoteId`, so a
   * retried/racing settlement can never double-count the same deficit.
   * Best-effort by design — accounting must never break the response path.
   */
  async recordUnderpaymentDebt(data: {
    quoteId: string;
    providerId: string;
    routeId: string;
    payerAddress: string;
    /** Deficit in stroops (actual cost − deposit). */
    amount: string;
  }): Promise<void> {
    const deficit = BigInt(data.amount);
    if (deficit <= 0n) return;

    try {
      await prisma.underpaymentDebt.create({
        data: {
          quoteId: data.quoteId,
          providerId: data.providerId,
          routeId: data.routeId,
          payerAddress: data.payerAddress,
          amount: deficit,
          status: 'open',
        },
      });
      logger.warn('Underpayment debt recorded', {
        quoteId: data.quoteId,
        providerId: data.providerId,
        payerAddress: data.payerAddress,
        amount: data.amount,
      });
    } catch (error) {
      // A unique violation means this quote's deficit is already recorded.
      logger.warn('Failed to record underpayment debt (possible duplicate quote)', {
        quoteId: data.quoteId,
        error: String(error),
      });
    }
  }

  /**
   * Total outstanding underpayment debt for a payer on a provider (stroops).
   */
  async getOpenDebtTotal(payerAddress: string, providerId: string): Promise<bigint> {
    const result = await prisma.underpaymentDebt.aggregate({
      where: { payerAddress, providerId, status: 'open' },
      _sum: { amount: true },
    });
    return result._sum.amount ?? 0n;
  }

  /**
   * Clear all open debt for a payer on a provider.
   *
   * Called when a verified on-chain payment covers the current deposit PLUS
   * the outstanding debt — the surplus over the deposit is the repayment.
   */
  async settleUnderpaymentDebts(payerAddress: string, providerId: string): Promise<number> {
    const result = await prisma.underpaymentDebt.updateMany({
      where: { payerAddress, providerId, status: 'open' },
      data: { status: 'settled', settledAt: new Date() },
    });
    if (result.count > 0) {
      logger.info('Underpayment debt settled', {
        payerAddress,
        providerId,
        count: result.count,
      });
    }
    return result.count;
  }

  /**
   * Get payment statistics for a provider owned by the authenticated wallet.
   */
  async getStats(providerId: string, ownerAddress: string) {
    // Ownership check first — statistics about another wallet's provider are
    // never exposed (and provider IDs can't be probed).
    const provider = await prisma.provider.findFirst({
      where: { id: providerId, walletAddress: ownerAddress },
    });
    if (!provider) throw new NotFoundException(`Provider ${providerId} not found`);

    const [confirmed, total, totalRevenue] = await Promise.all([
      prisma.payment.count({ where: { providerId, status: 'confirmed' } }),
      prisma.payment.count({ where: { providerId } }),
      prisma.payment.aggregate({
        where: { providerId, status: 'confirmed' },
        _sum: { amount: true },
      }),
    ]);

    return {
      totalPayments: total,
      confirmedPayments: confirmed,
      failedPayments: total - confirmed,
      totalRevenue: totalRevenue._sum.amount?.toString() || '0',
    };
  }
}
