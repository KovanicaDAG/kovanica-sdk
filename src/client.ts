/**
 * Main Kovanica client implementation.
 * Provides typed, read-only methods for interacting with a Kovanica JSON-RPC node.
 */

import { HttpTransport, type HttpTransportOptions, type Transport } from "./transport";
import type {
  BlockResponse,
  DagTips,
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
import { parseQuantity, toHexQuantity } from "./units";

export interface KovanicaClientOptions extends HttpTransportOptions {
  /** Optional custom transport. If provided, `url` and transport options are ignored. */
  transport?: Transport;
}

/**
 * Safely parse an optional quantity into a bigint.
 * - null or undefined -> undefined (preserves unavailable state; never turns into 0n)
 * - 0, "0", "0x0" -> 0n (preserves explicit zero)
 * - valid hex or decimal string / number / bigint -> parsed bigint
 * - boolean / object / invalid string -> undefined (wrong types are discarded rather than corrupting state)
 * - unsafe float numbers (> Number.MAX_SAFE_INTEGER) -> parseQuantity throws TypeError
 */
export function parseSafeOptionalQuantity(value: unknown): bigint | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "boolean" || typeof value === "object" || typeof value === "symbol") {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    if (!trimmed.startsWith("0x") && !trimmed.startsWith("0X") && !/^-?\d+$/.test(trimmed)) {
      return undefined;
    }
  }
  return parseQuantity(value);
}

/**
 * Evaluates whether a node is confirmed to be in sync based on its SyncStatus.
 *
 * In Kovanica L1, `catchingUp === false` alone is insufficient to claim a node is synced:
 * the node must also have a known local tip round and at least one connected peer.
 * If catchingUp is true, returns false (node is actively catching up).
 * If catchingUp is undefined, or peerCount is 0 / undefined, or localTipRound is undefined,
 * returns undefined (state is unknown/indeterminate).
 */
export function isNodeSynced(status: SyncStatus): boolean | undefined {
  if (status.catchingUp === true) {
    return false;
  }
  if (status.catchingUp === false) {
    if (
      status.localTipRound !== undefined &&
      status.peerCount !== undefined &&
      status.peerCount > 0
    ) {
      return true;
    }
    return undefined;
  }
  return undefined;
}

export class KovanicaClient {
  readonly transport: Transport;

  constructor(optionsOrUrl: string | KovanicaClientOptions) {
    if (typeof optionsOrUrl === "string") {
      this.transport = new HttpTransport({ url: optionsOrUrl });
    } else if (optionsOrUrl.transport) {
      this.transport = optionsOrUrl.transport;
    } else {
      this.transport = new HttpTransport(optionsOrUrl);
    }
  }

