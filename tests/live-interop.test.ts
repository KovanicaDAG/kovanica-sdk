/**
 * Live Interoperability Test Suite.
 *
 * Distinct from deterministic fixture tests:
 * This suite verifies compatibility against an active running Kovanica L1 node
 * (via KOVANICA_RPC_URL or default http://127.0.0.1:8545/rpc).
 * If no live node is reachable in the local environment, tests skip cleanly with diagnostic output.
 */

import { describe, expect, it } from "vitest";
import { isNodeSynced, KovanicaClient } from "../src/client";

const LIVE_RPC_URL = process.env.KOVANICA_RPC_URL || "http://127.0.0.1:8545/rpc";

async function isLiveNodeAvailable(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "kovanica_syncStatus",
        params: [],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

describe("Live L1 Node Interoperability", () => {
  it("interoperates with live Kovanica L1 RPC node if running", async (ctx) => {
    const available = await isLiveNodeAvailable(LIVE_RPC_URL);
    if (!available) {
      ctx.skip(
        `[Live Interop Skipped] No live Kovanica node reachable at ${LIVE_RPC_URL}. ` +
          "Run a local kovanica-node or set KOVANICA_RPC_URL for live cross-process verification.",
      );
      return;
    }

    const client = new KovanicaClient(LIVE_RPC_URL);

    // 1. syncStatus interop
    const status = await client.syncStatus();
    expect(status).toBeDefined();
    expect(typeof status.peerCount === "number" || status.peerCount === undefined).toBe(true);
    expect(Array.isArray(status.peers)).toBe(true);
    if (status.localTipRound !== undefined) {
      expect(typeof status.localTipRound).toBe("bigint");
    }
    if (status.committedHeight !== undefined) {
      expect(typeof status.committedHeight).toBe("bigint");
    }

    // Verify sync helper
    const synced = isNodeSynced(status);
    expect(synced === true || synced === false || synced === undefined).toBe(true);

    // 2. blockNumber interop
    const height = await client.blockNumber();
    expect(typeof height).toBe("bigint");
    expect(height >= 0n).toBe(true);
  });
});
