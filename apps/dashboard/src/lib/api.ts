/**
 * Gateway API client.
 * Calls the NestJS gateway directly (CORS is configured for dashboard origin).
 *
 * Auth strategy (defense in depth):
 *   1. httpOnly cookie — primary, works same-origin (localhost dev,
 *      Vercel + Railway production with HTTPS). Set by /auth/verify.
 *   2. Authorization header — fallback for cross-origin deployments
 *      where cookies can't be sent (Vercel HTTPS → localhost HTTP).
 *      Token is stored in memory only, never localStorage (XSS-safe).
 */
import { resolveGatewayUrl, gatewayConfigError } from './gatewayUrl';

const GATEWAY_URL = resolveGatewayUrl();
const BASE = `${GATEWAY_URL}/api/v1`;

/**
 * Hard ceiling on a single gateway call.
 *
 * Without it, an unreachable gateway (dead host, a black-holed proxy, or a
 * browser blocking a private-network request from an HTTPS page) leaves the
 * fetch promise pending for as long as the platform's TCP timeout allows.
 * Every dashboard request stays "in flight", so the navbar renders a
 * permanent `Connecting...` and each page a permanent loading state — the
 * exact symptom the deployed dashboard showed against its inlined
 * `localhost:3000`. 15s is far above a healthy round-trip and far below a
 * user's patience.
 */
export const REQUEST_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_API_TIMEOUT_MS) || 15_000;

/**
 * In-memory session token for cross-origin fallback.
 * Cleared on page refresh — not persistent, not accessible to XSS.
 */
let sessionToken: string | null = null;

/** Store the session token in memory (cross-origin fallback). */
export function setSessionToken(token: string): void {
  sessionToken = token;
}

/** Store the connected wallet address (UI display only, not a secret). */
export function setWalletAddress(address: string): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem('x402-wallet-address', address);
  }
}

/** Get the stored wallet address (UI display only). */
export function getWalletAddress(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('x402-wallet-address');
}

/**
 * Check for a legacy localStorage session token from before the httpOnly
 * cookie migration. If found, it is consumed once for migration then removed.
 */
function consumeLegacyToken(): string | null {
  if (typeof window === 'undefined') return null;
  const token = localStorage.getItem('x402-session-token');
  if (token) {
    localStorage.removeItem('x402-session-token');
    sessionToken = token;
  }
  return token;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  // Fail fast with an actionable message rather than firing a request at an
  // empty base URL (or, worse, an unintended localhost).
  const configError = gatewayConfigError();
  if (configError) {
    throw new Error(configError);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options?.headers as Record<string, string>) || {}),
  };

  // Migration: consume any legacy localStorage token into in-memory store.
  consumeLegacyToken();

  // Cross-origin fallback: send the token as Authorization header.
  // The gateway checks the httpOnly cookie first (primary); this header
  // covers deployments where cookies can't be sent cross-origin.
  if (sessionToken && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${sessionToken}`;
  }

  // Bound every call so a hanging request surfaces as an error the UI can
  // render instead of an indefinite spinner. A caller-supplied signal is
  // composed in so callers can still cancel earlier than the timeout.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  const external = options?.signal ?? null;
  const relayAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', relayAbort, { once: true });
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...options,
      headers,
      credentials: 'include',
      signal: controller.signal,
    });
  } catch (err) {
    if (timedOut) {
      throw new Error(
        `Gateway request to ${GATEWAY_URL} timed out after ${REQUEST_TIMEOUT_MS}ms. ` +
          'The gateway is unreachable from this browser — verify NEXT_PUBLIC_GATEWAY_URL and that ' +
          "the gateway's CORS_ORIGINS includes this dashboard's origin.",
      );
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener('abort', relayAbort);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gateway error ${res.status}: ${body}`);
  }

  // A 2xx with an empty body is a *successful* call with nothing to parse:
  // DELETE /routes/:id and DELETE /providers/:id both answer `204 No Content`.
  // Calling `res.json()` on that throws "Unexpected end of JSON input", which
  // the Routes and Settings pages render as a failed delete for a delete the
  // gateway actually performed. Found by the dashboard E2E's write-path check.
  const body = await res.text();
  if (!body) return undefined as T;
  return JSON.parse(body) as T;
}

