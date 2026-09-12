import { Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@x402/database';
import { logger } from '@x402/logger';
import type { NotificationEvent } from '@x402/types';

/** Serialized in-app notification returned by the dashboard API. */
export interface InAppNotification {
  id: string;
  providerId: string;
  event: string;
  payload: Record<string, unknown>;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

/** Minimal shape of the Prisma `notification` delegate used here. */
interface NotificationDelegate {
  create(args: {
    data: {
      providerId: string;
      event: string;
      channel: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: any;
      sent: boolean;
    };
  }): Promise<unknown>;
}

/**
 * Persist an in-app notification in PostgreSQL.
 *
 * Best-effort by design: the notification feed is an observability affordance,
 * so a failure to persist must never break the payment/request path that
 * triggered it. Returns true when the row was written.
 *
 * Kept as a standalone function (rather than a DI method) so services that do
 * not depend on Nest's container — and tests that construct them directly —
 * can persist notifications without a module wiring change.
 */
export async function persistInAppNotification(
  providerId: string,
  event: NotificationEvent,
  data: Record<string, unknown>,
): Promise<boolean> {
  try {
    const delegate = (prisma as unknown as { notification?: NotificationDelegate }).notification;
    if (!delegate?.create) return false;
    await delegate.create({
      data: {
        providerId,
        event,
        channel: 'in_app',
        payload: data,
        sent: true,
      },
    });
    return true;
  } catch (error) {
    logger.warn('Failed to persist in-app notification', {
      providerId,
      event,
      error: String(error),
    });
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawNotification = Record<string, any>;

function toResponse(row: RawNotification): InAppNotification {
  return {
    id: row.id,
    providerId: row.providerId,
    event: row.event,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    read: !!row.read,
    readAt: row.readAt ? new Date(row.readAt).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

@Injectable()
export class NotificationsService {
  /** Provider IDs owned by the authenticated wallet. */
  private async getOwnedProviderIds(ownerAddress: string): Promise<string[]> {
    const providers = await prisma.provider.findMany({
      where: { walletAddress: ownerAddress },
      select: { id: true },
    });
    return providers.map((provider: { id: string }) => provider.id);
  }

  /**
   * List in-app notifications for the authenticated wallet's providers.
   * Cross-tenant reads are impossible: the query is always scoped to the
   * owned-provider set, and an explicit foreign providerId 404s.
   */
  async findAll(
    ownerAddress: string,
    options: { providerId?: string; unreadOnly?: boolean; limit?: number; offset?: number } = {},
  ): Promise<{
    data: InAppNotification[];
    total: number;
    unread: number;
    limit: number;
    offset: number;
  }> {
    const providerIds = await this.getOwnedProviderIds(ownerAddress);
    if (options.providerId && !providerIds.includes(options.providerId)) {
      throw new NotFoundException(`Provider ${options.providerId} not found`);
    }

    const where: Record<string, unknown> = {
      channel: 'in_app',
      providerId: options.providerId ?? { in: providerIds },
    };
    if (options.unreadOnly) where.read = false;

    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    const [rows, total, unread] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({
        where: { channel: 'in_app', providerId: { in: providerIds }, read: false },
      }),
    ]);

    return {
      data: rows.map(toResponse),
      total,
      unread,
      limit,
      offset,
    };
  }

  /** Unread in-app notification count for the wallet (dashboard badge). */
  async unreadCount(ownerAddress: string): Promise<number> {
    const providerIds = await this.getOwnedProviderIds(ownerAddress);
    return prisma.notification.count({
      where: { channel: 'in_app', providerId: { in: providerIds }, read: false },
    });
  }

  /** Mark one notification read (ownership-scoped). */
  async markRead(ownerAddress: string, id: string): Promise<InAppNotification> {
    const providerIds = await this.getOwnedProviderIds(ownerAddress);
    const row = await prisma.notification.findFirst({
      where: { id, channel: 'in_app', providerId: { in: providerIds } },
    });
    if (!row) throw new NotFoundException(`Notification ${id} not found`);

    const updated = await prisma.notification.update({
      where: { id },
      data: { read: true, readAt: new Date() },
    });
    return toResponse(updated);
  }

  /** Mark all of the wallet's in-app notifications read. */
  async markAllRead(ownerAddress: string, providerId?: string): Promise<number> {
    const providerIds = await this.getOwnedProviderIds(ownerAddress);
    if (providerId && !providerIds.includes(providerId)) {
      throw new NotFoundException(`Provider ${providerId} not found`);
    }
    const result = await prisma.notification.updateMany({
      where: {
        channel: 'in_app',
        providerId: providerId ?? { in: providerIds },
        read: false,
      },
      data: { read: true, readAt: new Date() },
    });
    return result.count;
  }
}
