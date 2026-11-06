/**
 * Typed error hierarchy for Kovanica SDK operations.
 */

export enum RpcErrorCode {
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
  ExecutionError = -32000,
  Unauthorized = -32001,
  Timeout = -32003,
  NotImplemented = -32004,
}

export class KovanicaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KovanicaError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class KovanicaRpcError extends KovanicaError {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(`RPC error (${code}): ${message}`);
    this.name = "KovanicaRpcError";
    this.code = code;
    this.data = data;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  isMethodNotFound(): boolean {
    return this.code === RpcErrorCode.MethodNotFound;
  }

  isInvalidParams(): boolean {
    return this.code === RpcErrorCode.InvalidParams;
  }

  isUnauthorized(): boolean {
    return this.code === RpcErrorCode.Unauthorized;
  }

  isTimeout(): boolean {
    return this.code === RpcErrorCode.Timeout;
  }

  isNotImplemented(): boolean {
    return this.code === RpcErrorCode.NotImplemented;
  }
}

export class KovanicaTransportError extends KovanicaError {
  readonly status?: number;
  readonly statusText?: string;
  override readonly cause?: unknown;

  constructor(message: string, options?: { status?: number; statusText?: string; cause?: unknown }) {
    super(message);
    this.name = "KovanicaTransportError";
    this.status = options?.status;
    this.statusText = options?.statusText;
    this.cause = options?.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class KovanicaTimeoutError extends KovanicaTransportError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, message?: string) {
    super(message || `Request timed out after ${timeoutMs}ms`);
    this.name = "KovanicaTimeoutError";
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class KovanicaAbortError extends KovanicaTransportError {
  constructor(message = "Request was cancelled") {
    super(message);
    this.name = "KovanicaAbortError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
