/**
 * Gateway target for the optional `/api/gateway/*` same-origin rewrite.
 *
 * Mirrors `src/lib/gatewayUrl.ts` (this file is CommonJS and evaluated at build
 * time, so it cannot import the TypeScript helper). A production build with no
 * configured gateway gets NO rewrite at all: silently rewriting to
 * `http://localhost:3000` is what made the deployed dashboard appear to "load
 * forever" while every API call failed against the visitor's own machine.
 */
const configured = (process.env.NEXT_PUBLIC_GATEWAY_URL || '').trim().replace(/\/+$/, '');
const GATEWAY_URL =
  configured || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  transpilePackages: ['@x402/types', '@x402/ui', '@x402/wallet', '@x402/authentication'],
  async rewrites() {
    if (!GATEWAY_URL) return [];
    return [
      {
        source: '/api/gateway/:path*',
        destination: `${GATEWAY_URL}/api/v1/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
