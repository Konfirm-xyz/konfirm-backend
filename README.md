# konfirm-backend

The API and settlement-watching service behind **Konfirm**, a non-custodial payment processor built on Stellar. This repo is a pure JSON API: the NestJS app, the Postgres schema, and a Rust reconciler that watches the chain and turns confirmed transactions into records — nothing here ever holds a merchant's or payer's private key, and nothing here serves a page.

Sibling repos: [konfirm-contracts](https://github.com/konfirm-HQ/konfirm-contracts) (Soroban contracts — `compliance` and `payment` are both wired into this API's runtime path today; `treasury` and `channel` are deployed but not part of the checkout flow, see [Payment attestation](#payment-attestation) below) and [konfirm-frontend](https://github.com/konfirm-HQ/konfirm-frontend) (the Next.js app that calls this API — the only place the frontend lives; it proxies to whatever `BACKEND_URL` points at rather than being served from here).

## How it works

Konfirm has no "invoice" or "charge" object with a pending lifecycle. A merchant creates a **Link** (amount, currency, description). A payer hits that link, and the checkout page reserves a random session ID, builds a Stellar transaction, and gets it signed by the payer's own wallet — Konfirm never touches a signing key at any point, merchant or payer. A **Payment** row only ever gets written after the reconciler independently observes that transaction confirmed on Horizon; nothing is "pending" in the database because nothing is recorded until it's real.

Two ways to pay a link:
- **Freighter** (browser extension) — the API pre-builds the transaction and Freighter signs it.
- **SEP-7 QR code / mobile wallet** — a `web+stellar:pay` URI, since a Stellar transaction needs a fixed source account and sequence number that can't be known before a wallet is chosen; any SEP-7-compatible wallet (Lobstr, Vibrant, Beans, xBull) builds its own transaction from the request.

Cashing out to a bank account is a real SEP-10 (auth) + SEP-24 (interactive withdrawal) integration against Stellar's own reference anchor (`testanchor.stellar.org`) — see [Fiat off-ramp](#fiat-off-ramp) below.

## Tech stack

- **NestJS 10** / TypeScript, `ts-node` (no build step in dev — there is no hot reload either; restart the process after editing anything under `src/`)
- **PostgreSQL**, raw `pg` pool — no ORM. Migrations are plain, ordered SQL files in `db/migrations/`
- **Zod** for request validation at every controller boundary
- **`@stellar/stellar-sdk`** for building/reading transactions server-side
- **Rust reconciler** (`reconciler/`), a separate binary using `sqlx` against the same Postgres database

## Prerequisites

- Node.js 20+
- PostgreSQL 15+, running locally
- Rust (stable) — only needed to run the reconciler
- The [`stellar` CLI](https://developers.stellar.org/docs/tools/cli/install-cli), on `PATH`, with a `deployer` identity configured (`stellar keys add deployer --secret-key ...`) — needed by the reconciler's on-chain compliance check (`compliance.rs`, still CLI-shelled) and, locally only, as a convenience fallback if `STELLAR_DEPLOYER_SECRET_KEY` is unset (`x402.service.ts` resolves the facilitator's signing key via `stellar keys secret deployer` in that case). The API's own compliance checks (`payments.service.ts`, `x402.service.ts`) call the compliance contract directly over Soroban RPC — no CLI involved — see [Compliance](#compliance) below.
- [Freighter](https://www.freighter.app/) browser extension, set to Testnet, for exercising checkout yourself

## Setup

```bash
npm install
```

Generate a real secret and create `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | e.g. `postgres://you@localhost:5432/konfirm_dev` |
| `JWT_SECRET` | Recommended | Falls back to an insecure dev default with a console warning if unset — fine for localhost, never beyond it |
| `PORT` | No | Defaults to `3001` |
| `SENTRY_DSN` | No | Enables error tracking (see Logging & error tracking below); a no-op without it |
| `NODE_ENV` | No | Set to `production` for real JSON log lines instead of the pretty dev formatter |
| `PLATFORM_FEE_ADDRESS` | Recommended | A dedicated Stellar account (see `scripts/setup-fee-collection-account.mjs`) that receives Konfirm's checkout fee as a second payment operation in the same transaction as the merchant's. Unset means checkout skips fee collection entirely rather than failing — see [Fees](#fees) below. |

Create the database and apply migrations:

```bash
createdb konfirm_dev
npm run migrate:up
```

Run the API:

```bash
npm start
```

Run the reconciler (separate process, watches a specific merchant address):

```bash
cd reconciler
DATABASE_URL=postgres://you@localhost:5432/konfirm_dev \
  cargo run -- watch <merchant_stellar_address> <max_polls> <interval_secs>
```

## Reconciler CLI

| Command | Usage | Purpose |
|---|---|---|
| `seed-merchant` | `seed-merchant <stellar_address> <email> [name]` | Create/update a merchant row directly (bypasses signup — useful for scripted setup) |
| `watch` | `watch <merchant_address> [max_polls=20] [interval_secs=3]` | Poll Horizon for new payments to this address and record confirmed ones |
| `set-cursor` | `set-cursor <value\|'now'>` | Manually reset the Horizon paging cursor — a deliberate recovery/replay escape hatch, not a routine command |

`watch` keeps polling continuously — it only stops on hitting `max_polls` (default 20; the production Docker image defaults this to a very large number via `RECONCILER_MAX_POLLS`, see [Deployment](#deployment)) or a real error. It used to exit after its very first match (a "demo" convenience from early in this project's life); that behavior was removed once this was actually being deployed, since restarting the whole process — reconnecting to Postgres, re-resolving the merchant — after every single payment was real overhead a production reconciler shouldn't pay. For a long-running local session, still wrap it in a restart loop (`while true; do cargo run -- watch ...; done`) as a safety net against an unhandled error, same as production relies on the hosting platform's own restart-on-exit policy for the same reason.

## API reference

All endpoints are JSON unless noted. Routes marked 🔒 require a valid `konfirm_session` cookie (see [Auth](#auth)).

### Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| `POST` | `/auth/signup` | `email, password, name, stellar_base_address` | Creates the merchant, logs them in immediately |
| `POST` | `/auth/login` | `email, password` | Same error for wrong email or wrong password — no account enumeration |
| `POST` | `/auth/logout` | — | Clears the session cookie |
| `GET` | `/auth/me` 🔒 | — | Current merchant's claims |

### Links

| Method | Path | Body | Notes |
|---|---|---|---|
| `POST` | `/links` 🔒 | `amount_usdc, currency?, description?, reusable?` | `merchant_id` is never accepted from the client — always derived from the session |
| `GET` | `/links/:id/public` | — | Narrow projection safe for a checkout page: amount, currency, description, merchant name, merchant's Stellar address |
| `POST` | `/links/:linkId/sessions` | `muxed_id` | Reserves a session ID against a link; 409 on collision (client retries with a new one) |

### Payments

| Method | Path | Query | Notes |
|---|---|---|---|
| `GET` | `/payments/prepare-tx` | `linkId, muxed_id, payer` | Builds an unsigned Freighter transaction; runs compliance screening first; bundles a `ChangeTrust` op automatically if the payer has no USDC trustline yet |
| `GET` | `/payments/pay-uri` | `linkId, muxed_id` | Returns a `web+stellar:pay` SEP-7 URI for QR/mobile-wallet checkout — no payer address needed or knowable at this point |
| `GET` | `/payments/by-merchant/:stellarAddress` | — | Confirmed payments for this address, newest first |
| `GET` | `/payments/pending-by-merchant/:stellarAddress` | — | Whether a session was reserved but hasn't landed yet (drives the "waiting" UI state) |

### Withdrawals (fiat off-ramp)

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/withdrawals/challenge` 🔒 | — | Proxies a SEP-10 challenge from the anchor for the merchant's own address |
| `POST` | `/withdrawals/token` 🔒 | `transaction` (merchant-signed challenge) | Exchanges the signed challenge for an anchor session JWT |
| `POST` | `/withdrawals/start` 🔒 | `currency, token` | Opens a SEP-24 interactive session; returns the anchor's hosted URL |
| `GET` | `/withdrawals/status` 🔒 | `token, id` | Polls the anchor's transaction status |
| `POST` | `/withdrawals/prepare-payment` 🔒 | `currency, token, id` | Once the anchor is ready (`pending_user_transfer_start`), builds the on-chain payment to the anchor's account for the merchant to sign |

### Admin

Routes marked 🔐 require a valid `konfirm_admin_session` cookie — a completely separate identity from a merchant's `konfirm_session` (see [Admin auth](#admin-auth) below).

| Method | Path | Body | Notes |
|---|---|---|---|
| `POST` | `/admin/auth/login` | `email, password` | Same no-enumeration error as merchant login |
| `POST` | `/admin/auth/logout` | — | Clears the admin session cookie |
| `GET` | `/admin/auth/me` 🔐 | — | Current admin's claims |
| `GET` | `/admin/stats` 🔐 | — | Real Postgres aggregates for the Overview dashboard: merchant counts by status, today's payment count/volume, a zero-filled 7-day daily volume series — nothing fabricated for the sake of a fuller-looking chart |
| `GET` | `/admin/merchants` 🔐 | — | All merchants, newest first (`?limit`, `?offset`) |
| `PATCH` | `/admin/merchants/:id/status` 🔐 | `status: 'active'\|'suspended', reason?` | Takes effect immediately — see below, this isn't just a future-login gate |
| `GET` | `/admin/payments` 🔐 | — | All payments across every merchant, newest first (`?status`, `?limit`, `?offset`) |
| `PATCH` | `/admin/payments/:id/status` 🔐 | `status: 'paid'\|'held'\|'disputed', reason?` | Reuses the `payments.status` CHECK constraint that's existed since the original schema but was never written to anything but `'paid'` until now |
| `GET` | `/admin/compliance/blocked-addresses` 🔐 | — | The admin-managed address blocklist |
| `POST` | `/admin/compliance/blocked-addresses` 🔐 | `stellar_address, reason?` | 409 on a duplicate, not a silent no-op |
| `DELETE` | `/admin/compliance/blocked-addresses/:id` 🔐 | — | Unblocks |
| `GET` | `/admin/reconciler/status` 🔐 | — | The reconciler's current Horizon cursor + when it last moved |
| `POST` | `/admin/reconciler/rewind` 🔐 | `cursor` | **Backward-only** — see below |
| `GET` | `/admin/withdrawal-attempts` 🔐 | — | Merchant cash-outs Konfirm has observed being started, with the anchor's last known status |
| `GET` | `/admin/activity` 🔐 | — | Recent admin actions, newest first (`?limit`) — every mutation above logs here |

This was originally split into two delivery slices — identity plus merchant management shipped first, alone, before the rest — deliberately, so the newest and highest-privilege part of the system (a second, separate login) got proven in real use before more was built on top of it. Both slices are now built.

**The compliance blocklist covers both checkout paths, but at different points.** On the Freighter path (`POST /payments/prepare-tx`) it's checked before a transaction is ever built. On the SEP-7/QR path there's still no payer address at request time to check against anything — but the reconciler now checks every confirmed payment's payer against this same table (and the on-chain contract) immediately after recording it, holding it for review if flagged. See [Compliance](#compliance) for the full design.

**The reconciler rewind endpoint enforces backward-only**, in code, for the first time — previously this was only ever the reconciler CLI's `set-cursor` command plus a warning in `docs/RUNBOOK.md` §4 ("never manually set-cursor forward past unprocessed payments — that permanently skips real transactions"). The stored cursor is either the literal string `'now'` or a numeric Horizon paging token; moving off `'now'` to any real position is always allowed, but moving back *to* `'now'`, or to any numeric value ahead of the current one, is rejected with a 400. This does **not** add process coordination — if the Rust reconciler is actively running when an admin rewinds, the same race that already existed with the CLI tool still exists; this endpoint adds a correctness guard, not a lock.

**Withdrawal-attempt tracking is admin-visibility only, not control.** Withdrawals are a live proxy to Stellar's reference anchor with no local state of their own — `withdrawal_attempts` is a thin record written when a merchant starts a cash-out (`withdrawals.controller.ts`'s `start()`, best-effort — a tracking-insert failure never blocks the real cash-out, which has already succeeded on the anchor's side by then) and refreshed by re-polling the anchor with the stored session token whenever an admin loads the list. The anchor's own JWTs are short-lived (~24h on `testanchor.stellar.org`); once one expires, that row simply stops updating rather than erroring loudly. Konfirm has no authority to change the anchor's transaction state, so there is no admin "resolve this" action here — only visibility into what the anchor is reporting. The raw token itself is never returned to the admin UI — it's a bearer credential, not a display field.

## Auth

Sessions are an httpOnly JWT cookie (`konfirm_session`, 30-day expiry, `SameSite=Lax`). Passwords are bcrypt-hashed. `AuthGuard` attaches `req.merchant` (id, email, name, `stellar_base_address`) to any route behind it — controllers derive identity from this, never from a client-supplied field.

A suspended merchant is rejected in two places, not one: `login()` rejects it outright, and `AuthGuard` re-checks `merchants.status` on every authenticated request (one extra indexed lookup) so an **already-issued** session cookie stops working the instant an admin suspends the account — not just on the merchant's next login. `payments.service.ts`'s `loadPayableLink()` checks the same column, so a suspended merchant's payment links stop accepting money too, not only their own dashboard access.

### Admin auth

A fully separate identity system from merchant auth — admins aren't merchants with a flag, they're a different table (`admins`), a different JWT secret (`ADMIN_JWT_SECRET`, own insecure-dev-default warning, never the merchant `JWT_SECRET`), a different cookie (`konfirm_admin_session`, `SameSite=Strict`, 12-hour expiry vs. the merchant cookie's 30 days — a higher-privilege surface gets a shorter-lived session), and its own guard (`AdminGuard`). A leaked merchant secret can't forge an admin session, or vice versa.

**There is deliberately no `POST /admin/auth/signup`.** An internet-facing "create an admin account" endpoint is its own security problem for a surface that can suspend merchants and read everyone's data. Admins are provisioned out-of-band instead:

```bash
npm run seed:admin -- ops@example.com <password> "Ops Admin"
```

Every mutation an admin makes is written to `admin_actions` (who, what, on what, when, plus a free-text reason) and surfaced back through `GET /admin/activity` — an audit trail that isn't just written and forgotten.

## Project structure

```
src/
  auth/         signup, login, JWT session guard
  links/        payment link creation + public projection
  sessions/     muxed-ID reservation against a link
  payments/     prepare-tx (Freighter), pay-uri (SEP-7), compliance check, by-merchant queries
  withdrawals/  SEP-10/SEP-24 fiat off-ramp
  admin-auth/   separate admin identity — guard, JWT service, login/logout/me controller
  admin/        admin resource endpoints — merchants, payments, compliance, reconciler, withdrawal-attempts — + audit logger
  common/       shared asset resolution (XLM/USDC)
  db/           Postgres pool
reconciler/     Rust binary — watches Horizon, writes confirmed payments
db/migrations/  ordered .up.sql/.down.sql pairs, applied by db/migrate.ts
db/migrate.ts   the migration runner itself — no framework, tracks applied migrations in Postgres
db/seed-admin.ts  the only way to create an admin account — no signup endpoint, by design
scripts/testnet-harness/  standalone Node scripts for exercising payments outside the browser
```

## Logging & error tracking

Structured JSON logs via `nestjs-pino` (pretty-printed in dev, real newline-delimited JSON in
production) — every request gets an id, correlating its log lines. Two things worth knowing:

- **Cookies and auth headers are redacted at the logger level** (`req.headers.cookie`,
  `req.headers.authorization`, `res.headers["set-cookie"]`) — verified by inspecting real log output,
  not just trusting the config. Structured logging that leaked the session JWT would be a net loss.
- **High-frequency polling routes are excluded from request/response logging**
  (`/payments/by-merchant`, `/payments/pending-by-merchant`, `/withdrawals/status`,
  `/deposits/status`) — the activity/checkout/cash-out pages hit these every 2–3 seconds while open,
  and logging every poll would drown out everything else within minutes.

A global exception filter (`src/observability/all-exceptions.filter.ts`) passes through every
`HttpException` unchanged (a 401 or a 409 is expected application flow, not an incident) and logs
anything else — a genuinely unexpected failure — with full detail (stack trace, the real upstream
error body) while the client only ever sees a generic `{"statusCode":500,"message":"internal server
error"}`. Verified for real by forcing an actual unhandled Horizon SDK error and confirming both the
rich server-side log and the safe client response.

Error tracking is `@sentry/node`, entirely opt-in via `SENTRY_DSN` — this pilot has never had a Sentry
project, so unlike everything else in this README, that half can't be proven against a real dashboard.
What's real: the integration itself, and that it's already wired into the exception filter above, so
setting one env var in production turns it on with no code change. Without a DSN it logs a startup
warning and is a documented no-op, not a silent gap.

## Testing

```bash
createdb konfirm_test
DATABASE_URL=postgres:///konfirm_test npm run migrate:up
npm test
```

Real Postgres, real bcrypt hashing, real Horizon calls — no mocks standing in for the things that
actually need to be correct. Three layers:

- **Unit** (`src/common/asset.spec.ts`) — pure logic, no I/O.
- **Integration** (`src/auth/auth.service.spec.ts`) — hits the real `konfirm_test` database (set via
  `test/env.ts`, never `konfirm_dev`) for signup/login/duplicate-email/no-account-enumeration checks.
- **Critical-path E2E** (`test/critical-path.e2e-spec.ts`) — boots the actual Nest app and drives it
  through signup → create link (verifying a client-supplied `merchant_id` is ignored) → reserve a
  session → prepare a transaction, then **decodes the returned XDR for real** and asserts on its
  destination, operation, and memo — exactly the kind of check that would have caught the
  muxed-address-vs-memo routing bug earlier in this project's life automatically, rather than needing
  a human to notice a wallet crash days later.

What this suite deliberately does **not** cover: actually signing and submitting a transaction (needs
a real wallet holding a private key — a browser-and-a-human problem, not a CI problem) and the
SEP-10/24 anchor's interactive popup (same reason). Those stay manually tested.

## Migrations

```bash
npm run migrate:up            # applies every pending .up.sql, in order
npm run migrate:down          # reverts the most recently applied migration
npm run migrate:down -- 3     # reverts the last 3
```

Each migration is a `NNN_name.up.sql` / `NNN_name.down.sql` pair — `db/migrate.ts` tracks what's been
applied in a `schema_migrations` table, so `up` only ever runs what's actually pending (safe to run
repeatedly) and `down` can genuinely undo something, not just re-run `CREATE TABLE IF NOT EXISTS` and
hope. The migration's SQL and its tracking-table record land in the same transaction, so a failure
can't leave the two out of sync.

Verified for real: applied all 5 from empty, reverted one at a time down to nothing (confirming each
table — and the `claim_link_seq` function — actually disappeared), then reapplied cleanly. This isn't
theoretical; every step above was run against a live scratch database, not inferred from reading the
script.

**In production, `migrate:up` runs automatically** via `railway.json`'s `deploy.preDeployCommand` — a
real gap until this was added: two migrations (`014_referrals`, `015_referral_promos`) had landed in
the codebase and their code had already been deployed and running, but nobody had a step that actually
ran them against production Postgres, so every referral-reward cron tick failed with `relation
"referrals" does not exist` until this was caught in the logs. Railway runs `preDeployCommand` in a
throwaway container between build and deploy, gated — the new version never starts serving if it exits
non-zero — so a broken migration now blocks the deploy instead of shipping code that immediately breaks
against a schema that was never updated.

## Backups

```bash
db/scripts/backup.sh konfirm_dev                     # dumps to db/backups/, prunes to the last 14
BACKUP_S3_BUCKET=my-bucket db/scripts/backup.sh konfirm_dev   # also uploads off-machine
db/scripts/restore.sh <dump_file|s3://bucket/key> <target_db>  # restores; refuses to clobber a non-empty DB without FORCE=1
```

| Variable | Required | Notes |
|---|---|---|
| `BACKUP_S3_BUCKET` | No | If set, `backup.sh` uploads the dump here (via the `aws` CLI) immediately after taking it, before any local pruning runs. If unset, behavior is unchanged from before — local-only, no AWS account needed for day-to-day dev use. |

Real off-machine storage now, not just a local file — a dump uploads to S3 (or an S3-compatible bucket)
before anything local ever gets pruned, so a local disk failure doesn't take out every backup along
with the database. `restore.sh` accepts an `s3://` URI directly and fetches it to a temp path first, so
restoring from the real off-machine copy is the same one command as restoring from a local file.

Locally, a daily backup still runs via cron (`crontab -l` to see it) at 03:00 — this is dev-machine
scheduling only, not something checked into git; the production equivalent is a Railway Cron Job
service (see [Deployment](#deployment)) running against the database's private connection string,
never a host crontab. Both scripts have been run for real — restoring into a scratch database and
diffing every table's row count against the original, not just checking that `pg_dump` exited zero.

## Rate limiting

`@nestjs/throttler`, global default of 60 req/min per IP per route. Tighter limits where it actually
matters: `/auth/login` and `/auth/signup` at 10/min (brute-force/signup-spam resistance), and anything
that calls an external service — `/payments/prepare-tx` (calls the compliance contract over Soroban
RPC *and* calls Horizon), the whole `/withdrawals` and `/deposits` controllers (call the anchor) — at 20/min, since
those are slower and more expensive to abuse than a plain DB read. Status-polling endpoints
(`/withdrawals/status`, `/deposits/status`) get their own 60/min headroom since the frontend polls them
every 3 seconds for the duration of a cash-out or deposit, which would otherwise sit right at a tighter
limit's boundary.

## Timeouts & retries

Every external call (Horizon, the compliance contract's RPC call, the anchor) has a real timeout —
none of them could hang a request indefinitely before this. Retries are deliberately asymmetric, not
uniform, based on what's actually safe to repeat:

| Call | Retry? | Why |
|---|---|---|
| `horizon.loadAccount` (reads) | Yes, 2x | A read has no side effect if repeated |
| Anchor `GET` calls (challenge, status) | Yes | Same — idempotent reads |
| Anchor `POST /auth` (token exchange) | Once | Re-submitting the same signed challenge is safe |
| Anchor `POST .../interactive` (start withdraw/deposit) | No | Creates a new transaction on the anchor's side every success — a lost response retried blindly risks an orphaned duplicate, not a fixed request |
| Compliance contract RPC call (API and reconciler) | Once | Already fails open on any failure; one retry catches a single blip before falling through |

`fetchWithRetry` (`src/common/retry.ts`) only retries a transport-level failure or a 5xx — a 4xx means
the same thing on every attempt, so it's returned immediately rather than wasting three attempts on a
request that was never going to succeed. Covered by unit tests, including the specific case of *not*
retrying a 400.

The Rust reconciler's `reqwest::Client` had no timeout at all by default; it now has one, plus its own
retry-with-backoff on Horizon polling, on top of the existing shell-level `while true` restart loop
documented above.

## Compliance

Every payment is screened against the same deployed Soroban contract (`is_allowed`, contract id
`CDDVLE2DZQAYFY3Z2Z74TUNNPC4ROUACSBXOB2P64IT75EZFAQXSRSXY`) — the API (`payments.service.ts`,
`x402.service.ts`) calls it directly over Soroban RPC via `src/common/onchain-compliance.ts`
(`@stellar/stellar-sdk/contract`'s `Client`, simulate-only — `is_allowed` never mutates state, so no
signing or submission is needed); the reconciler's `compliance.rs` does the same over RPC now too, via
the `soroban-client` crate's `build_for_simulation()` (verified against real testnet on both branches —
a throwaway address was actually blocked and cleared on the live contract to confirm it reads real
on-chain state). Both languages now share the identical no-CLI, no-subprocess approach. The two checkout
paths screen at different points either way, because only one of them has a payer address to check
before the money moves:

- **Freighter checkout** (`payments.service.ts`'s `isPayerAllowed`) — before any transaction is built.
  Checks the local `blocked_addresses` table first (instant, fails closed on a hit), then the on-chain
  contract (fails open if unreachable, logged). A blocked address never receives a transaction to sign.
- **SEP-7/QR checkout** — the payer's own wallet builds and submits the transaction directly to the
  network; Konfirm never sees an address to check until the reconciler observes the confirmed payment
  on Horizon. This was a real, repeatedly-documented gap — screening it *before* the fact is
  architecturally impossible here, so the reconciler screens it immediately *after*, instead of not
  screening it at all:
  - The local blocklist check runs synchronously, in the reconciler's poll loop — it's a cheap
    in-process read, so a locally-blocked payer's payment lands as `held` the instant it's recorded.
  - The on-chain check runs **decoupled**, in a spawned background task, after the payment is already
    inserted as `paid` — if it comes back non-compliant, the row is flipped to `held` a few seconds
    later for admin review (`/admin/payments?status=held`). It deliberately does *not* run inline in the
    poll loop: that loop is strictly sequential, and blocking it on an ~8s worst-case external process
    call, once per payment, risks the reconciler itself falling behind — a worse, already-documented
    incident (see [Incidents](#incidents) below) than a flagged payment sitting as `paid` for a few
    extra seconds. The money has already moved on-chain either way by the time this runs; the check was
    never going to be prevention, only after-the-fact review.
  - A background check can be lost if the reconciler process is killed abruptly mid-check (a clean exit
    joins all pending checks first; a hard kill doesn't) — an accepted, documented gap consistent with
    the existing fail-open philosophy, not a new category of risk.

Verified for real: a locally-blocked test payer's payment landed as `held` immediately; a normal
payer's landed as `paid` immediately, with the background check confirmed to run (via logs) and not
flip a clean payment's status. Not simulated — both against real signed testnet transactions.

## Payment attestation

The deployed-but-previously-unused `payment` contract (`CCYRA6JT2L4NS5FG4B5TP52JPCGCPYSP7M6LUDUY2QA37V5UBXWJBRHV`) is
now wired into checkout as a pure attestation layer — matching its own doc comment: "an attestation
layer, not an escrow." It never moves funds and never gates a payment; `record_payment` is called
*after* the reconciler has already recorded a payment as `paid`, writing an on-chain mirror of
something that already fully settled to the merchant. `treasury`'s multisig settlement, by contrast,
is deliberately **not** wired into checkout — there is no existing payout step for it to sit next to
(a classic Stellar payment already lands directly in the merchant's own account), so doing that would
mean introducing real custody where none exists today. That's an intentional scope decision, not an
oversight; see the GitHub issue history on `konfirm-backend`#1 for the reasoning.

`PaymentAttestationSweeperService` (`src/payments/payment-attestation-sweeper.service.ts`) is an
in-process `@Cron('*/2 * * * *')` task — the fourth instance of this exact architecture in this codebase
(`ChannelKeeperService`, `FacilitatorSweepService`, the referral-rewards cron) — that sweeps
`payments WHERE status = 'paid' AND attested_at IS NULL`, calls `PaymentAttestationService.attest()`
per row (the real `Client`/`AssembledTransaction`/`signAndSend()` submission pattern, not the
lower-level `TransactionBuilder` pattern `channel.service.ts` uses — see that file's own doc comment
for why: `record_payment` requires the facilitator to authorize itself via `require_auth()`, the first
call in this codebase to need that, and only the high-level API collects and signs the resulting auth
entry correctly), and writes back `onchain_payment_id`/`attested_at` on real on-chain confirmation. Its
own `pg_try_advisory_lock` key (`402_003`) guards against double-sweeping across replicas, same as the
other three sweepers.

Verified for real, end to end: a real classic USDC payment (merchant landed on a fresh throwaway
address, no shortcuts), recorded by the reconciler as usual, picked up by a live `@Cron()` tick
(not simulated), and independently confirmed against the deployed contract's own `get_payment` — every
field (`amount`, `link_id`, `merchant`, `payer`, `tx_hash`) matched the local Postgres row exactly.

**A real dependency on the facilitator-key hardening work worth knowing about**: this feature's
self-authorization only works today because the currently-active raw-key signer
(`createEd25519Signer` from `@x402/stellar`) has a real `signAuthEntry` implementation
(`basicNodeSigner` under the hood). The KMS-backed signer (`src/common/kms-ed25519-signer.ts`) has
`signAuthEntry` as a documented, intentional throw — "no live call site... yet." This feature is now
that live call site, so the KMS cutover (still blocked on real AWS KMS key provisioning) cannot ship
until `signAuthEntry` is actually implemented there too.

## Incidents

[`docs/RUNBOOK.md`](docs/RUNBOOK.md) — four incidents in order of likelihood, three of which already
happened during development (Horizon/Soroban RPC outages, a compliance-check failure from the same
outage) plus the one most specific to this architecture (the reconciler falling behind, which makes
real on-chain payments invisible until it catches up). Written from having actually diagnosed each
one, not a generic template.

## Known limitations

- **Testnet only.** Mainnet needs a funded production USDC issuer, `JWT_SECRET` in a real secrets manager, and HTTPS in front of the session cookie.
- **XLM, USDC, and EURC.** All three resolve through `resolveAsset()` and get real fee/net USD math via the reconciler's live order-book conversion (see `reconciler/src/horizon.rs`'s `xlm_usdc_rate`/`eurc_usdc_rate`) — no other currency is wired up.
- **SEP-7/QR compliance screening is after-the-fact, not preventive** — by the time the reconciler can check it, the payment has already landed on-chain. See [Compliance](#compliance) for the full design; this is an architectural ceiling of the SEP-7 flow itself, not something a code change on Konfirm's side can move earlier.
- **The reconciler watches one merchant address per process.** Fine for a pilot; a real deployment needs either one process per merchant or a multi-account watch loop.
- Fails open, loudly, if the compliance contract is unreachable (logged, never silent) — a deliberate choice, not an oversight.
- **The compliance blocklist and reconciler rewind guard don't reach the SEP-7/QR checkout path or process-level coordination respectively** — see the [Admin](#admin) section above for exactly what each does and doesn't cover.
- **Withdrawal-attempt tracking is visibility only** — Konfirm has no authority over the anchor's own transaction state, so there's no admin "resolve this" action, only a record of what the anchor last reported.
- **`admin/merchants` and `admin/payments` pagination is simple limit/offset** with no search or filtering beyond a single status field — matches the pilot's current scale.

## Deployment

Three services on [Railway](https://railway.com), one project, sharing a managed Postgres add-on over
private networking:

| Service | Root / Dockerfile | Public? | Purpose |
|---|---|---|---|
| `api` | `/Dockerfile` | Yes | The NestJS app — `railway.json` at repo root |
| `reconciler` | `reconciler/Dockerfile` | No | Watches Horizon, writes confirmed payments — `reconciler/railway.json`, restart-always |
| backup cron | repo root, custom start command | No | Runs `db/scripts/backup.sh` on a schedule against the private `DATABASE_URL` — configured directly in the Railway dashboard as a Cron Job service, not a checked-in config file (a third service sharing the repo root can't share the default-discovered `railway.json` filename with `api`) |

Neither `Dockerfile` builds the `stellar` CLI from source anymore. The root `Dockerfile` (the `api`
service) never did; `reconciler/Dockerfile` used to (`cargo install --locked stellar-cli`, for
`compliance.rs`'s CLI shell-out), but that's gone now that the reconciler's compliance check calls the
contract directly over Soroban RPC too, via the `soroban-client` crate (see
[Compliance](#compliance)). That also means the whole class of "compiled binary needs a runtime shared
library the base image doesn't ship" failures this session hit (`libdbus-1.so.3`, `libssl.so.3`, missing
`ca-certificates`) doesn't apply to either service anymore — there's no separately-compiled CLI binary in
either image to carry those dependencies (`libssl-dev`/`libssl3` are still installed in
`reconciler/Dockerfile`, but for the reconciler binary's own TLS stack, not the CLI — confirmed via
`cargo tree -i native-tls`). The `deployer` identity used locally throughout development still doesn't
exist in a container (registering one non-interactively isn't possible — confirmed by hand: the CLI's
`--secret-key` flag requires a real TTY prompt, even a piped stdin doesn't satisfy it); this still
matters for transaction *signing* (the reconciler and `x402.service.ts`'s local-dev-only signing-key
fallback), both of which fall back to `STELLAR_DEPLOYER_SECRET_KEY` when unset — just no longer for the
compliance check itself, which only ever simulates and never signs.

The reconciler's `watch` used to exit after finding a single payment (a "demo" convenience) — that was
removed once this was actually being deployed, since restarting the whole process after every payment
was real, avoidable overhead. It now polls continuously until `RECONCILER_MAX_POLLS` (defaults to a
very large number in the container) or a real error, at which point the platform's restart-on-exit
policy relaunches it — same safety net `while true; do cargo run -- watch ...; done` provides locally.

See `.env.example` for the complete list of environment variables to set on each service.

### What only a human can do here

I don't have credentials for any of this — these steps need to be done directly, not asked for:

- Create the Railway project, the three services above, and the Postgres add-on; paste in the env vars
  from `.env.example`; provide the real `STELLAR_DEPLOYER_SECRET_KEY` (export it from wherever the
  local `deployer` identity's secret already lives: `stellar keys secret deployer`); trigger the first
  deploy.
- Create an S3 bucket (or an S3-compatible equivalent) and scoped IAM credentials for it; add them as
  env vars on the backup cron service.
- Point `konfirm-frontend`'s Vercel deployment's `BACKEND_URL` at this API's public URL once it exists.
- After the first deploy, over real HTTPS: confirm login actually works end to end. Both session
  cookies now set `secure` automatically from `NODE_ENV` (see `auth.controller.ts` /
  `admin-auth.controller.ts`) rather than needing a manual code edit, but that's still worth verifying
  against the real deployed URL rather than assumed.

## License

[MIT](LICENSE)
