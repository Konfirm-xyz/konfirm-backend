/** @type {import('jest').Config} */

// Three suites call the live Stellar testnet — Horizon, Friendbot, and Soroban
// RPC: fees.e2e-spec.ts submits a real settlement transaction, and
// admin.e2e-spec.ts / critical-path.e2e-spec.ts both call /payments/prepare-tx,
// which loads a real Horizon account and runs a real compliance simulation.
// They're real and valuable — this project's standing rule is no mocks for the
// things that actually need to be correct — but their speed and their pass/
// fail depend on testnet and Friendbot being up, which a merge-blocking CI
// gate shouldn't depend on. This session hit exactly that: two Friendbot
// timeouts and a slow-network run were briefly read as regressions before
// being traced to the network, and a `beforeAll` hook hit its timeout only
// because other local test runs were competing for the same machine.
//
// `fast` is what blocks CI (see .github/workflows/ci.yml). `live` still runs
// on every push, but is reported rather than blocking, and gets a longer
// timeout to match what real network calls actually take.
const LIVE_NETWORK_SPECS = [
  '<rootDir>/test/critical-path.e2e-spec.ts',
  '<rootDir>/test/admin.e2e-spec.ts',
  '<rootDir>/test/fees.e2e-spec.ts',
];

const shared = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  setupFiles: ['<rootDir>/test/env.ts'],
  // @stellar/stellar-sdk pulls in multiple transitive deps that ship
  // ESM-only files even under their "require" export condition
  // (@noble/hashes, uint8array-extras, possibly more) — Jest's default CJS
  // transform chokes on bare `import` syntax. Rather than chase each one by
  // name, transform all of node_modules; this test suite is small enough
  // that the extra transform cost doesn't matter.
  transformIgnorePatterns: [],
  transform: {
    '^.+\\.(t|j)sx?$': ['ts-jest', { tsconfig: { allowJs: true } }],
  },
};

module.exports = {
  // Integration/E2E specs share one real Postgres connection pool and must
  // not run concurrently against it — collisions on unique constraints
  // (email, muxed_id) would produce flaky failures that have nothing to do
  // with real bugs. This is a top-level setting rather than per-project
  // because `npm test` (no --selectProjects) runs both projects together,
  // against the same database, and must serialize across both, not just
  // within each.
  maxWorkers: 1,
  projects: [
    {
      ...shared,
      displayName: 'fast',
      testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/**/*.spec.ts', '<rootDir>/test/**/*.e2e-spec.ts'],
      testPathIgnorePatterns: ['/node_modules/', ...LIVE_NETWORK_SPECS],
      testTimeout: 20_000,
    },
    {
      ...shared,
      displayName: 'live',
      testMatch: LIVE_NETWORK_SPECS,
      // Friendbot and testnet RPC are slower and less predictable than
      // anything local. 20s has already proven too tight under load this
      // session — fees.e2e-spec.ts's beforeAll funds two accounts and waits
      // on two ledger closes before the first test even starts.
      testTimeout: 90_000,
    },
  ],
};
