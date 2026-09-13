import { amountToScVal } from './soroban-utils';

/** Decode an i128 ScVal back into its 128-bit numeric value. */
function decodeI128(value: string): bigint {
  const parts = amountToScVal(value).i128();
  const lo = BigInt(parts.lo().toString());
  const hi = BigInt(parts.hi().toString());
  return (hi << 64n) + lo;
}

describe('amountToScVal', () => {
  it('encodes a small stroop amount in the low word', () => {
    const parts = amountToScVal('1000000').i128();
    expect(parts.lo().toString()).toBe('1000000');
    expect(parts.hi().toString()).toBe('0');
  });

  it('encodes exactly 2^64 in the high word', () => {
    const parts = amountToScVal('18446744073709551616').i128(); // 2^64
    expect(parts.lo().toString()).toBe('0');
    expect(parts.hi().toString()).toBe('1');
  });

  it('splits a value larger than 64 bits across both words', () => {
    // 2^64 + 5 — a naive conversion that hardcoded hi=0 would either throw
    // from the Uint64 parser or silently encode the wrong amount.
    const parts = amountToScVal('18446744073709551621').i128();
    expect(parts.lo().toString()).toBe('5');
    expect(parts.hi().toString()).toBe('1');
  });

  it('round-trips arbitrary values across the full i128 range', () => {
    const samples = [
      '0',
      '1',
      '10000',
      '9999999999999999999',
      ((1n << 127n) - 1n).toString(), // i128 max
      (1n << 96n).toString(),
    ];
    for (const sample of samples) {
      expect(decodeI128(sample)).toBe(BigInt(sample));
    }
  });

  it('rejects a negative amount', () => {
    expect(() => amountToScVal('-1')).toThrow('non-negative');
  });

  it('rejects an amount above the i128 maximum instead of truncating', () => {
    expect(() => amountToScVal((1n << 127n).toString())).toThrow('i128 maximum');
  });
});
