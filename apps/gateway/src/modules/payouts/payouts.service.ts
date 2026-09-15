import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import type { Redis } from 'ioredis';
import { PAYOUT_RESERVING_STATUSES, type PrismaClient } from '@x402/database';
import { getConfig } from '@x402/config';
import { proposeMultisig, approveMultisig, getMultisigConfig } from '../x402/multisig-client';
import { releaseLock, tryAcquireLock } from '../../common/distributed-lock';
import { PAYOUT_LOCK_TTL_SECONDS, payoutProposeLockKey } from '../x402/payout-lock';

/** Minimal provider shape the payout loop needs. */
interface PayoutProvider {
  id: string;
  name: string;
  active: boolean;
  payoutWalletAddress: string | null;
}

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    @Inject('REDIS') private readonly redis: Redis,
  ) {}

  /**
   * Daily automated payout: for every APPROVED, active provider with a valid
   * payout wallet and pending confirmed revenue, propose a multisig payout
   * on-chain and record it in the `PayoutProposal` ledger.
   *
   * Approval is modelled by `Provider.active`. When
   * PROVIDER_APPROVAL_REQUIRED=true new providers are created inactive and
   * must be admin-approved (`POST /providers/:id/approve`) before they can
   * serve traffic — the same gate must also block their payouts, so only
   * `active: true` providers are ever paid.
   *
   * Pending revenue = sum(confirmed payments) − sum(executed payout proposals).
   * Only providers with net pending revenue above zero are proposed.
   *
   * `@Cron` fires in EVERY replica, so on a multi-replica deployment all of
   * them run this loop at the same midnight instant, and each one reads the
   * same pending revenue. Proposing is not idempotent, so the loop must not be
   * allowed to double-propose; `proposePayoutForProvider` takes a
   * per-provider lock for the duration of its read→reserve→propose sequence.
   * The reported `PAYOUT_RESERVING_STATUSES` sum only serialises runs
   * *within* one process — it cannot see another instance's in-flight
   * proposal until that instance has committed its row.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleDailyPayouts() {
    const config = getConfig();

    if (!config.payment.payoutAutomationEnabled) {
      this.logger.warn('Skipping payouts: PAYOUT_AUTOMATION_ENABLED is false.');
      return;
    }

    if (!config.payment.contractAdminSecret || !config.contracts.multisig) {
      this.logger.warn('Skipping payouts: Multisig contract or admin secret not configured.');
      return;
    }

    this.logger.log('Starting daily payout automation...');

    try {
      // Only approved (active) providers with a payout wallet are eligible.
      const providers = (await this.prisma.provider.findMany({
        where: {
          payoutWalletAddress: { not: null },
          active: true,
        },
      })) as unknown as PayoutProvider[];

      for (const provider of providers) {
        // Defense in depth: re-check the approval flag even though the query
        // already filters on it (a provider may be deactivated mid-loop).
        if (!provider.active) {
          this.logger.warn(`Skipping payout for inactive provider ${provider.name}`, {
            providerId: provider.id,
          });
          continue;
        }

        if (!provider.payoutWalletAddress) continue;

        // Never propose a payout to a malformed address — a single wrong
        // character would send funds to a non-existent account.
        if (!StrKey.isValidEd25519PublicKey(provider.payoutWalletAddress)) {
          this.logger.error(`Skipping payout for ${provider.name}: invalid payout wallet address`, {
            providerId: provider.id,
          });
          continue;
        }

        try {
          await this.proposePayoutForProvider(
            provider.id,
            provider.payoutWalletAddress,
            provider.name,
          );
        } catch (error) {
          this.logger.error(`Error proposing payout for ${provider.name}`, {
            providerId: provider.id,
            error: (error as Error).message,
          });
        }
      }
    } catch (error) {
      this.logger.error(`Error during payout automation: ${(error as Error).message}`);
    }
  }

  /**
   * Compute pending confirmed revenue and propose a payout if positive.
   *
   * Pending = total confirmed payment amount − total amount already covered
   * by executed payout proposals for this provider.
   */
  private async proposePayoutForProvider(
    providerId: string,
    payoutWalletAddress: string,
    providerName: string,
  ): Promise<void> {
    const config = getConfig();

    // Authorization gate at proposal time: the provider must still be active
    // and its payout wallet must be the same valid address that was approved.
    // Without this, a deactivated provider (or one whose payout wallet was
    // cleared) could still be paid from stale state.
    const current = await this.prisma.provider.findUnique({
      where: { id: providerId },
      select: { active: true, payoutWalletAddress: true },
    });
    if (!current?.active) {
      this.logger.warn(`Skipping payout for provider ${providerName}: not approved/active`, {
        providerId,
      });
      return;
    }
    if (
      !current.payoutWalletAddress ||
      current.payoutWalletAddress !== payoutWalletAddress ||
      !StrKey.isValidEd25519PublicKey(current.payoutWalletAddress)
    ) {
      this.logger.warn(
        `Skipping payout for provider ${providerName}: payout wallet changed or invalid`,
        { providerId },
      );
      return;
    }

    // Serialise the read→reserve→propose sequence for this provider.
    //
    // `pendingRevenue` is a read-modify-write against the `PayoutProposal`
    // ledger, and the “modify” (the `create` below) happens several awaited
    // steps later. Two writers that interleave inside that window both observe
    // the same `alreadyReserved` and both reserve the whole balance. The
    // writers here are the daily cron — which runs in *every* replica — and
    // `AdminService.proposePayout`, which a double-submitted or retried admin
    // request hits twice. Locking per provider excludes both cases and keeps
    // unrelated providers independent.
    //
    // Fail closed: if the lock cannot be taken because Redis is unreachable,
    // skip this provider. A skipped provider loses nothing (the revenue stays
    // `confirmed` and is proposed by the next run); a double proposal moves
    // real money that no revenue backs.
    const lock = await tryAcquireLock(
      this.redis,
      payoutProposeLockKey(providerId),
      PAYOUT_LOCK_TTL_SECONDS,
    );
    if (!lock.acquired) {
      if (lock.reason === 'held') {
        this.logger.log(
          `Skipping payout for ${providerName}: another instance is proposing for it.`,
          { providerId },
        );
      } else {
        this.logger.error(
          `Skipping payout for ${providerName}: could not acquire the payout lock ` +
            '(Redis unavailable). Refusing to propose concurrently.',
          { providerId },
        );
      }
      return;
    }

    try {
      // Aggregate confirmed revenue and already-reserved payout amounts in
      // parallel. `alreadyReserved` covers executed proposals AND in-flight ones
      // (pending/proposed/approved): an M-of-N proposal awaiting signer
      // approvals must reserve its revenue, or the next daily run would propose
      // the same revenue again and both proposals could pay out.
      const [confirmedAggregate, reservedAggregate] = await Promise.all([
        this.prisma.payment.aggregate({
          where: { providerId, status: 'confirmed' },
          _sum: { amount: true },
        }),
        this.prisma.payoutProposal.aggregate({
          where: { providerId, status: { in: [...PAYOUT_RESERVING_STATUSES] } },
          _sum: { amount: true },
        }),
      ]);

      const totalRevenue = confirmedAggregate._sum.amount ?? 0n;
      const alreadyReserved = reservedAggregate._sum.amount ?? 0n;
      const pendingRevenue = totalRevenue - alreadyReserved;

      if (pendingRevenue <= 0n) {
        return;
      }

      // Read the multisig config first so the threshold is recorded with the
      // proposal (used for the threshold-1 auto-approve decision).
      const multisigTimeout = Math.ceil(config.stellar.sorobanRpcTimeoutMs / 1000);
      const multisigConfig = await getMultisigConfig(
        config.contracts.multisig,
        config.stellar.sorobanRpcUrl,
        config.stellar.networkPassphrase,
        multisigTimeout,
      );
      const threshold = multisigConfig?.threshold ?? null;

      this.logger.log(
        `Proposing payout of ${pendingRevenue.toString()} stroops to ${payoutWalletAddress}`,
        {
          providerId,
          totalRevenue: totalRevenue.toString(),
          alreadyReserved: alreadyReserved.toString(),
          threshold,
        },
      );

      // 1. Create the PayoutProposal record first (source of truth).
      const proposalRow = await this.prisma.payoutProposal.create({
        data: {
          providerId,
          destination: payoutWalletAddress,
          amount: pendingRevenue,
          asset: 'USDC',
          status: 'pending',
          threshold,
        },
      });

      // 2. Propose on-chain via the multisig contract.
      const result = await proposeMultisig({
        contractId: config.contracts.multisig,
        rpcUrl: config.stellar.sorobanRpcUrl,
        networkPassphrase: config.stellar.networkPassphrase,
        timeoutSeconds: multisigTimeout,
        adminSecret: config.payment.contractAdminSecret!,
        destination: payoutWalletAddress,
        amount: pendingRevenue.toString(),
      });

      if (result.success) {
        this.logger.log(`Payout proposed successfully for ${providerName}.`, {
          providerId,
          proposalId: result.proposalId,
          amount: pendingRevenue.toString(),
        });

        await this.prisma.payoutProposal.update({
          where: { id: proposalRow.id },
          data: {
            status: 'proposed',
            proposalId: result.proposalId ?? null,
            // On-chain reference for the proposal call. When the payout later
            // executes, this is replaced by the approving (settling)
            // transaction — `txHash` always names this proposal's most recent
            // on-chain transaction.
            ...(result.txHash ? { txHash: result.txHash } : {}),
          },
        });

        // For threshold-1 wallets the gateway auto-executes (a single signer is
        // the whole quorum). The signer address is derived from the admin secret
        // by the multisig client, so approvals record the actual signer.
        if (threshold === 1 && result.proposalId !== undefined) {
          const approveResult = await approveMultisig({
            contractId: config.contracts.multisig,
            rpcUrl: config.stellar.sorobanRpcUrl,
            networkPassphrase: config.stellar.networkPassphrase,
            timeoutSeconds: multisigTimeout,
            signerSecret: config.payment.contractAdminSecret!,
            signer: '', // derived from signerSecret by the client
            proposalId: result.proposalId,
          });

          if (approveResult.success && approveResult.executed) {
            const signerAddress = this.deriveSignerAddress(config.payment.contractAdminSecret!);
            await this.prisma.payoutProposal.update({
              where: { id: proposalRow.id },
              data: {
                status: 'executed',
                approvals: signerAddress ? [signerAddress] : [],
                executedAt: new Date(),
                // The settlement transaction: this is the call that moved the
                // funds, and the receipt a provider would be shown.
                ...(approveResult.txHash ? { txHash: approveResult.txHash } : {}),
              },
            });
            this.logger.log(`Payout auto-approved and executed for ${providerName}.`, {
              providerId,
            });
          } else {
            this.logger.warn(
              `Auto-approval failed for ${providerName}: ${approveResult.error ?? 'not executed'}`,
              { providerId },
            );
          }
        }
      } else {
        this.logger.error(`Failed to propose payout for ${providerName}`, {
          providerId,
          error: result.error,
        });

        await this.prisma.payoutProposal.update({
          where: { id: proposalRow.id },
          data: {
            status: 'failed',
            error: result.error?.slice(0, 500) ?? 'Unknown error',
          },
        });
      }
    } finally {
      await releaseLock(this.redis, lock.handle);
    }
  }

  /**
   * Derive the public signer address from a Stellar secret key so the payout
   * ledger records who authorized execution. Returns null for a malformed key
   * (the on-chain call would already have failed).
   */
  private deriveSignerAddress(secret: string): string | null {
    try {
      return Keypair.fromSecret(secret).publicKey();
    } catch {
      return null;
    }
  }
}
