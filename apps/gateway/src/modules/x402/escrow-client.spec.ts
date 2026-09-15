/* eslint-disable @typescript-eslint/no-explicit-any */
import { chargeEscrow, refundEscrow, settleEscrow, getEscrowBalance } from './escrow-client';

// The escrow client dynamically imports `@stellar/stellar-sdk` (the `contract`
// namespace for the spec client) and uses `Keypair.fromSecret` statically.
// Mock the module so contract calls never touch a network.
jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk') as any;
  return {
    ...actual,
    Keypair: {
      ...actual.Keypair,
      fromSecret: (...args: unknown[]) => mockKeypairFromSecret(...args),
    },
    // Spread the real namespace: the client under test now signs through the
    // SDK's own `basicNodeSigner`, so replacing `contract` wholesale (as this
    // mock used to) leaves that helper undefined and every call throws before
    // it can send.
    contract: {
      ...actual.contract,
      Client: {
        from: (...args: unknown[]) => mockClientFrom(...args),
      },
    },
  };
});

const mockKeypairFromSecret = jest.fn();
const mockClientFrom = jest.fn();
const mockSign = jest.fn();
const mockSend = jest.fn();
const mockSignAuthEntries = jest.fn();

const RealSdk = jest.requireActual('@stellar/stellar-sdk') as any;
const adminKp = RealSdk.Keypair.random();
const userKp = RealSdk.Keypair.random();
const USER = userKp.publicKey();
const SETTLEMENT_TX_HASH = 'b'.repeat(64);

const BASE = {
  contractId: 'CCE7AWVXPO57W5KDONOPMHDV4S5UBUBMHNJVSAVPL7AZGMD4WQN6WVAP',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  adminSecret: adminKp.secret(),
  user: USER,
  amount: '100000',
  quoteId: 'quote-abc',
};

function makeTx() {
  return {
    sign: mockSign,
    signAuthEntries: mockSignAuthEntries,
    send: mockSend,
  };
}

beforeEach(() => {
  // resetAllMocks (not just clear) so mockResolvedValueOnce queues from one
  // test never leak into the next.
  jest.resetAllMocks();
  // A real Keypair, not a hand-rolled stub: `basicNodeSigner` signs the
  // envelope and the auth entries with it, so a fake without a working
  // `sign()` cannot exercise the path at all — which is exactly how the
  // original signing bug stayed hidden.
  mockKeypairFromSecret.mockReturnValue(adminKp);
  mockClientFrom.mockResolvedValue({
    charge: jest.fn().mockResolvedValue(makeTx()),
    refund: jest.fn().mockResolvedValue(makeTx()),
  });
  // `send()` resolves to the SDK's SentTransaction; the settlement transaction
  // hash is read from it and surfaced on the result for on-chain auditing.
  mockSend.mockResolvedValue({ sendTransactionResponse: { hash: SETTLEMENT_TX_HASH } });
});