  /**
   * Generic low-level JSON-RPC call.
   */
  async call<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: RequestOptions,
  ): Promise<TResult> {
    return this.transport.send<TResult>(method, params, options);
  }

  // ==========================================================================
  // Core Chain Methods
  // ==========================================================================

  /**
   * Returns the latest committed leader height as a `bigint`.
   * RPC: `kovanica_blockNumber`
   */
  async blockNumber(options?: RequestOptions): Promise<bigint> {
    const raw = await this.call<unknown>("kovanica_blockNumber", [], options);
    return parseQuantity(raw);
  }

  /**
   * Returns a block by its round/height number.
   * RPC: `kovanica_getBlockByNumber`
   */
  async getBlockByNumber(
    blockNumber: bigint | number | string,
    fullTransactions = false,
    options?: RequestOptions,
  ): Promise<BlockResponse | null> {
    const hex = typeof blockNumber === "string" && blockNumber.startsWith("0x")
      ? blockNumber
      : toHexQuantity(parseQuantity(blockNumber));

    const raw = await this.call<RawBlockResponse | null>(
      "kovanica_getBlockByNumber",
      [hex, fullTransactions],
      options,
    );
    if (!raw) return null;
    return mapBlockResponse(raw);
  }

  /**
   * Returns a block by its 32-byte digest/hash.
   * RPC: `kovanica_getBlockByHash`
   */
  async getBlockByHash(
    hash: string,
    fullTransactions = false,
    options?: RequestOptions,
  ): Promise<BlockResponse | null> {
    const normalized = hash.startsWith("0x") ? hash : `0x${hash}`;
    const raw = await this.call<RawBlockResponse | null>(
      "kovanica_getBlockByHash",
      [normalized, fullTransactions],
      options,
    );
    if (!raw) return null;
    return mapBlockResponse(raw);
  }

  // ==========================================================================
  // Account Methods
  // ==========================================================================

  /**
   * Returns the balance of an account in atomic units (atoms) as a `bigint`.
   * RPC: `kovanica_getBalance`
   */
  async getBalance(address: string, options?: RequestOptions): Promise<bigint> {
    const raw = await this.call<unknown>("kovanica_getBalance", [address], options);
    return parseQuantity(raw);
  }

  /**
   * Returns the transaction sequence nonce of an account as a `bigint`.
   * RPC: `kovanica_getNonce`
   */
  async getNonce(address: string, options?: RequestOptions): Promise<bigint> {
    const raw = await this.call<unknown>("kovanica_getNonce", [address], options);
    return parseQuantity(raw);
  }

  /**
   * Returns the compiled Wasm bytecode of a deployed contract as a hex string.
   * RPC: `kovanica_getCode`
   */
  async getCode(address: string, options?: RequestOptions): Promise<string> {
    return this.call<string>("kovanica_getCode", [address], options);
  }

  /**
   * Returns the value at a storage slot of an account.
   * RPC: `kovanica_getStorageAt`
   */
  async getStorageAt(
    address: string,
    slot: string | number | bigint,
    options?: RequestOptions,
  ): Promise<string> {
    const slotArg = typeof slot === "bigint" || typeof slot === "number"
      ? toHexQuantity(slot)
      : slot;
    return this.call<string>("kovanica_getStorageAt", [address, slotArg], options);
  }

  // ==========================================================================
  // Transaction & Mempool Methods
  // ==========================================================================

  /**
   * Returns transaction details by transaction hash.
   * RPC: `kovanica_getTransactionByHash`
   */
  async getTransactionByHash(
    hash: string,
    options?: RequestOptions,
  ): Promise<TransactionResponse | null> {
    const normalized = hash.startsWith("0x") ? hash : `0x${hash}`;
    const raw = await this.call<RawTransactionResponse | null>(
      "kovanica_getTransactionByHash",
      [normalized],
      options,
    );
    if (!raw) return null;
    return mapTransactionResponse(raw);
  }

  /**
   * Returns the receipt of a mined/committed transaction.
   * RPC: `kovanica_getTransactionReceipt`
   */
  async getTransactionReceipt(
    hash: string,
    options?: RequestOptions,
  ): Promise<TransactionReceipt | null> {
    const normalized = hash.startsWith("0x") ? hash : `0x${hash}`;
    const raw = await this.call<RawTransactionReceipt | null>(
      "kovanica_getTransactionReceipt",
      [normalized],
      options,
    );
    if (!raw) return null;
    return {
      transactionHash: raw.transactionHash,
      blockHash: raw.blockHash,
      blockNumber: parseQuantity(raw.blockNumber),
      transactionIndex:
        raw.transactionIndex != null ? parseQuantity(raw.transactionIndex) : null,
      status: typeof raw.status === "number" ? raw.status : Number(parseQuantity(raw.status)),
      success: Boolean(raw.success),
      gasUsed: raw.gasUsed != null ? parseQuantity(raw.gasUsed) : undefined,
    };
  }

  /**
   * Returns hashes of transactions currently pending in the mempool.
   * RPC: `kovanica_getPendingTransactions`
   */
  async getPendingTransactions(options?: RequestOptions): Promise<string[]> {
    return this.call<string[]>("kovanica_getPendingTransactions", [], options);
  }

  /**
   * Returns the suggested minimum gas fee rate in atoms per byte.
   * RPC: `kovanica_estimateFee`
   */
  async estimateFee(options?: RequestOptions): Promise<bigint> {
    const raw = await this.call<unknown>("kovanica_estimateFee", [], options);
    return parseQuantity(raw);
  }

  // ==========================================================================
  // Staking & Validator Methods
  // ==========================================================================

  /**
   * Returns the current validator set and their stake amounts.
   * RPC: `kovanica_getValidators`
   */
  async getValidators(options?: RequestOptions): Promise<ValidatorInfo[]> {
    const raw = await this.call<RawValidatorInfo[]>("kovanica_getValidators", [], options);
    return (raw || []).map((v) => ({
      address: v.address,
      stake: parseQuantity(v.stake),
      commission_bps: v.commission_bps,
      active: v.active,
      payout_address: v.payout_address,
    }));
  }

  /**
   * Returns the bonded stake for a given address.
   * RPC: `kovanica_getStake`
   */
  async getStake(address: string, options?: RequestOptions): Promise<bigint> {
    const raw = await this.call<unknown>("kovanica_getStake", [address], options);
    return parseQuantity(raw);
  }

  /**
   * Returns cumulative earned rewards for a given address.
   * RPC: `kovanica_getRewards`
   */
  async getRewards(address: string, options?: RequestOptions): Promise<bigint> {
    const raw = await this.call<unknown>("kovanica_getRewards", [address], options);
    return parseQuantity(raw);
  }

  /**
   * Returns the upcoming leader schedule.
   * RPC: `kovanica_getLeaderSchedule`
   */
  async getLeaderSchedule(count = 16, options?: RequestOptions): Promise<LeaderSlot[]> {
    const raw = await this.call<RawLeaderSlot[]>(
      "kovanica_getLeaderSchedule",
      [count],
      options,
    );
    return (raw || []).map((slot) => ({
      round: parseQuantity(slot.round),
      leaderIndex: (slot.leaderIndex ?? slot.leader_index)!,
      leaderAddress: (slot.leaderAddress ?? slot.leader_address)!,
    }));
  }

  // ==========================================================================
  // Node Diagnostics & Hybrid PoW / Chain 5 Methods
  // ==========================================================================

  /**
   * Returns node synchronization, catch-up and peer health status.
   * RPC: `kovanica_syncStatus`
   */
  async syncStatus(options?: RequestOptions): Promise<SyncStatus> {
    const raw = await this.call<RawSyncStatus>("kovanica_syncStatus", [], options);
    if (!raw || typeof raw !== "object") {
      throw new TypeError("Invalid syncStatus response: expected an object");
    }

    const localTipRound = parseSafeOptionalQuantity(raw.localTipRound ?? raw.local_tip_round);

    const rawCommitted =
      raw.committedHeight !== undefined && raw.committedHeight !== null
        ? raw.committedHeight
        : raw.committed_height !== undefined && raw.committed_height !== null
          ? raw.committed_height
          : raw.localHeight !== undefined && raw.localHeight !== null
            ? raw.localHeight
            : raw.local_height;
    const committedHeight = parseSafeOptionalQuantity(rawCommitted);

    const rawLocalHeight =
      raw.localHeight !== undefined && raw.localHeight !== null
        ? raw.localHeight
        : raw.local_height !== undefined && raw.local_height !== null
          ? raw.local_height
          : raw.committedHeight !== undefined && raw.committedHeight !== null
            ? raw.committedHeight
            : raw.committed_height;
    const localHeight = parseSafeOptionalQuantity(rawLocalHeight);

    let catchingUp: boolean | undefined;
    if (typeof raw.catchingUp === "boolean") {
      catchingUp = raw.catchingUp;
    } else if (typeof raw.catching_up === "boolean") {
      catchingUp = raw.catching_up;
    } else {
      catchingUp = undefined;
    }

    const catchUpTarget = parseSafeOptionalQuantity(raw.catchUpTarget ?? raw.catch_up_target);
    const behindBy = parseSafeOptionalQuantity(raw.behindBy ?? raw.behind_by);

    let peerCount: number | undefined;
    const rawCount =
      raw.peerCount !== undefined && raw.peerCount !== null ? raw.peerCount : raw.peer_count;
    if (typeof rawCount === "number" && Number.isSafeInteger(rawCount) && rawCount >= 0) {
      peerCount = rawCount;
    } else if (typeof rawCount === "string" && /^\d+$/.test(rawCount.trim())) {
      const n = Number(rawCount.trim());
      if (Number.isSafeInteger(n) && n >= 0) {
        peerCount = n;
      }
    } else if (
      typeof rawCount === "bigint" &&
      rawCount >= 0n &&
      rawCount <= BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      peerCount = Number(rawCount);
    } else {
      peerCount = undefined;
    }

    const peers: SyncPeerStatus[] = [];
    if (Array.isArray(raw.peers)) {
      for (const item of raw.peers) {
        if (item && typeof item === "object") {
          const rawPeerId = item.peerId ?? item.peer_id ?? item.addr;
          if (typeof rawPeerId === "string" && rawPeerId.trim().length > 0) {
            const peerId = rawPeerId.trim();
            const rawTip =
              item.reportedTipRound !== undefined && item.reportedTipRound !== null
                ? item.reportedTipRound
                : item.reported_tip_round !== undefined && item.reported_tip_round !== null
                  ? item.reported_tip_round
                  : item.tip_round;
            const reportedTipRound = parseSafeOptionalQuantity(rawTip);
            peers.push({
              peerId,
              reportedTipRound,
              peer_id: peerId,
              reported_tip_round: reportedTipRound,
              addr: peerId,
              tip_round: reportedTipRound,
            });
          }
        }
      }
    }

    const rawTag = raw.networkTag ?? raw.network_tag;
    const networkTag =
      typeof rawTag === "string" && rawTag.trim().length > 0 ? rawTag.trim() : undefined;

    return {
      localTipRound,
      committedHeight,
      localHeight,
      catchingUp,
      catchUpTarget,
      behindBy,
      peerCount,
      peers,
      networkTag,

      local_tip_round: localTipRound,
      committed_height: committedHeight,
      local_height: localHeight,
      catching_up: catchingUp,
      catch_up_target: catchUpTarget,
      behind_by: behindBy,
      peer_count: peerCount,
      network_tag: networkTag,
    };
  }

  /**
   * Returns PoW mining metrics, difficulty, and DAA targets (Hybrid PoW / Chain 5).
   * RPC: `kovanica_getMiningInfo`
   */
  async getMiningInfo(options?: RequestOptions): Promise<MiningInfo> {
    const raw = await this.call<RawMiningInfo>("kovanica_getMiningInfo", [], options);
    return {
      chain_id: raw.chain_id,
      mining_enabled: Boolean(raw.mining_enabled),
      mining_threads: raw.mining_threads,
      target_bits: raw.target_bits,
      target: raw.target,
      difficulty: parseQuantity(raw.difficulty),
      target_block_time_ms: raw.target_block_time_ms,
      ghostdag_k: raw.ghostdag_k,
      network_hashrate_estimate: parseQuantity(raw.network_hashrate_estimate),
      dag_tips_count: raw.dag_tips_count,
    };
  }

  /**
   * Returns current active DAG tip block hashes (Hybrid PoW / Chain 5).
   * RPC: `kovanica_getDagTips`
   */
  async getDagTips(options?: RequestOptions): Promise<DagTips> {
    const raw = await this.call<RawDagTips>("kovanica_getDagTips", [], options);
    return {
      chain_id: raw.chain_id,
      tips: raw.tips || [],
      count: raw.count,
      max_round: parseQuantity(raw.max_round),
      ghostdag_k: raw.ghostdag_k,
    };
  }
}

