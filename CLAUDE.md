# konfirm-backend

See `/Users/mac/konfirm/docs/PRD.md` (revamp plan) and `/Users/mac/konfirm/docs/ARCHITECTURE.md` (real current architecture, boundaries, data model) before working here.

## Architecture boundaries
- All Stellar/Soroban contract calls go through `src/common/` service wrappers (`stellar-network.ts`, `kms-ed25519-signer.ts`). Don't construct a contract client ad hoc elsewhere.
- Payment correctness has one source of truth: the reconciler (separate Rust binary, verifies against Horizon) — never attest a payment (`record_payment`) without that independent verification having already happened.
- Compliance screening currently has two unsynchronized copies (Postgres `blocked_addresses` vs. on-chain `compliance::is_allowed`) — know this is a live inconsistency (M3 of the PRD fixes it), don't add a third copy.
- Treasury holds real pooled funds pending multisig settlement — this is the one genuinely custodial part of the system. Treat any code touching it with the caution that implies.
- Admin/role auth checks happen server-side in NestJS guards, never only trusted from the frontend.

## Stack
NestJS, Postgres, Stellar SDK / Soroban RPC, KMS-backed signing (partially — some keys are still raw env-var secret keys, see ARCHITECTURE.md's Secrets section; don't assume KMS everywhere).

## Known in-flight hazards (read before touching CI, deploys, or merges)
- No branch protection on `main` as of the last audit. If you're setting it up (PRD M1), that's expected and welcome; if you're not aware it's missing, that's the thing to fix.
- An automated process referred to as "autosolve-cli" has had merge access to this repo and merged unreviewed PRs from many different accounts. Treat any PR you didn't personally request or review with extra scrutiny until M1's gate is in place.

## Guardrails

Enforced ones (⛔) are backed by a hook (`.claude/hooks/guard.mjs`) or permission, not just this file. Boundaries: `/Users/mac/konfirm/docs/ARCHITECTURE.md`.

**Always**
- Run `npm test` / `npm run build` before committing. A broken backend blocks the reconciler and every payment flow behind it.
- Verify a payment was independently confirmed on Horizon (reconciler) before calling `record_payment` — never attest on admin/frontend say-so alone.
- Show the user before any deploy, migration, or anything touching signer keys.

**Never**
- ⛔ Commit `.env*` or print/log a raw secret key — refer to env vars by name. A regex tripwire also blocks typing a raw Stellar seed (`S...`, 56 chars) into a shell command.
- ⛔ Force-push, push straight to `main`, `reset --hard`, `git clean -f`, or `checkout -- .` without asking.
- ⛔ `DROP TABLE`/`TRUNCATE` without explicit user go-ahead.
- ⛔ Close a GitHub issue via `gh issue close` — this repo's audit found issues closed by unrelated merges with no real fix (backend#29). Close through a reviewed, merged PR, or ask first.
- Treat any PR you didn't personally request as suspect until branch protection (PRD M1) is confirmed live.

**Ask first**
- Any DB migration, deploy, or signer-key rotation.
- Running the treasury settlement flow once it's automated (PRD M2) — even automated, a real fund transfer gets a heads-up first.
- Deleting files you didn't create this session.
