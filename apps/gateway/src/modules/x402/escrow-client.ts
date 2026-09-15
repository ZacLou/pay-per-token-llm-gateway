/**
 * Soroban contract client for the credit-escrow contract.
 *
 * Enables per-token metered billing: after each LLM response the gateway
 * charges the actual cost from the caller's escrow balance and auto-refunds
 * any surplus. All contract interactions are best-effort — failures are
 * logged but never block the LLM response from reaching the caller.
 *
 * Requires `CONTRACT_ADMIN_SECRET` and `ESCROW_SETTLEMENT_ENABLED=true`.
 */

import { xdr, Keypair } from '@stellar/stellar-sdk';
import { logger } from '@x402/logger';
import { accountAddressToScVal, amountToScVal, signAndSendContractTx } from './soroban-utils';

// ── Public API ───────────────────────────────

export interface EscrowBalanceOptions {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  user: string;
}

export interface EscrowChargeOptions {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  /** RPC timeout in seconds (passed to the stellar-sdk contract client). */
  timeoutSeconds?: number;
  /** Secret key of the contract admin (signs the invocation). */
  adminSecret: string;
  /** Stellar address of the user whose escrow balance to charge. */
  user: string;
  /** Amount to charge in stroops. */
  amount: string;
  /** Quote ID for idempotency (same quote never charged twice). */
  quoteId: string;
}

export interface EscrowRefundOptions {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  /** RPC timeout in seconds (passed to the stellar-sdk contract client). */
  timeoutSeconds?: number;
  adminSecret: string;
  user: string;
  /** Amount to refund in stroops (the surplus). */
  amount: string;
  /** Quote ID for idempotency (same quote never refunded twice). */
  quoteId: string;
}

export interface EscrowResult {
  success: boolean;
  error?: string;
  /** Hash of the transaction this call submitted, when one was submitted. */
  txHash?: string;
}

/**
 * The on-chain transactions a settlement produced, for persistence/auditing.
 *
 * Either field is absent when its leg did not run: no `chargeTxHash` when the
 * charge failed, and no `refundTxHash` when the caller did not overpay (or the
 * refund failed, which is logged as an error at the call site).
 */
export interface EscrowSettlementResult {
  chargeTxHash?: string;
  refundTxHash?: string;
}

// ── Core Operations ───────────────────────────

async function buildEscrowClient(options: {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
}) {
  // Dynamic import keeps the heavy @stellar/stellar-sdk contract namespace
  // out of the initial module graph until an escrow call is actually needed.
  const { contract } = await import('@stellar/stellar-sdk');
  const { Client } = contract;
  return Client.from({
    contractId: options.contractId,
    rpcUrl: options.rpcUrl,
    networkPassphrase: options.networkPassphrase,
  });
}

/**
 * Read a user's prepaid escrow balance.
 *
 * Returns the balance in stroops, or `null` if the contract call fails
 * (e.g. contract not initialized, network unreachable). Read-only and
 * permissionless, so no admin signer is required.
 */
export async function getEscrowBalance(options: EscrowBalanceOptions): Promise<string | null> {
  const { contractId, rpcUrl, networkPassphrase, user } = options;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = await buildEscrowClient({ contractId, rpcUrl, networkPassphrase });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = await client.balance({ user: accountAddressToScVal(user) });

    // In stellar-sdk 16 a read call resolves to an `AssembledTransaction`, and
    // the decoded contract return value (here an i128) is exposed as
    // `.result`. Passing the transaction object itself to the parser used to
    // coerce every funded escrow to `0`, so each escrow-funded request was
    // rejected as "balance insufficient: 0 < <quote>" — the feature looked
    // wired but could never serve a request.
    const balance = i128ToString(tx?.result);

    logger.info('[escrow] Balance read', {
      user: user.slice(0, 8),
      balance,
    });
    return balance;
  } catch (err) {
    const message = (err as Error).message;
    logger.warn(
      `[escrow] getEscrowBalance failed for user ${user.slice(0, 8)}... — ` +
        `treating balance as unavailable. Error: ${message}`,
    );
    return null;
  }
}

/**
 * Charge a user's escrow balance for actual LLM usage.
 *
 * Idempotent per (user, quoteId): the contract's `charge()` function uses a
 * `(CHARGED, user, quote_id)` guard so a retried settlement call can never
 * double-deduct.
 */
