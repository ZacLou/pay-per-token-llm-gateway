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
    service = new PayoutsService(mockPrisma as never);
    mockGetConfig.mockReturnValue(CONFIG);
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
});
