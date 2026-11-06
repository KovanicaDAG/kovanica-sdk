/**
 * JSON-RPC HTTP transport implementation for Kovanica.
 */

import {
  KovanicaAbortError,
  KovanicaRpcError,
  KovanicaTimeoutError,
  KovanicaTransportError,
} from "./errors";
import type { JsonRpcRequest, JsonRpcResponse, RequestOptions } from "./types";

export interface Transport {
  send<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: RequestOptions,
  ): Promise<TResult>;
}

export interface HttpTransportOptions {
  /** Full URL of the JSON-RPC endpoint (e.g. "http://127.0.0.1:8545/rpc"). */
  url: string;
  /** Custom HTTP headers sent with every request. */
  headers?: Record<string, string>;
  /** Default timeout in milliseconds for all requests. Default: 10_000ms. */
  timeoutMs?: number;
  /** Custom fetch implementation (useful for tests or custom proxies). */
  fetch?: typeof fetch;
  /** Custom ID generator. */
  requestIdGenerator?: () => number | string;
}

export class HttpTransport implements Transport {
  readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly defaultTimeoutMs: number;
  private readonly customFetch: typeof fetch;
  private idCounter = 1;
  private readonly requestIdGenerator?: () => number | string;

  constructor(options: HttpTransportOptions) {
    if (!options.url || options.url.trim().length === 0) {
      throw new Error("HTTP transport requires a non-empty RPC url");
    }
    this.url = options.url.trim();
    this.headers = {
      "Content-Type": "application/json",
      ...options.headers,
    };
    this.defaultTimeoutMs = options.timeoutMs ?? 10_000;
    this.customFetch = options.fetch ?? globalThis.fetch;
    this.requestIdGenerator = options.requestIdGenerator;
  }

  private nextId(): number | string {
    if (this.requestIdGenerator) {
      return this.requestIdGenerator();
    }
    return this.idCounter++;
  }

  async send<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: RequestOptions,
  ): Promise<TResult> {
    const id = this.nextId();
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      id,
    };
    if (params !== undefined) {
      req.params = params;
    }

    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    let isTimedOut = false;

    const timer = setTimeout(() => {
      isTimedOut = true;
      controller.abort();
    }, timeoutMs);

    let removeUserSignalListener: (() => void) | undefined;
    if (options?.signal) {
      if (options.signal.aborted) {
        clearTimeout(timer);
        throw new KovanicaAbortError("Request was already aborted");
      }
      const onUserAbort = () => {
        controller.abort();
      };
      options.signal.addEventListener("abort", onUserAbort, { once: true });
      removeUserSignalListener = () => {
        options.signal?.removeEventListener("abort", onUserAbort);
      };
    }

    try {
      const response = await this.customFetch(this.url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(req),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new KovanicaTransportError(
          `HTTP ${response.status} ${response.statusText}: ${await response.text().catch(() => "")}`,
          { status: response.status, statusText: response.statusText },
        );
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (err) {
        throw new KovanicaTransportError("Malformed JSON response from RPC server", {
          cause: err,
        });
      }

      const rpcRes = parsed as JsonRpcResponse<TResult>;

      if (rpcRes.error) {
        throw new KovanicaRpcError(
          rpcRes.error.code,
          rpcRes.error.message,
          rpcRes.error.data,
        );
      }

      return rpcRes.result as TResult;
    } catch (err: unknown) {
      if (isTimedOut) {
        throw new KovanicaTimeoutError(timeoutMs);
      }
      if (options?.signal?.aborted) {
        throw new KovanicaAbortError("Request was cancelled by user");
      }
      if (
        err instanceof KovanicaRpcError ||
        err instanceof KovanicaTransportError
      ) {
        throw err;
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new KovanicaAbortError("Request was aborted");
      }
      throw new KovanicaTransportError(
        err instanceof Error ? err.message : String(err),
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
      if (removeUserSignalListener) {
        removeUserSignalListener();
      }
    }
  }
}
