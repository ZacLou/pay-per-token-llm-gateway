/* eslint-disable @typescript-eslint/no-explicit-any */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../app.module';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';

jest.mock('dns/promises', () => ({
  lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

// ── Wallets & fixtures ─────────────────────────

const OWNER_WALLET = 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F';
const OTHER_WALLET = 'GB4YJON6574K74SGHSKHPMBJDJPLBPYN4HPGGN2J5RFKMSNFSWLBYFRL';
const OWNED_PROVIDER = 'provider-owned-001';
const OTHER_PROVIDER = 'provider-other-001';
const CONFIRMED_TX = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

interface NotificationRow {
  id: string;
  providerId: string;
  event: string;
  channel: string;
  payload: Record<string, unknown>;
  sent: boolean;
  read: boolean;
  readAt: Date | null;
  createdAt: Date;
}

let notificationStore: NotificationRow[] = [];

/** Minimal `where` matcher supporting scalar equality and `{ in: [...] }`. */
function matches(row: Record<string, any>, where: Record<string, any> = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) return true;
    if (expected !== null && typeof expected === 'object' && 'in' in expected) {
      return (expected as { in: unknown[] }).in.includes(row[key]);
    }
    return row[key] === expected;
  });
}

function seedNotifications() {
  notificationStore = [
    {
      id: 'notif-unread-1',
      providerId: OWNED_PROVIDER,
      event: 'payment_received',
      channel: 'in_app',
      payload: { txHash: CONFIRMED_TX, amount: '1000000' },
      sent: true,
      read: false,
      readAt: null,
      createdAt: new Date('2026-09-11T10:00:00.000Z'),
    },
    {
      id: 'notif-read-1',
      providerId: OWNED_PROVIDER,
      event: 'payment_received',
      channel: 'in_app',
      payload: { txHash: 'b'.repeat(64), amount: '500000' },
      sent: true,
      read: true,
      readAt: new Date('2026-09-10T12:00:00.000Z'),
      createdAt: new Date('2026-09-10T10:00:00.000Z'),
    },
    // Belongs to a DIFFERENT wallet — must never appear in the owner's feed.
    {
      id: 'notif-foreign-1',
      providerId: OTHER_PROVIDER,
      event: 'payment_received',
      channel: 'in_app',
      payload: { txHash: 'c'.repeat(64) },
      sent: true,
      read: false,
      readAt: null,
      createdAt: new Date('2026-09-11T11:00:00.000Z'),
    },
  ];
}

// ── Prisma mock (in-memory, store-driven) ──────

