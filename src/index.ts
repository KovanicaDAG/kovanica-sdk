/**
 * kovanica-sdk — Official TypeScript SDK for Kovanica (KVNC) Layer-1 Blockchain
 */

// Client & Transport
export {
  KovanicaClient,
  type KovanicaClientOptions,
  isNodeSynced,
  parseSafeOptionalQuantity,
} from "./client";
export {
  HttpTransport,
  type HttpTransportOptions,
  type Transport,
  parseLosslessJson,
} from "./transport";

// Types & Schemas
export type {
  BlockResponse,
  DagTips,
  JsonRpcErrorObject,
  JsonRpcRequest,
  JsonRpcResponse,
  LeaderSlot,
  MiningInfo,
  RequestOptions,
  SyncPeerStatus,
  SyncStatus,
  TransactionKind,
  TransactionReceipt,
  TransactionResponse,
  ValidatorInfo,
} from "./types";

// Errors
export {
  KovanicaAbortError,
  KovanicaError,
  KovanicaRpcError,
  KovanicaTimeoutError,
  KovanicaTransportError,
  RpcErrorCode,
} from "./errors";

// Units & Quantities
export {
  ATOMS_PER_KVNC,
  DECIMALS,
  formatKvnc,
  parseKvnc,
  parseQuantity,
  toHexQuantity,
} from "./units";

// Chains
export {
  CHAIN_IDS,
  type ChainConfig,
  type ChainId,
  getChainConfig,
  isLegacyAddressAllowed,
  KNOWN_CHAINS,
} from "./chains";

// Address Utilities
export {
  ADDRESS_BODY_CHARS,
  ADDRESS_CHECKSUM_BITS,
  ADDRESS_LEN,
  ADDRESS_PAYLOAD_LEN,
  ADDRESS_PREFIX,
  ADDRESS_SUFFIX,
  checksum29,
  decodeAddress,
  encodeAddress,
  isValidAddress,
  legacyChecksum,
  parseAddressForChain,
  parseLegacyAddress,
} from "./address";
