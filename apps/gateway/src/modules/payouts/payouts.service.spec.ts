import { Keypair } from '@stellar/stellar-sdk';
import { PayoutsService } from './payouts.service';

jest.mock('@x402/database', () => ({
  // Mirrors the real export: executed AND in-flight proposals reserve revenue.
  PAYOUT_RESERVING_STATUSES: ['pending', 'proposed', 'approved', 'executed'],
  prisma: {
    provider: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    payment: {
      aggregate: jest.fn(),
    },
    payoutProposal: {
      aggregate: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('../x402/multisig-client', () => ({
  proposeMultisig: jest.fn(),
  approveMultisig: jest.fn(),
  getMultisigConfig: jest.fn(),
}));

jest.mock('@x402/config', () => ({
  getConfig: jest.fn(),
}));

import { prisma } from '@x402/database';
import { getConfig } from '@x402/config';
import { proposeMultisig, approveMultisig, getMultisigConfig } from '../x402/multisig-client';

const mockPrisma = prisma as unknown as {
  provider: { findMany: jest.Mock; findUnique: jest.Mock };
  payment: { aggregate: jest.Mock };
  payoutProposal: { aggregate: jest.Mock; create: jest.Mock; update: jest.Mock };
};
const mockGetConfig = getConfig as jest.Mock;
const mockPropose = proposeMultisig as jest.Mock;
const mockApprove = approveMultisig as jest.Mock;
const mockGetMultisigConfig = getMultisigConfig as jest.Mock;

// A real, valid Stellar keypair used as the payout destination.
const payoutKeypair = Keypair.random();
const VALID_PAYOUT = payoutKeypair.publicKey();
const ADMIN_SECRET = Keypair.random().secret();
const ADMIN_PUBLIC = Keypair.fromSecret(ADMIN_SECRET).publicKey();

// Minimal Redis double: `set` is the lock claim (`SET NX`), `eval` is the
// compare-and-delete release.
const mockRedis = {
  set: jest.fn(),
  eval: jest.fn(),
};

const CONFIG = {
  payment: { payoutAutomationEnabled: true, contractAdminSecret: ADMIN_SECRET },
  contracts: { multisig: 'CDMBVMMNJVAJVAV3T2TAL2TAACGTKYUS45RXNLCYKYUC3VGHBI66NWAA' },
  stellar: {
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
    sorobanRpcTimeoutMs: 10_000,
    network: 'testnet',
  },
  security: { providerApprovalRequired: true },
};

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    name: 'Acme',
    active: true,
    payoutWalletAddress: VALID_PAYOUT,
    ...overrides,
  };
}

describe('PayoutsService', () => {
  let service: PayoutsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PayoutsService(mockPrisma as never, mockRedis as never);
    mockGetConfig.mockReturnValue(CONFIG);
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.eval.mockResolvedValue(1);
    mockPrisma.provider.findMany.mockResolvedValue([provider()]);
    mockPrisma.provider.findUnique.mockResolvedValue({
      active: true,
      payoutWalletAddress: VALID_PAYOUT,
    });
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 5_000_000n } });
    mockPrisma.payoutProposal.aggregate.mockResolvedValue({ _sum: { amount: 0n } });
    mockPrisma.payoutProposal.create.mockResolvedValue({ id: 'prop-1' });
    mockPrisma.payoutProposal.update.mockResolvedValue({});
    mockGetMultisigConfig.mockResolvedValue({ signers: [], threshold: 2, token: 'C...' });
    mockPropose.mockResolvedValue({ success: true, proposalId: 7 });
    mockApprove.mockResolvedValue({ success: true, executed: false });
  });

  it('skips entirely when payout automation is disabled', async () => {
    mockGetConfig.mockReturnValue({
      ...CONFIG,
      payment: { ...CONFIG.payment, payoutAutomationEnabled: false },
    });

    await service.handleDailyPayouts();

    expect(mockPrisma.provider.findMany).not.toHaveBeenCalled();
    expect(mockPropose).not.toHaveBeenCalled();
  });

  it('skips providers with a malformed payout wallet address', async () => {
    mockPrisma.provider.findMany.mockResolvedValue([
      provider({ payoutWalletAddress: 'not-a-stellar-address' }),
    ]);

    await service.handleDailyPayouts();

    expect(mockPropose).not.toHaveBeenCalled();
    expect(mockPrisma.payoutProposal.create).not.toHaveBeenCalled();
  });

  it('skips a provider that is no longer approved/active', async () => {
    mockPrisma.provider.findMany.mockResolvedValue([provider({ active: false })]);

    await service.handleDailyPayouts();

    expect(mockPropose).not.toHaveBeenCalled();
    expect(mockPrisma.payoutProposal.create).not.toHaveBeenCalled();
  });

  it('re-checks approval at proposal time and skips a deactivated provider', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue({
      active: false,
      payoutWalletAddress: VALID_PAYOUT,
    });

    await service.handleDailyPayouts();

    expect(mockPrisma.payoutProposal.create).not.toHaveBeenCalled();
    expect(mockPropose).not.toHaveBeenCalled();
  });

  it('skips when the payout wallet changed after the loop read it', async () => {
    mockPrisma.provider.findUnique.mockResolvedValue({
      active: true,
      payoutWalletAddress: Keypair.random().publicKey(),
    });

    await service.handleDailyPayouts();

    expect(mockPrisma.payoutProposal.create).not.toHaveBeenCalled();
    expect(mockPropose).not.toHaveBeenCalled();
  });

  it('proposes a payout for an approved provider with a valid wallet and pending revenue', async () => {
    await service.handleDailyPayouts();

    expect(mockPrisma.payoutProposal.create).toHaveBeenCalledWith({
      data: {
        providerId: 'p-1',
        destination: VALID_PAYOUT,
        amount: 5_000_000n,
        asset: 'USDC',
        status: 'pending',
        threshold: 2,
      },
    });
    expect(mockPropose).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: VALID_PAYOUT,
        amount: '5000000',
      }),
    );
    expect(mockPrisma.payoutProposal.update).toHaveBeenCalledWith({
      where: { id: 'prop-1' },
      data: { status: 'proposed', proposalId: 7 },
    });
  });

  it('does not propose when pending revenue is zero or negative', async () => {
    mockPrisma.payoutProposal.aggregate.mockResolvedValue({ _sum: { amount: 5_000_000n } });

    await service.handleDailyPayouts();

    expect(mockPrisma.payoutProposal.create).not.toHaveBeenCalled();
    expect(mockPropose).not.toHaveBeenCalled();
  });

  it('reserves in-flight proposals so the same revenue is never proposed twice', async () => {
    // A 2-of-3 proposal for the whole 5,000,000 sits in `proposed` awaiting
    // signer approval. The daily run must see it as already reserved and
    // propose nothing — otherwise each run mints another proposal for the
    // same revenue and two approvals could pay the provider twice.
    mockPrisma.payoutProposal.aggregate.mockResolvedValue({ _sum: { amount: 5_000_000n } });

    await service.handleDailyPayouts();

    expect(mockPrisma.payoutProposal.aggregate).toHaveBeenCalledWith({
      where: {
        providerId: 'p-1',
        status: { in: ['pending', 'proposed', 'approved', 'executed'] },
      },
      _sum: { amount: true },
    });
    expect(mockPrisma.payoutProposal.create).not.toHaveBeenCalled();
    expect(mockPropose).not.toHaveBeenCalled();
  });

  it('only counts executed + in-flight proposals, not failed/cancelled ones', async () => {
    await service.handleDailyPayouts();

    const where = mockPrisma.payoutProposal.aggregate.mock.calls[0][0].where;
    expect(where.status.in).toEqual(['pending', 'proposed', 'approved', 'executed']);
    expect(where.status.in).not.toContain('failed');
    expect(where.status.in).not.toContain('cancelled');
  });

  it('auto-approves a threshold-1 wallet and records the real signer address', async () => {
    mockGetMultisigConfig.mockResolvedValue({
      signers: [ADMIN_PUBLIC],
      threshold: 1,
      token: 'C...',
    });
    mockApprove.mockResolvedValue({ success: true, executed: true });

    await service.handleDailyPayouts();

    expect(mockApprove).toHaveBeenCalledWith(
      expect.objectContaining({ signer: '', proposalId: 7 }),
    );
    expect(mockPrisma.payoutProposal.update).toHaveBeenLastCalledWith({
      where: { id: 'prop-1' },
      data: {
        status: 'executed',
        approvals: [ADMIN_PUBLIC],
        executedAt: expect.any(Date),
      },
    });
  });

  it('does NOT auto-approve when the threshold is greater than 1', async () => {
    mockGetMultisigConfig.mockResolvedValue({ signers: [], threshold: 2, token: 'C...' });

    await service.handleDailyPayouts();

    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('marks the proposal failed when the on-chain proposal fails', async () => {
    mockPropose.mockResolvedValue({ success: false, error: 'RPC unavailable' });

    await service.handleDailyPayouts();

    expect(mockPrisma.payoutProposal.update).toHaveBeenCalledWith({
      where: { id: 'prop-1' },
      data: { status: 'failed', error: 'RPC unavailable' },
    });
  });

  // ── Per-provider double-proposal guard ──
  //
  // `pendingRevenue` is a read-modify-write against the `PayoutProposal`
  // ledger whose write lands several awaits after the read, so two writers
  // that interleave both reserve the whole balance. The writers are the daily
  // cron (which fires in EVERY replica) and the admin propose endpoint (whose
  // caller can double-submit or retry).

  describe('per-provider payout lock', () => {
    it('claims a per-provider lock with SET NX before reading revenue', async () => {
      await service.handleDailyPayouts();

      expect(mockRedis.set).toHaveBeenCalledWith(
        'x402:lock:payout-propose:p-1',
        expect.any(String),
        'EX',
        120,
        'NX',
      );
      // The claim precedes the read it protects.
      expect(mockRedis.set.mock.invocationCallOrder[0]).toBeLessThan(
        mockPrisma.payment.aggregate.mock.invocationCallOrder[0],
      );
    });

    it('skips a provider whose lock another instance already holds', async () => {
      mockRedis.set.mockResolvedValue(null); // NX rejected — key already held

      await service.handleDailyPayouts();

      expect(mockPrisma.payment.aggregate).not.toHaveBeenCalled();
      expect(mockPrisma.payoutProposal.create).not.toHaveBeenCalled();
      expect(mockPropose).not.toHaveBeenCalled();
      // It never owned the lock, so it must not delete it.
      expect(mockRedis.eval).not.toHaveBeenCalled();
    });

    it('fails closed when the lock cannot be acquired because Redis is down', async () => {
      mockRedis.set.mockRejectedValue(new Error('ECONNREFUSED'));

      await service.handleDailyPayouts();

      // A skipped provider is recoverable (its revenue stays confirmed and is
      // proposed next run); a duplicate payout is not. Never propose unlocked.
      expect(mockPrisma.payoutProposal.create).not.toHaveBeenCalled();
      expect(mockPropose).not.toHaveBeenCalled();
    });

    it('releases the lock with the acquiring token after a successful proposal', async () => {
      await service.handleDailyPayouts();

      const token = mockRedis.set.mock.calls[0][1];
      expect(token).toEqual(expect.any(String));
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('DEL'"),
        1,
        'x402:lock:payout-propose:p-1',
        token,
      );
    });

    it('releases the lock when the proposal fails, so the next run is not blocked', async () => {
      mockPrisma.payment.aggregate.mockRejectedValue(new Error('db down'));

      await service.handleDailyPayouts();

      expect(mockRedis.eval).toHaveBeenCalled();
    });

    it('does not lock at all when the provider is rejected before the money path', async () => {
      mockPrisma.provider.findUnique.mockResolvedValue({
        active: false,
        payoutWalletAddress: VALID_PAYOUT,
      });

      await service.handleDailyPayouts();

      expect(mockRedis.set).not.toHaveBeenCalled();
    });
  });
});
