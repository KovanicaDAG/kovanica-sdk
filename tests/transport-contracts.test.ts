/**
 * Deterministic Local Mock Server & Transport Contracts Test Suite.
 *
 * Verifies the actual public KovanicaClient and HttpTransport against a real,
 * local HTTP server (using node:http) across transport edge cases:
 * - Connection refusal (ECONNREFUSED)
 * - Timeout handling (KovanicaTimeoutError)
 * - Supported cancellation (pre-aborted and mid-flight AbortSignal)
 * - Non-success HTTP status codes (400, 401, 403, 404, 500, 502, 503)
 * - HTTP 200 with malformed JSON
 * - Invalid JSON-RPC envelopes (non-object, wrong version, missing result/error, both present, malformed error)
 * - Standard and custom typed RPC errors (preserving code, message, data)
 * - Mismatched response IDs
 * - Credential hygiene (never leaking passwords, basic auth, or bearer tokens in error diagnostics)
 * - Bigint numeric precision beyond Number.MAX_SAFE_INTEGER through public API
 * - Explicit preservation of zero vs unknown vs failed states
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isNodeSynced, KovanicaClient } from "../src/client";
import { CHAIN_IDS } from "../src/chains";
import {
  KovanicaAbortError,
  KovanicaRpcError,
  KovanicaTimeoutError,
  KovanicaTransportError,
  RpcErrorCode,
} from "../src/errors";
import { sanitizeDiagnostics } from "../src/transport";
import { parseQuantity, toHexQuantity } from "../src/units";
import { assertNonzeroExecutedState } from "./live-assertions";

describe("Transport Contracts & Precision Verification", () => {
  let server: http.Server;
  let serverUrl: string;
  let serverPort: number;
  let nextHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | null = null;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (nextHandler) {
        const handler = nextHandler;
        handler(req, res);
      } else {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("No handler registered");
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        serverPort = addr.port;
        serverUrl = `http://127.0.0.1:${serverPort}/rpc`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  // Helper to read JSON request body in mock handlers
  async function readRequestBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
      });
      req.on("end", () => {
        try {
          resolve(data.length > 0 ? JSON.parse(data) : null);
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });
  }

  // ==========================================================================
  // A. Transport & Network Contract Tests
  // ==========================================================================

  describe("A. Transport failure and error modes", () => {
    it("handles connection refusal (ECONNREFUSED) without leaking credentials", async () => {
      // Create a temporary server to find an unused port, then immediately close it
      const tempServer = http.createServer();
      await new Promise<void>((resolve) => tempServer.listen(0, "127.0.0.1", () => resolve()));
      const closedPort = (tempServer.address() as AddressInfo).port;
      await new Promise<void>((resolve) => tempServer.close(() => resolve()));

      // Configure client with sensitive credentials in the URL
      const client = new KovanicaClient(`http://user:supersecretpass@127.0.0.1:${closedPort}/rpc`);

      let caughtError: unknown;
      try {
        await client.blockNumber();
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(KovanicaTransportError);
      const transportErr = caughtError as KovanicaTransportError;
      // Error message should NOT expose the secret password
      expect(transportErr.message).not.toContain("supersecretpass");
      expect(transportErr.message).toMatch(/\*\*\*|fetch failed|ECONNREFUSED/);
    });

    it("times out requests exceeding client timeoutMs", async () => {
      nextHandler = (_req, res) => {
        // Intentionally delay longer than the client's timeoutMs
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }));
        }, 150);
      };

      const client = new KovanicaClient({
        url: serverUrl,
        timeoutMs: 30,
      });

      let caughtError: unknown;
      try {
        await client.blockNumber();
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(KovanicaTimeoutError);
      const timeoutErr = caughtError as KovanicaTimeoutError;
      expect(timeoutErr.timeoutMs).toBe(30);
      expect(timeoutErr.message).toContain("Request timed out after 30ms");
    });

    it("cancels request when caller signal aborts mid-flight", async () => {
      nextHandler = (_req, _res) => {
        // Hold connection without responding until cancelled
      };

      const client = new KovanicaClient({ url: serverUrl, timeoutMs: 5000 });
      const controller = new AbortController();

      const callPromise = client.blockNumber({ signal: controller.signal });
      setTimeout(() => controller.abort(), 20);

      await expect(callPromise).rejects.toThrow(KovanicaAbortError);
    });

    it("rejects immediately when caller signal is pre-aborted", async () => {
      const client = new KovanicaClient({ url: serverUrl });
      const controller = new AbortController();
      controller.abort();

      await expect(client.blockNumber({ signal: controller.signal })).rejects.toThrow(
        "Request was already aborted",
      );
    });

    it("handles non-success HTTP status codes and redacts sensitive credentials", async () => {
      const statuses = [400, 401, 403, 404, 500, 502, 503];

      for (const status of statuses) {
        nextHandler = (_req, res) => {
          res.writeHead(status, { "Content-Type": "text/plain" });
          res.end(`Error occurred: Bearer secret-bearer-token-12345 in status ${status}`);
        };

        const client = new KovanicaClient({
          url: serverUrl,
          headers: { Authorization: "Bearer secret-bearer-token-12345" },
        });

        let caughtError: unknown;
        try {
          await client.blockNumber();
        } catch (err) {
          caughtError = err;
        }

        expect(caughtError).toBeInstanceOf(KovanicaTransportError);
        const transportErr = caughtError as KovanicaTransportError;
        expect(transportErr.status).toBe(status);
        expect(transportErr.message).toContain(`HTTP ${status}`);
        // Bearer token must be redacted
        expect(transportErr.message).not.toContain("secret-bearer-token-12345");
        expect(transportErr.message).toContain("Bearer ***");
      }
    });

    it("rejects HTTP 200 with malformed JSON body", async () => {
      nextHandler = (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("<html><body>502 Bad Gateway from reverse proxy</body></html>");
      };

      const client = new KovanicaClient({ url: serverUrl });
      await expect(client.blockNumber()).rejects.toThrow("Malformed JSON response from RPC server");
    });

    it("rejects HTTP 200 with non-object JSON payload", async () => {
      nextHandler = (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(["array", "not", "object"]));
      };

      const client = new KovanicaClient({ url: serverUrl });
      await expect(client.blockNumber()).rejects.toThrow(
        "Invalid JSON-RPC 2.0 response: payload must be a JSON object",
      );
    });

    it("rejects HTTP 200 missing or invalid jsonrpc version", async () => {
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "1.0", id: body.id, result: "0x1" }));
      };

      const client = new KovanicaClient({ url: serverUrl });
      await expect(client.blockNumber()).rejects.toThrow(
        'missing or invalid "jsonrpc" version (expected "2.0", got "1.0")',
      );
    });

    it("rejects HTTP 200 missing both result and error", async () => {
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id }));
      };

      const client = new KovanicaClient({ url: serverUrl });
      await expect(client.blockNumber()).rejects.toThrow(
        "Invalid JSON-RPC 2.0 response: neither result nor error member present",
      );
    });

    it("rejects HTTP 200 with both result and error members present", async () => {
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: "0x1",
            error: { code: -32000, message: "ambiguous" },
          }),
        );
      };

      const client = new KovanicaClient({ url: serverUrl });
      await expect(client.blockNumber()).rejects.toThrow(
        "Invalid JSON-RPC 2.0 response: both result and error members present",
      );
    });

    it("rejects HTTP 200 with malformed error object", async () => {
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: "string error message is invalid per spec",
          }),
        );
      };

      const client = new KovanicaClient({ url: serverUrl });
      await expect(client.blockNumber()).rejects.toThrow(
        "Invalid JSON-RPC 2.0 response: malformed error object",
      );
    });

    it("propagates typed JSON-RPC errors and preserves code, message, and data", async () => {
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: {
              code: RpcErrorCode.MethodNotFound,
              message: "Method not found: kovanica_unknownMethod",
              data: { method: "kovanica_unknownMethod" },
            },
          }),
        );
      };

      const client = new KovanicaClient({ url: serverUrl });
      let caught: unknown;
      try {
        await client.call("kovanica_unknownMethod");
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(KovanicaRpcError);
      const rpcErr = caught as KovanicaRpcError;
      expect(rpcErr.code).toBe(RpcErrorCode.MethodNotFound);
      expect(rpcErr.isMethodNotFound()).toBe(true);
      expect(rpcErr.message).toContain("Method not found: kovanica_unknownMethod");
      expect(rpcErr.data).toEqual({ method: "kovanica_unknownMethod" });
    });

    it("accepts JSON-RPC error with null id per JSON-RPC 2.0 spec", async () => {
      nextHandler = (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: RpcErrorCode.ParseError,
              message: "Parse error: invalid json payload",
            },
          }),
        );
      };

      const client = new KovanicaClient({ url: serverUrl });
      let caught: unknown;
      try {
        await client.blockNumber();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(KovanicaRpcError);
      const rpcErr = caught as KovanicaRpcError;
      expect(rpcErr.code).toBe(RpcErrorCode.ParseError);
    });

    it("rejects mismatched response IDs", async () => {
      nextHandler = (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        // Client sends id 1, server responds with id 999999
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 999999, result: "0x1" }));
      };

      const client = new KovanicaClient({ url: serverUrl });
      await expect(client.blockNumber()).rejects.toThrow(
        /JSON-RPC response ID mismatch: expected \d+, got 999999/,
      );
    });

    it("handles connection loss mid-request (abrupt socket destruction) without leaking credentials", async () => {
      nextHandler = (req) => {
        // Abruptly destroy the underlying socket mid-request
        req.socket.destroy();
      };

      const client = new KovanicaClient({
        url: `http://user:supersecretpass@127.0.0.1:${serverPort}/rpc`,
        headers: { Authorization: "Bearer secret-bearer-token-9999" },
      });

      let caughtError: unknown;
      try {
        await client.blockNumber();
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(KovanicaTransportError);
      const transportErr = caughtError as KovanicaTransportError;
      expect(transportErr.message).not.toContain("supersecretpass");
      expect(transportErr.message).not.toContain("secret-bearer-token-9999");
      expect(transportErr.message).toMatch(/\*\*\*|fetch failed|socket|closed|ECONNRESET/i);
    });

    it("recovers cleanly on subsequent valid request across transport and RPC failure modes", async () => {
      const client = new KovanicaClient({
        url: serverUrl,
        timeoutMs: 40,
      });

      // 1. Recover after connection drop (abrupt socket destruction)
      nextHandler = (req) => {
        req.socket.destroy();
      };
      await expect(client.blockNumber()).rejects.toThrow(KovanicaTransportError);

      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x1" }));
      };
      const resAfterDrop = await client.blockNumber();
      expect(resAfterDrop).toBe(1n);

      // 2. Recover after timeout
      nextHandler = (_req, res) => {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 99, result: "0x2" }));
        }, 100);
      };
      await expect(client.blockNumber()).rejects.toThrow(KovanicaTimeoutError);

      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x2" }));
      };
      const resAfterTimeout = await client.blockNumber();
      expect(resAfterTimeout).toBe(2n);

      // 3. Recover after cancellation (AbortSignal)
      const controller = new AbortController();
      controller.abort();
      await expect(client.blockNumber({ signal: controller.signal })).rejects.toThrow();

      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x3" }));
      };
      const resAfterAbort = await client.blockNumber();
      expect(resAfterAbort).toBe(3n);

      // 4. Recover after HTTP 500 error
      nextHandler = (_req, res) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      };
      await expect(client.blockNumber()).rejects.toThrow(KovanicaTransportError);

      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x4" }));
      };
      const resAfter500 = await client.blockNumber();
      expect(resAfter500).toBe(4n);

      // 5. Recover after malformed JSON response
      nextHandler = (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("<html>Not JSON</html>");
      };
      await expect(client.blockNumber()).rejects.toThrow();

      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x5" }));
      };
      const resAfterMalformed = await client.blockNumber();
      expect(resAfterMalformed).toBe(5n);

      // 6. Recover after JSON-RPC error
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: RpcErrorCode.MethodNotFound, message: "Method not found" },
          }),
        );
      };
      await expect(client.call("nonexistent_method")).rejects.toThrow(KovanicaRpcError);

      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x6" }));
      };
      const resAfterRpcError = await client.blockNumber();
      expect(resAfterRpcError).toBe(6n);
    });
  });

  // ==========================================================================
  // B. Semantics & Lossless Precision Contracts
  // ==========================================================================

  describe("B. Semantics, precision, and state distinction", () => {
    it("losslessly parses integers exceeding Number.MAX_SAFE_INTEGER across public client methods", async () => {
      // 2^64 - 1 = 18446744073709551615 (exceeds Number.MAX_SAFE_INTEGER 9007199254740991)
      const u64MaxStr = "18446744073709551615";
      const u64MaxBigInt = 18446744073709551615n;

      // 1. blockNumber
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        // Return as unquoted integer in JSON to test parseLosslessJson
        res.end(`{"jsonrpc":"2.0","id":${body.id},"result":${u64MaxStr}}`);
      };

      const client = new KovanicaClient({ url: serverUrl });
      const blockNum = await client.blockNumber();
      expect(blockNum).toBe(u64MaxBigInt);

      // 2. getBalance
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(`{"jsonrpc":"2.0","id":${body.id},"result":"${u64MaxStr}"}`);
      };
      const balance = await client.getBalance("kvnc1test");
      expect(balance).toBe(u64MaxBigInt);

      // 3. syncStatus (localTipRound, committedHeight, peer.reportedTipRound)
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              localTipRound: u64MaxStr,
              committedHeight: u64MaxStr,
              catchingUp: false,
              peerCount: 1,
              peers: [
                {
                  peerId: "12D3KooWtest",
                  reportedTipRound: u64MaxStr,
                },
              ],
            },
          }),
        );
      };
      const status = await client.syncStatus();
      expect(status.localTipRound).toBe(u64MaxBigInt);
      expect(status.committedHeight).toBe(u64MaxBigInt);
      expect(status.peers[0].reportedTipRound).toBe(u64MaxBigInt);

      // 4. getMiningInfo (difficulty, network_hashrate_estimate)
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              chain_id: 5,
              mining_enabled: true,
              mining_threads: 4,
              target_bits: "0x1f00ffff",
              target: "0x000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
              difficulty: u64MaxStr,
              target_block_time_ms: 4000,
              ghostdag_k: 5,
              network_hashrate_estimate: u64MaxStr,
              dag_tips_count: 1,
            },
          }),
        );
      };
      const mining = await client.getMiningInfo();
      expect(mining.difficulty).toBe(u64MaxBigInt);
      expect(mining.network_hashrate_estimate).toBe(u64MaxBigInt);

      // 5. getDagTips (max_round)
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              chain_id: 5,
              tips: ["0x" + "11".repeat(32)],
              count: 1,
              max_round: u64MaxStr,
              ghostdag_k: 5,
            },
          }),
        );
      };
      const dagTips = await client.getDagTips();
      expect(dagTips.max_round).toBe(u64MaxBigInt);
    });

    it("preserves explicit zero and keeps zero, unknown, and unsupported distinct", async () => {
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              // Explicit zeros
              localTipRound: 0,
              committedHeight: 0,
              peerCount: 0,
              peers: [],
              catchingUp: false,
              // Unknown fields omitted (catchUpTarget, behindBy, networkTag)
            },
          }),
        );
      };

      const client = new KovanicaClient({ url: serverUrl });
      const status = await client.syncStatus();

      // Explicit zeros are preserved as 0n / 0 (never turned into undefined or omitted)
      expect(status.localTipRound).toBe(0n);
      expect(status.committedHeight).toBe(0n);
      expect(status.peerCount).toBe(0);
      expect(status.peers).toEqual([]);
      expect(status.catchingUp).toBe(false);

      // Unknown fields are preserved as undefined (never turned into 0n or false)
      expect(status.catchUpTarget).toBeUndefined();
      expect(status.behindBy).toBeUndefined();
      expect(status.networkTag).toBeUndefined();

      // Zero height and zero peers must not imply incompatibility
      expect(status.localTipRound).toBeDefined();

      // catchingUp=false alone with zero peers must NOT imply synced (must be indeterminate/undefined)
      expect(isNodeSynced(status)).toBeUndefined();
    });

    it("verifies isNodeSynced semantics: catchingUp=false alone is not synced", () => {
      // 1. Actively catching up -> false
      expect(
        isNodeSynced({
          catchingUp: true,
          localTipRound: 100n,
          peerCount: 5,
          peers: [],
        }),
      ).toBe(false);

      // 2. catchingUp=false but peerCount is 0 -> indeterminate (undefined)
      expect(
        isNodeSynced({
          catchingUp: false,
          localTipRound: 100n,
          peerCount: 0,
          peers: [],
        }),
      ).toBeUndefined();

      // 3. catchingUp=false but localTipRound is undefined -> indeterminate (undefined)
      expect(
        isNodeSynced({
          catchingUp: false,
          localTipRound: undefined,
          peerCount: 2,
          peers: [],
        }),
      ).toBeUndefined();

      // 4. catchingUp=false but peerCount is undefined -> indeterminate (undefined)
      expect(
        isNodeSynced({
          catchingUp: false,
          localTipRound: 100n,
          peerCount: undefined,
          peers: [],
        }),
      ).toBeUndefined();

      // 5. catchingUp=false with known tip round and peers > 0 -> synced (true)
      expect(
        isNodeSynced({
          catchingUp: false,
          localTipRound: 100n,
          peerCount: 2,
          peers: [],
        }),
      ).toBe(true);

      // 6. catchingUp is undefined -> indeterminate (undefined)
      expect(
        isNodeSynced({
          catchingUp: undefined,
          localTipRound: 100n,
          peerCount: 2,
          peers: [],
        }),
      ).toBeUndefined();
    });

    it("explicitly rejects unsupported inputs and unsafe floats, never silently rounding", () => {
      // Unsafe integers exceeding Number.MAX_SAFE_INTEGER as Number throw TypeError
      expect(() => parseQuantity(9007199254740992)).toThrow(TypeError);
      expect(() => parseQuantity(9007199254740992)).toThrow(/precision lost/);

      // Floating-point numbers are not safe integers and must throw TypeError (never round 1.5 to 1)
      expect(() => parseQuantity(1.5)).toThrow(TypeError);
      expect(() => parseQuantity(1.5)).toThrow(/precision lost/);

      // Negative numbers in toHexQuantity throw RangeError
      expect(() => toHexQuantity(-1n)).toThrow(RangeError);
      expect(() => toHexQuantity(-5)).toThrow(RangeError);

      // Empty string throws TypeError
      expect(() => parseQuantity("")).toThrow(TypeError);

      // Invalid non-numeric string throws TypeError
      expect(() => parseQuantity("not_a_number")).toThrow(TypeError);

      // Unsupported types throw TypeError
      expect(() => parseQuantity(true)).toThrow(TypeError);
      expect(() => parseQuantity({})).toThrow(TypeError);
    });

    it("sanitizes error diagnostics and redacts credentials", () => {
      const urlWithCreds = "http://admin:my_secret_password_123@127.0.0.1:8545/rpc";
      const sanitized = sanitizeDiagnostics(urlWithCreds);
      expect(sanitized).not.toContain("my_secret_password_123");
      expect(sanitized).toBe("http://admin:***@127.0.0.1:8545/rpc");

      const bearerMsg = "Failed request: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
      const sanitizedBearer = sanitizeDiagnostics(bearerMsg);
      expect(sanitizedBearer).not.toContain("eyJhbGci");
      expect(sanitizedBearer).toContain("Bearer ***");

      const basicMsg = "Failed request: Authorization: Basic dXNlcjpwYXNz";
      const sanitizedBasic = sanitizeDiagnostics(basicMsg);
      expect(sanitizedBasic).not.toContain("dXNlcjpwYXNz");
      expect(sanitizedBasic).toContain("Basic ***");
    });
  });

  // ==========================================================================
  // C. Error Non-Conversion Contracts
  // ==========================================================================

  describe("C. Error non-conversion: failures never converted to zero, empty success, or healthy node", () => {
    it("ensures getBalance throws on transport error, RPC error, and absent result, preserving explicit zero", async () => {
      const client = new KovanicaClient({ url: serverUrl });

      // 1. Transport failure (HTTP 503) -> must throw KovanicaTransportError, NOT return 0n
      nextHandler = (_req, res) => {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("Service Unavailable");
      };
      await expect(client.getBalance("kvnc1testaddr")).rejects.toThrow(KovanicaTransportError);

      // 2. JSON-RPC error (-32000) -> must throw KovanicaRpcError, NOT return 0n
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32000, message: "Account not found in state trie" },
          }),
        );
      };
      await expect(client.getBalance("kvnc1testaddr")).rejects.toThrow(KovanicaRpcError);

      // 3. Absent / null result -> must throw TypeError, NOT return 0n
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: null }));
      };
      await expect(client.getBalance("kvnc1testaddr")).rejects.toThrow(TypeError);

      // 4. Legitimate explicit zero ("0x0", "0") -> must return 0n
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x0" }));
      };
      const zeroHex = await client.getBalance("kvnc1testaddr");
      expect(zeroHex).toBe(0n);

      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0" }));
      };
      const zeroDec = await client.getBalance("kvnc1testaddr");
      expect(zeroDec).toBe(0n);
    });

    it("ensures getRewards and getStake throw on failure/absent result and preserve explicit zero", async () => {
      const client = new KovanicaClient({ url: serverUrl });

      // getRewards
      nextHandler = (_req, res) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      };
      await expect(client.getRewards("kvnc1testaddr")).rejects.toThrow(KovanicaTransportError);

      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32603, message: "Internal consensus failure" },
          }),
        );
      };
      await expect(client.getRewards("kvnc1testaddr")).rejects.toThrow(KovanicaRpcError);

      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: null }));
      };
      await expect(client.getRewards("kvnc1testaddr")).rejects.toThrow(TypeError);

      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x0" }));
      };
      expect(await client.getRewards("kvnc1testaddr")).toBe(0n);

      // getStake
      nextHandler = (_req, res) => {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("Bad Gateway");
      };
      await expect(client.getStake("kvnc1testaddr")).rejects.toThrow(KovanicaTransportError);

      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32000, message: "Validator stake unavailable" },
          }),
        );
      };
      await expect(client.getStake("kvnc1testaddr")).rejects.toThrow(KovanicaRpcError);

      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: null }));
      };
      await expect(client.getStake("kvnc1testaddr")).rejects.toThrow(TypeError);

      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x0" }));
      };
      expect(await client.getStake("kvnc1testaddr")).toBe(0n);
    });

    it("ensures blockNumber throws on failure and never converts failure or null to 0n", async () => {
      const client = new KovanicaClient({ url: serverUrl });

      // Transport error -> throws KovanicaTransportError
      nextHandler = (_req, res) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Server Error");
      };
      await expect(client.blockNumber()).rejects.toThrow(KovanicaTransportError);

      // RPC error -> throws KovanicaRpcError
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32603, message: "Storage read failure" },
          }),
        );
      };
      await expect(client.blockNumber()).rejects.toThrow(KovanicaRpcError);

      // Absent / null result -> throws TypeError
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: null }));
      };
      await expect(client.blockNumber()).rejects.toThrow(TypeError);

      // Explicit zero -> returns 0n (valid genesis committed height)
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x0" }));
      };
      expect(await client.blockNumber()).toBe(0n);
    });

    it("ensures syncStatus throws on failure and never converts failure or missing fields into healthy/synced status", async () => {
      const client = new KovanicaClient({ url: serverUrl });

      // Transport error -> throws KovanicaTransportError (never returns a fake sync status)
      nextHandler = (_req, res) => {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("Observer unavailable");
      };
      await expect(client.syncStatus()).rejects.toThrow(KovanicaTransportError);

      // RPC error -> throws KovanicaRpcError
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32000, message: "P2P network subsystem starting up" },
          }),
        );
      };
      await expect(client.syncStatus()).rejects.toThrow(KovanicaRpcError);

      // Non-object result -> throws TypeError
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: null }));
      };
      await expect(client.syncStatus()).rejects.toThrow("Invalid syncStatus response: expected an object");

      // Incomplete result missing catchingUp: status.catchingUp is undefined, isNodeSynced is indeterminate
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              localTipRound: 10,
              committedHeight: 10,
              peerCount: 2,
              peers: [],
              // catchingUp omitted
            },
          }),
        );
      };
      const statusMissingCatchingUp = await client.syncStatus();
      expect(statusMissingCatchingUp.catchingUp).toBeUndefined();
      expect(isNodeSynced(statusMissingCatchingUp)).toBeUndefined();

      // catchingUp: false with 0 peers: isNodeSynced is indeterminate (never falsely claimed as synced!)
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              localTipRound: 10,
              committedHeight: 10,
              catchingUp: false,
              peerCount: 0,
              peers: [],
            },
          }),
        );
      };
      const statusZeroPeers = await client.syncStatus();
      expect(statusZeroPeers.catchingUp).toBe(false);
      expect(statusZeroPeers.peerCount).toBe(0);
      expect(isNodeSynced(statusZeroPeers)).toBeUndefined();
    });

    it("ensures getValidators, getMiningInfo, and getDagTips throw on transport and RPC failures", async () => {
      const client = new KovanicaClient({ url: serverUrl });

      // getValidators transport failure -> throws KovanicaTransportError (never converts to [])
      nextHandler = (_req, res) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Crash");
      };
      await expect(client.getValidators()).rejects.toThrow(KovanicaTransportError);

      // getValidators RPC error -> throws KovanicaRpcError
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: "Method not found" },
          }),
        );
      };
      await expect(client.getValidators()).rejects.toThrow(KovanicaRpcError);

      // getMiningInfo transport failure -> throws KovanicaTransportError
      nextHandler = (_req, res) => {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("Bad Gateway");
      };
      await expect(client.getMiningInfo()).rejects.toThrow(KovanicaTransportError);

      // getDagTips RPC error -> throws KovanicaRpcError
      nextHandler = async (req, res) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32000, message: "DAG store uninitialized" },
          }),
        );
      };
      await expect(client.getDagTips()).rejects.toThrow(KovanicaRpcError);
    });
  });

  // ==========================================================================
  // D. Synthetic Fixture Verification of Live Execution Assertions
  // ==========================================================================

  describe("D. Synthetic fixture verification of live execution assertions", () => {
    // SYNTHETIC FIXTURE A: Node reporting genesis height 0 (execution not started)
    // Provenance: Synthetic fixture for offline assertion logic testing.
    const SYNTHETIC_FIXTURE_GENESIS_HEIGHT_ZERO = {
      blockNumber: "0x0",
      syncStatus: {
        committedHeight: "0x0",
        localTipRound: "0x0",
        catchingUp: false,
        peerCount: 1,
        peers: [{ peerId: "12D3KooWSyntheticObserver0", reportedTipRound: "0x0" }],
      },
      validators: [
        { address: "kvnc1val1synthetic000000000000000000000000000", stake: "0x1", commission_bps: 0, active: true },
        { address: "kvnc1val2synthetic000000000000000000000000000", stake: "0x1", commission_bps: 0, active: true },
      ],
      authorAddress: "kvnc1val1synthetic000000000000000000000000000",
      balance: "450000000000000",
      rewards: "0x0",
      stake: "0x1",
      miningInfo: {
        chain_id: CHAIN_IDS.HYBRID_TESTNET,
        mining_enabled: false,
        mining_threads: 0,
        target_bits: "0x1f00ffff",
        target: "0x000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        difficulty: "0x100",
        target_block_time_ms: 4000,
        ghostdag_k: 5,
        network_hashrate_estimate: "0x1000",
        dag_tips_count: 1,
      },
      dagTips: {
        chain_id: CHAIN_IDS.HYBRID_TESTNET,
        count: 1,
        max_round: "0x0",
        ghostdag_k: 5,
        tips: ["0x" + "11".repeat(32)],
      },
      block: null,
    };

    // SYNTHETIC FIXTURE B: Nonzero height (5) but author balance is at unrewarded genesis liquid baseline (450,000 KVNC = 450_000_000_000_000 atoms).
    // Execution evidence is absent because no block rewards have been credited.
    // Provenance: Synthetic fixture for offline assertion logic testing.
    const SYNTHETIC_FIXTURE_UNREWARDED_NONZERO_HEIGHT = {
      blockNumber: "0x5",
      syncStatus: {
        committedHeight: "0x5",
        localTipRound: "0x5",
        catchingUp: false,
        peerCount: 1,
        peers: [{ peerId: "12D3KooWSyntheticObserver1", reportedTipRound: "0x5" }],
      },
      validators: [
        { address: "kvnc1val1synthetic000000000000000000000000000", stake: "0x1", commission_bps: 0, active: true },
        { address: "kvnc1val2synthetic000000000000000000000000000", stake: "0x1", commission_bps: 0, active: true },
      ],
      authorAddress: "kvnc1val1synthetic000000000000000000000000000",
      balance: "450000000000000", // Exactly genesis liquid baseline: NO execution reward!
      rewards: "0x0",
      stake: "0x1",
      miningInfo: {
        chain_id: CHAIN_IDS.HYBRID_TESTNET,
        mining_enabled: false,
        mining_threads: 0,
        target_bits: "0x1f00ffff",
        target: "0x000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        difficulty: "0x100",
        target_block_time_ms: 4000,
        ghostdag_k: 5,
        network_hashrate_estimate: "0x1000",
        dag_tips_count: 1,
      },
      dagTips: {
        chain_id: CHAIN_IDS.HYBRID_TESTNET,
        count: 1,
        max_round: "0x5",
        ghostdag_k: 5,
        tips: ["0x" + "22".repeat(32)],
      },
      block: null,
    };

    // SYNTHETIC FIXTURE C: Nonzero height (5) with author balance reflecting mined block reward (450,000 KVNC + 2.5 KVNC = 450_002_500_000_000 atoms).
    // Provenance: Synthetic fixture for offline assertion logic testing.
    const SYNTHETIC_FIXTURE_REWARDED_EXECUTED = {
      blockNumber: "0x5",
      syncStatus: {
        committedHeight: "0x5",
        localTipRound: "0x5",
        catchingUp: false,
        peerCount: 1,
        peers: [{ peerId: "12D3KooWSyntheticObserver2", reportedTipRound: "0x5" }],
      },
      validators: [
        { address: "kvnc1val1synthetic000000000000000000000000000", stake: "0x1", commission_bps: 0, active: true },
        { address: "kvnc1val2synthetic000000000000000000000000000", stake: "0x1", commission_bps: 0, active: true },
      ],
      authorAddress: "kvnc1val1synthetic000000000000000000000000000",
      balance: "450002500000000", // Genesis baseline + 2.5 KVNC reward: genuine executed state!
      rewards: "0x0",
      stake: "0x1",
      miningInfo: {
        chain_id: CHAIN_IDS.HYBRID_TESTNET,
        mining_enabled: false,
        mining_threads: 0,
        target_bits: "0x1f00ffff",
        target: "0x000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        difficulty: "0x100",
        target_block_time_ms: 4000,
        ghostdag_k: 5,
        network_hashrate_estimate: "0x1000",
        dag_tips_count: 1,
      },
      dagTips: {
        chain_id: CHAIN_IDS.HYBRID_TESTNET,
        count: 1,
        max_round: "0x5",
        ghostdag_k: 5,
        tips: ["0x" + "33".repeat(32)],
      },
      block: {
        number: "0x5",
        round: "0x5",
        hash: "0x" + "44".repeat(32),
        parentHash: "0x" + "00".repeat(32),
        timestamp: "0x672d0000",
        transactions: [],
      },
    };

    function createSyntheticMockHandler(fixture: typeof SYNTHETIC_FIXTURE_GENESIS_HEIGHT_ZERO) {
      return async (req: http.IncomingMessage, res: http.ServerResponse) => {
        const body = await readRequestBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        let result: any = null;
        switch (body.method) {
          case "kovanica_blockNumber":
            result = fixture.blockNumber;
            break;
          case "kovanica_syncStatus":
            result = fixture.syncStatus;
            break;
          case "kovanica_getValidators":
            result = fixture.validators;
            break;
          case "kovanica_getBalance":
            result = fixture.balance;
            break;
          case "kovanica_getRewards":
            result = fixture.rewards;
            break;
          case "kovanica_getStake":
            result = fixture.stake;
            break;
          case "kovanica_getMiningInfo":
            result = fixture.miningInfo;
            break;
          case "kovanica_getDagTips":
            result = fixture.dagTips;
            break;
          case "kovanica_getBlockByNumber":
            result = fixture.block ?? null;
            break;
          default:
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                error: { code: -32601, message: `Method not found: ${body.method}` },
              }),
            );
            return;
        }
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      };
    }

    it("proves assertNonzeroExecutedState rejects a node at genesis height 0", async () => {
      nextHandler = createSyntheticMockHandler(SYNTHETIC_FIXTURE_GENESIS_HEIGHT_ZERO);
      const client = new KovanicaClient({ url: serverUrl });

      await expect(
        assertNonzeroExecutedState(client, {
          authorAddress: SYNTHETIC_FIXTURE_GENESIS_HEIGHT_ZERO.authorAddress,
        }),
      ).rejects.toThrow(/Expected nonzero committed height, got 0/);
    });

    it("proves a synthetic fixture with nonzero height but no executed balance/reward fails the execution assertion", async () => {
      nextHandler = createSyntheticMockHandler(SYNTHETIC_FIXTURE_UNREWARDED_NONZERO_HEIGHT);
      const client = new KovanicaClient({ url: serverUrl });

      // The author has balance 450_000_000_000_000n (exact genesis baseline, no reward).
      // The assertion checks: expect(balance).toBeGreaterThan(450_000_000_000_000n).
      // This MUST FAIL with an AssertionError, proving that height alone without executed balance/reward
      // CANNOT satisfy the test claiming executed nonzero state!
      await expect(
        assertNonzeroExecutedState(client, {
          authorAddress: SYNTHETIC_FIXTURE_UNREWARDED_NONZERO_HEIGHT.authorAddress,
        }),
      ).rejects.toThrow(/expected 450000000000000.* to be greater than 450000000000000/);
    });

    it("proves assertNonzeroExecutedState passes when nonzero height has verified executed reward", async () => {
      nextHandler = createSyntheticMockHandler(SYNTHETIC_FIXTURE_REWARDED_EXECUTED);
      const client = new KovanicaClient({ url: serverUrl });

      const executed = await assertNonzeroExecutedState(client, {
        authorAddress: SYNTHETIC_FIXTURE_REWARDED_EXECUTED.authorAddress,
      });

      expect(executed.height).toBe(5n);
      expect(executed.balance).toBe(450_002_500_000_000n);
      expect(executed.balance).toBeGreaterThan(450_000_000_000_000n);
      expect(executed.validators.length).toBe(2);
      expect(executed.status.committedHeight).toBe(5n);
      expect(executed.mining.chain_id).toBe(CHAIN_IDS.HYBRID_TESTNET);
      expect(executed.tips.max_round).toBe(5n);
      expect(executed.block).not.toBeNull();
      expect(executed.block!.number).toBe(5n);
    });
  });
});
