import { validateWebhookUrl, isPublicIp, WebhooksService } from './webhooks.service';

// Mock DNS so tests are hermetic (no real lookups, no network access).
jest.mock('dns/promises', () => ({
  lookup: jest.fn(),
}));

// Mock notifications so delivery never hits the network and the dispatcher is
// deterministic.
jest.mock('@x402/notifications', () => ({
  dispatcher: { dispatch: jest.fn().mockResolvedValue(['in_app']) },
  WebhookNotificationHandler: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue(true),
    sendWithSignature: jest.fn().mockResolvedValue(true),
  })),
}));

jest.mock('@x402/database', () => ({
  prisma: {
    provider: {
      findUnique: jest.fn(),
    },
  },
}));

import { lookup } from 'dns/promises';
import { prisma } from '@x402/database';
import { dispatcher, WebhookNotificationHandler } from '@x402/notifications';

const mockLookup = lookup as jest.MockedFunction<typeof lookup>;
const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockHandler = WebhookNotificationHandler as unknown as jest.Mock;

/** Make DNS resolve `host` to the given addresses. */
function mockResolve(addresses: Array<{ address: string; family: number }>) {
  mockLookup.mockResolvedValue(addresses as never);
}

const PUBLIC_V4 = { address: '93.184.216.34', family: 4 };
const PUBLIC_V6 = { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 };

describe('validateWebhookUrl (SSRF guard)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects non-HTTPS URLs', async () => {
    await expect(validateWebhookUrl('http://example.com/hook')).rejects.toThrow(
      'Webhook URL must use HTTPS',
    );
  });

  it('rejects malformed URLs', async () => {
    await expect(validateWebhookUrl('not-a-url')).rejects.toThrow('Invalid webhook URL');
  });

  it('accepts an HTTPS URL that resolves to a public IPv4 address', async () => {
    mockResolve([PUBLIC_V4]);
    await expect(validateWebhookUrl('https://example.com/hook')).resolves.toBe(
      'https://example.com/hook',
    );
  });

  it('accepts an HTTPS URL that resolves to a public IPv6 address', async () => {
    mockResolve([PUBLIC_V6]);
    await expect(validateWebhookUrl('https://example.com/hook')).resolves.toBe(
      'https://example.com/hook',
    );
  });

  it('rejects loopback addresses (localhost)', async () => {
    mockResolve([{ address: '127.0.0.1', family: 4 }]);
    await expect(validateWebhookUrl('https://localhost:4444/hook')).rejects.toThrow(
      'Webhook URL must point to a public IP address',
    );
  });

  it('rejects private / internal ranges (RFC1918, metadata, CGNAT)', async () => {
    const privateIps = [
      '10.1.2.3', // 10/8
      '192.168.1.1', // 192.168/16
      '172.16.0.1', // 172.16/12
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.1', // this-network
      '224.0.0.1', // multicast
    ];
    for (const address of privateIps) {
      mockResolve([{ address, family: 4 }]);
      await expect(validateWebhookUrl(`https://${address}/hook`)).rejects.toThrow(
        'Webhook URL must point to a public IP address',
      );
    }
  });

  it('rejects IPv6 loopback and link-local addresses', async () => {
    for (const address of ['::1', 'fe80::1', 'fc00::1']) {
      mockResolve([{ address, family: 6 }]);
      await expect(validateWebhookUrl('https://example.com/hook')).rejects.toThrow(
        'Webhook URL must point to a public IP address',
      );
    }
  });

  it('rejects IPv4-mapped private addresses', async () => {
    mockResolve([{ address: '::ffff:127.0.0.1', family: 6 }]);
    await expect(validateWebhookUrl('https://example.com/hook')).rejects.toThrow(
      'Webhook URL must point to a public IP address',
    );
  });

  it('rejects when ANY resolved address is private (mixed A/AAAA records)', async () => {
    mockResolve([PUBLIC_V4, { address: '10.0.0.5', family: 4 }]);
    await expect(validateWebhookUrl('https://example.com/hook')).rejects.toThrow(
      'Webhook URL must point to a public IP address',
    );
  });

  it('rejects when the hostname cannot be resolved', async () => {
    mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(validateWebhookUrl('https://does-not-exist.invalid/hook')).rejects.toThrow(
      'Webhook hostname could not be resolved',
    );
  });

  it('rejects when DNS returns no addresses', async () => {
    mockResolve([]);
    await expect(validateWebhookUrl('https://example.com/hook')).rejects.toThrow(
      'Webhook hostname could not be resolved',
    );
  });
});

