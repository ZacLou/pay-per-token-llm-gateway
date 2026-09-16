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
  NEXT_PUBLIC_GATEWAY_SAME_ORIGIN?: string;
}

/** Local development convenience target — never used in a production build. */
export const DEV_GATEWAY_URL = 'http://localhost:3000';

/** Path prefix for every gateway call, on whichever origin serves it. */
export const API_PATH_PREFIX = '/api/v1';

/**
 * How the dashboard reaches the gateway.
 *
 * - `absolute`   — call the gateway's own origin directly (CORS + a cross-site
 *                  cookie in production).
 * - `same-origin` — call `/api/v1/*` on the dashboard's own origin; the rewrite
 *                  in `next.config.js` proxies it to the gateway. The session
 *                  cookie the gateway sets then belongs to the dashboard's own
 *                  host, so it is **first-party**: no third-party-cookie
 *                  restrictions apply (Safari's ITP and Chrome's limits both
 *                  drop a `*.up.railway.app` cookie set from a `*.vercel.app`
 *                  page, which is why sign-in would not stick).
 * - `unconfigured` — a production build with nothing to call. Callers must
 *                  treat this as a hard configuration error.
 */
export type GatewayMode = 'absolute' | 'same-origin' | 'unconfigured';

export interface GatewayRouting {
  mode: GatewayMode;
  /**
   * Gateway origin, for diagnostics. In `same-origin` mode this is the proxy
   * target (what the rewrite forwards to), not a URL the browser dials.
   */
  base: string;
  /** Base every request is joined to: `${apiBase}${path}`. */
  apiBase: string;
  /** Human-readable target for error messages. */
  label: string;
}

/** True when the dashboard is configured to call the gateway through itself. */
export function isSameOriginMode(env: GatewayEnv = readGatewayEnv()): boolean {
  return (env.NEXT_PUBLIC_GATEWAY_SAME_ORIGIN || '').trim().toLowerCase() === 'true';
}

const UNCONFIGURED: GatewayRouting = { mode: 'unconfigured', base: '', apiBase: '', label: '' };

/**
 * Resolve how (and whether) the dashboard can reach a gateway.
 *
 * Same-origin mode still requires a proxy target: `next.config.js` forwards
 * `/api/v1/*` to `NEXT_PUBLIC_GATEWAY_URL`, and with neither a configured URL
 * nor the development default there is nothing behind the path — so it fails
 * closed exactly like the absolute case rather than emitting requests at
 * `/api/v1/*` that can only 404.
 */
export function resolveGatewayRouting(env: GatewayEnv = readGatewayEnv()): GatewayRouting {
  const configured = (env.NEXT_PUBLIC_GATEWAY_URL || '').trim().replace(/\/+$/, '');
  const target = configured || (env.NODE_ENV === 'production' ? '' : DEV_GATEWAY_URL);

  if (!target) return UNCONFIGURED;

  if (isSameOriginMode(env)) {
    return {
      mode: 'same-origin',
      base: target,
      apiBase: API_PATH_PREFIX,
      label: `this dashboard's own ${API_PATH_PREFIX} (proxied to ${target})`,
    };
  }

  return {
    mode: 'absolute',
    base: target,
    apiBase: `${target}${API_PATH_PREFIX}`,
    label: target,
  };
}

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
    NEXT_PUBLIC_GATEWAY_SAME_ORIGIN: process.env.NEXT_PUBLIC_GATEWAY_SAME_ORIGIN,
  };
}

/**
 * The gateway base URL, or `''` when a production build was shipped without
 * one. Callers must treat `''` as a hard configuration error.
 */
export function resolveGatewayUrl(env: GatewayEnv = readGatewayEnv()): string {
  return resolveGatewayRouting(env).base;
}

/** True when the dashboard has a usable way to reach the gateway. */
export function isGatewayConfigured(env: GatewayEnv = readGatewayEnv()): boolean {
  return resolveGatewayRouting(env).mode !== 'unconfigured';
}

/**
 * A human-readable explanation of what is misconfigured, or null when the
 * configuration is usable. Surfaced in the dashboard's error states so a bad
 * deploy is diagnosable from the UI.
 */
export function gatewayConfigError(env: GatewayEnv = readGatewayEnv()): string | null {
  if (isGatewayConfigured(env)) return null;

  // Same-origin mode with no target is its own, more specific mistake: the
  // request path would be right but nothing would be proxying it.
  if (isSameOriginMode(env)) {
    return (
      'NEXT_PUBLIC_GATEWAY_SAME_ORIGIN=true requires NEXT_PUBLIC_GATEWAY_URL to be set ' +
      'as the proxy target for /api/v1/*, so this production build has nothing to ' +
      'forward to. Set it and redeploy — NEXT_PUBLIC_* values are baked into the ' +
      'bundle at build time.'
    );
  }

  return (
    'NEXT_PUBLIC_GATEWAY_URL is not set for this production build, so the dashboard ' +
    'has no gateway to call. Set it to the public gateway URL and redeploy — ' +
    'NEXT_PUBLIC_* values are baked into the bundle at build time.'
  );
}
