/**
 * Dev-mode wallet fallback configuration.
 *
 * The dashboard's wallet-authentication fallback (used when no browser
 * wallet extension is installed) is env-driven and fail-closed:
 *
 *  - The fallback address comes from NEXT_PUBLIC_DEV_WALLET. There is no
 *    hardcoded default, so a misconfigured deployment gets no fallback.
 *  - The fallback is only armed in non-production builds, or behind the
 *    explicit NEXT_PUBLIC_AUTH_DEV_MODE=true opt-in (Vercel test
 *    deployments). This mirrors the gateway, which only accepts dev
 *    signatures behind an explicit AUTH_DEV_MODE=true flag.
 *  - In a production build without the explicit opt-in the fallback is
 *    impossible even if NEXT_PUBLIC_DEV_WALLET is set.
 *
 * All functions are pure over an env object (defaulting to process.env)
 * so the fail-closed rules can be unit-tested without a browser
 * environment. NEXT_PUBLIC_* variables are inlined by Next.js at build
 * time, so these work identically in client components.
 */

export interface DevModeEnv {
  NODE_ENV?: string;
  NEXT_PUBLIC_DEV_WALLET?: string;
  NEXT_PUBLIC_AUTH_DEV_MODE?: string;
}

/**
 * Read the build-time environment **by literal expression**.
 *
 * Next.js only substitutes the exact expression `process.env.NEXT_PUBLIC_*`
 * at build time and provides no runtime `process.env` in the browser, so
 * reading these through a variable (`env.NEXT_PUBLIC_AUTH_DEV_MODE`) yields
 * `undefined` in the client. That would silently *disarm* the fail-closed
 * production guard here — a production build could never see
 * `NEXT_PUBLIC_AUTH_DEV_MODE === 'true'`, but it also could not see
 * `NODE_ENV === 'production'`, so the check below would fall through to the
 * `NODE_ENV !== 'production'` branch and arm the dev wallet. Keeping the
 * literal member accesses is what makes the guard real. See
 * `lib/gatewayUrl.ts` for the full explanation.
 */
function readDevModeEnv(): DevModeEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_DEV_WALLET: process.env.NEXT_PUBLIC_DEV_WALLET,
    NEXT_PUBLIC_AUTH_DEV_MODE: process.env.NEXT_PUBLIC_AUTH_DEV_MODE,
  };
}

/** True when the dev-mode fallback is permitted to run in this build. */
export function isDevModeAllowed(env: DevModeEnv = readDevModeEnv()): boolean {
  return env.NODE_ENV !== 'production' || env.NEXT_PUBLIC_AUTH_DEV_MODE === 'true';
}

/**
 * The dev fallback wallet address, or null when the fallback is not armed.
 * Fail-closed: production builds need the explicit NEXT_PUBLIC_AUTH_DEV_MODE
 * opt-in, and the address itself must be configured via NEXT_PUBLIC_DEV_WALLET.
 */
export function getDevWalletAddress(env: DevModeEnv = readDevModeEnv()): string | null {
  const wallet = env.NEXT_PUBLIC_DEV_WALLET;
  if (!wallet || !isDevModeAllowed(env)) {
    return null;
  }
  return wallet;
}

/** True when the dev fallback is armed (drives the login fallback and banner). */
export function isDevModeActive(env: DevModeEnv = readDevModeEnv()): boolean {
  return getDevWalletAddress(env) !== null;
}
