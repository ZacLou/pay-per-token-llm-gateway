import type { Config } from 'jest';

const config: Config = {
  displayName: 'wallet',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  // stellar-sdk 16 depends on ESM-only packages (@noble/hashes 2.x,
  // uint8array-extras). Node can `require()` them; Jest cannot, so they must
  // pass through the transformer rather than being skipped as node_modules.
  transformIgnorePatterns: ['node_modules/(?!(.*@noble|.*uint8array-extras)/)'],
  coverageDirectory: '../../coverage/packages/wallet',
  // coverageReporters is configured via the nx executor options (global config).
  // Thresholds calibrated slightly below current coverage (97% stmts / 100%
  // branches) so CI stays green while enforcing a floor. Ratchet up over time.
  coverageThreshold: {
    global: {
      statements: 90,
      branches: 90,
      functions: 90,
      lines: 90,
    },
  },
};

export default config;
