/** @jest-environment jsdom */

import {
  setSessionToken,
  setWalletAddress,
  getWalletAddress,
  fetchNotifications,
  fetchUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  fetchPayments,
  fetchEscrowBalance,
  deleteRoute,
  REQUEST_TIMEOUT_MS,
} from './api';

describe('in-memory session token', () => {
  it('stores a token without touching localStorage', () => {
    setSessionToken('test-token-123');
    expect(localStorage.getItem('x402-session-token')).toBeNull();
  });
});

describe('wallet address management', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('stores and retrieves the wallet address', () => {
    setWalletAddress('GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F');
    expect(getWalletAddress()).toBe('GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F');
  });

  it('returns null when no wallet address is stored', () => {
    expect(getWalletAddress()).toBeNull();
  });
});

describe('notification API', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function mockJson(body: unknown, ok = true, status = 200) {
    global.fetch = jest.fn().mockResolvedValue({
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as typeof fetch;
  }

  it('fetches paginated notifications with filters in the query string', async () => {
    mockJson({ data: [], total: 0, unread: 0, limit: 10, offset: 0 });

    const result = await fetchNotifications({ providerId: 'p1', unreadOnly: true, limit: 10 });

    expect(result.total).toBe(0);
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/notifications?');
    expect(url).toContain('providerId=p1');
    expect(url).toContain('unreadOnly=true');
    expect(url).toContain('limit=10');
  });

  it('fetches the unread notification count', async () => {
    mockJson({ unread: 3 });

    await expect(fetchUnreadNotificationCount()).resolves.toEqual({ unread: 3 });
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('/notifications/unread-count');
  });

  it('marks a single notification read via POST', async () => {
    mockJson({ id: 'n1', read: true });

    await markNotificationRead('n1');

    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toContain('/notifications/n1/read');
    expect(options.method).toBe('POST');
  });

  it('marks all notifications read via POST', async () => {
    mockJson({ updated: 4 });

    await expect(markAllNotificationsRead()).resolves.toEqual({ updated: 4 });
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toContain('/notifications/read-all');
    expect(options.method).toBe('POST');
  });

  it('throws a descriptive error when the gateway rejects the request', async () => {
    mockJson({ message: 'nope' }, false, 500);

    await expect(fetchNotifications()).rejects.toThrow('Gateway error 500');
  });

  it('serializes payment pagination params', async () => {
    mockJson({ data: [], total: 0, page: 2, limit: 20, totalPages: 0 });

    await fetchPayments({ page: 2, limit: 20, status: 'confirmed' });

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('page=2');
    expect(url).toContain('limit=20');
    expect(url).toContain('status=confirmed');
  });
});

describe('gateway request timeout', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('bounds every request with an abort signal', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ unread: 0 }),
      text: async () => '{}',
    }) as unknown as typeof fetch;

    await fetchUnreadNotificationCount();

    const init = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects with an actionable message instead of hanging forever', async () => {
    // Regression: an unreachable gateway left these promises pending, so the
    // dashboard rendered a permanent `Connecting...`/loading wall. The request
    // must fail fast and say what to check.
    jest.useFakeTimers();
    global.fetch = jest.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ) as unknown as typeof fetch;

    const pending = fetchNotifications();
    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);

    await expect(pending).rejects.toThrow(`timed out after ${REQUEST_TIMEOUT_MS}ms`);
  });

  it('names the gateway URL and CORS in the timeout message', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ) as unknown as typeof fetch;

    const pending = fetchNotifications();
    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);

    await expect(pending).rejects.toThrow(/CORS_ORIGINS/);
  });
});

describe('empty-body responses', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('resolves deleteRoute for the 204 No Content the gateway returns', async () => {
    // Regression: `request()` ended with `res.json()`, and parsing the empty
    // body of a 204 rejected with "Unexpected end of JSON input" — so the
    // Routes page reported a failed delete for a delete that had succeeded.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 204,
      text: async () => '',
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    }) as unknown as typeof fetch;

    await expect(deleteRoute('route-1')).resolves.toBeUndefined();
  });

  it('still parses a JSON body', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ unread: 3 }),
    }) as unknown as typeof fetch;

    await expect(fetchUnreadNotificationCount()).resolves.toEqual({ unread: 3 });
  });
});

describe('escrow API', () => {
  const originalFetch = global.fetch;
  const ADDRESS = 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F';

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function mockJson(body: unknown) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as typeof fetch;
  }

  it('reads the balance through the gateway base URL, never a relative path', async () => {
    // Regression: this page fetched `/api/v1/escrow/...`, a relative URL that
    // resolved against the dashboard's own origin — which serves no API route
    // — so the request 404'd without ever reaching the gateway.
    mockJson({ address: ADDRESS, balance: '1.5000000', asset: 'USDC', contractId: 'CABC' });

    await expect(fetchEscrowBalance(ADDRESS)).resolves.toEqual({
      address: ADDRESS,
      balance: '1.5000000',
      asset: 'USDC',
      contractId: 'CABC',
    });

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url.startsWith('http')).toBe(true);
    expect(url).toContain('/api/v1/escrow/');
    expect(url).toContain(ADDRESS);
  });

  it('percent-encodes the address so it cannot escape the path segment', async () => {
    mockJson({});

    await fetchEscrowBalance('G/../../admin');

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).not.toContain('G/../..');
    expect(url).toContain('%2F');
  });
});
