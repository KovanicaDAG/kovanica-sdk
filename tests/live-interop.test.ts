/**
 * Live Interoperability Test Suite.
 *
 * Distinct from deterministic fixture tests:
 * This suite verifies read-only compatibility against an active running Kovanica L1 node
 * (configured via KOVANICA_RPC_URL, defaulting to http://127.0.0.1:8545/rpc).
 *
 * Test Modes:
 * 1. Default (Optional) Mode (`npm test`):
 *    If no live node is reachable, or the endpoint fails JSON-RPC readiness validation,
 *    live verification is cleanly skipped with a diagnostic notice. Offline unit/fixture tests pass.
 *
 * 2. Required-Live Mode (`npm run test:live` or `KOVANICA_REQUIRE_LIVE=1 npm test`):
 *    The test fails immediately if the node is unavailable or fails JSON-RPC readiness.
 *    HTTP 200 alone is NOT a valid readiness check: the endpoint must return a valid JSON-RPC 2.0
 *    response with valid `kovanica_syncStatus` schema.
 */

import { describe, expect, it } from "vitest";
import { isNodeSynced, KovanicaClient } from "../src/client";
import { CHAIN_IDS } from "../src/chains";

export const LIVE_RPC_URL = process.env.KOVANICA_RPC_URL || "http://127.0.0.1:8545/rpc";
export const REQUIRE_LIVE =
  process.env.KOVANICA_REQUIRE_LIVE === "1" ||
  process.env.KOVANICA_REQUIRE_LIVE === "true";

export interface ReadinessCheckResult {
  ready: boolean;
  reason?: string;
  payload?: any;
}

/**
 * Validates whether an endpoint is genuinely ready to serve Kovanica JSON-RPC.
 * An HTTP 200 response alone is insufficient: proxies, web servers, or misconfigured
 * ports can return HTTP 200 with HTML, error objects, or non-conforming payloads.
 */
