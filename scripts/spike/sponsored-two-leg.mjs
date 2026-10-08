// Spike for the sponsored two-leg QR design (docs/design/qr-fee-collection.md,
// Option A). Runs against testnet with Friendbot-funded throwaway accounts.
//
//   A. Known payer: the platform sponsor is the transaction source, and the
//      payer is the source of both payment operations. Both sign, and both
//      legs should land atomically.
//   B. Unknown payer (what a QR scan actually is): the server builds the same
//      transaction with a placeholder account in the payer's operation-source
//      slots and signs as sponsor. The wallet then substitutes its own account
//      (SEP-7 `replace`) and signs. Expected: rejected, because the sponsor's
//      signature covered the placeholder.
//
// Run: node scripts/spike/sponsored-two-leg.mjs
import { Account, Asset, BASE_FEE, Horizon, Keypair, Memo, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

const server = new Horizon.Server('https://horizon-testnet.stellar.org');

async function fund(kp) {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
  if (!res.ok) throw new Error(`friendbot failed for ${kp.publicKey()}: ${res.status}`);
}

function buildTwoLeg({ sponsorAddress, sponsorSeq, payerOpSource, merchant, feeAccount, amount, feeAmount, memoId }) {
  return new TransactionBuilder(new Account(sponsorAddress, sponsorSeq), {
    fee: String(Number(BASE_FEE) * 3),
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 300 },
  })
    .addOperation(Operation.payment({ source: payerOpSource, destination: merchant, asset: Asset.native(), amount }))
    .addOperation(Operation.payment({ source: payerOpSource, destination: feeAccount, asset: Asset.native(), amount: feeAmount }))
    .addMemo(Memo.id(memoId))
    .build();
}

async function submit(tx) {
  try {
    const r = await server.submitTransaction(tx);
    return { ok: true, hash: r.hash };
  } catch (err) {
    return { ok: false, codes: err?.response?.data?.extras?.result_codes ?? String(err) };
  }
}

const sponsor = Keypair.random();
const payer = Keypair.random();
const merchant = Keypair.random();
const feeAccount = Keypair.random();
for (const kp of [sponsor, payer, merchant, feeAccount]) await fund(kp);

const seqOf = async (addr) => (await server.loadAccount(addr)).sequenceNumber();
const common = {
  sponsorAddress: sponsor.publicKey(),
  merchant: merchant.publicKey(),
  feeAccount: feeAccount.publicKey(),
  amount: '10.0000000',
  feeAmount: '0.0100000',
  memoId: '424242',
};

// A. known payer
const txA = buildTwoLeg({ ...common, sponsorSeq: await seqOf(sponsor.publicKey()), payerOpSource: payer.publicKey() });
txA.sign(sponsor, payer);
console.log('A known payer          :', JSON.stringify(await submit(txA)));

// B. unknown payer
const placeholder = Keypair.random().publicKey();
const txB = buildTwoLeg({ ...common, sponsorSeq: await seqOf(sponsor.publicKey()), payerOpSource: placeholder });
txB.sign(sponsor);
// Wallet-side SEP-7 replacement: the placeholder becomes the real payer.
const replaced = TransactionBuilder.fromXDR(txB.toXDR(), Networks.TESTNET);
for (const op of replaced.operations) op.source = payer.publicKey();
const replacedXdr = replaced.toXDR();
const replacedTx = TransactionBuilder.fromXDR(replacedXdr, Networks.TESTNET);
replacedTx.sign(payer);
console.log('B unknown payer (replaced):', JSON.stringify(await submit(replacedTx)));

// C. isolate the cause: the wallet holds no sponsor key, so the most it can
// do is add the payer's signature. Same transaction, payer-only signature.
const txC = buildTwoLeg({ ...common, sponsorSeq: await seqOf(sponsor.publicKey()), payerOpSource: payer.publicKey() });
txC.sign(payer);
console.log('C wallet-only signature:', JSON.stringify(await submit(txC)));
