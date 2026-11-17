# Contributing

## Local setup

Use Node.js 20+ and PostgreSQL 15+. You can start a local PostgreSQL instance with one command using Docker:

```bash
docker compose up -d
```

This provisions PostgreSQL with `konfirm_dev` and `konfirm_test` pre-configured on port `5432`.

Alternatively, if running PostgreSQL natively, ensure the server is active and create the databases:

```bash
createdb konfirm_dev
createdb konfirm_test
```

From the repository root, install dependencies and prepare the database:

```bash
npm install
DATABASE_URL=postgres://postgres:postgres@localhost:5432/konfirm_dev npm run migrate:up
```

`test/env.ts` selects `postgres:///konfirm_test` by default; do not point it at
development or production data. If Postgres uses a different local connection,
set `TEST_DATABASE_URL` to the test database URL when running Jest.

Run the CI-sized suite and the TypeScript check with:

```bash
npm run test:fast
npm run build
```

`test:fast` uses real Postgres but avoids the Stellar network. `npm run test:live`
runs the flows that require Horizon, Friendbot, or Soroban RPC; those tests use real
testnet state and can be slower or temporarily unavailable. See `jest.config.js`
for the split and its CI rationale.

## Test approach

Use real Postgres for SQL-backed behavior and real testnet flows when chain
signing, submission, or Horizon behavior is the subject. Avoid mocks for an
external dependency when its real behavior is what must be proven. Pure arithmetic
and other deterministic logic should stay unit-testable without I/O.

Use sequential calls when each result intentionally sets up the next assertion.
Use concurrent calls when correctness depends on check-then-write behavior,
locking, uniqueness, or shared limits; see `test/helpers/concurrent.ts`.

## Picking up work

Choose a scoped issue, confirm its acceptance criteria and owning module, and keep
the implementation focused on that behavior. Done means the relevant tests and
`npm run build` pass, documentation is updated when behavior or operations change,
and the pull request references the issue. Follow the comment guidance in
`docs/specs/07-comment-style.md` for new comments.