# System design audit — 2026-10-07

Scope: process topology, service coupling, test architecture, and configuration. This is a different pass from the security/money audit in [docs/specs/](../specs/README.md) — it asks whether the pieces fit together well, not whether any one piece is correct.

## Already solid — checked, not changed

- **In-process cron jobs** (`ChannelKeeperService`, `FacilitatorSweepService`, `FeeCollectionSweepService`, `ReferralRewardsService`, `FeesSweeperService`, `ReconcilerWatchdogService`) share the API's Postgres pool and Soroban signer instead of running as separate services. This was a deliberate call, made after a real incident where a separately-deployed backup-cron service silently shared the API's own `railway.json`. The trade-off is documented at the call sites and still holds: these jobs are small, tightly coupled to resources the API already owns, and a dedicated worker service would reproduce that exact class of bug for no real benefit at this scale.
- **Advisory lock keys** (`402_001`, `402_002`, `402_003`) are manually assigned but each one's comment names the others, so a new one is unlikely to collide by accident. `fees.service.ts` uses a different scheme — `hashtext('fees:<merchant>')` — because it needs a lock per merchant, not one static lock; the two schemes share a 64-bit keyspace, but the collision odds are astronomically low and not worth engineering around.
- **DB pool sizing** is already configurable (`DB_POOL_MAX`, `DB_POOL_IDLE_TIMEOUT_MS`, `DB_POOL_CONNECTION_TIMEOUT_MS`), with a comment warning that raising it without a matching plan for Postgres's own `max_connections` just moves the bottleneck.
- **`fetchWithRetry` is built on `withRetry`**, not a second copy of it, with one clear rule (retry a transport failure or a 5xx, return a 4xx immediately).
- **The reconciler's per-merchant task isolation** (`watch_merchant_supervised`) already protects against one merchant's Horizon trouble taking down another's polling.

## Fixed this pass

### 1. Live-network tests were blocking every merge

`critical-path.e2e-spec.ts`, `admin.e2e-spec.ts`, and `fees.e2e-spec.ts` all call the real Stellar testnet — Horizon, Friendbot, Soroban RPC — and CI ran them in the same blocking step as every fast, local test. This session hit the consequence directly: two Friendbot timeouts and a slow-network run were briefly mistaken for regressions before being traced to the network, and one `beforeAll` hook needed its timeout raised twice because other local work was competing for the same machine.

**Fix:** `jest.config.js` now defines two projects, `fast` and `live`. `npm run test:fast` is what blocks CI; `npm run test:live` still runs on every push but is `continue-on-error: true`, so a testnet or Friendbot hiccup is visible without failing the build. `npm test` (no args) still runs both, for local use.

Verified: `fast` — 22 suites, 127 tests, ~12s. `live` — 3 suites, 48 tests, ~34s, run clean after chasing down an unrelated one-off failure (below).

### 2. Duplicated anchor integration, and a config gap that followed from it

`deposits.service.ts` and `withdrawals.service.ts` each hand-rolled an identical SEP-10/SEP-24 client — same `getChallenge`, `exchangeToken`, and status-polling logic, same hardcoded `testanchor.stellar.org` URLs, differing only in two words of error copy. Neither used `stellar-network.ts`'s `ANCHOR_AUTH_URL` / `ANCHOR_TRANSFER_SERVER`, which already existed from the mainnet-config work but had never been wired to a caller. Worse, that config's own mainnet boot check (`missingForNetwork`) had never required those two variables, even though their type already allowed `undefined` — a mainnet deploy could have booted with no anchor configured at all.

**Fix:** extracted `src/common/anchor-client.ts`, a single `AnchorClient` parameterized by endpoints and error copy. Both services now construct one and delegate every method to it. `missingForNetwork` now requires `ANCHOR_AUTH_URL` and `ANCHOR_TRANSFER_SERVER` on mainnet.

Verified: typecheck clean, 8 new unit tests on `AnchorClient` (mocked `fetch`, since this tests the client's own logic — asset-code mapping, which error belongs to which copy — not the anchor itself), `stellar-network.spec.ts` still passes (it derives its expected env list from `missingForNetwork` itself, so it didn't need updating).

### 3. A stale self-justification in the admin controller

`admin.controller.ts`'s own comment said "~25 endpoints across 5 resources." It's now 18 injected services and about 30 routes. The design is still defensible — every route is a one- or two-line delegation to its own service plus an audit-log call, so the controller stays a router, not a place logic accumulates — but the comment was arguing from a count that was no longer true. Corrected it to argue from the actual shape of the code, and named the real signal for when to split a resource out (route-level middleware or guards its neighbors don't need), rather than a line count.

## Noted, not changed

- **`ChannelKeeperService` has a documented, known gap**: an idle channel where neither party initiates a close can't be force-closed by the facilitator, because the contract's `require_auth` on `initiate_close` restricts it to the channel's own parties. The code already surfaces this (`logIdleChannels`), and the real fix needs a contract change — an optional delegated-closer address captured at `open_channel` — which is contract work, the same category as the treasury and deployer-admin specs, not something to patch in the backend.
- **Deposits and withdrawals still have no automated test against the live anchor.** This pass added a mocked unit test of the client logic that moved, but the anchor's hosted SEP-24 UI needs a human in a browser, same limitation the README already states for the rest of the SEP-24 flow. Not a regression, not fixed here.
- **One flaky failure, unrelated to this pass's changes:** `critical-path.e2e-spec.ts`'s fee-split test failed once on a shared run and passed clean on its own immediately after, on a code path (the live XLM/USDC rate fetch) this pass never touched. This is exactly the kind of noise item 1's `fast`/`live` split exists to make visible without blocking a merge — not chased further.

## Verification

- Backend typecheck: clean.
- `npm run test:fast`: 22 suites, 127 tests.
- `npm run test:live`: 3 suites, 48 tests (clean run).
- `npm audit --omit=dev`: 0 findings.
