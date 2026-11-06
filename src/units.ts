/**
 * Units, quantities, and precision-preserving numeric utilities for Kovanica.
 *
 * Kovanica uses 9 decimals: 1 KVNC = 1,000,000,000 base units (atoms).
 * Wire quantities in JSON-RPC are minimal `0x`-prefixed hex strings (e.g. "0x0", "0x5f5e100").
 * JavaScript IEEE-754 Numbers lose precision above Number.MAX_SAFE_INTEGER (9,007,199,254,740,991).
 * To guarantee lossless precision, all block numbers, balances, nonces, stakes, and fees
 * are represented as JavaScript `bigint` in the SDK.
 */

export const DECIMALS = 9;
export const ATOMS_PER_KVNC = 1_000_000_000n;

/**
 * Losslessly parse an unknown value (hex quantity string, decimal string, number, or bigint) into a `bigint`.
 * Throws if a number is not a safe integer to prevent silent precision corruption.
 */
export function parseQuantity(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(
        `Quantity ${value} exceeds Number.MAX_SAFE_INTEGER; precision lost. Expected a hex string.`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new TypeError("Cannot parse empty string as quantity");
    }
    if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
      return BigInt(trimmed);
    }
    if (/^-?\d+$/.test(trimmed)) {
      return BigInt(trimmed);
    }
    throw new TypeError(`Invalid quantity string: "${value}"`);
  }
  throw new TypeError(`Cannot parse quantity from type ${typeof value}`);
}

/**
 * Format an integer quantity to an Ethereum/Kovanica standard minimal `0x`-prefixed hex string.
 */
export function toHexQuantity(value: bigint | number): string {
  const b = typeof value === "bigint" ? value : BigInt(value);
  if (b < 0n) {
    throw new RangeError("Quantities cannot be negative");
  }
  return `0x${b.toString(16)}`;
}

/**
 * Convert an atomic integer amount (atoms) into a decimal KVNC string without floating point error.
 *
 * Example: `2_500_000_000n` -> `"2.5"`
 */
export function formatKvnc(atoms: bigint, options?: { maxFractionDigits?: number; minFractionDigits?: number }): string {
  const isNegative = atoms < 0n;
  const absAtoms = isNegative ? -atoms : atoms;

  const whole = absAtoms / ATOMS_PER_KVNC;
  const fraction = absAtoms % ATOMS_PER_KVNC;

  let fractionStr = fraction.toString().padStart(DECIMALS, "0");

  const maxDigits = options?.maxFractionDigits ?? DECIMALS;
  const minDigits = options?.minFractionDigits ?? 0;

  if (maxDigits < DECIMALS) {
    fractionStr = fractionStr.slice(0, maxDigits);
  }

  // Trim trailing zeros unless required by minDigits
  fractionStr = fractionStr.replace(/0+$/, "");
  while (fractionStr.length < minDigits) {
    fractionStr += "0";
  }

  const sign = isNegative ? "-" : "";
  if (fractionStr.length === 0) {
    return `${sign}${whole.toString()}`;
  }
  return `${sign}${whole.toString()}.${fractionStr}`;
}

/**
 * Parse a human-readable KVNC decimal string into atomic units (`bigint`) without floating point error.
 *
 * Example: `"2.5"` -> `2_500_000_000n`
 */
export function parseKvnc(amountStr: string): bigint {
  const trimmed = amountStr.trim();
  if (!trimmed) {
    throw new TypeError("Empty KVNC amount string");
  }

  const parts = trimmed.split(".");
  if (parts.length > 2) {
    throw new TypeError(`Invalid decimal KVNC amount: "${amountStr}"`);
  }

  const isNegative = parts[0].startsWith("-");
  const wholePartRaw = isNegative ? parts[0].slice(1) : parts[0];

  if (!/^\d*$/.test(wholePartRaw)) {
    throw new TypeError(`Invalid whole part in KVNC amount: "${amountStr}"`);
  }
  const whole = wholePartRaw.length > 0 ? BigInt(wholePartRaw) : 0n;

  let fraction = 0n;
  if (parts.length === 2) {
    const fractionPart = parts[1];
    if (!/^\d*$/.test(fractionPart)) {
      throw new TypeError(`Invalid fraction part in KVNC amount: "${amountStr}"`);
    }
    if (fractionPart.length > DECIMALS) {
      throw new RangeError(
        `KVNC amounts support at most ${DECIMALS} decimal places; got ${fractionPart.length}`,
      );
    }
    const padded = fractionPart.padEnd(DECIMALS, "0");
    fraction = BigInt(padded);
  }

  const total = whole * ATOMS_PER_KVNC + fraction;
  return isNegative ? -total : total;
}
