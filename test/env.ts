// Runs before any test file or application module is imported (Jest
// `setupFiles`), so DATABASE_URL is already pointing at the dedicated test
// database by the time src/db/pool.ts reads it — real Postgres, real
// constraints, never the dev database with mom's actual pilot data in it.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres:///konfirm_test';
process.env.JWT_SECRET = 'test-only-secret-do-not-use-elsewhere';
process.env.PORT = '0';
// A real, funded testnet account (see scripts/setup-fee-collection-account.mjs)
// -- checkout tests exercise the real two-operation split against it, not a
// placeholder, matching this codebase's standing "verify against real
// testnet" bar rather than mocking prepareTx's output.
process.env.PLATFORM_FEE_ADDRESS = process.env.PLATFORM_FEE_ADDRESS ?? 'GBJG2IGPXJ673TMTQMMJCSMITNSLVTIJ62MRSHCTQTTGNLV75TFR5PHY';
// Several services resolve the facilitator signer eagerly at module init,
// even in specs that never submit a transaction. Without this,
// resolveFacilitatorSecretKey() falls through to shelling out to the local
// `stellar` CLI's `deployer` keyring identity (facilitator-signer.ts) — fine
// on a dev machine with that identity configured, `spawn stellar ENOENT`
// anywhere else, including CI. This is a throwaway, unfunded keypair: it
// only needs to be a syntactically valid secret key for the 'fast' suite,
// which never submits real transactions (that's 'live', against testnet).
process.env.FACILITATOR_SECRET_KEY =
  process.env.FACILITATOR_SECRET_KEY ?? 'SBYXFFJCQSGC4742XGBI6F3YHGRHAWK77VBSBQJSLQNRI7IXTHX6KAAT';