describe('escrow-client', () => {
  describe('getEscrowBalance', () => {
    // The read call is the one path the mock-based suite never covered, and
    // that omission hid a defect that made the whole escrow feature unusable:
    // the SDK's read call resolves to an assembled transaction, so the balance
    // lives on `.result`. The old parser coerced the transaction object to
    // `0`, reporting every funded escrow as empty.
    it('reads the balance from the assembled transaction result', async () => {
      const balanceFn = jest.fn().mockResolvedValue({ result: 10_000_000n });
      mockClientFrom.mockResolvedValue({ balance: balanceFn });

      const balance = await getEscrowBalance({
        contractId: BASE.contractId,
        rpcUrl: BASE.rpcUrl,
        networkPassphrase: BASE.networkPassphrase,
        user: USER,
      });

      expect(balance).toBe('10000000');
      expect(balanceFn).toHaveBeenCalledTimes(1);
    });

    it('reads a >64-bit balance returned as lo/hi parts', async () => {
      // 2^64 + 5 — does not fit a 64-bit limb, so the SDK hands back parts.
      mockClientFrom.mockResolvedValue({
        balance: jest.fn().mockResolvedValue({ result: { lo: 5n, hi: 1n } }),
      });

      const balance = await getEscrowBalance({
        contractId: BASE.contractId,
        rpcUrl: BASE.rpcUrl,
        networkPassphrase: BASE.networkPassphrase,
        user: USER,
      });

      expect(balance).toBe((2n ** 64n + 5n).toString());
    });

    it('fails closed (null) on an unrecognised result shape rather than reporting 0', async () => {
      // The regression: an object with no lo/hi used to be coerced to "0".
      mockClientFrom.mockResolvedValue({
        balance: jest.fn().mockResolvedValue({ result: { unexpected: true } }),
      });

      const balance = await getEscrowBalance({
        contractId: BASE.contractId,
        rpcUrl: BASE.rpcUrl,
        networkPassphrase: BASE.networkPassphrase,
        user: USER,
      });

      expect(balance).toBeNull();
      expect(balance).not.toBe('0');
    });

    it('returns null (never throws) when the contract read fails', async () => {
      mockClientFrom.mockResolvedValue({
        balance: jest.fn().mockRejectedValue(new Error('contract not found')),
      });

      const balance = await getEscrowBalance({
        contractId: BASE.contractId,
        rpcUrl: BASE.rpcUrl,
        networkPassphrase: BASE.networkPassphrase,
        user: USER,
      });

      expect(balance).toBeNull();
    });
  });

  describe('chargeEscrow', () => {
    it('charges on-chain and returns success', async () => {
      const result = await chargeEscrow(BASE);

      expect(result.success).toBe(true);
      expect(result.txHash).toBe(SETTLEMENT_TX_HASH);
      expect(mockSign).toHaveBeenCalled();
      expect(mockSend).toHaveBeenCalled();
    });

    it('returns an error result (never throws) when the contract call fails', async () => {
      mockClientFrom.mockResolvedValue({
        charge: jest.fn().mockRejectedValue(new Error('Quote already charged')),
      });

      const result = await chargeEscrow(BASE);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Quote already charged');
    });

    it('returns an error when the admin secret is invalid', async () => {
      mockKeypairFromSecret.mockImplementation(() => {
        throw new Error('Invalid secret');
      });

      const result = await chargeEscrow({ ...BASE, adminSecret: 'bad' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid secret');
    });
  });

  describe('refundEscrow', () => {
    it('refunds on-chain and returns success', async () => {
      const result = await refundEscrow(BASE);

      expect(result.success).toBe(true);
      expect(result.txHash).toBe(SETTLEMENT_TX_HASH);
      expect(mockSend).toHaveBeenCalled();
    });

    it('returns an error result (never throws) when the contract call fails', async () => {
      mockClientFrom.mockResolvedValue({
        refund: jest.fn().mockRejectedValue(new Error('Insufficient prepaid balance')),
      });

      const result = await refundEscrow(BASE);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient prepaid balance');
    });
  });

  describe('settleEscrow', () => {
    it('is a silent no-op when disabled (no contract calls)', async () => {
      await settleEscrow({
        ...BASE,
        enabled: false,
        adminSecret: undefined,
        actualCost: '100000',
        surplus: '0',
        isOverpaid: false,
      });

      expect(mockClientFrom).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('is a silent no-op when adminSecret is missing even if enabled', async () => {
      await settleEscrow({
        ...BASE,
        enabled: true,
        adminSecret: undefined,
        actualCost: '100000',
        surplus: '0',
        isOverpaid: false,
      });

      expect(mockClientFrom).not.toHaveBeenCalled();
    });

    it('charges the actual cost when enabled', async () => {
      mockClientFrom
        .mockResolvedValueOnce({
          charge: jest.fn().mockResolvedValue(makeTx()),
        })
        .mockResolvedValueOnce({
          refund: jest.fn().mockResolvedValue(makeTx()),
        });

      await settleEscrow({
        ...BASE,
        enabled: true,
        actualCost: '100000',
        surplus: '5000',
        isOverpaid: true,
      });

      expect(mockClientFrom).toHaveBeenCalledTimes(2);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('charges only (no refund) when not overpaid', async () => {
      mockClientFrom.mockResolvedValueOnce({
        charge: jest.fn().mockResolvedValue(makeTx()),
      });

      await settleEscrow({
        ...BASE,
        enabled: true,
        actualCost: '100000',
        surplus: '0',
        isOverpaid: false,
      });

      expect(mockClientFrom).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('skips the refund when the charge fails (never refund on a failed charge)', async () => {
      mockClientFrom.mockResolvedValueOnce({
        charge: jest.fn().mockRejectedValue(new Error('RPC down')),
      });

      await settleEscrow({
        ...BASE,
        enabled: true,
        actualCost: '100000',
        surplus: '5000',
        isOverpaid: true,
      });

      expect(mockClientFrom).toHaveBeenCalledTimes(1);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
