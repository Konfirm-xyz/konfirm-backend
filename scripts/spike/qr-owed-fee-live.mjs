// Live check of the QR path. A Friendbot payer pays a Friendbot merchant the
// link amount with a MEMO_ID and no fee leg, as a SEP-7 `pay` URI would. The
// reconciler should record the payment as paid, with the fee owed. Run the
// reconciler after this script prints the payment's hash.
//
// Expects the session rows to exist already (see the psql setup in the spike
// notes). Prints the merchant and payer addresses.
import { Keypair, Horizon, TransactionBuilder, Networks, Operation, Asset, Memo, BASE_FEE } from '@stellar/stellar-sdk';

const server = new Horizon.Server('https://horizon-testnet.stellar.org');
const [, , merchantAddr, muxedId, amount] = process.argv;
const payer = Keypair.random();
await fetch(`https://friendbot.stellar.org/?addr=${payer.publicKey()}`);
const acct = await server.loadAccount(payer.publicKey());
const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
  .addOperation(Operation.payment({ destination: merchantAddr, asset: Asset.native(), amount }))
  .addMemo(Memo.id(muxedId))
  .setTimeout(120)
  .build();
tx.sign(payer);
const res = await server.submitTransaction(tx);
console.log(JSON.stringify({ payer: payer.publicKey(), hash: res.hash }));