// ── Auth ────────────────────────────────────

export interface ChallengeResponse {
  challengeId: string;
  challenge: string;
}

export interface VerifyResponse {
  verified: boolean;
  address: string;
  /** JWT session token (for cross-origin Authorization header fallback). */
  token?: string;
}

export interface SessionResponse {
  address: string;
  sessionId: string;
}

export function requestChallenge(address: string): Promise<ChallengeResponse> {
  return request<ChallengeResponse>('/auth/challenge', {
    method: 'POST',
    body: JSON.stringify({ address }),
  });
}

export function verifyChallenge(
  challengeId: string,
  address: string,
  signature: string,
): Promise<VerifyResponse> {
  // The gateway sets an httpOnly cookie (x402-session) and also returns
  // the token for in-memory cross-origin fallback.
  return request<VerifyResponse>('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId, address, signature }),
  });
}

export function validateSession(): Promise<SessionResponse> {
  return request<SessionResponse>('/auth/session');
}

export function endSession(): Promise<void> {
  return request<void>('/auth/session', { method: 'DELETE' });
}

// ── Payments ────────────────────────────────

export interface PaymentResponse {
  id: string;
  quoteId: string;
  txHash: string | null;
  payerAddress: string | null;
  amount: string;
  asset: string;
  status: string;
  verifiedAt: string | null;
  routeId: string;
  providerId: string;
  createdAt: string;
}

