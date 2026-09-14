// ──────────────────────────────────────────────
// @x402/analytics — Analytics types (persistence via Prisma in gateway)
// ──────────────────────────────────────────────

import type { StellarAddress } from '@x402/types';

export interface AnalyticsEvent {
  /**
   * Only the event types the gateway actually writes. `payment:verified` and
   * `request:forwarded` were declared but never produced by any code path, so
   * anything built on them read as permanently zero.
   */
  type: 'request:paid' | 'request:unpaid' | 'payment:failed';
  route: string;
  providerId: string;
  callerAddress?: StellarAddress;
  amount?: string;
  asset?: string;
  responseTime?: number;
}
