import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { PrismaClient } from '@x402/database';
import { getConfig } from '@x402/config';
import { logger } from '@x402/logger';
import { proposeMultisig, approveMultisig, getMultisigConfig } from '../x402/multisig-client';

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(@Inject('PRISMA') private readonly prisma: PrismaClient) {}

  /**
   * Daily automated payout: for every provider with a payout wallet and
   * pending confirmed revenue, propose a multisig payout on-chain and record
   * it in the `PayoutProposal` ledger.
   *
   * Pending revenue = sum(confirmed payments) − sum(executed payout proposals).
   * Only providers with net pending revenue above zero are proposed.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleDailyPayouts() {
    this.logger.log('Starting daily payout automation...');

    try {
      const config = getConfig();

      if (!config.payment.payoutAutomationEnabled) {
        this.logger.warn('Skipping payouts: PAYOUT_AUTOMATION_ENABLED is false.');
        return;
      }

      if (!config.payment.contractAdminSecret || !config.contracts.multisig) {
        this.logger.warn('Skipping payouts: Multisig contract or admin secret not configured.');
        return;
      }

      // Find all providers with a payout wallet
      const providers = await this.prisma.provider.findMany({
        where: {
          payoutWalletAddress: { not: null },
          active: true,
        },
      });

      for (const provider of providers) {
        if (!provider.payoutWalletAddress) continue;

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

    // Aggregate confirmed revenue and already-executed payout amounts in parallel.
    const [confirmedAggregate, executedAggregate] = await Promise.all([
      this.prisma.payment.aggregate({
        where: { providerId, status: 'confirmed' },
        _sum: { amount: true },
      }),
      this.prisma.payoutProposal.aggregate({
        where: { providerId, status: 'executed' },
        _sum: { amount: true },
      }),
    ]);

    const totalRevenue = confirmedAggregate._sum.amount ?? 0n;
    const alreadyPaid = executedAggregate._sum.amount ?? 0n;
    const pendingRevenue = totalRevenue - alreadyPaid;

    if (pendingRevenue <= 0n) {
      return;
    }

    this.logger.log(
      `Proposing payout of ${pendingRevenue.toString()} stroops to ${payoutWalletAddress}`,
      {
        providerId,
        totalRevenue: totalRevenue.toString(),
        alreadyPaid: alreadyPaid.toString(),
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
      },
    });

    // 2. Propose on-chain via the multisig contract.
    const result = await proposeMultisig({
      contractId: config.contracts.multisig,
      rpcUrl: config.stellar.sorobanRpcUrl,
      networkPassphrase: config.stellar.networkPassphrase,
      timeoutSeconds: Math.ceil(config.stellar.sorobanRpcTimeoutMs / 1000),
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
        },
      });

      // For threshold-1 wallets the gateway auto-executes (single signer = whole quorum).
      // Read the multisig config to decide.
      const multisigConfig = await getMultisigConfig(
        config.contracts.multisig,
        config.stellar.sorobanRpcUrl,
        config.stellar.networkPassphrase,
        Math.ceil(config.stellar.sorobanRpcTimeoutMs / 1000),
      );

      if (multisigConfig && multisigConfig.threshold <= 1 && result.proposalId !== undefined) {
        // Auto-approve: the single signer is the whole quorum.
        const approveResult = await approveMultisig({
          contractId: config.contracts.multisig,
          rpcUrl: config.stellar.sorobanRpcUrl,
          networkPassphrase: config.stellar.networkPassphrase,
          timeoutSeconds: Math.ceil(config.stellar.sorobanRpcTimeoutMs / 1000),
          signerSecret: config.payment.contractAdminSecret!,
          signer: '', // Will be resolved from the secret
          proposalId: result.proposalId,
        });

        if (approveResult.success) {
          await this.prisma.payoutProposal.update({
            where: { id: proposalRow.id },
            data: {
              status: 'executed',
              approvals: approveResult.executed ? [payoutWalletAddress] : [],
              executedAt: approveResult.executed ? new Date() : null,
            },
          });
          this.logger.log(`Payout auto-approved and executed for ${providerName}.`, { providerId });
        } else {
          this.logger.warn(`Auto-approval failed for ${providerName}: ${approveResult.error}`, {
            providerId,
          });
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
  }
}
