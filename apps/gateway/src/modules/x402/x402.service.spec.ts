import { X402Service } from './x402.service';
import type { Quote } from '@x402/types';

jest.mock('./escrow-client', () => ({
  getEscrowBalance: jest.fn(),
}));

jest.mock('./contract-client', () => ({
  isPaymentUsedOnChain: jest.fn().mockResolvedValue(false),
  recordPaymentOnChain: jest.fn(),
}));

jest.mock('@x402/config', () => ({
  getConfig: jest.fn(),
}));

import { getEscrowBalance } from './escrow-client';
import { getConfig } from '@x402/config';

const mockGetEscrowBalance = getEscrowBalance as jest.Mock;
const mockGetConfig = getConfig as jest.Mock;

const CONFIG = {
  payment: { escrowSettlementEnabled: true },
  contracts: { creditEscrow: 'CCE7AWVXPO57W5KDONOPMHDV4S5UBUBMHNJVSAVPL7AZGMD4WQN6WVAP' },
  stellar: {
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
  },
};

function makeQuote(id: string, amount = '1000000'): Quote {
  return {
    id,
    route: '/v1/chat/completions',
    pricingModel: 'flat',
    amount,
    asset: 'USDC',
    paymentAddress: 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F',
    memo: 'memo',
    network: 'testnet',
    issuedAt: 1,
    expiresAt: 2,
    statusUrl: 'http://localhost/status',
  } as Quote;
}

describe('X402Service.verifyEscrowPayment', () => {
  let service: X402Service;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConfig.mockReturnValue(CONFIG);
    service = new X402Service(
      {} as never,
      {} as never,
      { safe: (fn: () => void) => fn() } as never,
    );
    mockGetEscrowBalance.mockResolvedValue('5000000');
  });

  it('returns a distinct, prefixed synthetic txHash per escrow draw', async () => {
    const first = await service.verifyEscrowPayment('GUSER1', makeQuote('quote-a'));
    const second = await service.verifyEscrowPayment('GUSER2', makeQuote('quote-b'));

    expect(first.verified).toBe(true);
    expect(second.verified).toBe(true);
    // Unique per quote — an empty string would collide with the unique
    // Payment.txHash index on the second draw.
    expect(first.txHash).toBe('escrow:quote-a');
    expect(second.txHash).toBe('escrow:quote-b');
    expect(first.txHash).not.toBe(second.txHash);
    // Settlement wiring keys off this prefix.
    expect(first.txHash.startsWith('escrow:')).toBe(true);
  });

  it('rejects a draw when the escrow balance is insufficient', async () => {
    mockGetEscrowBalance.mockResolvedValue('10');

    const result = await service.verifyEscrowPayment('GUSER1', makeQuote('quote-c'));

    expect(result.verified).toBe(false);
    expect(result.failureReason).toMatch(/insufficient/i);
    expect(result.txHash).toBe('');
  });

  it('rejects when escrow settlement is disabled', async () => {
    mockGetConfig.mockReturnValue({
      ...CONFIG,
      payment: { escrowSettlementEnabled: false },
    });

    const result = await service.verifyEscrowPayment('GUSER1', makeQuote('quote-d'));

    expect(result.verified).toBe(false);
    expect(result.failureReason).toMatch(/not enabled/i);
    expect(mockGetEscrowBalance).not.toHaveBeenCalled();
  });

  it('fails closed when the escrow balance cannot be read', async () => {
    mockGetEscrowBalance.mockResolvedValue(null);

    const result = await service.verifyEscrowPayment('GUSER1', makeQuote('quote-e'));

    expect(result.verified).toBe(false);
    expect(result.failureReason).toMatch(/could not read/i);
  });
});
