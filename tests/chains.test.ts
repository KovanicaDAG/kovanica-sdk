import { describe, expect, it } from "vitest";
import {
  CHAIN_IDS,
  getChainConfig,
  isLegacyAddressAllowed,
  KNOWN_CHAINS,
} from "../src/chains";

describe("chains configuration", () => {
  it("defines standard Kovanica chain IDs", () => {
    expect(CHAIN_IDS.MAINNET).toBe(1);
    expect(CHAIN_IDS.TESTNET).toBe(2);
    expect(CHAIN_IDS.DEVNET).toBe(3);
    expect(CHAIN_IDS.TESTNET_V2).toBe(4);
    expect(CHAIN_IDS.HYBRID_TESTNET).toBe(5);
    expect(CHAIN_IDS.LOCAL).toBe(1337);
  });

  it("retrieves chain config by chain ID", () => {
    const mainnet = getChainConfig(CHAIN_IDS.MAINNET);
    expect(mainnet).toBeDefined();
    expect(mainnet?.name).toBe("Mainnet");
    expect(mainnet?.ticker).toBe("KVNC");
    expect(mainnet?.decimals).toBe(9);
    expect(mainnet?.allowsLegacyAddress).toBe(false);

    const hybrid = getChainConfig(CHAIN_IDS.HYBRID_TESTNET);
    expect(hybrid).toBeDefined();
    expect(hybrid?.name).toBe("Hybrid PoW Testnet");
    expect(hybrid?.consensus).toBe("Hybrid PoW + GHOSTDAG");
    expect(hybrid?.targetBlockTimeMs).toBe(4000);
    expect(hybrid?.ghostdagK).toBe(5);
    expect(hybrid?.allowsLegacyAddress).toBe(true);
  });

  it("accurately reports legacy address allowance", () => {
    expect(isLegacyAddressAllowed(1)).toBe(false);
    expect(isLegacyAddressAllowed(2)).toBe(false);
    expect(isLegacyAddressAllowed(3)).toBe(true);
    expect(isLegacyAddressAllowed(4)).toBe(true);
    expect(isLegacyAddressAllowed(5)).toBe(true);
    expect(isLegacyAddressAllowed(1337)).toBe(true);
    expect(isLegacyAddressAllowed(999)).toBe(false);
  });
});
