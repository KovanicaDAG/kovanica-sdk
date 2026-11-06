import { describe, expect, it } from "vitest";
import { formatKvnc, parseKvnc, parseQuantity, toHexQuantity } from "../src/units";

describe("units and quantity handling", () => {
  it("losslessly parses hex quantities to bigint", () => {
    expect(parseQuantity("0x0")).toBe(0n);
    expect(parseQuantity("0x1")).toBe(1n);
    expect(parseQuantity("0xa")).toBe(10n);
    expect(parseQuantity("0x2540be400")).toBe(10_000_000_000n);
    // Quantity exceeding Number.MAX_SAFE_INTEGER
    expect(parseQuantity("0x10000000000000000")).toBe(18446744073709551616n);
  });

  it("handles decimal string quantities", () => {
    expect(parseQuantity("1000000")).toBe(1000000n);
    expect(parseQuantity("-500")).toBe(-500n);
  });

  it("accepts safe numbers but rejects unsafe numbers", () => {
    expect(parseQuantity(42)).toBe(42n);
    expect(parseQuantity(Number.MAX_SAFE_INTEGER)).toBe(9007199254740991n);

    expect(() => parseQuantity(Number.MAX_SAFE_INTEGER + 100)).toThrow(
      /exceeds Number\.MAX_SAFE_INTEGER/,
    );
  });

  it("formats integers to minimal 0x hex strings", () => {
    expect(toHexQuantity(0n)).toBe("0x0");
    expect(toHexQuantity(1n)).toBe("0x1");
    expect(toHexQuantity(15n)).toBe("0xf");
    expect(toHexQuantity(16n)).toBe("0x10");
    expect(toHexQuantity(255n)).toBe("0xff");
    expect(toHexQuantity(18446744073709551616n)).toBe("0x10000000000000000");

    expect(() => toHexQuantity(-1n)).toThrow(/cannot be negative/);
  });

  it("formats atomic units to human-readable KVNC", () => {
    expect(formatKvnc(1_000_000_000n)).toBe("1");
    expect(formatKvnc(2_500_000_000n)).toBe("2.5");
    expect(formatKvnc(100_000_000n)).toBe("0.1");
    expect(formatKvnc(1n)).toBe("0.000000001");
    expect(formatKvnc(0n)).toBe("0");
    expect(formatKvnc(-2_500_000_000n)).toBe("-2.5");

    // With explicit min/max fraction digits
    expect(formatKvnc(2_500_000_000n, { minFractionDigits: 4 })).toBe("2.5000");
    expect(formatKvnc(1_234_567_890n, { maxFractionDigits: 2 })).toBe("1.23");
  });

  it("parses human-readable KVNC strings into atoms", () => {
    expect(parseKvnc("1")).toBe(1_000_000_000n);
    expect(parseKvnc("2.5")).toBe(2_500_000_000n);
    expect(parseKvnc("0.1")).toBe(100_000_000n);
    expect(parseKvnc("0.000000001")).toBe(1n);
    expect(parseKvnc("0")).toBe(0n);
    expect(parseKvnc("-2.5")).toBe(-2_500_000_000n);

    // Rejects more than 9 decimal places
    expect(() => parseKvnc("0.0000000001")).toThrow(/at most 9 decimal places/);
    expect(() => parseKvnc("abc")).toThrow(/Invalid whole part/);
  });
});
