# Runbook

Four incidents, in order of how likely they are to actually happen to this project, not a generic
list. The first three are things that already happened during development — this is written from
having lived through them, not guessed at.

## 1. Horizon or Soroban RPC unreachable

**What it looks like:** checkout, cash-out, or the "get test USDC" flow fails with a generic
"Something didn't go through on our end" on the client, and the server log shows an `unhandled
exception` with `"type": "NetworkError"` or `"fetch failed"`, `context: "AllExceptionsFilter"`.

**This already happened**, live, mid-session — Horizon had a transient outage that broke both
`payments.service.ts`'s `loadAccount` call and the compliance check's Soroban RPC call at the same
time. Confirmed via `curl -o /dev/null -w "%{http_code}" https://horizon-testnet.stellar.org` returning
nothing, then recovering a few minutes later on its own.

**Diagnose:**
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://horizon-testnet.stellar.org
curl -s -o /dev/null -w "%{http_code}\n" https://soroban-testnet.stellar.org
```
A non-200 (or a hang) on either confirms it's upstream, not the app.

**Respond:** Nothing to do but wait — every call to Horizon already has a timeout (8–10s) and retry
with backoff (see README § Timeouts & retries), and the compliance check fails open rather than
blocking checkout entirely. If it's been down more than ~15 minutes, check
[Stellar's status page] for a known incident before assuming it's local.

**Follow-up:** none needed if this was transient. If it recurs often, that's a signal to add an
alternate Horizon endpoint as a fallback, not just retry the same one harder.

## 2. Postgres connection exhaustion / database unreachable

**What it looks like:** everything fails at once — signup, login, activity, checkout — since every
one of those touches Postgres directly (`src/db/pool.ts`). Errors will mention `ECONNREFUSED`,
`too many clients already`, or a hung query.

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
- **Never** manually `set-cursor` forward past unprocessed payments to "fix" a stuck reconciler — that
  permanently skips real transactions. `set-cursor` is for deliberate replay/recovery, documented as
  such in the code, not a routine unstick command.

**Second payment to the same session (not a stall):** a payer who sends twice to the same muxed
address (double-send, wallet retry, top-up) no longer stops the reconciler. The extra payment is
recorded as `status = 'held'`, `flag_reason = 'duplicate_session'`, with a `second payment to an
already-paid session` warning in the reconciler log, and the cursor moves on. It is never dropped:
review it in the admin payments list and set its status by hand (refund, or mark paid if the top-up
was intended). It doesn't count toward paid volume or owed fees until an admin changes its status.

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