jest.mock('@x402/database', () => ({
  prisma: {
    provider: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockImplementation(({ where }: any) => {
        if (where?.walletAddress === OWNER_WALLET) {
          return Promise.resolve([{ id: OWNED_PROVIDER }]);
        }
        if (where?.walletAddress === OTHER_WALLET) {
          return Promise.resolve([{ id: OTHER_PROVIDER }]);
        }
        return Promise.resolve([]);
      }),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn().mockResolvedValue(1),
    },
    route: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    payment: {
      create: jest.fn(),
      // Drives the rate-limit guard's server-verified wallet lookup: only a
      // CONFIRMED row for CONFIRMED_TX yields a verified payer address.
      findFirst: jest.fn().mockImplementation(({ where }: any) => {
        if (where?.txHash === CONFIRMED_TX && where?.status === 'confirmed') {
          return Promise.resolve({ id: 'pay-confirmed-001', payerAddress: OWNER_WALLET });
        }
        return Promise.resolve(null);
      }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
    },
    underpaymentDebt: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({}),
    },
    analyticsEvent: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0n }, _avg: { responseTime: 0 } }),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    notification: {
      create: jest.fn().mockImplementation(({ data }: any) => {
        const row: NotificationRow = {
          id: `notif-created-${notificationStore.length}`,
          providerId: data.providerId,
          event: data.event,
          channel: data.channel ?? 'in_app',
          payload: data.payload ?? {},
          sent: data.sent ?? true,
          read: false,
          readAt: null,
          createdAt: new Date(),
        };
        notificationStore.push(row);
        return Promise.resolve({ ...row });
      }),
      findMany: jest.fn().mockImplementation(({ where, take, skip }: any) => {
        let rows = notificationStore
          .filter((r) => matches(r, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        if (skip) rows = rows.slice(skip);
        if (take != null) rows = rows.slice(0, take);
        return Promise.resolve(rows.map((r) => ({ ...r })));
      }),
      findFirst: jest.fn().mockImplementation(({ where }: any) => {
        const row = notificationStore.find((r) => matches(r, where));
        return Promise.resolve(row ? { ...row } : null);
      }),
      count: jest.fn().mockImplementation(({ where }: any) => {
        return Promise.resolve(notificationStore.filter((r) => matches(r, where)).length);
      }),
      update: jest.fn().mockImplementation(({ where, data }: any) => {
        const row = notificationStore.find((r) => r.id === where?.id);
        if (!row) throw new Error('Record not found');
        Object.assign(row, data);
        return Promise.resolve({ ...row });
      }),
      updateMany: jest.fn().mockImplementation(({ where, data }: any) => {
        let count = 0;
        for (const row of notificationStore) {
          if (matches(row, where)) {
            Object.assign(row, data);
            count++;
          }
        }
        return Promise.resolve({ count });
      }),
    },
  },
  Prisma: {},
}));

const mockPrisma = jest.requireMock('@x402/database').prisma as any;

jest.mock('@x402/notifications', () => ({
  dispatcher: { dispatch: jest.fn().mockResolvedValue(['email']) },
  WebhookNotificationHandler: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue(true),
  })),
}));

jest.mock('../modules/x402/escrow-client', () => ({
  settleEscrow: jest.fn().mockResolvedValue(undefined),
  chargeEscrow: jest.fn().mockResolvedValue({ success: true }),
  refundEscrow: jest.fn().mockResolvedValue({ success: true }),
  getEscrowBalance: jest.fn().mockResolvedValue('0'),
}));

// ── In-memory Redis ────────────────────────────
// Must behave like a real store (get/set/del) because the auth challenge and
// session lifecycle is exercised end to end; `eval` backs rate limiting.

const evalKeys: string[] = [];