export async function chargeEscrow(options: EscrowChargeOptions): Promise<EscrowResult> {
  const { contractId, rpcUrl, networkPassphrase, adminSecret, user, amount, quoteId } = options;

  try {
    const adminKeypair = Keypair.fromSecret(adminSecret);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { contract } = await import('@stellar/stellar-sdk');
    const { Client } = contract;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = await Client.from({
      contractId,
      rpcUrl,
      networkPassphrase,
      // The SDK builds the invocation against this account and takes the
      // sequence number from it. Omit it and `getAccount` falls back to
      // `new Account(NULL_ACCOUNT, '0')`, so the transaction is submitted from
      // an all-zero source with sequence 1 and every call is rejected
      // (`txBadSeq`). It must be the account that signs.
      publicKey: adminKeypair.publicKey(),
      ...(options.timeoutSeconds ? { timeout: options.timeoutSeconds } : {}),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = await client.charge({
      user: accountAddressToScVal(user),
      amount: amountToScVal(amount),
      quote_id: xdr.ScVal.scvString(quoteId),
    });

    const txHash = await signAndSendContractTx(tx, adminKeypair, networkPassphrase);

    logger.info('[escrow] Charge settled on-chain', {
      user: user.slice(0, 8),
      amount,
      quoteId: quoteId.slice(0, 8),
      txHash,
    });
    return { success: true, txHash };
  } catch (err) {
    // Best-effort: escrow settlement must never block the LLM response.
    const message = (err as Error).message;
    logger.warn(
      `[escrow] chargeEscrow failed for user ${user.slice(0, 8)}... — ` +
        `skipping on-chain settlement. Error: ${message}`,
    );
    return { success: false, error: message };
  }
}

/**
 * Refund a surplus back to a user's escrow balance.
 *
 * Idempotent per (user, quoteId): the contract's `refund()` function uses a
 * `(REFUNDED, user, quote_id)` guard so a retried refund can never double-pay.
 */
export async function refundEscrow(options: EscrowRefundOptions): Promise<EscrowResult> {
  const { contractId, rpcUrl, networkPassphrase, adminSecret, user, amount, quoteId } = options;

  try {
    const adminKeypair = Keypair.fromSecret(adminSecret);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { contract } = await import('@stellar/stellar-sdk');
    const { Client } = contract;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = await Client.from({
      contractId,
      rpcUrl,
      networkPassphrase,
      // See chargeEscrow: without this the invocation is built against the
      // null account and the network rejects it with `txBadSeq`.
      publicKey: adminKeypair.publicKey(),
      ...(options.timeoutSeconds ? { timeout: options.timeoutSeconds } : {}),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = await client.refund({
      user: accountAddressToScVal(user),
      amount: amountToScVal(amount),
      quote_id: xdr.ScVal.scvString(quoteId),
    });

    const txHash = await signAndSendContractTx(tx, adminKeypair, networkPassphrase);

    logger.info('[escrow] Refund settled on-chain', {
      user: user.slice(0, 8),
      amount,
      quoteId: quoteId.slice(0, 8),
      txHash,
    });
    return { success: true, txHash };
  } catch (err) {
    const message = (err as Error).message;
    logger.warn(
      `[escrow] refundEscrow failed for user ${user.slice(0, 8)}... — ` +
        `skipping on-chain refund. Error: ${message}`,
    );
    return { success: false, error: message };
  }
}

/**
 * Full settlement: charge actual cost from escrow, then refund any surplus.
 *
 * This is the high-level entry point wired into `applyMeteredPricing()`. It
 * gates on `escrowSettlementEnabled` and `contractAdminSecret` — if either is
 * missing the call is a silent no-op so the feature can be configured but not
 * active in every deployment.
 */
export async function settleEscrow(options: {
  enabled: boolean;
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  adminSecret?: string;
  user: string;
  actualCost: string;
  surplus: string;
  isOverpaid: boolean;
  quoteId: string;
}): Promise<EscrowSettlementResult> {
  // Callers persist the returned hashes so the settlement is auditable from
  // the database, not only from the gateway log.
  if (!options.enabled || !options.adminSecret) return {};

  const {
    contractId,
    rpcUrl,
    networkPassphrase,
    adminSecret,
    user,
    actualCost,
    surplus,
    isOverpaid,
    quoteId,
  } = options;

  // Charge the actual cost from the user's escrow balance.
  // Idempotent — retrying the same quote never double-charges.
  const chargeResult = await chargeEscrow({
    contractId,
    rpcUrl,
    networkPassphrase,
    adminSecret,
    user,
    amount: actualCost,
    quoteId,
  });

  if (!chargeResult.success) {
    logger.warn('[escrow] Charge failed, skipping refund', {
      user: user.slice(0, 8),
      actualCost,
      error: chargeResult.error,
    });
    return {};
  }

  const settlement: EscrowSettlementResult = { chargeTxHash: chargeResult.txHash };

  // Refund surplus when the caller overpaid (per-token deposit > actual cost).
  if (isOverpaid && BigInt(surplus) > 0n) {
    const refundResult = await refundEscrow({
      contractId,
      rpcUrl,
      networkPassphrase,
      adminSecret,
      user,
      amount: surplus,
      quoteId,
    });
    if (refundResult.success) {
      settlement.refundTxHash = refundResult.txHash;
    } else {
      // The charge already debited the caller by the full draw, so an
      // unrefunded surplus is the caller's money stranded in the contract.
      // Surface it as an error so it is alertable, not buried in a warning.
      logger.error('[escrow] Surplus refund failed — caller overcharged', {
        user: user.slice(0, 8),
        surplus,
        quoteId: quoteId.slice(0, 8),
        error: refundResult.error,
      });
    }
  }

  return settlement;
}

// ── Helpers ───────────────────────────────────

/**
 * Convert an i128 result (as decoded by the Stellar SDK contract client) into
 * a decimal string.
 *
 * The SDK returns a plain bigint when the value fits in 64 bits and an object
 * with `lo`/`hi` bigint parts when it does not. We handle both.
 *
 * Fail closed: an unrecognised shape must throw, never coerce. The previous
 * implementation read `obj.lo ?? 0n` / `obj.hi ?? 0n`, so any object without
 * those fields (including the assembled transaction the read call actually
 * returns) silently became `0` — indistinguishable from a genuinely empty
 * escrow account, and wrong in the direction that denies service.
 */
function i128ToString(value: unknown): string {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value && typeof value === 'object') {
    const obj = value as { lo?: unknown; hi?: unknown };
    if (typeof obj.lo === 'bigint' && typeof obj.hi === 'bigint') {
      return ((obj.hi << 64n) + obj.lo).toString();
    }
  }
  const shape = value && typeof value === 'object' ? Object.keys(value).join(',') : typeof value;
  throw new Error(`Unexpected escrow balance result shape: ${shape}`);
}
