/**
 * Kovanica PRO-21 and legacy address encoding, decoding and validation.
 * Verified against crates/kovanica-types/src/address.rs at commit 2c2e54b4615eb53c61ebb9963b7606d2ccbfaa47.
 */

import { blake3 } from "@noble/hashes/blake3.js";
import { isLegacyAddressAllowed } from "./chains";

export const ADDRESS_PREFIX = "kvnc";
export const ADDRESS_SUFFIX = "dag";
export const ADDRESS_PAYLOAD_LEN = 32;
export const ADDRESS_CHECKSUM_BITS = 29;
export const ADDRESS_BODY_CHARS = 57; // (256 + 29) / 5
export const ADDRESS_LEN = 64; // "kvnc" (4) + 57 + "dag" (3)

const BASE32_ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const LEGACY_CHECKSUM_LEN = 4;

/**
 * Computes the 29-bit blake3 checksum for a 32-byte public key.
 * low 29 bits of u32 (first 29 bits MSB-first of blake3(key)).
 */
export function checksum29(payload: Uint8Array): number {
  if (payload.length !== ADDRESS_PAYLOAD_LEN) {
    throw new Error(`Expected ${ADDRESS_PAYLOAD_LEN} bytes payload, got ${payload.length}`);
  }
  const hash = blake3(payload);
  const u32 =
    ((hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3]) >>> 0;
  return u32 >>> (32 - ADDRESS_CHECKSUM_BITS);
}

/**
 * Computes the 4-byte legacy blake3 checksum for a 32-byte public key.
 */
export function legacyChecksum(payload: Uint8Array): Uint8Array {
  const hash = blake3(payload);
  return hash.slice(0, LEGACY_CHECKSUM_LEN);
}

/**
 * Canonical PRO-21 encoding: `kvnc` + 57 base32 chars (bech32 alphabet) + `dag` = 64 characters.
 */
export function encodeAddress(publicKey: Uint8Array): string {
  if (publicKey.length !== ADDRESS_PAYLOAD_LEN) {
    throw new Error(`Public key must be exactly ${ADDRESS_PAYLOAD_LEN} bytes`);
  }

  const check = checksum29(publicKey);

  // Pack 256 bits of key + 29 bits of checksum = 285 bits into 5-bit chunks
  const chunks: number[] = [];
  let acc = 0;
  let bits = 0;

  for (let i = 0; i < publicKey.length; i++) {
    acc = (acc << 8) | publicKey[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      chunks.push((acc >> bits) & 0x1f);
    }
  }

  // Push the 29 checksum bits
  let checkAcc = check;
  let checkBits = ADDRESS_CHECKSUM_BITS;
  // Combine remainder of acc with top bits of check
  acc = (acc << checkBits) | checkAcc;
  bits += checkBits;

  while (bits >= 5) {
    bits -= 5;
    chunks.push((acc >> bits) & 0x1f);
  }

  if (chunks.length !== ADDRESS_BODY_CHARS) {
    throw new Error(`Encoding produced ${chunks.length} body characters, expected ${ADDRESS_BODY_CHARS}`);
  }

  let body = "";
  for (const c of chunks) {
    body += BASE32_ALPHABET[c];
  }

  return `${ADDRESS_PREFIX}${body}${ADDRESS_SUFFIX}`;
}

/**
 * Decodes a canonical 64-character PRO-21 address string into raw 32-byte public key.
 * Throws an Error if invalid.
 */
export function decodeAddress(address: string): Uint8Array {
  const trimmed = address.trim();
  if (trimmed.length !== ADDRESS_LEN) {
    throw new Error(`Address must be exactly ${ADDRESS_LEN} characters, got ${trimmed.length}`);
  }
  if (!trimmed.startsWith(ADDRESS_PREFIX) || !trimmed.endsWith(ADDRESS_SUFFIX)) {
    throw new Error(`Address must start with "${ADDRESS_PREFIX}" and end with "${ADDRESS_SUFFIX}"`);
  }

  const body = trimmed.slice(ADDRESS_PREFIX.length, trimmed.length - ADDRESS_SUFFIX.length);
  if (body.length !== ADDRESS_BODY_CHARS) {
    throw new Error(`Invalid body length: ${body.length}`);
  }

  let acc = 0n;
  let nbits = 0;
  const payload = new Uint8Array(ADDRESS_PAYLOAD_LEN);
  let filled = 0;

  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    const val = BASE32_ALPHABET.indexOf(char);
    if (val === -1) {
      throw new Error(`Address contains invalid base32 character: "${char}"`);
    }

    acc = (acc << 5n) | BigInt(val);
    nbits += 5;

    if (filled < ADDRESS_PAYLOAD_LEN && nbits >= 8) {
      nbits -= 8;
      payload[filled++] = Number((acc >> BigInt(nbits)) & 0xffn);
      acc &= (1n << BigInt(nbits)) - 1n;
    }
  }

  if (filled !== ADDRESS_PAYLOAD_LEN || nbits !== ADDRESS_CHECKSUM_BITS) {
    throw new Error(`Bit unpack mismatch: filled=${filled}, remaining_bits=${nbits}`);
  }

  const expectedChecksum = checksum29(payload);
  const actualChecksum = Number(acc);

  if (actualChecksum !== expectedChecksum) {
    throw new Error("Address checksum mismatch");
  }

  return payload;
}