// ============================================================================
// Internal Raw JSON Deserialization Interfaces & Mappers
// ============================================================================

interface RawBlockResponse {
  hash: string;
  digest: string;
  author: number;
  number: string | number;
  round: string | number;
  parents: string[];
  transactions: Array<RawTransactionResponse | string>;
  statements: string;
  signature: string;
}

interface RawTransactionResponse {
  hash: string;
  sender: string;
  nonce: string | number;
  fee: string | number;
  kind: RawTransactionKind;
  signature: string;
}

type RawTransactionKind =
  | { type: "transfer"; to: string; amount: string | number }
  | { type: "stake"; amount: string | number }
  | { type: "unstake"; amount: string | number }
  | { type: "delegate"; validator: string; amount: string | number }
  | { type: "claim_rewards"; validator: string | null }
  | { type: "deploy"; code: string }
  | {
      type: "call";
      contract: string;
      value: number;
      method: string;
      args: string;
      gas_limit: string | number;
    }
  | { type: "register_light_node"; vrfPublicKey: string; stake: string | number }
  | { type: "exit_light_node" }
  | {
      type: "submit_light_witness";
      epoch: string | number;
      vrfHash: string;
      vrfProof: string;
    }
  | { type: "set_commission"; validator: string; commission_bps: string | number }
  | { type: "claim_treasury"; amount: string | number }
  | {
      type: "evidence";
      author: string;
      round: string | number;
      digest_a: string;
      digest_b: string;
    };