export async function checkNodeReadiness(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2000,
): Promise<ReadinessCheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
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

    if (!res.ok) {
      return {
        ready: false,
        reason: `HTTP ${res.status} ${res.statusText}`,
      };
    }

    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        ready: false,
        reason: `Endpoint returned non-JSON body: "${text.slice(0, 100)}"`,
      };
    }

    if (!json || typeof json !== "object" || Array.isArray(json)) {
      return {
        ready: false,
        reason: "Endpoint response is not a JSON object",
      };
    }

    if (json.jsonrpc !== "2.0") {
      return {
        ready: false,
        reason: `Invalid JSON-RPC protocol version: expected "2.0", got "${json.jsonrpc}"`,
      };
    }

    if (json.error) {
      return {
        ready: false,
        reason: `Endpoint returned JSON-RPC error [${json.error.code}]: ${json.error.message}`,
      };
    }

    if (!json.result || typeof json.result !== "object") {
      return {
        ready: false,
        reason: "kovanica_syncStatus result is not an object",
      };
    }

    if (typeof json.result.catchingUp !== "boolean") {
      return {
        ready: false,
        reason: `kovanica_syncStatus result missing boolean "catchingUp" field (got ${typeof json.result.catchingUp})`,
      };
    }

    if (typeof json.result.peerCount !== "number" || !Number.isSafeInteger(json.result.peerCount)) {
      return {
        ready: false,
        reason: `kovanica_syncStatus result missing integer "peerCount" field (got ${typeof json.result.peerCount})`,
      };
    }

    return {
      ready: true,
      payload: json.result,
    };
  } catch (err: any) {
    return {
      ready: false,
      reason: `Connection error: ${err.message || String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

describe("Live L1 Node Interoperability", () => {
  // ==========================================================================
  // Readiness Check Unit Tests (verifies HTTP 200 alone is rejected)
  // ==========================================================================

  describe("Readiness check validation (HTTP 200 alone is insufficient)", () => {
    it("rejects HTTP 200 with HTML body", async () => {
      const mockFetch = async () =>
        new Response("<!DOCTYPE html><html><body>200 OK Gateway</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });

      const result = await checkNodeReadiness("http://mock/rpc", mockFetch as any);
      expect(result.ready).toBe(false);
      expect(result.reason).toMatch(/non-JSON/);
    });

    it("rejects HTTP 200 with non-JSON-RPC object", async () => {
      const mockFetch = async () =>
        new Response(JSON.stringify({ status: "healthy", timestamp: Date.now() }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      const result = await checkNodeReadiness("http://mock/rpc", mockFetch as any);
      expect(result.ready).toBe(false);
      expect(result.reason).toMatch(/Invalid JSON-RPC protocol version/);
    });

    it("rejects HTTP 200 with JSON-RPC error response", async () => {
      const mockFetch = async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32601, message: "Method not found" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );

      const result = await checkNodeReadiness("http://mock/rpc", mockFetch as any);
      expect(result.ready).toBe(false);
      expect(result.reason).toMatch(/JSON-RPC error \[-32601\]/);
    });

    it("rejects HTTP 200 with invalid syncStatus payload schema", async () => {
      const mockFetch = async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { peer_count: 5 }, // missing catchingUp and wrong camelCase
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );

      const result = await checkNodeReadiness("http://mock/rpc", mockFetch as any);
      expect(result.ready).toBe(false);
      expect(result.reason).toMatch(/missing boolean "catchingUp"/);
    });

    it("accepts HTTP 200 with conforming JSON-RPC syncStatus payload", async () => {
      const mockFetch = async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              catchingUp: false,
              peerCount: 0,
              committedHeight: 0,
              localTipRound: 0,
              peers: [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );

      const result = await checkNodeReadiness("http://mock/rpc", mockFetch as any);
      expect(result.ready).toBe(true);
      expect(result.payload.peerCount).toBe(0);
    });
  });

  // ==========================================================================
  // Live Node Execution Suite
  // ==========================================================================

  describe("Live node RPC queries", () => {
    it("interoperates with live Kovanica L1 RPC node", async (ctx) => {
      const readiness = await checkNodeReadiness(LIVE_RPC_URL);

      if (!readiness.ready) {
        if (REQUIRE_LIVE) {
          throw new Error(
            `[REQUIRED-LIVE FAILURE] Required live node check failed for ${LIVE_RPC_URL}: ${readiness.reason}. ` +
              "Ensure an isolated local node is running and configured via KOVANICA_RPC_URL.",
          );
        } else {
          ctx.skip(
            `[Live Interop Skipped] No conforming Kovanica L1 node ready at ${LIVE_RPC_URL} (${readiness.reason}). ` +
              "Set KOVANICA_REQUIRE_LIVE=1 or run 'npm run test:live' to require a live node.",
          );
          return;
        }
      }

      const client = new KovanicaClient(LIVE_RPC_URL);

      // 1. syncStatus live verification
      const status = await client.syncStatus();
      expect(status).toBeDefined();
      expect(typeof status.catchingUp).toBe("boolean");
      expect(typeof status.peerCount).toBe("number");
      expect(status.peerCount! >= 0).toBe(true);
      expect(Array.isArray(status.peers)).toBe(true);

      // Verify numeric precision and explicit zero preservation on live response
      if (status.localTipRound !== undefined) {
        expect(typeof status.localTipRound).toBe("bigint");
        expect(status.localTipRound >= 0n).toBe(true);
      }
      if (status.committedHeight !== undefined) {
        expect(typeof status.committedHeight).toBe("bigint");
        expect(status.committedHeight >= 0n).toBe(true);
      }

      // 2. isNodeSynced live semantics
      const synced = isNodeSynced(status);
      if (status.catchingUp === true) {
        expect(synced).toBe(false);
      } else if (status.peerCount === 0 || status.localTipRound === undefined) {
        // In an isolated zero-peer node, catchingUp=false alone is insufficient to claim in-sync:
        // status is correctly indeterminate (undefined), never falsely claimed as synced!
        expect(synced).toBeUndefined();
      } else {
        expect(synced).toBe(true);
      }

      // 3. blockNumber live verification
      const blockNumber = await client.blockNumber();
      expect(typeof blockNumber).toBe("bigint");
      expect(blockNumber >= 0n).toBe(true);

      // 4. Network identity & Chain 5 mining/DAG queries
      if (status.networkTag) {
        expect(typeof status.networkTag).toBe("string");
        const parts = status.networkTag.split("-");
        const reportedChainId = Number(parts[0]);
        expect(Number.isInteger(reportedChainId)).toBe(true);

        // If the live node is running on Chain 5 (Hybrid PoW testnet), verify mining methods
        if (reportedChainId === CHAIN_IDS.HYBRID_TESTNET) {
          const mining = await client.getMiningInfo();
          expect(mining.chain_id).toBe(5);
          expect(typeof mining.mining_enabled).toBe("boolean");
          expect(typeof mining.mining_threads).toBe("number");
          expect(typeof mining.difficulty).toBe("bigint");
          expect(mining.difficulty >= 0n).toBe(true);
          expect(mining.target_bits.startsWith("0x")).toBe(true);
          expect(mining.target.startsWith("0x")).toBe(true);
          expect(mining.target_block_time_ms).toBe(4000);
          expect(mining.ghostdag_k).toBe(5);
          expect(typeof mining.network_hashrate_estimate).toBe("bigint");
          expect(mining.dag_tips_count >= 1).toBe(true);

          const tips = await client.getDagTips();
          expect(tips.chain_id).toBe(5);
          expect(tips.count >= 1).toBe(true);
          expect(typeof tips.max_round).toBe("bigint");
          expect(tips.ghostdag_k).toBe(5);
          expect(tips.tips.length).toBe(tips.count);
          for (const tip of tips.tips) {
            expect(tip.startsWith("0x")).toBe(true);
            expect(tip.length).toBe(66); // "0x" + 64 hex chars
          }
        }
      }
    });
  });
});
