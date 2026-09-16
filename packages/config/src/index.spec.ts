// Tests for the config security hardening (H3): JWT_SECRET is required in
// every non-test environment, known placeholder secrets are rejected, and the
// explicit AUTH_DEV_MODE / TRUST_PROXY switches are read from the environment.

import { loadConfig, validateEnv, getConfig, setConfig, parseTrustProxy } from './index';

describe('config security hardening', () => {
  // `@x402/config` auto-loads the repo `.env` on import, so a developer's
  // local `AUTH_DEV_MODE=true` becomes part of the "clean" baseline that
  // afterEach restores — and every no-throw-in-production case below then
  // fails locally while passing in CI (where no `.env` exists). Pin the
  // security switches this suite asserts on so the baseline is deterministic.
  const originalEnv = { ...process.env, AUTH_DEV_MODE: 'false' };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('loadConfig', () => {
    it('throws when JWT_SECRET is missing in a non-test environment', () => {
      delete process.env.JWT_SECRET;
      process.env.NODE_ENV = 'development';

      expect(() => loadConfig()).toThrow(/JWT_SECRET/);
    });

    it('throws when JWT_SECRET is missing in production', () => {
      delete process.env.JWT_SECRET;
      process.env.NODE_ENV = 'production';

      expect(() => loadConfig()).toThrow(/JWT_SECRET/);
    });

    it('rejects known insecure placeholder secrets', () => {
      process.env.NODE_ENV = 'development';
      process.env.JWT_SECRET = 'change-me-to-a-random-64-byte-hex-string';

      expect(() => loadConfig()).toThrow(/JWT_SECRET/);
    });

    it('rejects the old hardcoded dev default', () => {
      process.env.NODE_ENV = 'development';
      process.env.JWT_SECRET = 'dev-secret-change-in-production';

      expect(() => loadConfig()).toThrow(/JWT_SECRET/);
    });

    it('allows a missing JWT_SECRET in test mode (test suites set their own)', () => {
      delete process.env.JWT_SECRET;
      process.env.NODE_ENV = 'test';

      expect(() => loadConfig()).not.toThrow();
    });

    it('throws when AUTH_DEV_MODE=true is set in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      process.env.AUTH_DEV_MODE = 'true';

      expect(() => loadConfig()).toThrow(/AUTH_DEV_MODE/);
    });

    it('accepts AUTH_DEV_MODE=true outside production', () => {
      process.env.NODE_ENV = 'development';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      process.env.AUTH_DEV_MODE = 'true';

      expect(() => loadConfig()).not.toThrow();
      expect(loadConfig().security.authDevMode).toBe(true);
    });

    it('accepts a real secret and reads AUTH_DEV_MODE / TRUST_PROXY from the environment', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      process.env.AUTH_DEV_MODE = 'true';
      process.env.TRUST_PROXY = 'loopback';

      const config = loadConfig();
      expect(config.security.jwtSecret).toBe('a-real-random-256-bit-secret');
      expect(config.security.authDevMode).toBe(true);
      expect(config.security.trustProxy).toBe('loopback');
    });

    it('defaults authDevMode to false and trustProxy to false (do not trust proxies)', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      delete process.env.AUTH_DEV_MODE;
      delete process.env.TRUST_PROXY;

      const config = loadConfig();
      expect(config.security.authDevMode).toBe(false);
      // Secure default: proxy headers are ignored unless explicitly opted in.
      expect(config.security.trustProxy).toBe(false);
    });

    it('parses TRUST_PROXY into explicit hop / host forms', () => {
      expect(parseTrustProxy(undefined)).toBe(false);
      expect(parseTrustProxy('')).toBe(false);
      expect(parseTrustProxy('false')).toBe(false);
      expect(parseTrustProxy('0')).toBe(false);
      expect(parseTrustProxy('1')).toBe(1);
      expect(parseTrustProxy('2')).toBe(2);
      expect(parseTrustProxy('loopback')).toBe('loopback');
      expect(parseTrustProxy('127.0.0.1,10.0.0.1')).toBe('127.0.0.1,10.0.0.1');
    });

    it('maps the boolean forms to booleans, never to a string Express cannot compile', () => {
      // Regression: `true` used to be returned as the *string* 'true', which
      // `proxy-addr` rejects from `app.set('trust proxy', …)` with a bare
      // `TypeError: invalid IP address: true` — a crash at boot that named
      // neither TRUST_PROXY nor the accepted values. It took the Railway
      // gateway down.
      expect(parseTrustProxy('true')).toBe(true);
      expect(parseTrustProxy('TRUE')).toBe(true);
      expect(parseTrustProxy(' true ')).toBe(true);
      expect(parseTrustProxy('false')).toBe(false);
      expect(parseTrustProxy('FALSE')).toBe(false);

      // The booleans stay booleans, and hop counts stay numbers — neither is
      // ever handed to `proxy-addr` as an unparseable string.
      expect(parseTrustProxy('true')).toStrictEqual(true);
      expect(parseTrustProxy('false')).toStrictEqual(false);
      expect(parseTrustProxy('1')).toStrictEqual(1);
    });

    it('accepts every proxy form Express documents', () => {
      expect(parseTrustProxy('linklocal')).toBe('linklocal');
      expect(parseTrustProxy('uniquelocal')).toBe('uniquelocal');
      expect(parseTrustProxy('LoopBack')).toBe('LoopBack');
      expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
      expect(parseTrustProxy('127.0.0.1, 10.0.0.1')).toBe('127.0.0.1, 10.0.0.1');
      expect(parseTrustProxy('::1')).toBe('::1');
      expect(parseTrustProxy('2001:db8::/32')).toBe('2001:db8::/32');
      expect(parseTrustProxy('::ffff:10.0.0.1')).toBe('::ffff:10.0.0.1');
    });

    it('rejects values Express would throw on, with a message naming the variable', () => {
      // These all reached `proxy-addr` before, producing its opaque boot
      // TypeError instead of a configuration error.
      for (const bad of ['treu', 'yes', '*', 'localhost', '999.1.1.1', '1,2', 'loopback, nope']) {
        expect(() => parseTrustProxy(bad)).toThrow(/TRUST_PROXY=/);
      }
      // The message has to be actionable, not just a rejection.
      expect(() => parseTrustProxy('treu')).toThrow(/"true"/);
    });

    it('does not trust proxies when TRUST_PROXY is an explicit false', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      process.env.TRUST_PROXY = 'false';

      expect(loadConfig().security.trustProxy).toBe(false);
    });

    it('defaults payoutAutomationEnabled to false and reads it from PAYOUT_AUTOMATION_ENABLED', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';

      delete process.env.PAYOUT_AUTOMATION_ENABLED;
      expect(loadConfig().payment.payoutAutomationEnabled).toBe(false);

      process.env.PAYOUT_AUTOMATION_ENABLED = 'true';
      expect(loadConfig().payment.payoutAutomationEnabled).toBe(true);
    });

    it('caches the config singleton via getConfig and replaces it via setConfig', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      delete process.env.AUTH_DEV_MODE;
      delete process.env.TRUST_PROXY;

      const first = getConfig();
      const second = getConfig();
      expect(second).toBe(first); // cached singleton

      const modified = { ...first, security: { ...first.security, trustProxy: 'loopback' } };
      setConfig(modified);
      expect(getConfig()).toBe(modified);
    });
  });

  describe('Stellar network presets', () => {
    const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
    const MAINNET_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

    it('defaults to testnet endpoints and the testnet USDC issuer when STELLAR_NETWORK is unset', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      delete process.env.STELLAR_NETWORK;
      delete process.env.USDC_ISSUER;
      delete process.env.HORIZON_URL;
      delete process.env.SOROBAN_RPC_URL;

      const config = loadConfig();
      expect(config.stellar.network).toBe('testnet');
      expect(config.stellar.horizonUrl).toBe('https://horizon-testnet.stellar.org');
      expect(config.stellar.sorobanRpcUrl).toBe('https://soroban-testnet.stellar.org');
      expect(config.stellar.networkPassphrase).toBe('Test SDF Network ; September 2015');
      expect(config.payment.usdcIssuer).toBe(TESTNET_USDC_ISSUER);
    });

    it('loads mainnet endpoints, passphrase, and the mainnet USDC issuer when STELLAR_NETWORK=mainnet', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      process.env.STELLAR_NETWORK = 'mainnet';
      delete process.env.USDC_ISSUER;
      delete process.env.HORIZON_URL;
      delete process.env.SOROBAN_RPC_URL;

      const config = loadConfig();
      expect(config.stellar.network).toBe('mainnet');
      expect(config.stellar.horizonUrl).toBe('https://horizon.stellar.org');
      expect(config.stellar.sorobanRpcUrl).toBe('https://soroban-mainnet.stellar.org');
      expect(config.stellar.networkPassphrase).toBe(
        'Public Global Stellar Network ; September 2015',
      );
      expect(config.payment.usdcIssuer).toBe(MAINNET_USDC_ISSUER);
    });

    it('keeps the testnet USDC issuer on futurenet', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      process.env.STELLAR_NETWORK = 'futurenet';
      delete process.env.USDC_ISSUER;

      const config = loadConfig();
      expect(config.payment.usdcIssuer).toBe(TESTNET_USDC_ISSUER);
    });

    it('lets an explicit USDC_ISSUER env var override the network default on test networks', () => {
      // On testnet/futurenet an explicit issuer is a legitimate override. On
      // mainnet it is NOT (see the mainnet-consistency guard below) — the
      // only acceptable mainnet USDC issuer is Circle's.
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      process.env.STELLAR_NETWORK = 'testnet';
      process.env.USDC_ISSUER = 'GCUSTOMISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

      const config = loadConfig();
      expect(config.payment.usdcIssuer).toBe('GCUSTOMISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
      // The network preset itself is still testnet.
      expect(config.stellar.network).toBe('testnet');
    });
  });

  describe('mainnet network-consistency guard', () => {
    const REAL_JWT = 'a-real-random-256-bit-secret';
    const MAINNET_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

    it('accepts a consistent mainnet configuration with defaults', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = REAL_JWT;
      process.env.STELLAR_NETWORK = 'mainnet';
      delete process.env.HORIZON_URL;
      delete process.env.SOROBAN_RPC_URL;
      delete process.env.NETWORK_PASSPHRASE;
      delete process.env.USDC_ISSUER;

      expect(() => loadConfig()).not.toThrow();
      const config = loadConfig();
      expect(config.stellar.network).toBe('mainnet');
      expect(config.payment.usdcIssuer).toBe(MAINNET_ISSUER);
    });

    it('rejects a testnet Horizon URL with STELLAR_NETWORK=mainnet', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = REAL_JWT;
      process.env.STELLAR_NETWORK = 'mainnet';
      process.env.HORIZON_URL = 'https://horizon-testnet.stellar.org';
      delete process.env.USDC_ISSUER;

      expect(() => loadConfig()).toThrow(/HORIZON_URL.*mainnet/);
    });

    it('rejects a testnet Soroban RPC URL with STELLAR_NETWORK=mainnet', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = REAL_JWT;
      process.env.STELLAR_NETWORK = 'mainnet';
      process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
      delete process.env.USDC_ISSUER;

      expect(() => loadConfig()).toThrow(/SOROBAN_RPC_URL.*mainnet/);
    });

    it('rejects a non-mainnet network passphrase with STELLAR_NETWORK=mainnet', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = REAL_JWT;
      process.env.STELLAR_NETWORK = 'mainnet';
      process.env.NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
      delete process.env.USDC_ISSUER;

      expect(() => loadConfig()).toThrow(/NETWORK_PASSPHRASE/);
    });

    it('rejects a non-Circle USDC issuer with STELLAR_NETWORK=mainnet', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = REAL_JWT;
      process.env.STELLAR_NETWORK = 'mainnet';
      process.env.USDC_ISSUER = 'GCUSTOMISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

      expect(() => loadConfig()).toThrow(/USDC_ISSUER/);
    });

    it('allows a custom (non-test) mainnet Horizon URL', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = REAL_JWT;
      process.env.STELLAR_NETWORK = 'mainnet';
      process.env.HORIZON_URL = 'https://horizon-mainnet.example.com';
      delete process.env.USDC_ISSUER;

      expect(() => loadConfig()).not.toThrow();
      expect(loadConfig().stellar.horizonUrl).toBe('https://horizon-mainnet.example.com');
    });

    it('allows a custom (non-test) mainnet Soroban RPC URL', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = REAL_JWT;
      process.env.STELLAR_NETWORK = 'mainnet';
      process.env.SOROBAN_RPC_URL = 'https://rpc-mainnet.example.com';
      delete process.env.USDC_ISSUER;

      expect(() => loadConfig()).not.toThrow();
      expect(loadConfig().stellar.sorobanRpcUrl).toBe('https://rpc-mainnet.example.com');
    });

    it('is a no-op outside mainnet (testnet/futurenet defaults)', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = REAL_JWT;
      process.env.STELLAR_NETWORK = 'testnet';
      process.env.HORIZON_URL = 'https://horizon-testnet.stellar.org';
      process.env.USDC_ISSUER = 'GCUSTOMISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

      expect(() => loadConfig()).not.toThrow();

      process.env.STELLAR_NETWORK = 'futurenet';
      expect(() => loadConfig()).not.toThrow();
    });

    it('validateEnv rejects a mainnet config pointed at testnet Horizon', () => {
      process.env.NODE_ENV = 'development';
      process.env.JWT_SECRET = REAL_JWT;
      process.env.DATABASE_URL = 'postgres://db.example.com:5432/x402';
      process.env.REDIS_URL = 'redis://redis.example.com:6379';
      process.env.STELLAR_NETWORK = 'mainnet';
      process.env.HORIZON_URL = 'https://horizon-testnet.stellar.org';
      delete process.env.USDC_ISSUER;

      expect(() => validateEnv()).toThrow(/HORIZON_URL.*mainnet/);
    });

    it('validateEnv accepts a consistent mainnet configuration', () => {
      process.env.NODE_ENV = 'development';
      process.env.JWT_SECRET = REAL_JWT;
      process.env.DATABASE_URL = 'postgres://db.example.com:5432/x402';
      process.env.REDIS_URL = 'redis://redis.example.com:6379';
      process.env.STELLAR_NETWORK = 'mainnet';
      delete process.env.HORIZON_URL;
      delete process.env.SOROBAN_RPC_URL;
      delete process.env.NETWORK_PASSPHRASE;
      delete process.env.USDC_ISSUER;

      expect(() => validateEnv()).not.toThrow();
    });
  });

  describe('validateEnv', () => {
    it('throws when JWT_SECRET is missing outside of test', () => {
      delete process.env.JWT_SECRET;
      process.env.NODE_ENV = 'development';
      process.env.DATABASE_URL = 'postgres://localhost:5432/db';
      process.env.REDIS_URL = 'redis://localhost:6379';

      expect(() => validateEnv()).toThrow(/JWT_SECRET/);
    });

    it('throws for placeholder secrets', () => {
      process.env.NODE_ENV = 'development';
      process.env.JWT_SECRET = 'change-me-in-production';
      process.env.DATABASE_URL = 'postgres://localhost:5432/db';
      process.env.REDIS_URL = 'redis://localhost:6379';

      expect(() => validateEnv()).toThrow(/JWT_SECRET/);
    });

    it('skips validation entirely in test mode', () => {
      delete process.env.JWT_SECRET;
      process.env.NODE_ENV = 'test';

      expect(() => validateEnv()).not.toThrow();
    });

    it('rejects development localhost Redis URL in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      process.env.DATABASE_URL = 'postgres://db.example.com:5432/x402';
      process.env.REDIS_URL = 'redis://localhost:6379';

      expect(() => validateEnv()).toThrow(/REDIS_URL/);
    });

    it('rejects unexpanded Railway template references in Redis URL', () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      process.env.DATABASE_URL = 'postgres://db.example.com:5432/x402';
      process.env.REDIS_URL = '${{Redis.REDIS_URL}}';

      expect(() => validateEnv()).toThrow(/REDIS_URL/);
    });

    it('rejects AUTH_DEV_MODE=true in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      process.env.DATABASE_URL = 'postgres://db.example.com:5432/x402';
      process.env.REDIS_URL = 'redis://redis.example.com:6379';
      process.env.AUTH_DEV_MODE = 'true';

      expect(() => validateEnv()).toThrow(/AUTH_DEV_MODE/);
    });

    it('allows AUTH_DEV_MODE=true in development', () => {
      process.env.NODE_ENV = 'development';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      process.env.DATABASE_URL = 'postgres://localhost:5432/db';
      process.env.REDIS_URL = 'redis://localhost:6379';
      process.env.AUTH_DEV_MODE = 'true';

      expect(() => validateEnv()).not.toThrow();
    });

    it('accepts a real Redis URL in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      process.env.DATABASE_URL = 'postgres://db.example.com:5432/x402';
      process.env.REDIS_URL = 'redis://redis.example.com:6379';

      expect(() => validateEnv()).not.toThrow();
    });

    it('accepts localhost Redis URL in development', () => {
      process.env.NODE_ENV = 'development';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      process.env.DATABASE_URL = 'postgres://localhost:5432/db';
      process.env.REDIS_URL = 'redis://localhost:6379';

      expect(() => validateEnv()).not.toThrow();
    });
  });
});
