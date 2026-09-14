/** @jest-environment node */

import {
  resolveGatewayUrl,
  isGatewayConfigured,
  gatewayConfigError,
  DEV_GATEWAY_URL,
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
});