interface RawTransactionReceipt {
  transactionHash: string;
  blockHash: string;
  blockNumber: string | number;
  transactionIndex: string | number | null;
  status: string | number;
  success: boolean;
  gasUsed?: string | number;
}

interface RawValidatorInfo {
  address: string;
  stake: string | number;
  commission_bps: number;
  active: boolean;
  payout_address: string;
}

interface RawLeaderSlot {
  round: string | number;
  leader_index?: number;
  leaderIndex?: number;
  leader_address?: string;
  leaderAddress?: string;
}

interface RawSyncPeerStatus {
  peerId?: string;
  peer_id?: string;
  reportedTipRound?: string | number | bigint;
  reported_tip_round?: string | number | bigint;
  addr?: string;
  tip_round?: string | number | bigint;
  latency_ms?: number;
  connected_secs?: number;
}

interface RawSyncStatus {
  localTipRound?: string | number | bigint;
  local_tip_round?: string | number | bigint;
  committedHeight?: string | number | bigint;
  committed_height?: string | number | bigint;
  localHeight?: string | number | bigint;
  local_height?: string | number | bigint;
  catchingUp?: boolean | null;
  catching_up?: boolean | null;
  catchUpTarget?: string | number | bigint;
  catch_up_target?: string | number | bigint;
  behindBy?: string | number | bigint;
  behind_by?: string | number | bigint;
  peerCount?: number | string | bigint | null;
  peer_count?: number | string | bigint | null;
  peers?: RawSyncPeerStatus[] | null;
  networkTag?: string | null;
  network_tag?: string | null;
}

