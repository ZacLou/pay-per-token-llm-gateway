/** @jest-environment node */

/**
 * Guard for the Next.js `NEXT_PUBLIC_*` inlining contract.
 *
 * Next.js substitutes public env vars into the client bundle with a webpack
 * `DefinePlugin` whose keys are the *exact* expressions
 * `process.env.NEXT_PUBLIC_<NAME>` (see `getNextPublicEnvironmentVariables` in
 * Next's `static-env`). It does **not** expose a runtime `process.env` object
 * containing those values in the browser — the client `process` shim has an
 * empty `env`.
 *
 * So any read that reaches a `NEXT_PUBLIC_*` value *through* `process.env`
 * rather than as the literal expression compiles to a runtime lookup that is
 * always `undefined` in the browser:
 *
 * ```ts
 * const env = process.env as { NEXT_PUBLIC_GATEWAY_URL?: string };
 * env.NEXT_PUBLIC_GATEWAY_URL; // undefined in the client, forever
 * ```
 *
 * That silently selects whatever dev fallback is nearby — which is exactly how
 * the deployed dashboard shipped calling `http://localhost:3000` while the
 * build and the unit tests (which inject a fake env object) both passed. The
 * server never showed the bug, because Next also assigns the values into the
 * Node `process.env` via `populateStaticEnv`.
 *
 * Passing the value as a normal function argument (as the pure resolvers in
 * `gatewayUrl.ts` / `devMode.ts` do) is fine and stays testable — the rule is
 * only that the *default* must be the literal expression. The end-to-end
 * enforcement of that is the `dashboard-build-arg` CI job, which greps the
 * built **client** assets for a probe URL; these tests catch the source-level
 * anti-patterns cheaply, on every `nx test dashboard`.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { resolveGatewayUrl } from './gatewayUrl';

const SRC_ROOT = join(__dirname, '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(full) && !/\.spec\.tsx?$/.test(full)) {
      out.push(full);
    }
  }
  return out;
}

const files = sourceFiles(SRC_ROOT);
const rel = (file: string) => file.replace(`${SRC_ROOT}/`, 'src/');

describe('NEXT_PUBLIC_* inlining contract', () => {
  it('scans the dashboard source', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('never narrows process.env through a cast — the exact regression this guards', () => {
    const offenders = files.filter((file) =>
      /process\.env\s+as\s/.test(readFileSync(file, 'utf8')),
    );

    expect(offenders.map(rel)).toEqual([]);
  });

  it('never reaches a NEXT_PUBLIC_* value through dynamic indexing', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const match of src.matchAll(/process\.env\[[^\]]*NEXT_PUBLIC[^\]]*\]/g)) {
        offenders.push(`${rel(file)} → ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('resolves the configured gateway URL from the real process env by default', () => {
    // Pins the default-parameter wiring. The literal-expression form inside
    // readGatewayEnv() is what makes the same code work in the browser.
    const previousUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;

    process.env.NEXT_PUBLIC_GATEWAY_URL = 'https://from-process-env.invalid';
    try {
      expect(resolveGatewayUrl()).toBe('https://from-process-env.invalid');
    } finally {
      process.env.NEXT_PUBLIC_GATEWAY_URL = previousUrl;
    }
  });
});