/**
 * Validates whether an address string is valid for a given chain ID.
 * Strict PRO-21 base32 on Mainnet (1) and Testnet (2); legacy hex formats are strictly rejected on Mainnet (1) and Testnet (2).
 * Legacy hex formats are accepted only on Devnet (3) and Local (1337).
 */
export function isValidAddress(address: string, chainId: number): boolean {
  try {
    parseAddressForChain(address, chainId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse an address for a specific chain ID, returning the 32-byte public key.
 */
export function parseAddressForChain(address: string, chainId: number): Uint8Array {
  const trimmed = address.trim();

  // Try canonical PRO-21 format first
  if (
    trimmed.length === ADDRESS_LEN &&
    trimmed.startsWith(ADDRESS_PREFIX) &&
    trimmed.endsWith(ADDRESS_SUFFIX)
  ) {
    return decodeAddress(trimmed);
  }

  // If not canonical, check whether legacy addresses are allowed on this chain
  if (!isLegacyAddressAllowed(chainId)) {
    throw new Error(
      `Legacy addresses are not allowed on chain ${chainId}. Only canonical ${ADDRESS_LEN}-character kvnc...dag base32 addresses are accepted.`,
    );
  }

  return parseLegacyAddress(trimmed);
}

function parseHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid hex length");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const val = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(val)) {
      throw new Error(`Invalid hex byte at index ${i * 2}`);
    }
    bytes[i] = val;
  }
  return bytes;
}

/**
 * Parses legacy address formats (chain-independent helper).
 */
export function parseLegacyAddress(rawAddress: string): Uint8Array {
  const trimmed = rawAddress.trim();

  // kvnc<72 hex>dag (32 bytes key + 4 bytes blake3 checksum)
  if (trimmed.startsWith(ADDRESS_PREFIX) || trimmed.endsWith(ADDRESS_SUFFIX)) {
    if (!trimmed.startsWith(ADDRESS_PREFIX) || !trimmed.endsWith(ADDRESS_SUFFIX)) {
      throw new Error(`Legacy address missing "${ADDRESS_PREFIX}" prefix or "${ADDRESS_SUFFIX}" suffix`);
    }
    const body = trimmed.slice(ADDRESS_PREFIX.length, trimmed.length - ADDRESS_SUFFIX.length);
    if (!/^[0-9a-fA-F]+$/.test(body)) {
      throw new Error("Legacy address payload must be hex");
    }
    const bytes = parseHex(body);
    if (bytes.length !== ADDRESS_PAYLOAD_LEN + LEGACY_CHECKSUM_LEN) {
      throw new Error(`Legacy address payload must be 36 bytes (72 hex chars), got ${bytes.length}`);
    }

    const payload = bytes.slice(0, ADDRESS_PAYLOAD_LEN);
    const check = bytes.slice(ADDRESS_PAYLOAD_LEN);
    const expected = legacyChecksum(payload);

    for (let i = 0; i < LEGACY_CHECKSUM_LEN; i++) {
      if (check[i] !== expected[i]) {
        throw new Error("Legacy address checksum mismatch");
      }
    }
    return payload;
  }

  // Bare hex or 0x-prefixed hex (32 bytes; prefix is strictly lowercase "0x" per kovanica-types)
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("Hex address must be valid hexadecimal");
  }
  const bytes = parseHex(hex);
  if (bytes.length !== ADDRESS_PAYLOAD_LEN) {
    throw new Error(`Address must be exactly 32 bytes (64 hex characters), got ${bytes.length}`);
  }
  return bytes;
}