describe('isPublicIp', () => {
  it('classifies public IPv4 addresses correctly', () => {
    expect(isPublicIp('8.8.8.8')).toBe(true);
    expect(isPublicIp('93.184.216.34')).toBe(true);
  });

  it('classifies private IPv4 addresses correctly', () => {
    expect(isPublicIp('127.0.0.1')).toBe(false);
    expect(isPublicIp('10.0.0.1')).toBe(false);
    expect(isPublicIp('172.16.0.1')).toBe(false);
    expect(isPublicIp('192.168.1.1')).toBe(false);
    expect(isPublicIp('169.254.169.254')).toBe(false);
    expect(isPublicIp('100.64.0.1')).toBe(false);
    expect(isPublicIp('224.0.0.1')).toBe(false);
    expect(isPublicIp('0.0.0.0')).toBe(false);
  });

  it('classifies public IPv6 addresses correctly', () => {
    expect(isPublicIp('2606:2800:220:1:248:1893:25c8:1946')).toBe(true);
    // Compressed forms of a public address must classify the same.
    expect(isPublicIp('2606:2800::1')).toBe(true);
    expect(isPublicIp('::1')).toBe(false);
    expect(isPublicIp('fe80::1')).toBe(false);
    expect(isPublicIp('fd12:3456::1')).toBe(false);
    expect(isPublicIp('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicIp('::ffff:8.8.8.8')).toBe(true);
  });

  // Regression: these all used to be classified as PUBLIC. `::` connects to
  // localhost on Linux, so an upstream/webhook hostname with an AAAA record of
  // `::` was an SSRF route into the gateway's own loopback.
  it('refuses non-global-unicast IPv6 that used to fail open', () => {
    expect(isPublicIp('::')).toBe(false); // unspecified — connects to localhost
    expect(isPublicIp('0:0:0:0:0:0:0:0')).toBe(false);
    expect(isPublicIp('ff02::1')).toBe(false); // ff00::/8 multicast
    expect(isPublicIp('64:ff9b::7f00:1')).toBe(false); // NAT64 to 127.0.0.1
    expect(isPublicIp('::7f00:1')).toBe(false); // IPv4-compatible 127.0.0.1
    expect(isPublicIp('2002:7f00:0001::')).toBe(false); // 6to4 embedding 127.0.0.1
    expect(isPublicIp('2002:0a00:0001::')).toBe(false); // 6to4 embedding 10.0.0.1
    expect(isPublicIp('2001:0000:4136:e378::1')).toBe(false); // Teredo
    expect(isPublicIp('::ffff:7f00:1')).toBe(false); // hex IPv4-mapped loopback
  });

  it('returns false for non-IP input', () => {
    expect(isPublicIp('not-an-ip')).toBe(false);
    expect(isPublicIp('')).toBe(false);
  });
});

describe('WebhooksService.notify (delivery-time SSRF re-validation)', () => {
  let service: WebhooksService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new WebhooksService();
  });

  it('re-validates the webhook URL and delivers when it is SSRF-safe', async () => {
    mockResolve([PUBLIC_V4]);
    (mockPrisma.provider.findUnique as jest.Mock).mockResolvedValue({
      webhookUrl: 'https://hooks.example.com/x402',
      webhookSecret: null,
    });

    const result = await service.notify('p-1', 'payment_received', { txHash: 'abc' });

    // The delivery path re-ran the SSRF guard with the stored URL.
    expect(mockLookup).toHaveBeenCalledWith('hooks.example.com', { all: true });
    // `mock.results[0].value` is the object the mocked constructor factory
    // returned (mock.instances would be the empty `this` of the `new` call,
    // which has no methods on it).
    const handler = mockHandler.mock.results[0]?.value as
      | {
          sendWithSignature: jest.Mock;
        }
      | undefined;
    expect(handler?.sendWithSignature).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'p-1', event: 'payment_received' }),
      'https://hooks.example.com/x402',
      undefined,
    );
    expect(result.success).toBe(true);
    expect(result.channels).toContain('webhook');
  });

  it('skips delivery when the stored URL is no longer SSRF-safe (DNS rebinding)', async () => {
    // The stored URL used to resolve publicly, but now resolves to the cloud
    // metadata IP — delivery must be skipped, not performed.
    mockResolve([{ address: '169.254.169.254', family: 4 }]);
    (mockPrisma.provider.findUnique as jest.Mock).mockResolvedValue({
      webhookUrl: 'https://hooks.example.com/x402',
      webhookSecret: '0123456789abcdef0123456789abcdef',
    });

    const result = await service.notify('p-1', 'payment_received', { txHash: 'abc' });

    // No handler instance was created → sendWithSignature was never called.
    expect(mockHandler).not.toHaveBeenCalled();
    expect(result.success).toBe(true); // in-app channel still dispatched
    expect(result.channels).not.toContain('webhook');
  });

  it('still dispatches in-app notifications when the provider has no webhook', async () => {
    (mockPrisma.provider.findUnique as jest.Mock).mockResolvedValue({
      webhookUrl: null,
      webhookSecret: null,
    });

    const result = await service.notify('p-1', 'payment_received', { txHash: 'abc' });

    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'p-1', event: 'payment_received' }),
    );
    expect(mockHandler).not.toHaveBeenCalled();
    expect(result.channels).toEqual(['in_app']);
  });
});
