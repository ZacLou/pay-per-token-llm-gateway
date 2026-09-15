import { Injectable } from '@nestjs/common';
import { createHmac } from 'crypto';
import { isIP } from 'net';
import { lookup } from 'dns/promises';
import { dispatcher, WebhookNotificationHandler } from '@x402/notifications';
import { prisma } from '@x402/database';
import { persistInAppNotification } from '../notifications/notifications.service';
import { logger } from '@x402/logger';
import type { NotificationEvent } from '@x402/types';

/** SSRF guard: only public HTTPS endpoints may be webhook targets. */
export async function validateWebhookUrl(url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid webhook URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Webhook URL must use HTTPS');
  }

  // Resolve the hostname and reject private / loopback / link-local / CGNAT
  // ranges and the cloud metadata IP — a webhook endpoint must never reach
  // internal infrastructure.
  let addresses: string[];
  try {
    addresses = (await lookup(parsed.hostname, { all: true })).map((a) => a.address);
  } catch {
    throw new Error('Webhook hostname could not be resolved');
  }
  if (addresses.length === 0) {
    throw new Error('Webhook hostname could not be resolved');
  }

  for (const addr of addresses) {
    if (!isPublicIp(addr)) {
      throw new Error('Webhook URL must point to a public IP address');
    }
  }

  return url;
}

/**
 * True when `ip` is a routable public address (safe as an SSRF target).
 *
 * Fail-closed by construction: anything that cannot be classified is refused.
 * IPv6 needs more care than the string-prefix checks it used to do — `::` (the
 * unspecified address) *connects to localhost* on Linux and matched no prefix,
 * so it was classified as public; `ff00::/8` multicast, IPv4-compatible
 * `::a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16` (which carries an
 * arbitrary IPv4 in groups 1–2) and Teredo `2001:0::/32` all passed as well.
 * The address is now expanded to its eight groups and admitted only when it is
 * global unicast (`2000::/3`) with no embedded private IPv4.
 */
export function isPublicIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPublicIpv4(ip);
  if (family === 6) return isPublicIpv6(ip);
  return false;
}

function isPublicIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return false;
  const [a, b] = parts;
  if (a === 0) return false; // 0.0.0.0/8 "this host"
  if (a === 10) return false; // 10.0.0.0/8
  if (a === 127) return false; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return false; // 169.254.0.0/16 (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
  if (a === 192 && b === 168) return false; // 192.168.0.0/16
  if (a === 192 && b === 0) return false; // 192.0.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18.0.0/15 benchmarking
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 CGNAT
  if (a >= 224) return false; // multicast + reserved
  return true;
}

/**
 * Expand an IPv6 address to its eight 16-bit groups (or `null` when it cannot
 * be parsed). A trailing dotted-quad is folded into the low two groups.
 */
function ipv6Groups(raw: string): number[] | null {
  let head = raw.toLowerCase();
  const v4 = head.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const parts = v4[1].split('.').map(Number);
    if (parts.some((n) => n > 255)) return null;
    const hi = ((parts[0] << 8) | parts[1]).toString(16);
    const lo = ((parts[2] << 8) | parts[3]).toString(16);
    head = `${head.slice(0, v4.index)}${hi}:${lo}`;
  }

  const halves = head.split('::');
  if (halves.length > 2) return null; // more than one '::'
  const [left, right] = halves;
  const l = left ? left.split(':') : [];
  const r = right ? right.split(':') : [];
  const missing = 8 - l.length - r.length;
  // '::' must stand for at least one group; a full address cannot contain it.
  if (right !== undefined && missing < 1) return null;
  if (right === undefined && l.length !== 8) return null;

  const groups = [...l, ...Array(right === undefined ? 0 : missing).fill('0'), ...r];
  if (groups.length !== 8) return null;
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function isPublicIpv6(ip: string): boolean {
  const groups = ipv6Groups(ip);
  if (!groups) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;

  // IPv4-mapped (::ffff:a.b.c.d) — classify the embedded IPv4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPublicIpv4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
  }

  // Only global unicast (2000::/3) is acceptable. This refuses the unspecified
  // address `::` (connects to localhost), `::1` loopback, IPv4-compatible
  // `::a.b.c.d`, NAT64 `64:ff9b::/96`, fc00::/7 unique-local, fe80::/10
  // link-local and ff00::/8 multicast in one rule.
  if (g0 < 0x2000 || g0 > 0x3fff) return false;

  // 6to4 (2002::/16) embeds an arbitrary IPv4 in groups 1–2 — classify it.
  if (g0 === 0x2002) {
    return isPublicIpv4(`${g1 >> 8}.${g1 & 0xff}.${g2 >> 8}.${g2 & 0xff}`);
  }

  // Teredo (2001:0::/32) tunnels IPv4 with an obfuscated address — refuse it.
  if (g0 === 0x2001 && g1 === 0x0000) return false;

  return true;
}