export interface PaginatedPayments {
  data: PaymentResponse[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export function fetchPayments(params?: {
  providerId?: string;
  status?: string;
  payerAddress?: string;
  page?: number;
  limit?: number;
}): Promise<PaginatedPayments> {
  const qs = new URLSearchParams();
  if (params?.providerId) qs.set('providerId', params.providerId);
  if (params?.status) qs.set('status', params.status);
  if (params?.payerAddress) qs.set('payerAddress', params.payerAddress);
  if (params?.page) qs.set('page', String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  const query = qs.toString();
  return request<PaginatedPayments>(`/payments${query ? `?${query}` : ''}`);
}

// ── Routes ───────────────────────────────────

export interface RouteResponse {
  id: string;
  providerId: string;
  path: string;
  upstreamUrl: string;
  model: string;
  pricingModel: 'flat' | 'per_token';
  flatPrice?: string;
  perTokenPrice?: string;
  acceptedAssets: string[];
  rateLimit: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export function fetchRoutes(providerId?: string): Promise<RouteResponse[]> {
  return request<RouteResponse[]>(`/routes${providerId ? `?providerId=${providerId}` : ''}`);
}

export function createRoute(data: {
  providerId: string;
  path: string;
  upstreamUrl: string;
  model: string;
  pricingModel: 'flat' | 'per_token';
  flatPrice?: string;
  perTokenPrice?: string;
  acceptedAssets?: string[];
  rateLimit?: number;
}): Promise<RouteResponse> {
  return request<RouteResponse>('/routes', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateRoute(id: string, data: Partial<RouteResponse>): Promise<RouteResponse> {
  return request<RouteResponse>(`/routes/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteRoute(id: string): Promise<void> {
  return request<void>(`/routes/${id}`, { method: 'DELETE' });
}

// ── Analytics ────────────────────────────────

export interface AnalyticsSummary {
  totalRequests: number;
  paidRequests: number;
  unpaidRequests: number;
  totalRevenue: string;
  revenueAsset: string;
  averageResponseTime: number;
  successRate: number;
  topCallers: Array<{ address: string; totalSpent: string; requestCount: number }>;
  topRoutes: Array<{ path: string; requestCount: number; revenue: string }>;
}

export interface TimeSeriesPoint {
  timestamp: string;
  paidRequests: number;
  unpaidRequests: number;
  revenue: string;
  failedVerifications: number;
}

export function fetchAnalyticsSummary(providerId?: string): Promise<AnalyticsSummary> {
  return request<AnalyticsSummary>(
    `/analytics/summary${providerId ? `?providerId=${providerId}` : ''}`,
  );
}

export function fetchTimeSeries(
  providerId: string,
  intervalMinutes?: number,
  durationHours?: number,
): Promise<TimeSeriesPoint[]> {
  const qs = new URLSearchParams({ providerId });
  if (intervalMinutes) qs.set('intervalMinutes', String(intervalMinutes));
  if (durationHours) qs.set('durationHours', String(durationHours));
  return request<TimeSeriesPoint[]>(`/analytics/timeseries?${qs.toString()}`);
}

// ── Escrow ───────────────────────────────────

export interface EscrowBalance {
  address: string;
  balance: string;
  asset: string;
  contractId: string;
}

/**
 * Read a wallet's prepaid credit-escrow balance.
 *
 * Read-only and permissionless on the gateway — no session is required, so
 * this works before sign-in. Routed through `BASE` like every other call: a
 * relative `/api/v1/...` fetch would resolve against the dashboard's own
 * origin, which serves no API routes, and 404 without ever reaching the
 * gateway.
 */
export function fetchEscrowBalance(address: string): Promise<EscrowBalance> {
  return request<EscrowBalance>(`/escrow/${encodeURIComponent(address)}/balance`);
}

// ── Admin / Audit ────────────────────────────

export interface AuditLogEntry {
  id: string;
  action: string;
  entity: string;
  entityId?: string;
  actor?: string;
  details?: Record<string, unknown>;
  ip?: string;
  createdAt: string;
}

export interface PaginatedAuditLogs {
  data: AuditLogEntry[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export function fetchAuditLogs(params?: {
  page?: number;
  limit?: number;
  action?: string;
  entity?: string;
}): Promise<PaginatedAuditLogs> {
  const qs = new URLSearchParams();
  if (params?.page) qs.set('page', String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.action) qs.set('action', params.action);
  if (params?.entity) qs.set('entity', params.entity);
  const query = qs.toString();
  return request<PaginatedAuditLogs>(`/admin/audit${query ? `?${query}` : ''}`);
} // ── Notifications ────────────────────────────

export interface InAppNotification {
  id: string;
  providerId: string;
  event: string;
  payload: Record<string, unknown>;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface PaginatedNotifications {
  data: InAppNotification[];
  total: number;
  unread: number;
  limit: number;
  offset: number;
}

/** Persisted in-app notifications for the authenticated wallet's providers. */
export function fetchNotifications(params?: {
  providerId?: string;
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
}): Promise<PaginatedNotifications> {
  const qs = new URLSearchParams();
  if (params?.providerId) qs.set('providerId', params.providerId);
  if (params?.unreadOnly) qs.set('unreadOnly', 'true');
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  const query = qs.toString();
  return request<PaginatedNotifications>(`/notifications${query ? `?${query}` : ''}`);
}

export function fetchUnreadNotificationCount(): Promise<{ unread: number }> {
  return request<{ unread: number }>('/notifications/unread-count');
}

export function markNotificationRead(id: string): Promise<InAppNotification> {
  return request<InAppNotification>(`/notifications/${encodeURIComponent(id)}/read`, {
    method: 'POST',
  });
}

export function markAllNotificationsRead(providerId?: string): Promise<{ updated: number }> {
  return request<{ updated: number }>('/notifications/read-all', {
    method: 'POST',
    body: JSON.stringify(providerId ? { providerId } : {}),
  });
}

// ── Webhooks ─────────────────────────────────
export function sendWebhookTest(webhookUrl: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('/webhooks/test', {
    method: 'POST',
    body: JSON.stringify({ webhookUrl }),
  });
}

// ── Providers ────────────────────────────────

export interface ProviderResponse {
  id: string;
  name: string;
  walletAddress: string;
  payoutWalletAddress?: string;
  webhookUrl?: string;
  active: boolean;
  metadata?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export function fetchProviders(): Promise<ProviderResponse[]> {
  return request<ProviderResponse[]>('/providers');
}

export function createProvider(data: {
  name: string;
  payoutWalletAddress?: string;
  webhookUrl?: string;
  webhookSecret?: string;
}): Promise<ProviderResponse> {
  return request<ProviderResponse>('/providers', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateProvider(
  id: string,
  data: Partial<ProviderResponse> & { webhookSecret?: string },
): Promise<ProviderResponse> {
  return request<ProviderResponse>(`/providers/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}
