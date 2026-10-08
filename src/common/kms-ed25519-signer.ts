import { KMSClient, GetPublicKeyCommand, SignCommand } from '@aws-sdk/client-kms';
import { StrKey, Transaction } from '@stellar/stellar-sdk';
import type { Ed25519Signer } from '@x402/stellar';

// Written out explicitly rather than imported: @x402/stellar's own
// compiled .d.ts declares Ed25519Signer.signTransaction/signAuthEntry by
// referencing SignTransaction/SignAuthEntry from
// '@stellar/stellar-sdk/contract', but that package's actual public
// exports only expose them as SignTransactionLike/SignAuthEntryLike --
// the reference in @x402/stellar's bundled types doesn't resolve, which
// silently widens Ed25519Signer's method types to `any` rather than
// erroring. These shapes are copied verbatim from
// @stellar/stellar-sdk's lib/esm/contract/types.d.ts (SignTransaction/
// SignAuthEntry definitions) so this stays correct regardless of that
// unresolved reference.
type SignTransactionOpts = { networkPassphrase?: string; address?: string; submit?: boolean; submitUrl?: string };
type SignResult = { signedTxXdr: string; signerAddress?: string; error?: { message: string } };
type SignAuthEntryOpts = { networkPassphrase?: string; address?: string };
type SignAuthEntryResult = { signedAuthEntry: string; signerAddress?: string; error?: { message: string } };

// Same DER/SPKI envelope Ed25519 public keys always carry, used in reverse
// (wrapping a raw key) in channel-claim.ts's ED25519_SPKI_PREFIX. KMS's
// GetPublicKey returns the same standard encoding, so unwrapping here is
// just slicing off this fixed 12-byte prefix, not something KMS-specific.
const ED25519_SPKI_PREFIX_LEN = 12;

// Confirmed against the actual @aws-sdk/client-kms enum (not just AWS's
// announcement prose) -- SigningAlgorithmSpec.ED25519_SHA_512, not "EDDSA".
// ED25519_SHA_512 + MessageType RAW signs a raw message directly with
// standard Ed25519 (SHA-512 is part of the Ed25519 algorithm itself, not
// an extra pre-hash step this code needs to apply) -- exactly matching
// what Transaction.hash() already produces.
const SIGNING_ALGORITHM = 'ED25519_SHA_512';
const MESSAGE_TYPE = 'RAW';

/**
 * A drop-in replacement for @x402/stellar's createEd25519Signer, backed by
 * an AWS KMS asymmetric Ed25519 key instead of a raw secret key held in
 * application memory/env vars. The private key material never leaves KMS;
 * this only ever sends a 32-byte hash to be signed and gets a 64-byte
 * signature back.
 *
 * Implements signTransaction by reusing the SDK's own validated signature
 * attachment (Transaction.hash() + Transaction.addSignature()) rather than
 * hand-building XDR DecoratedSignature structures -- the same reasoning
 * channel.service.ts already documents for why it lets the SDK do this
 * part rather than reimplementing it.
 *
 * signAuthEntry has no live call site in this codebase today (the
 * facilitator only ever calls signTransaction -- traced every call site in
 * channel.service.ts and x402.service.ts before writing this) but is
 * implemented to satisfy the Ed25519Signer type and
 * isFacilitatorStellarSigner's guard; it intentionally throws rather than
 * silently misbehaving; wire it up for real if/when the facilitator ever
 * needs to sign an auth entry on its own behalf.
 */
export async function createKmsEd25519Signer(keyId: string): Promise<Ed25519Signer> {
  const client = new KMSClient({});
  const address = await deriveStellarAddress(client, keyId);

  async function signTransaction(xdr: string, opts?: SignTransactionOpts): Promise<SignResult> {
    const networkPassphrase = opts?.networkPassphrase;
    if (!networkPassphrase) {
      return { signedTxXdr: xdr, error: { message: 'networkPassphrase is required to sign' } };
    }
    try {
      const tx = new Transaction(xdr, networkPassphrase);
      const signature = await signWithKms(client, keyId, Buffer.from(tx.hash()));
      tx.addSignature(address, signature.toString('base64'));
      return { signedTxXdr: tx.toXDR(), signerAddress: address };
    } catch (err) {
      return { signedTxXdr: xdr, error: { message: err instanceof Error ? err.message : String(err) } };
    }
  }

  async function signAuthEntry(_authEntry: string, _opts?: SignAuthEntryOpts): Promise<SignAuthEntryResult> {
    throw new Error(
      'createKmsEd25519Signer: signAuthEntry has no implementation yet -- the facilitator has never needed ' +
        'to call this in practice (it only ever signs full transactions as source/fee-payer). Implement ' +
        'against the auth-entry preimage hashing helper in @stellar/stellar-sdk/contract before relying on this.',
    );
  }

  // Cast justified: the shapes above are copied verbatim from the real
  // SDK type definitions (see the comment above SignTransactionOpts) --
  // this isn't bypassing a check, it's working around @x402/stellar's own
  // unresolved internal type reference silently widening to `any`.
  return { address, signTransaction, signAuthEntry } as Ed25519Signer;
}

async function deriveStellarAddress(client: KMSClient, keyId: string): Promise<string> {
  const { PublicKey } = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (!PublicKey) throw new Error(`KMS GetPublicKey returned no key material for ${keyId}`);
  const der = Buffer.from(PublicKey);
  const rawPublicKey = der.subarray(ED25519_SPKI_PREFIX_LEN);
  if (rawPublicKey.length !== 32) {
    throw new Error(`unexpected Ed25519 public key length from KMS: got ${rawPublicKey.length} raw bytes, expected 32`);
  }
  return StrKey.encodeEd25519PublicKey(rawPublicKey);
}

async function signWithKms(client: KMSClient, keyId: string, message: Buffer): Promise<Buffer> {
  const { Signature } = await client.send(
    new SignCommand({
      KeyId: keyId,
      Message: message,
      MessageType: MESSAGE_TYPE,
      SigningAlgorithm: SIGNING_ALGORITHM,
    }),
  );
  if (!Signature) throw new Error('KMS Sign returned no signature');
  const sig = Buffer.from(Signature);
  if (sig.length !== 64) {
    throw new Error(`unexpected Ed25519 signature length from KMS: got ${sig.length} bytes, expected 64`);
  }
  return sig;
}