/** HMAC-SHA256 signature over the raw payload, hex-encoded. */
export function signWebhookPayload(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * SSRF guard for upstream LLM URLs configured in routes.
 *
 * Unlike webhooks (HTTPS-only), upstream URLs may use HTTP (many LLM APIs
 * and internal proxies run over plain HTTP). The guard still enforces that
 * the resolved hostname points to a public IP address — internal/private
 * infrastructure must never be reachable through the proxy.
 *
 * DNS resolution is performed here at configuration time and re-checked at
 * proxy time (`ProxyService.isUpstreamHostPublic`, 60 s cache) to catch DNS
 * rebinding between save and send. Redirects are refused at proxy time, so a
 * malicious upstream cannot bounce the request to an internal address.
 */
export async function validateUpstreamUrl(url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid upstream URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Upstream URL must use HTTP or HTTPS');
  }

  // Resolve the hostname and reject private / loopback / link-local / CGNAT
  // ranges and the cloud metadata IP.
  let addresses: string[];
  try {
    addresses = (await lookup(parsed.hostname, { all: true })).map((a) => a.address);
  } catch {
    throw new Error('Upstream hostname could not be resolved');
  }
  if (addresses.length === 0) {
    throw new Error('Upstream hostname could not be resolved');
  }

  for (const addr of addresses) {
    if (!isPublicIp(addr)) {
      throw new Error('Upstream URL must point to a public IP address');
    }
  }

  return url;
}

@Injectable()
export class WebhooksService {
  /**
   * Dispatch a notification to all registered channels for a provider.
   * Also delivers a signed webhook when the provider configured a webhookUrl.
   */
  async notify(providerId: string, event: NotificationEvent, data: Record<string, unknown>) {
    const channels: string[] = [];

    // Persist the in-app notification in PostgreSQL so the dashboard feed
    // survives restarts and is shared across gateway instances. The package
    // dispatcher's in-app handler only keeps an in-memory queue, so this is
    // the durable path. Best-effort — never blocks or fails the caller.
    if (await persistInAppNotification(providerId, event, data)) {
      channels.push('in_app');
    }

    try {
      const delivered = await dispatcher.dispatch({ providerId, event, data });
      for (const channel of delivered) {
        if (!channels.includes(channel)) channels.push(channel);
      }
    } catch (error) {
      logger.error('Notification dispatch failed', { providerId, event, error: String(error) });
    }

    // Real webhook delivery to the provider's configured endpoint.
    try {
      const provider = await prisma.provider.findUnique({
        where: { id: providerId },
        select: { webhookUrl: true, webhookSecret: true },
      });
      const webhookUrl = provider?.webhookUrl;
      if (webhookUrl) {
        // Re-validate at delivery time: DNS answers can change between save
        // and send (DNS-rebinding TOCTOU), so the SSRF guard must be applied
        // here too — not only when the URL was configured.
        await validateWebhookUrl(webhookUrl);
        const handler = new WebhookNotificationHandler({ retryCount: 3, retryDelayMs: 1000 });
        const ok = await handler.sendWithSignature(
          { providerId, event, data },
          webhookUrl,
          provider?.webhookSecret || undefined,
        );
        if (ok) channels.push('webhook');
      }
    } catch (error) {
      logger.error('Provider webhook delivery failed', { providerId, event, error: String(error) });
    }

    logger.info('Notification dispatched', { providerId, event, channels });
    return { success: channels.length > 0, channels };
  }

  /**
   * Send a payment received notification.
   */
  async notifyPaymentReceived(
    providerId: string,
    data: { txHash: string; amount: string; asset: string; payerAddress: string },
  ) {
    return this.notify(providerId, 'payment_received', data);
  }

  /**
   * Send a verification failure notification.
   */
  async notifyVerificationFailed(providerId: string, data: { txHash: string; reason: string }) {
    return this.notify(providerId, 'verification_failed', data);
  }

  /**
   * Send a test webhook. Validates the target URL against SSRF first.
   */
  async sendWebhook(webhookUrl: string, payload: Record<string, unknown>): Promise<boolean> {
    const validated = await validateWebhookUrl(webhookUrl);
    const { WebhookNotificationHandler } = await import('@x402/notifications');
    const handler = new WebhookNotificationHandler({ retryCount: 3, retryDelayMs: 1000 });
    return handler.send(
      {
        providerId: 'system',
        event: 'request_forwarded',
        data: payload,
      },
      validated,
    );
  }
}
