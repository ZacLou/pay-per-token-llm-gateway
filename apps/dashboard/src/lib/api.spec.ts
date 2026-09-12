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
