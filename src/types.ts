/**
 * Kovanica JSON-RPC request and response schemas.
 * Verified against crates/kovanica-rpc in kovanica git SHA: 2c2e54b4615eb53c61ebb9963b7606d2ccbfaa47
 */

export interface RequestOptions {
  /** Optional cancellation signal. */
  signal?: AbortSignal;
  /** Timeout in milliseconds for this specific request. Overrides transport default. */
  timeoutMs?: number;
}

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: TParams;
  id: string | number;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse<TResult = unknown> {
  jsonrpc: "2.0";
  result?: TResult;
  error?: JsonRpcErrorObject;
  id: string | number | null;
}

export type TransactionKind =
  | { type: "transfer"; to: string; amount: bigint }
  | { type: "stake"; amount: bigint }
  | { type: "unstake"; amount: bigint }
  | { type: "delegate"; validator: string; amount: bigint }
  | { type: "claim_rewards"; validator: string | null }
  | { type: "deploy"; code: string }
  | {
      type: "call";
      contract: string;
      value: number;
      method: string;
      args: string;
      gas_limit: bigint;
    }
  | { type: "register_light_node"; vrfPublicKey: string; stake: bigint }
  | { type: "exit_light_node" }
  | {
      type: "submit_light_witness";
      epoch: bigint;
      vrfHash: string;
      vrfProof: string;
    }
  | { type: "set_commission"; validator: string; commission_bps: bigint }
  | { type: "claim_treasury"; amount: bigint }
  | {
      type: "evidence";
      author: string;
      round: bigint;
      digest_a: string;
      digest_b: string;
    };

export interface TransactionResponse {
  hash: string;
  sender: string;
  nonce: bigint;
  fee: bigint;
  kind: TransactionKind;
  signature: string;
}

export interface BlockResponse {
  hash: string;
  digest: string;
  author: number;
  number: bigint;
  round: bigint;
  parents: string[];
  transactions: Array<TransactionResponse | string>;
  statements: string;
  signature: string;
}

export interface TransactionReceipt {
  transactionHash: string;
  blockHash: string;
  blockNumber: bigint;
  transactionIndex: bigint | null;
  status: number;
  success: boolean;
  gasUsed?: bigint;
}

export interface ValidatorInfo {
  address: string;
  stake: bigint;
  commission_bps: number;
  active: boolean;
  payout_address: string;
}

export interface LeaderSlot {
  round: bigint;
  leaderIndex: number;
  leaderAddress: string;
}

export interface SyncPeerStatus {
  /** libp2p peer id (transport identity, not the validator key). */
  peerId: string;
  /** Last DAG tip round the peer reported, if it has answered a probe. */
  reportedTipRound?: bigint;

  // Backwards-compatible aliases:
  /** @deprecated Snake-case alias for peerId */
  peer_id?: string;
  /** @deprecated Snake-case alias for reportedTipRound */
  reported_tip_round?: bigint;
  /** @deprecated Legacy alias */
  addr?: string;
  /** @deprecated Legacy alias */
  tip_round?: bigint;
}

export interface SyncStatus {
  /** Local DAG tip round (`max_dag_round`); undefined if storage cannot be read. */
  localTipRound?: bigint;
  /** Latest committed leader height, when available. */
  committedHeight?: bigint;
  /** Local committed height (alias for committedHeight). */
  localHeight?: bigint;
  /**
   * Whether the node is actively pulling a peer's rounds.
   * `undefined` if unknown or unpopulated by node.
   */
  catchingUp?: boolean;
  /** Highest peer-advertised tip round being chased, when catching up. */
  catchUpTarget?: bigint;
  /** How many rounds behind the catch-up target the local tip is. */
  behindBy?: bigint;
  /** Number of connected peers; undefined if not reported. */
  peerCount?: number;
  /** Connected peers, bounded by the node's max_peers. */
  peers: SyncPeerStatus[];
  /** `<chain_id>-<first 16 hex chars of the genesis digest>`. */
  networkTag?: string;

  // Backwards-compatible aliases:
  /** @deprecated Use localTipRound */
  local_tip_round?: bigint;
  /** @deprecated Use committedHeight */
  committed_height?: bigint;
  /** @deprecated Use localHeight */
  local_height?: bigint;
  /** @deprecated Use catchingUp */
  catching_up?: boolean;
  /** @deprecated Use catchUpTarget */
  catch_up_target?: bigint;
  /** @deprecated Use behindBy */
  behind_by?: bigint;
  /** @deprecated Use peerCount */
  peer_count?: number;
  /** @deprecated Use networkTag */
  network_tag?: string;
}

export interface MiningInfo {
  chain_id: number;
  mining_enabled: boolean;
  mining_threads: number;
  target_bits: string;
  target: string;
  difficulty: bigint;
  target_block_time_ms: number;
  ghostdag_k: number;
  network_hashrate_estimate: bigint;
  dag_tips_count: number;
}

export interface DagTips {
  chain_id: number;
  tips: string[];
  count: number;
  max_round: bigint;
  ghostdag_k: number;
}