interface RawMiningInfo {
  chain_id: number;
  mining_enabled: boolean;
  mining_threads: number;
  target_bits: string;
  target: string;
  difficulty: string | number;
  target_block_time_ms: number;
  ghostdag_k: number;
  network_hashrate_estimate: string | number;
  dag_tips_count: number;
}

interface RawDagTips {
  chain_id: number;
  tips: string[];
  count: number;
  max_round: string | number;
  ghostdag_k: number;
}

function mapTransactionKind(raw: RawTransactionKind): TransactionKind {
  switch (raw.type) {
    case "transfer":
      return { type: "transfer", to: raw.to, amount: parseQuantity(raw.amount) };
    case "stake":
      return { type: "stake", amount: parseQuantity(raw.amount) };
    case "unstake":
      return { type: "unstake", amount: parseQuantity(raw.amount) };
    case "delegate":
      return { type: "delegate", validator: raw.validator, amount: parseQuantity(raw.amount) };
    case "claim_rewards":
      return { type: "claim_rewards", validator: raw.validator };
    case "deploy":
      return { type: "deploy", code: raw.code };
    case "call":
      return {
        type: "call",
        contract: raw.contract,
        value: raw.value,
        method: raw.method,
        args: raw.args,
        gas_limit: parseQuantity(raw.gas_limit),
      };
    case "register_light_node":
      return {
        type: "register_light_node",
        vrfPublicKey: raw.vrfPublicKey,
        stake: parseQuantity(raw.stake),
      };
    case "exit_light_node":
      return { type: "exit_light_node" };
    case "submit_light_witness":
      return {
        type: "submit_light_witness",
        epoch: parseQuantity(raw.epoch),
        vrfHash: raw.vrfHash,
        vrfProof: raw.vrfProof,
      };
    case "set_commission":
      return {
        type: "set_commission",
        validator: raw.validator,
        commission_bps: parseQuantity(raw.commission_bps),
      };
    case "claim_treasury":
      return { type: "claim_treasury", amount: parseQuantity(raw.amount) };
    case "evidence":
      return {
        type: "evidence",
        author: raw.author,
        round: parseQuantity(raw.round),
        digest_a: raw.digest_a,
        digest_b: raw.digest_b,
      };
  }
}

function mapTransactionResponse(raw: RawTransactionResponse): TransactionResponse {
  return {
    hash: raw.hash,
    sender: raw.sender,
    nonce: parseQuantity(raw.nonce),
    fee: parseQuantity(raw.fee),
    kind: mapTransactionKind(raw.kind),
    signature: raw.signature,
  };
}

function mapBlockResponse(raw: RawBlockResponse): BlockResponse {
  return {
    hash: raw.hash,
    digest: raw.digest,
    author: raw.author,
    number: parseQuantity(raw.number),
    round: parseQuantity(raw.round),
    parents: raw.parents || [],
    transactions: (raw.transactions || []).map((tx) =>
      typeof tx === "string" ? tx : mapTransactionResponse(tx),
    ),
    statements: raw.statements,
    signature: raw.signature,
  };
}
