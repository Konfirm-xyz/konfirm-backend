import { Keypair, Horizon, Networks, TransactionBuilder, Operation, Asset, BASE_FEE } from '@stellar/stellar-sdk';

const API = 'http://localhost:4001';
const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const horizon = new Horizon.Server(HORIZON_URL);
const friendbot = (addr) => fetch(`https://friendbot.stellar.org?addr=${addr}`);
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function randomMuxedId() {
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  const high = BigInt(buf[0] & 0x7fffffff);
  const low = BigInt(buf[1]);
  return ((high << 32n) | low).toString();
}

async function main() {
  const email = `usdc-fee-sweep-verify-${Date.now()}@example.com`;
  const merchantAddr = Keypair.random();
  const payer = Keypair.fromSecret('SBT5ZCV42YYDZEWIAM633KL5GEX6SBMCJJ546JN5JCV76O7NYC7E662T');

  console.log('funding merchant + adding USDC trustline...');
  await friendbot(merchantAddr.publicKey());
  await new Promise((r) => setTimeout(r, 3000));
  const merchantAcc = await horizon.loadAccount(merchantAddr.publicKey());
  const trustTx = new TransactionBuilder(merchantAcc, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: new Asset('USDC', USDC_ISSUER) }))
    .setTimeout(60)
    .build();
  trustTx.sign(merchantAddr);
  await horizon.submitTransaction(trustTx);

  console.log('signup merchant', merchantAddr.publicKey());
  const signupRes = await fetch(`${API}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'a-real-password-000', name: 'USDC Fee Sweep Verify', stellar_base_address: merchantAddr.publicKey() }),
  });
  const signupBody = await signupRes.json();
  if (!signupRes.ok) throw new Error('signup failed: ' + JSON.stringify(signupBody));
  const cookie = signupRes.headers.get('set-cookie').split(';')[0];

  console.log('creating link (1.00 USDC, default fee_bps=10)...');
  const linkRes = await fetch(`${API}/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ amount_usdc: '1.00', currency: 'USDC', description: 'usdc fee sweep verify' }),
  });
  const link = await linkRes.json();
  if (!linkRes.ok) throw new Error('link creation failed: ' + JSON.stringify(link));
  console.log('link id', link.id);

  const muxedId = randomMuxedId();
  const sessionRes = await fetch(`${API}/links/${link.id}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ muxed_id: muxedId }),
  });
  if (!sessionRes.ok) throw new Error('session reserve failed: ' + JSON.stringify(await sessionRes.json()));

  console.log('preparing real USDC fee-split transaction...');
  const prepRes = await fetch(`${API}/payments/prepare-tx?linkId=${link.id}&muxed_id=${muxedId}&payer=${payer.publicKey()}`);
  const prep = await prepRes.json();
  if (!prepRes.ok) throw new Error('prepareTx failed: ' + JSON.stringify(prep));

  const tx = TransactionBuilder.fromXDR(prep.xdr, Networks.TESTNET);
  console.log('operations:', tx.operations.map((o) => ({ type: o.type, destination: o.destination, amount: o.amount, asset: o.asset?.code })));
  tx.sign(payer);
  const submit = await horizon.submitTransaction(tx);
  console.log('submitted tx hash:', submit.hash);
  console.log('merchant address:', merchantAddr.publicKey());
}

main().catch((err) => {
  console.error(err.response?.data ?? err);
  process.exit(1);
});
