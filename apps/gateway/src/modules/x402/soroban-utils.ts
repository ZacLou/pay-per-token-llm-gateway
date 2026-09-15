/**
 * Shared Soroban helpers used by the payment-verifier, credit-escrow and
 * multisig contract clients.
 */

import { Address, xdr } from '@stellar/stellar-sdk';
import type { Keypair } from '@stellar/stellar-sdk';

/**
 * Convert a Stellar account (G...) or contract (C...) address to an
 * `Address` ScVal. `Address.fromString` accepts both forms in stellar-sdk
 * v12 (the raw-ed25519 workaround was only needed for older SDK versions).
 */
export function accountAddressToScVal(address: string): xdr.ScVal {
  return Address.fromString(address).toScVal();
}

/** Highest value representable by a signed 128-bit integer. */
const I128_MAX = (1n << 127n) - 1n;
/** 64-bit mask used to split an i128 into its low/high words. */
const U64_MASK = (1n << 64n) - 1n;

/**
 * Convert a non-negative stroop amount to a signed 128-bit (`i128`) ScVal.
 *
 * The value is split into its low and high 64-bit words. A naive conversion
 * that puts the whole value in `lo` and hardcodes `hi = 0` silently produces
 * the wrong on-chain amount for anything above 2^64-1 (or throws from the
 * Uint64 parser) — these are contract calls that move real value, so the
 * conversion must be exact for the full i128 range.
 */
export function amountToScVal(amount: string): xdr.ScVal {
  const value = BigInt(amount);
  if (value < 0n) throw new Error('Amount must be non-negative');
  if (value > I128_MAX) throw new Error('Amount exceeds the i128 maximum');

  const lo = xdr.Uint64.fromString((value & U64_MASK).toString());
  const hi = xdr.Int64.fromString((value >> 64n).toString());
  return xdr.ScVal.scvI128(new xdr.Int128Parts({ lo, hi }));
}

/** Signs a raw transaction envelope XDR, returning the signed XDR. */
type SignTransaction = (txXdr: string) => Promise<string>;
/** Signs a single auth-entry XDR, returning the signed entry. */
type SignAuthEntry = (entryXdr: string) => Promise<string>;

/**
 * The subset of the SDK's `AssembledTransaction` this helper drives. Declared
 * structurally so the contract clients can pass their dynamically-imported
 * transactions without an `any` cast.
 */
export interface SignableContractTx {
  sign(opts: { signTransaction?: SignTransaction }): Promise<void | unknown>;
  send(): Promise<unknown>;
  signAuthEntries?(opts: {
    signAuthEntry?: SignAuthEntry;
    publicKey?: string;
  }): Promise<void | unknown>;
  needsNonInvokerSigningBy?(): string[];
}

/**
 * Sign (authorization entries and envelope) and submit a Soroban invocation.
 *
 * `AssembledTransaction.signAuthEntries` and `.sign` take an **options object**
 * holding `signAuthEntry` / `signTransaction` callbacks — they do not accept a
 * `Keypair` — and both are async. Every call site in this module used to pass
 * the Keypair directly and drop the returned promise, which failed three ways:
 *
 *   1. the SDK destructured `publicKey` off the Keypair and got the *unbound
 *      method*, so it matched no auth entries and threw `NoSignatureNeeded`
 *      (the error text contained the function's source);
 *   2. `send()` ran before anything was signed, so Horizon rejected the
 *      envelope as unsigned;
 *   3. the abandoned promise rejected unhandled, which terminates the Node
 *      process — one authenticated request could take the whole gateway down.
 *
 * `basicNodeSigner` is the SDK's own adapter from a Keypair to the callbacks
 * these methods expect, so no hand-rolled signer is needed.
 *
 * `needsNonInvokerSigningBy()` is consulted first because `signAuthEntries`
 * throws `NoSignatureNeeded` when the invocation carries no auth entries; a
 * call that needs no `require_auth` is still signed and sent.
 */
export async function signAndSendContractTx(
  tx: SignableContractTx,
  keypair: Keypair,
  networkPassphrase: string,
): Promise<void> {
  const { contract } = await import('@stellar/stellar-sdk');
  const signer = contract.basicNodeSigner(keypair, networkPassphrase);

  const needsAuthEntries =
    typeof tx.needsNonInvokerSigningBy !== 'function' || tx.needsNonInvokerSigningBy().length > 0;

  if (needsAuthEntries && typeof tx.signAuthEntries === 'function') {
    await tx.signAuthEntries({
      signAuthEntry: signer.signAuthEntry,
      publicKey: keypair.publicKey(),
    });
  }

  await tx.sign({ signTransaction: signer.signTransaction });
  await tx.send();
}
