import { describe, expect, it, vi } from "vitest";
import { isNodeSynced, KovanicaClient, parseSafeOptionalQuantity } from "../src/client";
import { HttpTransport, parseLosslessJson, type Transport } from "../src/transport";
import type { SyncStatus } from "../src/types";

describe("syncStatus source-backed fixtures and regressions", () => {
  // ==========================================================================
  // 1. Valid responses backed by crates/kovanica-rpc/src/chain_methods.rs
  // ==========================================================================

  it("handles valid node catching-up response (source: chain_methods.rs:3222-3258)", async () => {
    // Exact JSON serialization from L1 handle_sync_status when catching up
    const fixtureL1CatchingUp = {
      localTipRound: 120,
      committedHeight: 300,
      localHeight: 300,
      catchingUp: true,
      catchUpTarget: 200,
      behindBy: 80,
      peerCount: 2,
      peers: [
        {
          peerId: "12D3KooWpeer-a",
          reportedTipRound: 200,
        },
        {
          peerId: "12D3KooWpeer-b",
          // Peer b has no reported tip round: omitted on wire
        },
      ],
      networkTag: "2-0123456789abcdef",
    };

    const mockTransport: Transport = {
      send: vi.fn().mockResolvedValue(fixtureL1CatchingUp),
    };
    const client = new KovanicaClient({ transport: mockTransport });

    const status = await client.syncStatus();

    // Canonical camelCase
    expect(status.localTipRound).toBe(120n);
    expect(status.committedHeight).toBe(300n);
    expect(status.localHeight).toBe(300n);
    expect(status.catchingUp).toBe(true);
    expect(status.catchUpTarget).toBe(200n);
    expect(status.behindBy).toBe(80n);
    expect(status.peerCount).toBe(2);
    expect(status.peers).toHaveLength(2);
    expect(status.peers[0].peerId).toBe("12D3KooWpeer-a");
    expect(status.peers[0].reportedTipRound).toBe(200n);
    expect(status.peers[1].peerId).toBe("12D3KooWpeer-b");
    expect(status.peers[1].reportedTipRound).toBeUndefined();
    expect(status.networkTag).toBe("2-0123456789abcdef");

    // Backwards-compatible aliases
    expect(status.local_tip_round).toBe(120n);
    expect(status.committed_height).toBe(300n);
    expect(status.local_height).toBe(300n);
    expect(status.catching_up).toBe(true);
    expect(status.catch_up_target).toBe(200n);
    expect(status.behind_by).toBe(80n);
    expect(status.peer_count).toBe(2);
    expect(status.peers[0].peer_id).toBe("12D3KooWpeer-a");
    expect(status.peers[0].reported_tip_round).toBe(200n);
    expect(status.network_tag).toBe("2-0123456789abcdef");

    // Catching up means definitely not in sync
    expect(isNodeSynced(status)).toBe(false);
  });

  it("handles valid node in-sync response (source: node.rs:56-65, main.rs:893-903)", async () => {
    const fixtureL1InSync = {
      localTipRound: 500,
      committedHeight: 500,
      localHeight: 500,
      catchingUp: false,
      peerCount: 4,
      peers: [
        { peerId: "12D3KooWpeer-1", reportedTipRound: 500 },
        { peerId: "12D3KooWpeer-2", reportedTipRound: 500 },
      ],
      networkTag: "1-fedcba9876543210",
    };

    const mockTransport: Transport = {
      send: vi.fn().mockResolvedValue(fixtureL1InSync),
    };
    const client = new KovanicaClient({ transport: mockTransport });

    const status = await client.syncStatus();
    expect(status.catchingUp).toBe(false);
    expect(status.localTipRound).toBe(500n);
    expect(status.committedHeight).toBe(500n);
    expect(status.catchUpTarget).toBeUndefined();
    expect(status.behindBy).toBeUndefined();
    expect(status.peerCount).toBe(4);

    expect(isNodeSynced(status)).toBe(true);
  });

  it("handles bare peer count response without sync source (source: chain_methods.rs:3203-3216)", async () => {
    // When no SyncStatusSource is installed on RPC server, only peerCount, catchingUp: false, and empty peers are reported
    const fixtureBareRpc = {
      peerCount: 3,
      catchingUp: false,
      peers: [],
    };

    const mockTransport: Transport = {
      send: vi.fn().mockResolvedValue(fixtureBareRpc),
    };
    const client = new KovanicaClient({ transport: mockTransport });

    const status = await client.syncStatus();
    expect(status.peerCount).toBe(3);
    expect(status.catchingUp).toBe(false);
    expect(status.peers).toEqual([]);
    expect(status.localTipRound).toBeUndefined();
    expect(status.committedHeight).toBeUndefined();
    expect(status.catchUpTarget).toBeUndefined();
    expect(status.behindBy).toBeUndefined();
    expect(status.networkTag).toBeUndefined();

    // catchingUp=false alone is insufficient when localTipRound is undefined: state is indeterminate
    expect(isNodeSynced(status)).toBeUndefined();
  });

  // ==========================================================================
  // 2. Missing and wrong types (regressions)
  // ==========================================================================

  it("never turns unknown catchingUp into false (synced claim)", async () => {
    const payloadsWithInvalidCatchingUp = [
      {}, // missing catchingUp entirely
      { catchingUp: null },
      { catchingUp: "false" }, // string, not boolean
      { catchingUp: 0 }, // number, not boolean
      { catchingUp: undefined },
    ];

    for (const raw of payloadsWithInvalidCatchingUp) {
      const mockTransport: Transport = {
        send: vi.fn().mockResolvedValue(raw),
      };
      const client = new KovanicaClient({ transport: mockTransport });

      const status = await client.syncStatus();
      expect(status.catchingUp).toBeUndefined();
      expect(status.catching_up).toBeUndefined();
      expect(isNodeSynced(status)).toBeUndefined();
    }
  });

  it("never turns unknown peerCount into 0", async () => {
    const rawWithoutPeerCount = {
      localTipRound: 100,
      catchingUp: false,
    };

    const mockTransport: Transport = {
      send: vi.fn().mockResolvedValue(rawWithoutPeerCount),
    };
    const client = new KovanicaClient({ transport: mockTransport });

    const status = await client.syncStatus();
    expect(status.peerCount).toBeUndefined();
    expect(status.peer_count).toBeUndefined();
  });

  it("safely handles wrong types in fields without crashing or corrupting state", async () => {
    const malformedTypesPayload = {
      localTipRound: true, // boolean instead of number
      committedHeight: { height: 123 }, // object
      catchingUp: "yes", // string instead of boolean
      catchUpTarget: "invalid_hex", // malformed string
      behindBy: null,
      peerCount: -5, // negative peer count
      peers: "not_an_array", // string instead of array
      networkTag: 12345, // number instead of string
    };

    const mockTransport: Transport = {
      send: vi.fn().mockResolvedValue(malformedTypesPayload),
    };
    const client = new KovanicaClient({ transport: mockTransport });

    const status = await client.syncStatus();
    expect(status.localTipRound).toBeUndefined();
    expect(status.committedHeight).toBeUndefined();
    expect(status.catchingUp).toBeUndefined();
    expect(status.catchUpTarget).toBeUndefined();
    expect(status.behindBy).toBeUndefined();
    expect(status.peerCount).toBeUndefined();
    expect(status.peers).toEqual([]);
    expect(status.networkTag).toBeUndefined();
  });

  it("safely filters out malformed peers without peerId", async () => {
    const payloadWithBadPeers = {
      catchingUp: false,
      peerCount: 3,
      peers: [
        null,
        {},
        { peerId: "" }, // empty string
        { peerId: "   " }, // whitespace only
        { peerId: 12345 }, // non-string
        { peerId: "12D3KooWValid", reportedTipRound: "not-a-number" },
      ],
    };

    const mockTransport: Transport = {
      send: vi.fn().mockResolvedValue(payloadWithBadPeers),
    };
    const client = new KovanicaClient({ transport: mockTransport });

    const status = await client.syncStatus();
    expect(status.peers).toHaveLength(1);
    expect(status.peers[0].peerId).toBe("12D3KooWValid");
    expect(status.peers[0].reportedTipRound).toBeUndefined();
  });

  it("throws TypeError if syncStatus payload is not an object", async () => {
    const nonObjectPayloads = [null, undefined, "hello", 123];

    for (const raw of nonObjectPayloads) {
      const mockTransport: Transport = {
        send: vi.fn().mockResolvedValue(raw),
      };
      const client = new KovanicaClient({ transport: mockTransport });

      await expect(client.syncStatus()).rejects.toThrow(TypeError);
    }
  });

  // ==========================================================================
  // 3. Explicit zero handling (never dropped or turned to undefined)
  // ==========================================================================

  it("preserves explicit zero across all numeric and quantity fields", async () => {
    const explicitZeroPayload = {
      localTipRound: 0,
      committedHeight: 0,
      localHeight: 0,
      catchingUp: false,
      catchUpTarget: 0,
      behindBy: 0,
      peerCount: 0,
      peers: [
        {
          peerId: "12D3KooWpeer-genesis",
          reportedTipRound: 0,
        },
      ],
      networkTag: "1-0000000000000000",
    };

    const mockTransport: Transport = {
      send: vi.fn().mockResolvedValue(explicitZeroPayload),
    };
    const client = new KovanicaClient({ transport: mockTransport });

    const status = await client.syncStatus();
    expect(status.localTipRound).toBe(0n);
    expect(status.committedHeight).toBe(0n);
    expect(status.localHeight).toBe(0n);
    expect(status.catchingUp).toBe(false);
    expect(status.catchUpTarget).toBe(0n);
    expect(status.behindBy).toBe(0n);
    expect(status.peerCount).toBe(0);
    expect(status.peers[0].reportedTipRound).toBe(0n);

    // Also check hex zero "0x0"
    const hexZeroPayload = {
      localTipRound: "0x0",
      committedHeight: "0x0",
      localHeight: "0x0",
      catchingUp: false,
      catchUpTarget: "0x0",
      behindBy: "0x0",
      peerCount: "0",
      peers: [{ peerId: "12D3KooWpeer-genesis", reportedTipRound: "0x0" }],
    };

    mockTransport.send = vi.fn().mockResolvedValue(hexZeroPayload);
    const statusHex = await client.syncStatus();
    expect(statusHex.localTipRound).toBe(0n);
    expect(statusHex.committedHeight).toBe(0n);
    expect(statusHex.localHeight).toBe(0n);
    expect(statusHex.catchUpTarget).toBe(0n);
    expect(statusHex.behindBy).toBe(0n);
    expect(statusHex.peerCount).toBe(0);
    expect(statusHex.peers[0].reportedTipRound).toBe(0n);
  });

  // ==========================================================================
  // 4. Unavailable data (never turned into 0 or false)
  // ==========================================================================

  it("preserves unavailable data as undefined and refuses false synced claim", async () => {
    // Node starting up: storage read failed or not initialized yet
    const unavailablePayload = {
      // localTipRound omitted
      // committedHeight omitted
      catchingUp: false, // probing phase, not actively catching up
      peerCount: 0, // no peers connected
      peers: [],
    };

    const mockTransport: Transport = {
      send: vi.fn().mockResolvedValue(unavailablePayload),
    };
    const client = new KovanicaClient({ transport: mockTransport });

    const status = await client.syncStatus();
    expect(status.localTipRound).toBeUndefined();
    expect(status.committedHeight).toBeUndefined();
    expect(status.localHeight).toBeUndefined();
    expect(status.catchUpTarget).toBeUndefined();
    expect(status.behindBy).toBeUndefined();
    expect(status.networkTag).toBeUndefined();

    // Never turn unknown state into zero
    expect(status.localTipRound).not.toBe(0n);
    expect(status.committedHeight).not.toBe(0n);

    // catchingUp=false alone is insufficient: node with 0 peers and unknown tip is NOT confirmed synced
    expect(isNodeSynced(status)).toBeUndefined();
  });

  // ==========================================================================
  // 5. Values beyond JavaScript's safe integer range (lossless precision)
  // ==========================================================================

  it("handles quantities up to u64::MAX (18446744073709551615) losslessly", async () => {
    const maxU64String = "18446744073709551615";
    const maxU64BigInt = 18446744073709551615n;

    const hugePayload = {
      localTipRound: maxU64String,
      committedHeight: maxU64String,
      localHeight: maxU64String,
      catchingUp: true,
      catchUpTarget: maxU64String,
      behindBy: "1000",
      peerCount: 5,
      peers: [
        {
          peerId: "12D3KooWHugePeer",
          reportedTipRound: maxU64String,
        },
      ],
      networkTag: "1-fedcba9876543210",
    };

    const mockTransport: Transport = {
      send: vi.fn().mockResolvedValue(hugePayload),
    };
    const client = new KovanicaClient({ transport: mockTransport });

    const status = await client.syncStatus();
    expect(status.localTipRound).toBe(maxU64BigInt);
    expect(status.committedHeight).toBe(maxU64BigInt);
    expect(status.localHeight).toBe(maxU64BigInt);
    expect(status.catchUpTarget).toBe(maxU64BigInt);
    expect(status.peers[0].reportedTipRound).toBe(maxU64BigInt);
  });

  it("parseLosslessJson protects raw JSON text from IEEE-754 precision corruption", () => {
    const rawJsonText = `{
      "jsonrpc": "2.0",
      "result": {
        "localTipRound": 18446744073709551615,
        "committedHeight": 18446744073709551615,
        "peerCount": 3,
        "catchingUp": false,
        "peers": [
          {
            "peerId": "12D3KooWtest",
            "reportedTipRound": 18446744073709551615
          }
        ],
        "note": "String containing 18446744073709551615 inside quotes must not be altered",
        "nested": {
          "safeNum": 42,
          "floatVal": 3.14159
        }
      },
      "id": 1
    }`;

    const parsed = parseLosslessJson(rawJsonText) as any;
    expect(parsed.result.localTipRound).toBe("18446744073709551615");
    expect(parsed.result.committedHeight).toBe("18446744073709551615");
    expect(parsed.result.peerCount).toBe(3);
    expect(parsed.result.catchingUp).toBe(false);
    expect(parsed.result.peers[0].reportedTipRound).toBe("18446744073709551615");
    expect(parsed.result.note).toBe(
      "String containing 18446744073709551615 inside quotes must not be altered",
    );
    expect(parsed.result.nested.safeNum).toBe(42);
    expect(parsed.result.nested.floatVal).toBe(3.14159);
  });

  it("HttpTransport uses parseLosslessJson on response text", async () => {
    const rawJsonText = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        localTipRound: 18446744073709551615n.toString(), // string or raw int
        committedHeight: 9007199254740995n.toString(),
        peerCount: 1,
        catchingUp: false,
        peers: [{ peerId: "peer1", reportedTipRound: 9007199254740995n.toString() }],
      },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => rawJsonText,
      json: async () => JSON.parse(rawJsonText),
    });

    const transport = new HttpTransport({
      url: "http://127.0.0.1:8545/rpc",
      fetch: mockFetch,
    });
    const client = new KovanicaClient({ transport });

    const status = await client.syncStatus();
    expect(status.committedHeight).toBe(9007199254740995n);
    expect(status.localTipRound).toBe(18446744073709551615n);
  });
});
