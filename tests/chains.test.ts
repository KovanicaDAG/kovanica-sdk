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
    expect(CHAIN_IDS.HYBRID_TESTNET).toBe(2);
    expect(CHAIN_IDS.LOCAL).toBe(1337);
  });

  it("retrieves chain config by chain ID", () => {
    const mainnet = getChainConfig(CHAIN_IDS.MAINNET);
    expect(mainnet).toBeDefined();
    expect(mainnet?.name).toBe("Mainnet");
    expect(mainnet?.ticker).toBe("KVNC");
    expect(mainnet?.decimals).toBe(9);
    expect(mainnet?.consensus).toBe("Hybrid PoW + GHOSTDAG");
    expect(mainnet?.ghostdagK).toBe(5);
    expect(mainnet?.allowsLegacyAddress).toBe(false);

    const local = getChainConfig(CHAIN_IDS.LOCAL);
    expect(local).toBeDefined();
    expect(local?.name).toBe("Local Devnet");
    expect(local?.consensus).toBe("Mysticeti");
    expect(local?.ghostdagK).toBeUndefined();
    expect(local?.allowsLegacyAddress).toBe(true);

    const testnet = getChainConfig(CHAIN_IDS.TESTNET);
    expect(testnet).toBeDefined();
    expect(testnet?.name).toBe("Testnet");
    expect(testnet?.consensus).toBe("Hybrid PoW + GHOSTDAG");
    expect(testnet?.targetBlockTimeMs).toBe(4000);
    expect(testnet?.ghostdagK).toBe(5);
    expect(testnet?.allowsLegacyAddress).toBe(false);
  });

  it("accurately reports legacy address allowance", () => {
    expect(isLegacyAddressAllowed(1)).toBe(false);
    expect(isLegacyAddressAllowed(2)).toBe(false);
    expect(isLegacyAddressAllowed(3)).toBe(true);
    expect(isLegacyAddressAllowed(4)).toBe(true);
    expect(isLegacyAddressAllowed(1337)).toBe(true);
    expect(isLegacyAddressAllowed(999)).toBe(false);
  });
});
