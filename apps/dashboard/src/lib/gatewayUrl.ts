/**
 * Gateway URL resolution for the dashboard.
 *
 * `NEXT_PUBLIC_GATEWAY_URL` is inlined into the client bundle by Next.js at
 * **build** time. That makes it easy to ship a production build with the value
 * unset, and the old code hid that mistake behind a silent
 * `|| 'http://localhost:3000'` fallback — every request then went to the
 * visitor's own machine, failed, and the dashboard rendered as a wall of
 * loading placeholders (exactly what the deployed Vercel app did).
 *
 * The rule here is fail-closed, matching the gateway's own config rules and
 * the dashboard's dev-mode wallet fallback (see lib/devMode.ts):
 *
 *  - An explicitly configured URL always wins, normalized without a trailing
 *    slash so path joins never double up.
 *  - A production build with no configured URL resolves to the empty string,
 *    so callers surface a configuration error naming the missing variable
 *    instead of silently dialling localhost.
 *  - Development builds keep the localhost convenience default.
 *
 * All functions are pure over an env object (defaulting to process.env) so the
 * rules are unit-testable outside a browser.
 */

export interface GatewayEnv {
  NODE_ENV?: string;
  NEXT_PUBLIC_GATEWAY_URL?: string;
}

/** Local development convenience target — never used in a production build. */
export const DEV_GATEWAY_URL = 'http://localhost:3000';

/**
 * Read the build-time environment **by literal expression**.
 *
 * This indirection is load-bearing. Next.js inlines `NEXT_PUBLIC_*` into the
 * client bundle with a webpack `DefinePlugin` whose keys are the *exact*
 * expressions `process.env.NEXT_PUBLIC_<NAME>` (see
 * `getNextPublicEnvironmentVariables` in Next's `static-env`). It also does
 * **not** expose a runtime `process.env` object containing those values in
 * the browser — the client `process` shim is `next/dist/compiled/process`,
 * whose `env` is empty.
 *
 * So reading the value through a variable or defaulted parameter
 * (`env.NEXT_PUBLIC_GATEWAY_URL`, `env.NODE_ENV`) compiles to a *runtime*
 * lookup that is always `undefined` in the browser, and the production build
 * silently selects the `localhost` fallback — the exact failure the deployed
 * Vercel dashboard showed. (It worked on the server, because Next also
 * assigns these into the Node `process.env` via `populateStaticEnv`, which is
 * why this regressed invisibly.)
 *
 * Keeping the access as the literal member expression here is what lets the
 * bundler substitute it, while the resolvers below stay pure and testable.
 */
function readGatewayEnv(): GatewayEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_GATEWAY_URL: process.env.NEXT_PUBLIC_GATEWAY_URL,
  };
}

/**
 * The gateway base URL, or `''` when a production build was shipped without
 * one. Callers must treat `''` as a hard configuration error.
 */
export function resolveGatewayUrl(env: GatewayEnv = readGatewayEnv()): string {
  const configured = (env.NEXT_PUBLIC_GATEWAY_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  if (env.NODE_ENV === 'production') return '';
  return DEV_GATEWAY_URL;
}

/** True when the dashboard has a usable gateway base URL. */
export function isGatewayConfigured(env: GatewayEnv = readGatewayEnv()): boolean {
  return resolveGatewayUrl(env) !== '';
}

/**
 * A human-readable explanation of what is misconfigured, or null when the
 * configuration is usable. Surfaced in the dashboard's error states so a bad
 * deploy is diagnosable from the UI.
 */
export function gatewayConfigError(env: GatewayEnv = readGatewayEnv()): string | null {
  if (isGatewayConfigured(env)) return null;
  return (
    'NEXT_PUBLIC_GATEWAY_URL is not set for this production build, so the dashboard ' +
    'has no gateway to call. Set it to the public gateway URL and redeploy — ' +
    'NEXT_PUBLIC_* values are baked into the bundle at build time.'
  );
}
