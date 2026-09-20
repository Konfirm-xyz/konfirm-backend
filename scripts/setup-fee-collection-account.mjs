// One-time setup for the platform's fee-collection account (see
// PLATFORM_FEE_ADDRESS in src/common/platform-fee.ts and the fee-split
// checkout plan). Generates a fresh keypair, funds it via friendbot, and
// adds USDC + EURC trustlines -- mirrors scripts/x402-harness/setup.js's
// exact fund-then-trustline pattern, extended to two assets since this
// account needs to receive whichever currency a link is priced in.
//
// Run once: node scripts/setup-fee-collection-account.mjs
// Then set PLATFORM_FEE_ADDRESS (public key only) in .env -- the printed
// secret is only needed later, for the treasury-sweep follow-up work, not
// for checkout itself, which never signs from this account.
import { Keypair, Horizon, Networks, TransactionBuilder, Operation, Asset, BASE_FEE } from '@stellar/stellar-sdk';

const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const EURC_ISSUER = 'GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO';
const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');

const friendbot = (addr) => fetch(`https://friendbot.stellar.org?addr=${addr}`);

async function main() {
  const account = Keypair.random();

  process.stderr.write(`funding fee-collection account ${account.publicKey()} ...\n`);
  const res = await friendbot(account.publicKey());
  if (!res.ok) throw new Error('friendbot funding failed');

  // friendbot's tx needs a moment to land before loadAccount can see it.
  await new Promise((r) => setTimeout(r, 3000));

  process.stderr.write('adding USDC + EURC trustlines ...\n');
  const acc = await horizon.loadAccount(account.publicKey());
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: new Asset('USDC', USDC_ISSUER) }))
    .addOperation(Operation.changeTrust({ asset: new Asset('EURC', EURC_ISSUER) }))
    .setTimeout(60)
    .build();
  tx.sign(account);
  await horizon.submitTransaction(tx);

  process.stderr.write('\nDone. Add to .env:\n\n');
  process.stderr.write(`PLATFORM_FEE_ADDRESS=${account.publicKey()}\n\n`);
  process.stderr.write('Secret (save somewhere safe -- not needed by checkout itself, only by a future treasury-sweep for this account):\n');
  process.stderr.write(`${account.secret()}\n`);
}

main().catch((err) => {
  console.error(err.response?.data ?? err);
  process.exit(1);
});
