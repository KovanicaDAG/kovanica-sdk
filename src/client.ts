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
      leaderIndex: slot.leader_index,
      leaderAddress: slot.leader_address,
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
    return {
      local_tip_round: raw.local_tip_round != null ? parseQuantity(raw.local_tip_round) : undefined,
      committed_height: raw.committed_height != null ? parseQuantity(raw.committed_height) : undefined,
      local_height: raw.local_height != null ? parseQuantity(raw.local_height) : undefined,
      catching_up: Boolean(raw.catching_up),
      catch_up_target: raw.catch_up_target != null ? parseQuantity(raw.catch_up_target) : undefined,
      behind_by: raw.behind_by != null ? parseQuantity(raw.behind_by) : undefined,
      peer_count: raw.peer_count ?? (raw.peers?.length || 0),
      peers: (raw.peers || []).map((p) => ({
        addr: p.addr,
        tip_round: p.tip_round != null ? parseQuantity(p.tip_round) : undefined,
        latency_ms: p.latency_ms,
        connected_secs: p.connected_secs,
      })),
      network_tag: raw.network_tag,
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
  leader_index: number;
  leader_address: string;
}

interface RawSyncPeerStatus {
  addr: string;
  tip_round?: string | number;
  latency_ms?: number;
  connected_secs?: number;
}

interface RawSyncStatus {
  local_tip_round?: string | number;
  committed_height?: string | number;
  local_height?: string | number;
  catching_up: boolean;
  catch_up_target?: string | number;
  behind_by?: string | number;
  peer_count: number;
  peers: RawSyncPeerStatus[];
  network_tag?: string;
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
