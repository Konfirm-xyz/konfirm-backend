# Runbook

Operational notes for on-call and maintainers.

## Referral rewards and disputed/refunded qualifying payments

### Decision (issue #57): claw-back is NOT implemented; accepted risk

The referral sweep (`src/referrals/referral-rewards.service.ts`) evaluates the
qualifying-payment check once via a one-shot `EXISTS` query and then stamps
`reward_granted_at`, which is treated as permanent. If that qualifying payment
is later set to `disputed` or `refunded` (see `db/migrations/003_payments.up.sql`
status values and the admin action in `src/admin/admin-payments.service.ts`),
the referrer keeps the reward and there is no automatic reversal path.

We have decided to **accept this risk** rather than implement claw-back, because:

- Dispute/refund volume on payments originated through referral signups is low.
- The reward value per referral is small relative to the cost of building and
  operating a reversal path (re-validation windows, idempotent revocation,
  partial-reversal accounting).
- A one-shot grant keeps the sweep simple and idempotent; adding re-validation
  would introduce double-revoke and race hazards for marginal financial benefit.

### What to do if this becomes material

If dispute/refund volume on referral-originated payments grows, revisit this
decision. A claw-back would need to:

1. Re-validate eligibility after a cooldown window instead of treating
   `reward_granted_at` as immediately final, and
2. Revoke idempotently (guard on a revocation marker) so a reward is never
   double-revoked and the existing grant path is unaffected.

**Current real settings, not assumed:** `pool.ts` sets no explicit size, so `pg`'s `Pool` defaults to
**max 10 connections** per process. With Postgres's own default `max_connections = 100`, this app
alone can't exhaust the server — but the reconciler (a separate process, its own `sqlx` pool) and any
other process sharing this database count against the same ceiling.

**Diagnose:**
```bash
psql -tAc "SELECT count(*), state FROM pg_stat_activity WHERE datname = 'konfirm_dev' GROUP BY state;"
psql -tAc "SHOW max_connections;"
pg_isready
```

