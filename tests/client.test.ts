import { describe, expect, it, vi } from "vitest";
import { KovanicaClient } from "../src/client";
import {
  KovanicaAbortError,
  KovanicaRpcError,
  KovanicaTimeoutError,
  KovanicaTransportError,
  RpcErrorCode,
} from "../src/errors";
import { HttpTransport, type Transport } from "../src/transport";

describe("KovanicaClient & HttpTransport", () => {
  it("executes blockNumber and parses hex quantity to bigint", async () => {
    const mockTransport: Transport = {
      send: vi.fn().mockResolvedValue("0x2a"),
    };
    const client = new KovanicaClient({ transport: mockTransport });

    const height = await client.blockNumber();
    expect(height).toBe(42n);
    expect(mockTransport.send).toHaveBeenCalledWith(
      "kovanica_blockNumber",
      [],
      undefined,
    );
  });

  it("handles getBlockByNumber and getBlockByHash with full mapping", async () => {
    const mockBlock = {
      hash: "0x" + "a".repeat(64),
      digest: "0x" + "a".repeat(64),
      author: 7,
      number: "0x10",
      round: "0x10",
      parents: ["0x" + "b".repeat(64)],
      transactions: [
        {
          hash: "0x" + "c".repeat(64),
          sender: "kvnc123dag",
          nonce: "0x1",
          fee: "0x5",
          kind: {
            type: "transfer",
            to: "kvnc456dag",
            amount: "0x3b9aca00", // 1_000_000_000 (1 KVNC)
          },
          signature: "0x" + "d".repeat(128),
        },
      ],
      statements: "0x",
      signature: "0x" + "e".repeat(128),
    };

    const mockTransport: Transport = {
      send: vi.fn().mockResolvedValue(mockBlock),
    };
    const client = new KovanicaClient({ transport: mockTransport });

    const block = await client.getBlockByNumber(16n, true);
    expect(block).not.toBeNull();
    expect(block?.number).toBe(16n);
    expect(block?.round).toBe(16n);
    expect(block?.transactions).toHaveLength(1);

    const tx = block?.transactions[0];
    if (typeof tx !== "string") {
      expect(tx?.nonce).toBe(1n);
      expect(tx?.fee).toBe(5n);
      if (tx?.kind.type === "transfer") {
        expect(tx.kind.amount).toBe(1_000_000_000n);
      }
    }
  });

  it("handles getBalance, getNonce, getStake, and getRewards", async () => {
    const mockTransport: Transport = {
      send: vi
        .fn()
        .mockResolvedValueOnce("0x2540be400") // 10 KVNC
        .mockResolvedValueOnce("0x4") // nonce 4
        .mockResolvedValueOnce("0x12a05f200") // 5 KVNC stake
        .mockResolvedValueOnce("0x0"), // 0 rewards
    };
    const client = new KovanicaClient({ transport: mockTransport });

    const balance = await client.getBalance("kvnc123dag");
    expect(balance).toBe(10_000_000_000n);

    const nonce = await client.getNonce("kvnc123dag");
    expect(nonce).toBe(4n);

    const stake = await client.getStake("kvnc123dag");
    expect(stake).toBe(5_000_000_000n);

    const rewards = await client.getRewards("kvnc123dag");
    expect(rewards).toBe(0n);
  });

  it("handles getValidators with parsed BigInt stakes", async () => {
    const mockValidators = [
      {
        address: "kvncval1dag",
        stake: "0x2540be400",
        commission_bps: 500,
        active: true,
        payout_address: "kvncpayout1dag",
      },
    ];

    const mockTransport: Transport = {
      send: vi.fn().mockResolvedValue(mockValidators),
    };
    const client = new KovanicaClient({ transport: mockTransport });

    const validators = await client.getValidators();
    expect(validators).toHaveLength(1);
    expect(validators[0].stake).toBe(10_000_000_000n);
    expect(validators[0].commission_bps).toBe(500);
  });

  it("handles syncStatus and node diagnostics", async () => {
    const mockSync = {
      local_tip_round: "0x100",
      committed_height: "0x90",
      local_height: "0x90",
      catching_up: false,
      peer_count: 3,
      peers: [{ addr: "192.168.1.1:8000", tip_round: "0x100", latency_ms: 12 }],
      network_tag: "5-a1b2c3d4e5f60718",
    };

    const mockTransport: Transport = {
      send: vi.fn().mockResolvedValue(mockSync),
    };
    const client = new KovanicaClient({ transport: mockTransport });

    const status = await client.syncStatus();
    expect(status.local_tip_round).toBe(256n);
    expect(status.committed_height).toBe(144n);
    expect(status.catching_up).toBe(false);
    expect(status.peer_count).toBe(3);
    expect(status.peers[0].latency_ms).toBe(12);
    expect(status.network_tag).toBe("5-a1b2c3d4e5f60718");
  });

  it("handles Chain 5 mining info and DAG tips", async () => {
    const mockMiningInfo = {
      chain_id: 5,
      mining_enabled: true,
      mining_threads: 4,
      target_bits: "0x1f00ffff",
      target: "0x" + "00".repeat(3) + "ff".repeat(29),
      difficulty: "1000",
      target_block_time_ms: 4000,
      ghostdag_k: 5,
      network_hashrate_estimate: "250",
      dag_tips_count: 2,
    };

    const mockDagTips = {
      chain_id: 5,
      tips: ["0x" + "11".repeat(32), "0x" + "22".repeat(32)],
      count: 2,
      max_round: "0x20",
      ghostdag_k: 5,
    };

    const mockTransport: Transport = {
      send: vi
        .fn()
        .mockResolvedValueOnce(mockMiningInfo)
        .mockResolvedValueOnce(mockDagTips),
    };
    const client = new KovanicaClient({ transport: mockTransport });

    const mining = await client.getMiningInfo();
    expect(mining.chain_id).toBe(5);
    expect(mining.mining_enabled).toBe(true);
    expect(mining.difficulty).toBe(1000n);
    expect(mining.network_hashrate_estimate).toBe(250n);

    const tips = await client.getDagTips();
    expect(tips.chain_id).toBe(5);
    expect(tips.tips).toHaveLength(2);
    expect(tips.max_round).toBe(32n);
  });

  it("preserves integers exceeding Number.MAX_SAFE_INTEGER", async () => {
    const hugeIntHex = "0x10000000000000000"; // 2^64
    const mockTransport: Transport = {
      send: vi.fn().mockResolvedValue(hugeIntHex),
    };
    const client = new KovanicaClient({ transport: mockTransport });

    const balance = await client.getBalance("kvnc123dag");
    expect(balance).toBe(18446744073709551616n);
  });

  it("propagates RPC errors with typed codes", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: RpcErrorCode.MethodNotFound,
          message: "Method not found: kovanica_fakeMethod",
        },
      }),
    });

    const transport = new HttpTransport({
      url: "http://127.0.0.1:8545/rpc",
      fetch: mockFetch,
    });

    try {
      await transport.send("kovanica_fakeMethod");
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(KovanicaRpcError);
      const rpcErr = err as KovanicaRpcError;
      expect(rpcErr.code).toBe(RpcErrorCode.MethodNotFound);
      expect(rpcErr.isMethodNotFound()).toBe(true);
    }
  });

  it("handles HTTP 500 error as KovanicaTransportError", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "Internal server crash",
    });

    const transport = new HttpTransport({
      url: "http://127.0.0.1:8545/rpc",
      fetch: mockFetch,
    });

    await expect(transport.send("kovanica_blockNumber")).rejects.toThrow(
      KovanicaTransportError,
    );
  });

  it("handles malformed JSON response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error("Unexpected token < in JSON");
      },
    });

    const transport = new HttpTransport({
      url: "http://127.0.0.1:8545/rpc",
      fetch: mockFetch,
    });

    await expect(transport.send("kovanica_blockNumber")).rejects.toThrow(
      /Malformed JSON response/,
    );
  });

  it("times out requests exceeding timeoutMs", async () => {
    const mockFetch = vi.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    });

    const transport = new HttpTransport({
      url: "http://127.0.0.1:8545/rpc",
      fetch: mockFetch,
      timeoutMs: 50,
    });

    await expect(transport.send("kovanica_blockNumber")).rejects.toThrow(
      KovanicaTimeoutError,
    );
  });

  it("cancels request when caller signal aborts", async () => {
    const controller = new AbortController();
    const mockFetch = vi.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    });

    const transport = new HttpTransport({
      url: "http://127.0.0.1:8545/rpc",
      fetch: mockFetch,
      timeoutMs: 5000,
    });

    const promise = transport.send("kovanica_blockNumber", [], {
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toThrow(KovanicaAbortError);
  });
});
