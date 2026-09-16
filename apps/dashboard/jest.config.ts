import type { Config } from 'jest';

const config: Config = {
  displayName: 'dashboard',
  preset: '../../jest.preset.js',
  testEnvironment: 'jsdom',
  // tsconfig.spec.json exists so .tsx specs compile with an emitted JSX
  // runtime (the app tsconfig sets `jsx: "preserve"` for Next).
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  coverageDirectory: '../../coverage/apps/dashboard',
  setupFilesAfterEnv: [],
};

export default config;
