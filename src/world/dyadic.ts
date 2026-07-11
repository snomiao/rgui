export interface Dyadic {
  readonly mantissa: bigint;
  readonly exponent: number;
}

export const DYADIC_ZERO: Dyadic = Object.freeze({ mantissa: 0n, exponent: 0 });

export function normalizeDyadic(value: Dyadic): Dyadic {
  if (value.mantissa === 0n) return DYADIC_ZERO;
  let { mantissa, exponent } = value;
  while (exponent > 0 && mantissa % 2n === 0n) {
    mantissa /= 2n;
    exponent--;
  }
  return { mantissa, exponent };
}

export function addDyadic(a: Dyadic, b: Dyadic): Dyadic {
  const exponent = Math.max(a.exponent, b.exponent);
  return normalizeDyadic({
    mantissa:
      (a.mantissa << BigInt(exponent - a.exponent)) +
      (b.mantissa << BigInt(exponent - b.exponent)),
    exponent,
  });
}

export function subtractDyadic(a: Dyadic, b: Dyadic): Dyadic {
  return addDyadic(a, { mantissa: -b.mantissa, exponent: b.exponent });
}

export function compareDyadic(a: Dyadic, b: Dyadic): -1 | 0 | 1 {
  const difference = subtractDyadic(a, b).mantissa;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function equalsDyadic(a: Dyadic, b: Dyadic): boolean {
  return compareDyadic(a, b) === 0;
}

export function subtractAvailableDyadic(a: Dyadic, b: Dyadic): Dyadic | undefined {
  if (compareDyadic(a, b) < 0) return undefined;
  return subtractDyadic(a, b);
}

export function splitOctreeVolume(value: Dyadic): Dyadic {
  return normalizeDyadic({ mantissa: value.mantissa, exponent: value.exponent + 3 });
}

// Display only: large mantissas may exceed Number's exact integer range.
export function approximateDyadicNumber(value: Dyadic): number {
  return Number(value.mantissa) * 2 ** -value.exponent;
}
