import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { NotificationsService, persistInAppNotification } from './notifications.service';

jest.mock('@x402/database', () => ({
  prisma: {
    provider: {
      findMany: jest.fn(),
    },
    notification: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

import { prisma } from '@x402/database';

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const OWNER = 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F';
const OTHER_OWNER = 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK4G';

function mockOwnedProviders(ids: string[] = ['provider-1', 'provider-2']) {
  (mockPrisma.provider.findMany as jest.Mock).mockResolvedValue(ids.map((id) => ({ id })));
}

function notificationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    providerId: 'provider-1',
    event: 'payment_received',
    channel: 'in_app',
    payload: { txHash: 'abc' },
    sent: true,
    read: false,
    readAt: null,
    createdAt: new Date('2026-09-10T12:00:00.000Z'),
    ...overrides,
  };
}

describe('persistInAppNotification', () => {
  beforeEach(() => jest.clearAllMocks());

  it('writes an in_app notification row and reports success', async () => {
    (mockPrisma.notification.create as jest.Mock).mockResolvedValue({});

    const ok = await persistInAppNotification('p-1', 'payment_received', { txHash: 'abc' });

    expect(ok).toBe(true);
    expect(mockPrisma.notification.create).toHaveBeenCalledWith({
      data: {
        providerId: 'p-1',
        event: 'payment_received',
        channel: 'in_app',
        payload: { txHash: 'abc' },
        sent: true,
      },
    });
  });

  it('never throws when persistence fails (best-effort)', async () => {
    (mockPrisma.notification.create as jest.Mock).mockRejectedValue(new Error('db down'));

    await expect(
      persistInAppNotification('p-1', 'payment_received', { txHash: 'abc' }),
    ).resolves.toBe(false);
  });

  it('returns false without throwing when the delegate is unavailable', async () => {
    // The unit-test mock for @x402/database in other suites may omit the
    // notification delegate entirely — persistence must degrade gracefully.
    const original = (mockPrisma as unknown as { notification?: unknown }).notification;
    (mockPrisma as unknown as { notification?: unknown }).notification = undefined;
    try {
      await expect(persistInAppNotification('p-1', 'payment_received', {})).resolves.toBe(false);
    } finally {
      (mockPrisma as unknown as { notification?: unknown }).notification = original;
    }
  });
});

describe('NotificationsService', () => {
  let service: NotificationsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [NotificationsService],
    }).compile();
    service = module.get(NotificationsService);
    jest.clearAllMocks();
    mockOwnedProviders();
  });

  describe('findAll', () => {
    it('scopes the query to the wallet-owned providers and returns unread count', async () => {
      (mockPrisma.notification.findMany as jest.Mock).mockResolvedValue([notificationRow()]);
      (mockPrisma.notification.count as jest.Mock)
        .mockResolvedValueOnce(1) // total
        .mockResolvedValueOnce(1); // unread

      const result = await service.findAll(OWNER, { limit: 10, offset: 0 });

      expect(mockPrisma.provider.findMany).toHaveBeenCalledWith({
        where: { walletAddress: OWNER },
        select: { id: true },
      });
      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith({
        where: { channel: 'in_app', providerId: { in: ['provider-1', 'provider-2'] } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        skip: 0,
      });
      expect(result.total).toBe(1);
      expect(result.unread).toBe(1);
      expect(result.data[0]).toMatchObject({
        id: 'n1',
        providerId: 'provider-1',
        event: 'payment_received',
        read: false,
        readAt: null,
      });
    });

    it('filters to unread only when requested', async () => {
      (mockPrisma.notification.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.notification.count as jest.Mock).mockResolvedValue(0);

      await service.findAll(OWNER, { unreadOnly: true });

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            channel: 'in_app',
            providerId: { in: ['provider-1', 'provider-2'] },
            read: false,
          },
        }),
      );
    });

    it('404s for a provider the wallet does not own (no cross-tenant read)', async () => {
      await expect(service.findAll(OTHER_OWNER, { providerId: 'provider-3' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.notification.findMany).not.toHaveBeenCalled();
    });
  });

  describe('markRead', () => {
    it('marks an owned notification read', async () => {
      (mockPrisma.notification.findFirst as jest.Mock).mockResolvedValue(notificationRow());
      (mockPrisma.notification.update as jest.Mock).mockResolvedValue(
        notificationRow({ read: true, readAt: new Date('2026-09-11T00:00:00.000Z') }),
      );

      const result = await service.markRead(OWNER, 'n1');

      expect(mockPrisma.notification.update).toHaveBeenCalledWith({
        where: { id: 'n1' },
        data: { read: true, readAt: expect.any(Date) },
      });
      expect(result.read).toBe(true);
      expect(result.readAt).toBe('2026-09-11T00:00:00.000Z');
    });

    it('404s when the notification is not owned by the wallet', async () => {
      (mockPrisma.notification.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.markRead(OTHER_OWNER, 'n-foreign')).rejects.toThrow(NotFoundException);
      expect(mockPrisma.notification.update).not.toHaveBeenCalled();
    });
  });

  describe('markAllRead', () => {
    it('marks all owned notifications read and returns the count', async () => {
      (mockPrisma.notification.updateMany as jest.Mock).mockResolvedValue({ count: 3 });

      const updated = await service.markAllRead(OWNER);

      expect(updated).toBe(3);
      expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
        where: {
          channel: 'in_app',
          providerId: { in: ['provider-1', 'provider-2'] },
          read: false,
        },
        data: { read: true, readAt: expect.any(Date) },
      });
    });

    it('404s for a foreign provider filter', async () => {
      await expect(service.markAllRead(OTHER_OWNER, 'provider-3')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('unreadCount', () => {
    it('counts unread in-app notifications across owned providers', async () => {
      (mockPrisma.notification.count as jest.Mock).mockResolvedValue(4);

      await expect(service.unreadCount(OWNER)).resolves.toBe(4);
      expect(mockPrisma.notification.count).toHaveBeenCalledWith({
        where: {
          channel: 'in_app',
          providerId: { in: ['provider-1', 'provider-2'] },
          read: false,
        },
      });
    });
  });
});
