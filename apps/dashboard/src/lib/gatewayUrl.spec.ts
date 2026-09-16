/** @jest-environment node */

import {
  resolveGatewayUrl,
  resolveGatewayRouting,
  isGatewayConfigured,
  isSameOriginMode,
  gatewayConfigError,
  DEV_GATEWAY_URL,
  API_PATH_PREFIX,
  type GatewayEnv,
} from './gatewayUrl';

const GATEWAY = 'https://x402-gateway.up.railway.app';

function env(overrides: Partial<GatewayEnv> = {}): GatewayEnv {
  return { NODE_ENV: 'development', ...overrides };
}

describe('gateway URL resolution', () => {
  describe('resolveGatewayUrl', () => {
    it('uses the configured URL when set', () => {
      expect(resolveGatewayUrl(env({ NEXT_PUBLIC_GATEWAY_URL: GATEWAY }))).toBe(GATEWAY);
    });

    it('falls back to localhost in development', () => {
      expect(resolveGatewayUrl(env())).toBe(DEV_GATEWAY_URL);
    });

    it('fails closed in production instead of silently aiming at localhost', () => {
      // Regression: the deployed Vercel build inlined the localhost default and
      // every API call failed against the visitor's own machine.
      expect(resolveGatewayUrl(env({ NODE_ENV: 'production' }))).toBe('');
    });

    it('treats a whitespace-only value as unset', () => {
      expect(
        resolveGatewayUrl(env({ NODE_ENV: 'production', NEXT_PUBLIC_GATEWAY_URL: '   ' })),
      ).toBe('');
    });

    it('strips trailing slashes so path joins do not double up', () => {
      expect(resolveGatewayUrl(env({ NEXT_PUBLIC_GATEWAY_URL: `${GATEWAY}/` }))).toBe(GATEWAY);
      expect(resolveGatewayUrl(env({ NEXT_PUBLIC_GATEWAY_URL: `${GATEWAY}///` }))).toBe(GATEWAY);
    });

    it('trims surrounding whitespace around a configured value', () => {
      expect(resolveGatewayUrl(env({ NEXT_PUBLIC_GATEWAY_URL: `  ${GATEWAY}  ` }))).toBe(GATEWAY);
    });
  });

  describe('isGatewayConfigured', () => {
    it('is true with a configured URL', () => {
      expect(isGatewayConfigured(env({ NEXT_PUBLIC_GATEWAY_URL: GATEWAY }))).toBe(true);
    });

    it('is false for an unconfigured production build', () => {
      expect(isGatewayConfigured(env({ NODE_ENV: 'production' }))).toBe(false);
    });

    it('is true for an unconfigured development build (localhost default)', () => {
      expect(isGatewayConfigured(env())).toBe(true);
    });
  });

  describe('gatewayConfigError', () => {
    it('returns null when configuration is usable', () => {
      expect(gatewayConfigError(env({ NEXT_PUBLIC_GATEWAY_URL: GATEWAY }))).toBeNull();
    });

    it('names the missing variable and the build-time caveat', () => {
      const message = gatewayConfigError(env({ NODE_ENV: 'production' }));
      expect(message).toContain('NEXT_PUBLIC_GATEWAY_URL');
      expect(message).toContain('build time');
    });
  });

  describe('same-origin routing', () => {
    const sameOrigin = (overrides: Partial<GatewayEnv> = {}) =>
      env({ NODE_ENV: 'production', NEXT_PUBLIC_GATEWAY_SAME_ORIGIN: 'true', ...overrides });

    it('is off unless the flag is exactly "true"', () => {
      expect(isSameOriginMode(env({ NEXT_PUBLIC_GATEWAY_URL: GATEWAY }))).toBe(false);
      expect(isSameOriginMode(sameOrigin({ NEXT_PUBLIC_GATEWAY_URL: GATEWAY }))).toBe(true);
      expect(isSameOriginMode(sameOrigin({ NEXT_PUBLIC_GATEWAY_SAME_ORIGIN: '1' }))).toBe(false);
      expect(isSameOriginMode(sameOrigin({ NEXT_PUBLIC_GATEWAY_SAME_ORIGIN: ' yes ' }))).toBe(
        false,
      );
    });

    it('calls its own origin at /api/v1 and keeps the proxy target for diagnostics', () => {
      const routing = resolveGatewayRouting(sameOrigin({ NEXT_PUBLIC_GATEWAY_URL: GATEWAY }));

      // The request base is relative: the browser must never dial the gateway
      // origin directly, or the cookie goes back to being third-party.
      expect(routing.mode).toBe('same-origin');
      expect(routing.apiBase).toBe(API_PATH_PREFIX);
      expect(routing.apiBase.startsWith('http')).toBe(false);
      // …and the target is still reported, so a failing proxy is diagnosable.
      expect(routing.base).toBe(GATEWAY);
      expect(routing.label).toContain(GATEWAY);
    });

    it('fails closed in production when the flag is on but there is no proxy target', () => {
      // A relative base with nothing proxying it would 404 on every call — the
      // same class of silent breakage as the localhost fallback.
      const routing = resolveGatewayRouting(sameOrigin());
      expect(routing.mode).toBe('unconfigured');
      expect(routing.apiBase).toBe('');
      expect(isGatewayConfigured(sameOrigin())).toBe(false);
      expect(gatewayConfigError(sameOrigin())).toContain('NEXT_PUBLIC_GATEWAY_SAME_ORIGIN=true');
    });

    it('uses the development default as the proxy target in development', () => {
      const routing = resolveGatewayRouting(env({ NEXT_PUBLIC_GATEWAY_SAME_ORIGIN: 'true' }));
      expect(routing.mode).toBe('same-origin');
      expect(routing.apiBase).toBe(API_PATH_PREFIX);
      expect(routing.base).toBe(DEV_GATEWAY_URL);
    });

    it('keeps absolute routing when the flag is off', () => {
      const routing = resolveGatewayRouting(env({ NEXT_PUBLIC_GATEWAY_URL: GATEWAY }));
      expect(routing.mode).toBe('absolute');
      expect(routing.apiBase).toBe(`${GATEWAY}${API_PATH_PREFIX}`);
    });
  });
});
