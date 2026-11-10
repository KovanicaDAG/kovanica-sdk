import { describe, expect, it } from "vitest";
import {
  decodeAddress,
  encodeAddress,
  isValidAddress,
  parseAddressForChain,
} from "../src/address";
import { CHAIN_IDS } from "../src/chains";

describe("PRO-21 address handling", () => {
  const sampleKey = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    sampleKey[i] = i;
  }

  it("encodes a 32-byte public key into a 64-character canonical address", () => {
    const encoded = encodeAddress(sampleKey);
    expect(encoded).toHaveLength(64);
    expect(encoded.startsWith("kvnc")).toBe(true);
    expect(encoded.endsWith("dag")).toBe(true);

    // Decodes back to the exact same bytes
    const decoded = decodeAddress(encoded);
    expect(decoded).toEqual(sampleKey);
  });

  it("rejects an address with corrupted checksum", () => {
    const encoded = encodeAddress(sampleKey);
    // Mutate one character in the body (e.g. at index 10)
    const charToReplace = encoded[10] === "q" ? "p" : "q";
    const corrupted =
      encoded.slice(0, 10) + charToReplace + encoded.slice(11);

    expect(() => decodeAddress(corrupted)).toThrow(/checksum mismatch/);
  });

  it("rejects an address with incorrect length", () => {
    expect(() => decodeAddress("kvnctooshortdag")).toThrow(/must be exactly 64 characters/);
  });

  it("rejects an address missing prefix or suffix", () => {
    const valid = encodeAddress(sampleKey);
    const badPrefix = "xxxx" + valid.slice(4);
    expect(() => decodeAddress(badPrefix)).toThrow(/must start with "kvnc"/);
  });

  it("enforces strict PRO-21 addresses on Mainnet (1) and Testnet (2)", () => {
    const validCanonical = encodeAddress(sampleKey);
    expect(isValidAddress(validCanonical, CHAIN_IDS.MAINNET)).toBe(true);
    expect(isValidAddress(validCanonical, CHAIN_IDS.TESTNET)).toBe(true);

    // Bare hex is rejected on chain 1 and 2
    const hex = "0x" + "00".repeat(32);
    expect(isValidAddress(hex, CHAIN_IDS.MAINNET)).toBe(false);
    expect(isValidAddress(hex, CHAIN_IDS.TESTNET)).toBe(false);

    expect(() => parseAddressForChain(hex, CHAIN_IDS.MAINNET)).toThrow(
      /Legacy addresses are not allowed on chain 1/,
    );
  });

  it("allows legacy hex addresses on Devnet (3), Testnet V2 (4), and Local (1337)", () => {
    const hex = "0x" + "01".repeat(32);
    expect(isValidAddress(hex, CHAIN_IDS.DEVNET)).toBe(true);
    expect(isValidAddress(hex, CHAIN_IDS.TESTNET_V2)).toBe(true);
    expect(isValidAddress(hex, CHAIN_IDS.TESTNET)).toBe(false);
    expect(isValidAddress(hex, CHAIN_IDS.LOCAL)).toBe(true);

    const parsed = parseAddressForChain(hex, CHAIN_IDS.DEVNET);
    expect(parsed).toEqual(new Uint8Array(32).fill(1));
  });
});