function createRedisMock() {
  const store = new Map<string, string>();
  return {
    store,
    eval: jest.fn().mockImplementation((_script: string, _n: number, key: string) => {
      evalKeys.push(key);
      return Promise.resolve(1);
    }),
    exists: jest.fn().mockResolvedValue(0),
    get: jest.fn().mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: jest.fn().mockImplementation((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    del: jest.fn().mockImplementation((key: string) => Promise.resolve(store.delete(key) ? 1 : 0)),
    on: jest.fn(),
    connect: jest.fn(),
    ping: jest.fn().mockResolvedValue('PONG'),
    quit: jest.fn().mockResolvedValue('OK'),
  };
}

// A single shared instance: Nest's `useValue` captures the object reference at
// compile time, so the store must be cleared per test rather than replaced.
const redisMock = createRedisMock();

jest.mock('ioredis', () => ({
  default: jest.fn().mockImplementation(() => createRedisMock()),
  Redis: jest.fn().mockImplementation(() => createRedisMock()),
}));

// ═══════════════════════════════════════════════════════════════════
// Persisted in-app notifications API
// ═══════════════════════════════════════════════════════════════════

describe('x402 Gateway E2E — Persisted Notifications Flow', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider('REDIS')
      .useValue(redisMock)
      .overrideProvider('PRISMA')
      .useValue(mockPrisma)
      .compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    delete process.env.AUTH_DEV_MODE;
    await app.close();
  });

  beforeEach(() => {
    seedNotifications();
    evalKeys.length = 0;
    redisMock.store.clear();
    jest.clearAllMocks();
  });

  /** Full wallet-auth round trip; returns the JWT plus the session cookie. */
  async function authenticate(address: string): Promise<{ token: string; cookie: string }> {
    const challenge = await request(app.getHttpServer())
      .post('/api/v1/auth/challenge')
      .send({ address })
      .expect(201);

    const verified = await request(app.getHttpServer())
      .post('/api/v1/auth/verify')
      .send({
        challengeId: challenge.body.challengeId,
        address,
        signature: `dev-sig-${address}-${Date.now()}`,
      })
      .expect(200);

    const setCookie = verified.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const sessionCookie = cookies.find((c: string) => c.startsWith('x402-session='));
    return { token: verified.body.token, cookie: sessionCookie ?? '' };
  }

  it('rejects unauthenticated reads with 401', async () => {
    await request(app.getHttpServer()).get('/api/v1/notifications').expect(401);
    await request(app.getHttpServer()).get('/api/v1/notifications/unread-count').expect(401);
    await request(app.getHttpServer()).post('/api/v1/notifications/read-all').expect(401);
  });

  it('rejects a forged session token with 401', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .set('Authorization', 'Bearer not-a-real-jwt')
      .expect(401);
  });

  it('authenticates with the cookie issued by /auth/verify and lists only owned notifications', async () => {
    const { cookie } = await authenticate(OWNER_WALLET);
    expect(cookie).toContain('x402-session=');
    expect(cookie).toContain('HttpOnly');

    const res = await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .set('Cookie', cookie)
      .expect(200);

    // Newest first, and the other wallet's row is never visible.
    expect(res.body.data.map((n: any) => n.id)).toEqual(['notif-unread-1', 'notif-read-1']);
    expect(res.body.total).toBe(2);
    expect(res.body.unread).toBe(1);
    expect(res.body.data[0]).toMatchObject({
      providerId: OWNED_PROVIDER,
      event: 'payment_received',
      read: false,
      readAt: null,
    });
    expect(res.body.data[0].payload).toEqual({ txHash: CONFIRMED_TX, amount: '1000000' });
  });

  it('supports unreadOnly and providerId filters plus pagination bounds', async () => {
    const { token } = await authenticate(OWNER_WALLET);
    const auth = { Authorization: `Bearer ${token}` };

    const unread = await request(app.getHttpServer())
      .get('/api/v1/notifications?unreadOnly=true')
      .set(auth)
      .expect(200);
    expect(unread.body.data.map((n: any) => n.id)).toEqual(['notif-unread-1']);
    expect(unread.body.total).toBe(1);

    const scoped = await request(app.getHttpServer())
      .get(`/api/v1/notifications?providerId=${OWNED_PROVIDER}&limit=1&offset=1`)
      .set(auth)
      .expect(200);
    expect(scoped.body.data).toHaveLength(1);
    expect(scoped.body.data[0].id).toBe('notif-read-1');
    expect(scoped.body.total).toBe(2);
    expect(scoped.body.limit).toBe(1);
    expect(scoped.body.offset).toBe(1);
  });

  it('clamps an oversized limit and rejects non-numeric pagination', async () => {
    const { token } = await authenticate(OWNER_WALLET);
    const auth = { Authorization: `Bearer ${token}` };

    const clamped = await request(app.getHttpServer())
      .get('/api/v1/notifications?limit=9999')
      .set(auth)
      .expect(200);
    expect(clamped.body.limit).toBe(200);

    await request(app.getHttpServer()).get('/api/v1/notifications?limit=abc').set(auth).expect(400);
    await request(app.getHttpServer()).get('/api/v1/notifications?offset=-5').set(auth).expect(400);
  });

  it("refuses to read another wallet's provider feed (404)", async () => {
    const { token } = await authenticate(OWNER_WALLET);

    await request(app.getHttpServer())
      .get(`/api/v1/notifications?providerId=${OTHER_PROVIDER}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    // The owning wallet can read the same provider id.
    const other = await authenticate(OTHER_WALLET);
    const res = await request(app.getHttpServer())
      .get(`/api/v1/notifications?providerId=${OTHER_PROVIDER}`)
      .set('Authorization', `Bearer ${other.token}`)
      .expect(200);
    expect(res.body.data.map((n: any) => n.id)).toEqual(['notif-foreign-1']);
  });

  it('reports the unread count and marks a single notification read', async () => {
    const { token } = await authenticate(OWNER_WALLET);
    const auth = { Authorization: `Bearer ${token}` };

    const before = await request(app.getHttpServer())
      .get('/api/v1/notifications/unread-count')
      .set(auth)
      .expect(200);
    expect(before.body).toEqual({ unread: 1 });

    const marked = await request(app.getHttpServer())
      .post('/api/v1/notifications/notif-unread-1/read')
      .set(auth)
      .expect(201);
    expect(marked.body.read).toBe(true);
    expect(marked.body.readAt).not.toBeNull();

    const after = await request(app.getHttpServer())
      .get('/api/v1/notifications/unread-count')
      .set(auth)
      .expect(200);
    expect(after.body).toEqual({ unread: 0 });

    // Read state survives a re-read (i.e. it is persisted, not in-memory only).
    const list = await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .set(auth)
      .expect(200);
    expect(list.body.data.find((n: any) => n.id === 'notif-unread-1').read).toBe(true);
  });

  it('returns 404 when marking an unknown or foreign notification read', async () => {
    const { token } = await authenticate(OWNER_WALLET);
    const auth = { Authorization: `Bearer ${token}` };

    await request(app.getHttpServer())
      .post('/api/v1/notifications/does-not-exist/read')
      .set(auth)
      .expect(404);

    // A row that exists but belongs to another wallet is indistinguishable
    // from a missing one — no cross-tenant existence oracle.
    await request(app.getHttpServer())
      .post('/api/v1/notifications/notif-foreign-1/read')
      .set(auth)
      .expect(404);
  });

  it('marks every owned notification read and scopes read-all by providerId', async () => {
    const { token } = await authenticate(OWNER_WALLET);
    const auth = { Authorization: `Bearer ${token}` };

    // Scoping read-all to a provider the wallet does not own is rejected.
    await request(app.getHttpServer())
      .post('/api/v1/notifications/read-all')
      .set(auth)
      .send({ providerId: OTHER_PROVIDER })
      .expect(404);

    const res = await request(app.getHttpServer())
      .post('/api/v1/notifications/read-all')
      .set(auth)
      .send({})
      .expect(201);
    expect(res.body.updated).toBe(1);

    const count = await request(app.getHttpServer())
      .get('/api/v1/notifications/unread-count')
      .set(auth)
      .expect(200);
    expect(count.body).toEqual({ unread: 0 });
  });

  it('rate-limits a confirmed payer by wallet, not by client IP', async () => {
    // The auth challenge endpoint is guarded by RateLimitGuard, so it
    // exercises the real bucket-key derivation.
    await request(app.getHttpServer())
      .post('/api/v1/auth/challenge')
      .set('X-Payment-Hash', CONFIRMED_TX)
      .send({ address: OWNER_WALLET })
      .expect(201);

    // The paid tier bucket must be keyed on the server-verified payer
    // address recorded on the confirmed payment row — never on a header.
    expect(evalKeys.some((key) => key === `x402:ratelimit:paid:wallet:${OWNER_WALLET}`)).toBe(true);

    // An unverified hash (no confirmed row) must NOT unlock the paid tier.
    evalKeys.length = 0;
    await request(app.getHttpServer())
      .post('/api/v1/auth/challenge')
      .set('X-Payment-Hash', 'f'.repeat(64))
      .send({ address: OWNER_WALLET })
      .expect(201);
    expect(evalKeys.every((key) => key.startsWith('x402:ratelimit:unpaid:ip:'))).toBe(true);
  });
});