**Respond:**
- If `pg_isready` fails outright: Postgres itself is down — `brew services restart postgresql` (or
  the equivalent for however it's actually running) and check its own logs for why it stopped.
- If connections are maxed but Postgres is up: find what's holding them —
  `SELECT pid, state, query, now() - query_start AS duration FROM pg_stat_activity ORDER BY duration DESC;`
  — a query running for minutes is more likely the cause than genuine load at this project's current
  scale.

**Recovery:** restore from the most recent backup if data was actually lost (not just
unreachable) — `db/scripts/restore.sh <dump> <target_db>`, see README § Backups. This has been tested
for real against a scratch database with row-count verification; it has not yet been tested as a true
disaster recovery (i.e., restoring over a genuinely corrupted `konfirm_dev`).

## 3. Compliance check (Soroban contract call) failing

**What it looks like:** server logs show `[compliance] on-chain check unreachable, failing open`,
repeatedly, in `payments.service.ts`. Checkout keeps working — that's the point of failing open — but
every payer is passing screening only because the check itself couldn't run, not because they were
actually cleared.

**This already happened** — the `stellar` CLI's underlying Soroban RPC call failed with `client error
(Connect)` during the same Horizon outage above, since both point at the same testnet infrastructure.

**Diagnose:**
```bash
stellar contract invoke --id CDDVLE2DZQAYFY3Z2Z74TUNNPC4ROUACSBXOB2P64IT75EZFAQXSRSXY \
  --source deployer --network testnet -- is_allowed --addr GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB
```
If this hangs or errors outside of the app entirely, it's the same upstream issue as #1.

**Respond:** Same as #1 if it's an RPC outage. If the CLI itself is missing or misconfigured (not
installed, wrong `deployer` identity) rather than a network issue, `grep` the exact error — a
`command not found` versus a `client error` are different problems with the same symptom.

**This is a fail-open system by design** — the tradeoff documented in the README is that an
unreachable compliance check never blocks a real payer, at the cost of screening not actually running
during an outage. If this needs to become fail-closed for a real deployment, that's a real design
conversation, not a one-line fix.

## 4. Reconciler falls behind or stops (Konfirm-specific)

**What it looks like:** payments genuinely land on-chain (visible on
[stellar.expert](https://stellar.expert/explorer/testnet)) but never appear in `/activity` or
`/payments/by-merchant`. This is the single most Konfirm-specific incident — the whole "nothing is
real until confirmed" design means a stalled reconciler makes real money look like it never arrived.

**Diagnose:**
```bash
ps aux | grep "konfirm-reconciler watch"
psql -tAc "SELECT * FROM reconciler_state;" konfirm_dev
```
Compare `updated_at` on the cursor row against the current time — if it hasn't moved in longer than
the poll interval (default 3s) times a large margin, the reconciler isn't running or is stuck.

**Respond:**
- If the process isn't running at all: restart it (`watch` now polls continuously until `max_polls` or
  a real error — it no longer exits after finding one match, that was a demo-loop leftover removed once
  this was deployed for real). In production this is the hosting platform's restart-on-exit policy;
  locally, wrap it in `while true; do cargo run -- watch ...; done` as the same safety net.
- If it's running but the cursor is stale: check its stdout for repeated `Horizon request failed,
  retrying after backoff` — that's incident #1 again, propagating downstream.
- **Hung, not crashed:** the reconciler can't wedge silently anymore. Every Postgres call is bounded
  (`acquire_timeout` 10s, `statement_timeout` 30s on every connection — `reconciler/src/store.rs`), so
  a stalled query surfaces as a `poll failed — backing off` warning instead of blocking forever. And
  `watch-all` runs a liveness watchdog on its own OS thread: if neither the merchant-refresh loop nor
  any merchant's poll loop has ticked in 600s, it logs `no reconciler loop has ticked` and exits 1, so
  Railway's `restartPolicyType: ALWAYS` restarts it. Seeing that line in the logs means the process was
  stuck and got restarted — look for what preceded it (Postgres/Horizon trouble), not at the restart.
- **Never** manually `set-cursor` forward past unprocessed payments to "fix" a stuck reconciler — that
  permanently skips real transactions. `set-cursor` is for deliberate replay/recovery, documented as
  such in the code, not a routine unstick command.

**Second payment to the same session (not a stall):** a payer who sends twice to the same muxed
address (double-send, wallet retry, top-up) no longer stops the reconciler. The extra payment is
recorded as `status = 'held'`, `flag_reason = 'duplicate_session'`, with a `second payment to an
already-paid session` warning in the reconciler log, and the cursor moves on. It is never dropped:
review it in the admin payments list and set its status by hand (refund, or mark paid if the top-up
was intended). It doesn't count toward paid volume or owed fees until an admin changes its status.

## Adding an index to a large, live table

A plain `CREATE INDEX` takes a `SHARE` lock that blocks every INSERT/UPDATE/DELETE on the table for the
whole build — on `payments` that means stalled checkouts. Use `CREATE INDEX CONCURRENTLY` through the
runner's non-transactional path:

1. Put the marker `-- no-transaction` as the **first line** of the `.up.sql`, and keep the file to that
   one statement: `CREATE INDEX CONCURRENTLY IF NOT EXISTS ...`.
2. Write the `.down.sql` the same way: `-- no-transaction` then `DROP INDEX CONCURRENTLY IF EXISTS ...`.
3. If the build fails partway, Postgres leaves an `INVALID` index behind and the migration stays
   pending. Check with `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;`, drop it with
   `DROP INDEX CONCURRENTLY`, then re-run `npm run migrate:up`.

## Verifying migrations against real data (manual, before a risky migration ships)

CI only ever runs `migrate:up` against a fresh, empty database, so backfills and data guards (e.g.
`021_account_recovery`'s duplicate-email check, `022_fee_settlement`'s `fee_status` backfill) and lock
behaviour on large tables are never exercised there. Before shipping a migration that touches existing
rows or indexes a hot table:

```bash
createdb konfirm_migration_check
db/scripts/restore.sh <recent_backup_dump> konfirm_migration_check   # production-shaped data
DATABASE_URL=postgres:///konfirm_migration_check npm run migrate:up
DATABASE_URL=postgres:///konfirm_migration_check npm run migrate:down
DATABASE_URL=postgres:///konfirm_migration_check npm run migrate:up
dropdb konfirm_migration_check
```

Note the date and migration range you verified in the PR description.

## Accepted dependency advisories (reconciler)

`cd reconciler && cargo audit` is expected to report exactly one accepted item after a plain
`cargo update`: `h2 0.3.27` (and `rustls-pemfile 1.0.4`), pulled in transitively by
`soroban-client 0.6.0` via its older `reqwest 0.11` / `hyper 0.14` stack. `soroban-client` 0.6.0 is
the only published version, so there is no fix available from this repo.

- Confirm with `cargo tree -i h2@0.3.27`.
- Tracked upstream: re-check `cargo info soroban-client` on each weekly review; once a release moves
  off `reqwest 0.11` / `hyper 0.14`, bump it and remove this entry.
- Anything else `cargo audit` reports is a real gap: run `cargo update` first.

## Weekly review

There's no real dashboard yet — no Sentry project, no APM. Until there is, this is manual:

```bash
# Error rate: count ERROR-level lines in the last 7 days of logs
grep -c '"level":50' /path/to/log/file   # if running with structured JSON logging in production

# Reconciler health: has the cursor moved recently, and does it match on-chain reality?
psql -tAc "SELECT * FROM reconciler_state;" konfirm_dev
```

p95 latency isn't measured anywhere yet — pino-http logs a `responseTime` on every non-excluded
request (see README § Logging), so it's *derivable* from log data, but nothing computes the
percentile automatically today. Wiring that up is a real follow-up, not something this runbook can
paper over with a checklist item.

[Stellar's status page]: https://status.stellar.org
