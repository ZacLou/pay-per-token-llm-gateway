import { Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@x402/database';
import type { AnalyticsEvent } from '@x402/analytics';
import type { AnalyticsSummary, TimeSeriesDataPoint } from '@x402/types';

/** Row shape returned by the Postgres time-series aggregation query. */
interface TimeSeriesBucketRow {
  bucket_epoch: bigint;
  paid_requests: bigint;
  unpaid_requests: bigint;
  revenue: bigint | null;
  failed_verifications: bigint;
}

@Injectable()
export class AnalyticsService {
  /**
   * Resolve the provider IDs owned by the authenticated wallet. All analytics
   * reads are scoped to this set — a wallet can never see another wallet's
   * events.
   */
  private async getOwnedProviderIds(ownerAddress: string): Promise<string[]> {
    const providers = await prisma.provider.findMany({
      where: { walletAddress: ownerAddress },
      select: { id: true },
    });
    return providers.map((provider: { id: string }) => provider.id);
  }

  /** Record an unpaid (402) request event. */
  async recordUnpaidRequest(route: string, providerId: string) {
    await prisma.analyticsEvent.create({
      data: { type: 'request:unpaid', route, providerId },
    });
  }

  /** Record a paid request with amount and response time. */
  async recordPaidRequest(
    route: string,
    providerId: string,
    callerAddress: string,
    amount: string,
    asset: string,
    responseTime?: number,
  ) {
    await prisma.analyticsEvent.create({
      data: {
        type: 'request:paid',
        route,
        providerId,
        callerAddress,
        amount: BigInt(amount),
        asset,
        responseTime,
      },
    });
  }

  /** Record a failed payment verification. */
  async recordPaymentFailed(route: string, providerId: string, callerAddress: string) {
    await prisma.analyticsEvent.create({
      data: {
        type: 'payment:failed',
        route,
        providerId,
        callerAddress,
      },
    });
  }

  /**
   * Get analytics summary using Prisma aggregation queries, scoped to the
   * authenticated wallet's providers.
   */
  async getSummary(ownerAddress: string, providerId?: string): Promise<AnalyticsSummary> {
    const providerIds = await this.getOwnedProviderIds(ownerAddress);
    // Ownership gate first — never construct a query for a resource the
    // caller cannot touch (404 instead of 403 so provider IDs can't be probed).
    if (providerId && !providerIds.includes(providerId)) {
      throw new NotFoundException(`Provider ${providerId} not found`);
    }
    const where: Record<string, unknown> = providerId
      ? { providerId }
      : { providerId: { in: providerIds } };

    const [totalCount, paidCount, unpaidCount, revenueResult, avgResponseResult] =
      await Promise.all([
        prisma.analyticsEvent.count({ where }),
        prisma.analyticsEvent.count({
          where: { ...where, type: 'request:paid' },
        }),
        prisma.analyticsEvent.count({
          where: { ...where, type: 'request:unpaid' },
        }),
        // Sum of amounts for paid USDC events
        prisma.analyticsEvent.aggregate({
          where: {
            ...where,
            type: 'request:paid',
            asset: 'USDC',
            amount: { not: null },
          },
          _sum: { amount: true },
        }),
        // Average response time across forwarded (paid) requests. This must
        // read `request:paid` — the event the proxy actually writes with a
        // `responseTime` — because nothing ever writes a separate forwarded
        // event. Reading a type that is never produced made this dashboard
        // metric a permanent 0ms.
        prisma.analyticsEvent.aggregate({
          where: {
            ...where,
            type: 'request:paid',
            responseTime: { not: null },
          },
          _avg: { responseTime: true },
        }),
      ]);

    // Top callers: group by callerAddress
    const topCallerRows = await prisma.analyticsEvent.groupBy({
      by: ['callerAddress'],
      where: {
        ...where,
        type: 'request:paid',
        callerAddress: { not: null },
      },
      _count: { id: true },
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: 10,
    });

    const topCallers = topCallerRows.map(
      (row: {
        callerAddress: string | null;
        _sum: { amount: bigint | null };
        _count: { id: number };
      }) => ({
        address: row.callerAddress ?? 'unknown',
        totalSpent: (row._sum.amount || 0n).toString(),
        requestCount: row._count.id,
      }),
    );

    // Top routes: group by route
    const topRouteRows = await prisma.analyticsEvent.groupBy({
      by: ['route'],
      where: { ...where, type: 'request:paid' },
      _count: { id: true },
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: 10,
    });

    const topRoutes = topRouteRows.map(
      (row: { route: string; _count: { id: number }; _sum: { amount: bigint | null } }) => ({
        path: row.route,
        requestCount: row._count.id,
        revenue: (row._sum.amount || 0n).toString(),
      }),
    );

    return {
      totalRequests: totalCount,
      paidRequests: paidCount,
      unpaidRequests: unpaidCount,
      totalRevenue: (revenueResult._sum.amount || 0n).toString(),
      revenueAsset: 'USDC',
      averageResponseTime: Math.round(avgResponseResult._avg.responseTime || 0),
      successRate: totalCount > 0 ? Math.round((paidCount / totalCount) * 10000) / 100 : 0,
      topCallers,
      topRoutes,
    };
  }

  /**
   * Get time-series data using a single Postgres aggregation query, scoped to
   * the authenticated wallet's providers. Uses epoch-arithmetic bucketing to
   * support arbitrary intervals without an unbounded `findMany`.
   */
  async getTimeSeries(
    providerId: string,
    ownerAddress: string,
    intervalMinutes = 60,
    durationHours = 24,
  ): Promise<TimeSeriesDataPoint[]> {
    const providerIds = await this.getOwnedProviderIds(ownerAddress);
    if (!providerIds.includes(providerId)) {
      throw new NotFoundException(`Provider ${providerId} not found`);
    }

    const now = new Date();
    const intervalMs = intervalMinutes * 60 * 1000;
    const intervalSeconds = intervalMinutes * 60;

    // Align the window start DOWN to an interval boundary. SQL buckets with
    // `floor(epoch / interval) * interval`, so unaligned boundaries (e.g. a
    // `now` of 12:34:56 with a 60-minute interval) produce bucket timestamps
    // the zero-filled map does not contain — every row would be silently
    // dropped. Aligning both sides to the same grid is what makes the SQL
    // result actually land in the output buckets.
    const windowStartMs =
      Math.floor((now.getTime() - durationHours * 60 * 60 * 1000) / intervalMs) * intervalMs;
    const startTime = new Date(windowStartMs);

    // One SQL query: aggregate time-series data using Postgres so the
    // database does the bucketing — no unbounded findMany into memory.
    const rows = await prisma.$queryRaw<TimeSeriesBucketRow[]>`
      SELECT
        (EXTRACT(EPOCH FROM "createdAt")::bigint / ${intervalSeconds})::bigint * ${intervalSeconds} AS bucket_epoch,
        COUNT(*) FILTER (WHERE type = 'request:paid')::int AS paid_requests,
        COUNT(*) FILTER (WHERE type = 'request:unpaid')::int AS unpaid_requests,
        COALESCE(SUM(amount) FILTER (WHERE type = 'request:paid'), 0) AS revenue,
        COUNT(*) FILTER (WHERE type = 'payment:failed')::int AS failed_verifications
      FROM "AnalyticsEvent"
      WHERE "providerId" = ${providerId}
        AND "createdAt" >= ${startTime}
        AND "createdAt" <= ${now}
      GROUP BY bucket_epoch
      ORDER BY bucket_epoch
    `;

    // Build zero-filled buckets on the same grid the SQL query groups by.
    const buckets: Map<number, TimeSeriesDataPoint> = new Map();

    for (let t = windowStartMs; t <= now.getTime(); t += intervalMs) {
      buckets.set(t, {
        timestamp: new Date(t).toISOString(),
        paidRequests: 0,
        unpaidRequests: 0,
        revenue: '0',
        failedVerifications: 0,
      });
    }

    // Fill buckets from SQL results
    for (const row of rows) {
      const bucketTime = Number(row.bucket_epoch) * 1000; // epoch seconds → ms
      const bucket = buckets.get(bucketTime);
      if (!bucket) continue;

      bucket.paidRequests = Number(row.paid_requests);
      bucket.unpaidRequests = Number(row.unpaid_requests);
      bucket.revenue = (row.revenue ?? 0n).toString();
      bucket.failedVerifications = Number(row.failed_verifications);
    }

    return Array.from(buckets.values()).sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  }

  /**
   * Get raw events for audit/debugging, scoped to the authenticated wallet's
   * providers.
   */
  async getEvents(
    ownerAddress: string,
    filter?: {
      providerId?: string;
      type?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<AnalyticsEvent[]> {
    const providerIds = await this.getOwnedProviderIds(ownerAddress);
    const where: Record<string, unknown> = filter?.providerId
      ? { providerId: filter.providerId }
      : { providerId: { in: providerIds } };
    if (filter?.providerId && !providerIds.includes(filter.providerId)) {
      throw new NotFoundException(`Provider ${filter.providerId} not found`);
    }
    if (filter?.type) where.type = filter.type;

    const rows = await prisma.analyticsEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: filter?.offset || 0,
      take: filter?.limit || 100,
    });

    return rows.map(
      (row: {
        type: string;
        route: string;
        providerId: string;
        callerAddress: string | null;
        amount: bigint | null;
        asset: string | null;
        responseTime: number | null;
      }) => ({
        type: row.type as AnalyticsEvent['type'],
        route: row.route,
        providerId: row.providerId,
        callerAddress: row.callerAddress || undefined,
        amount: row.amount?.toString() || undefined,
        asset: row.asset || undefined,
        responseTime: row.responseTime || undefined,
      }),
    );
  }
}
