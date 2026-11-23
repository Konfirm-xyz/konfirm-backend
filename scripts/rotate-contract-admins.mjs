// Rotates the admin of the treasury, compliance, payment, and channel contracts
// in one pass, via each contract's `set_admin(current_admin, new_admin)`.
// Runbook: docs/KEYS.md ("Rotating a contract admin via set_admin").
//
// `set_admin` requires both the current and the new admin to authorize the call,
// so this script needs both secret keys. It never prints them, and it verifies
// the result by reading the admin back from the contract.
//
//   CURRENT_ADMIN_SECRET=S... NEW_ADMIN_SECRET=S... \
//     node scripts/rotate-contract-admins.mjs --network testnet
//
// Contract ids come from the same env vars the backend uses
// (TREASURY_CONTRACT_ID, COMPLIANCE_CONTRACT_ID, PAYMENT_CONTRACT_ID,
// CHANNEL_CONTRACT_ID). Pass --only treasury,payment to rotate a subset.
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { Keypair } from '@stellar/stellar-sdk';

const NETWORKS = ['testnet', 'mainnet'];

// Contract ids come from the env vars src/common/stellar-network.ts reads, so
// the script runs without booting the Nest app.
const contractIdFor = (name) => process.env[`${name.toUpperCase()}_CONTRACT_ID`];
const CONTRACTS = ['treasury', 'compliance', 'payment', 'channel'];

function parseArgs(argv) {
  const args = { network: 'testnet', only: CONTRACTS, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--network') args.network = argv[++i];
    else if (argv[i] === '--only') args.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!NETWORKS.includes(args.network)) throw new Error(`--network must be testnet or mainnet, got ${args.network}`);
  for (const name of args.only) {
    if (!CONTRACTS.includes(name)) throw new Error(`--only: unknown contract ${name} (expected ${CONTRACTS.join(', ')})`);
  }
  return args;
}

// The admin a contract currently has, read from its own storage. Returns null
// when the contract has no `admin` getter or no admin set.
function readAdmin(contractId, network) {
  try {
    const out = execFileSync(
      'stellar',
      ['contract', 'invoke', '--id', contractId, '--network', network, '--', 'admin'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    return out.replace(/^"|"$/g, '');
  } catch {
    return null;
  }
}

function setAdmin(contractId, current, next, network) {
  // Both parties sign: the CLI signs the envelope with --source-account, and the
  // two `--<arg>-signer` flags attach the Soroban authorizations for the
  // current_admin and new_admin addresses.
  execFileSync(
    'stellar',
    [
      'contract', 'invoke',
      '--id', contractId,
      '--source-account', current.secret(),
      '--network', network,
      '--',
      'set_admin',
      '--current_admin', current.publicKey(),
      '--new_admin', next.publicKey(),
      '--current_admin-signer', current.secret(),
      '--new_admin-signer', next.secret(),
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const currentSecret = process.env.CURRENT_ADMIN_SECRET;
  const nextSecret = process.env.NEW_ADMIN_SECRET;
  if (!currentSecret || !nextSecret) {
    throw new Error('set CURRENT_ADMIN_SECRET and NEW_ADMIN_SECRET (both are needed: set_admin is a two-party handshake)');
  }
  const current = Keypair.fromSecret(currentSecret);
  const next = Keypair.fromSecret(nextSecret);
  if (current.publicKey() === next.publicKey()) throw new Error('current and new admin are the same account');

  const results = [];
  for (const name of args.only) {
    const id = contractIdFor(name);
    if (!id) {
      results.push({ contract: name, ok: false, error: `no contract id (set ${name.toUpperCase()}_CONTRACT_ID)` });
      continue;
    }
    const before = readAdmin(id, args.network);
    if (before && before !== current.publicKey()) {
      results.push({ contract: name, ok: false, error: `admin is ${before}, not the current admin ${current.publicKey()}` });
      continue;
    }
    if (args.dryRun) {
      results.push({ contract: name, ok: true, dryRun: true, before });
      continue;
    }
    try {
      setAdmin(id, current, next, args.network);
    } catch (err) {
      results.push({ contract: name, ok: false, error: String(err.stderr || err.message).slice(0, 400) });
      continue;
    }
    const after = readAdmin(id, args.network);
    results.push({ contract: name, ok: after === next.publicKey(), before, after });
  }

  console.log(JSON.stringify({ network: args.network, newAdmin: next.publicKey(), results }, null, 2));
  if (results.some((r) => !r.ok)) process.exit(1);
}

main();
