/**
 * Gateway target and the same-origin proxy that sits in front of it.
 *
 * Mirrors `src/lib/gatewayUrl.ts` (this file is CommonJS and evaluated at build
 * time, so it cannot import the TypeScript helper). A production build with no
 * configured gateway gets NO rewrite at all: silently rewriting to
 * `http://localhost:3000` is what made the deployed dashboard appear to "load
 * forever" while every API call failed against the visitor's own machine.
 *
 * With `NEXT_PUBLIC_GATEWAY_SAME_ORIGIN=true` the client calls `/api/v1/*` on
 * its own origin and the rewrite below proxies that to the gateway. That makes
 * the gateway's session cookie first-party (owned by the dashboard's host), so
 * sign-in no longer depends on a cookie surviving third-party-cookie
 * restrictions across `*.vercel.app` → `*.up.railway.app`.
 */
const configured = (process.env.NEXT_PUBLIC_GATEWAY_URL || '').trim().replace(/\/+$/, '');
const GATEWAY_URL =
  configured || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000');
const SAME_ORIGIN =
  (process.env.NEXT_PUBLIC_GATEWAY_SAME_ORIGIN || '').trim().toLowerCase() === 'true';

// Same-origin mode with no target would ship a dashboard whose every API call
// 404s on its own origin. Fail the build instead of the runtime.
if (SAME_ORIGIN && !GATEWAY_URL) {
  throw new Error(
    'NEXT_PUBLIC_GATEWAY_SAME_ORIGIN=true requires NEXT_PUBLIC_GATEWAY_URL to be set: ' +
      'it is the target the /api/v1/* rewrite proxies to, and NEXT_PUBLIC_* values are ' +
      'read at build time.',
  );
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  transpilePackages: ['@x402/types', '@x402/ui', '@x402/wallet', '@x402/authentication'],
  async rewrites() {
    if (!GATEWAY_URL) return [];
    return [
      {
        // The path the client calls, for both routing modes: in same-origin
        // mode this is what the browser hits, and in absolute mode it is a
        // convenience alias that mirrors the gateway's own paths.
        source: '/api/v1/:path*',
        destination: `${GATEWAY_URL}/api/v1/:path*`,
      },
    ];
  },
  async headers() {
    // Proxied responses are per-session (they carry Set-Cookie and
    // `credentials: include` requests); the CDN must never hold one.
    return [
      {
        source: '/api/v1/:path*',
        headers: [{ key: 'Cache-Control', value: 'private, no-store' }],
      },
    ];
  },
};

module.exports = nextConfig;
