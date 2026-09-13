/**
 * Shared Soroban ScVal conversion helpers used by both the payment-verifier
 * contract client and the credit-escrow contract client.
 */

import { Address, xdr } from '@stellar/stellar-sdk';

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
