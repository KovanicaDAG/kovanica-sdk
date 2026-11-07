# kovanica-sdk

Typed, lightweight TypeScript client and utilities for the **Kovanica (KVNC)** Layer-1 blockchain, suitable for modern browsers and Node.js (18+).

> [!NOTE]
> **Developer Preview Notice:** This repository is an initial read-only developer preview. It does not contain private key derivation, transaction signing, hardware wallet connectors, or mining engines.

---

## Features

- **Standard JSON-RPC 2.0 Transport:** Configurable endpoint URL, automatic request IDs, configurable timeouts, caller-controlled cancellation (`AbortSignal`), and typed error classes.
- **Read-Only Verified Methods:** Full set of query methods verified against actual `crates/kovanica-rpc` Rust handlers at commit [`feab9050b178ee6d25798c0976a7fa138e90f537`](https://github.com/KovanicaDAG/kovanica/commit/feab9050b178ee6d25798c0976a7fa138e90f537).
- **Lossless Precision (Large Integers):** Kovanica balances, heights, stakes, nonces, and gas rates are represented losslessly as native JavaScript `bigint`. Never coerced into IEEE-754 `Number`. Plain JSON integers up to `u64::MAX` are preserved losslessly.
- **PRO-21 Address Support:** Canonical 64-character `kvnc...dag` base32 addresses (256-bit Ed25519 public key + 29-bit `blake3` checksum) and chain-aware validation.
- **Chain Registry:** Verified chain ID metadata for Mainnet (1), Testnet (2), Devnet (3), Testnet V2 (4), Hybrid PoW Testnet (5), and Local (1337). Correct consensus mapping (Mainnet and Local use Mysticeti; only Chain 5 uses Hybrid PoW + GHOSTDAG).
- **Hybrid PoW & DAG Queries:** First-class typed support for `kovanica_getMiningInfo` and `kovanica_getDagTips` for Chain 5 (Hybrid PoW + GHOSTDAG).

---

## Installation

```bash
# Direct local dependency or npm tarball
npm install kovanica-sdk
```

---

## Quick Start

### 1. Connecting and Querying State

```typescript
import { KovanicaClient, formatKvnc, isNodeSynced } from "kovanica-sdk";

// Connect to a local node (Chain 5 Hybrid or Local Devnet)
const client = new KovanicaClient("http://127.0.0.1:8545/rpc");

// Get latest committed leader block height (returns bigint)
const height = await client.blockNumber();
console.log(`Current committed height: ${height}`);

// Query account balance (returns bigint in atoms: 1 KVNC = 10^9 atoms)
const balanceAtoms = await client.getBalance("kvnc123...dag");
console.log(`Balance: ${formatKvnc(balanceAtoms)} KVNC (${balanceAtoms} atoms)`);

// Query node synchronization and peer health (L1 camelCase contract with snake_case aliases)
const sync = await client.syncStatus();
console.log(`Node peers: ${sync.peerCount}, Catching up: ${sync.catchingUp}`);
console.log(`Is confirmed in-sync: ${isNodeSynced(sync)}`);
```

### 2. Querying Chain 5 Hybrid PoW Mining Info & DAG Tips

> **Important:** Chain 5 is the planned hybrid PoW + GHOSTDAG testnet (ADR 0003, KovanicaHash, target block 4 s, GHOSTDAG K=5). No public endpoints are invented; queries are performed against a local node running with `--chain-id 5`.

```typescript
// Query PoW mining parameters and difficulty
const mining = await client.getMiningInfo();
console.log(`Chain ID: ${mining.chain_id}`);
console.log(`Difficulty: ${mining.difficulty}`);
console.log(`Target Bits: ${mining.target_bits}`);
console.log(`Estimated Hashrate: ${mining.network_hashrate_estimate} H/s`);

// Query active DAG tips
const tips = await client.getDagTips();
console.log(`Active DAG tips count: ${tips.count}`);
for (const tipHash of tips.tips) {
  console.log(`  - Tip: ${tipHash}`);
}
```

### 3. PRO-21 Address Verification

```typescript
import {
  CHAIN_IDS,
  encodeAddress,
  decodeAddress,
  isValidAddress,
} from "kovanica-sdk";

const publicKey = new Uint8Array(32); // 32-byte Ed25519 public key

// Encode to canonical 64-character PRO-21 address
const address = encodeAddress(publicKey);
console.log(`Address: ${address}`); // "kvnc...dag"

// Strict validation on Mainnet (Chain 1) and Testnet (Chain 2)
console.log(isValidAddress(address, CHAIN_IDS.MAINNET)); // true
console.log(isValidAddress("0x1234...", CHAIN_IDS.MAINNET)); // false (legacy hex forbidden on mainnet)

// Devnet (3), Testnet V2 (4), Hybrid (5), and Local (1337) allow legacy hex
console.log(isValidAddress("0x1234...", CHAIN_IDS.HYBRID_TESTNET)); // true (if valid 32-byte hex)
```

### 4. Timeout and Cancellation with `AbortSignal`

```typescript
const controller = new AbortController();

// Automatically cancel after 3 seconds
const timeout = setTimeout(() => controller.abort(), 3000);

try {
  const block = await client.getBlockByNumber(100n, false, {
    signal: controller.signal,
    timeoutMs: 5000,
  });
  console.log(block);
} catch (err) {
  if (err instanceof KovanicaAbortError) {
    console.warn("Request was cancelled");
  } else if (err instanceof KovanicaTimeoutError) {
    console.error(`Request timed out after ${err.timeoutMs}ms`);
  }
} finally {
  clearTimeout(timeout);
}
```

---

## Large Integer Representation & Lossless Quantities

Kovanica JSON-RPC uses `0x`-prefixed minimal hex strings for integers (e.g. `"0x0"`, `"0x2540be400"` for 10 KVNC).

In JavaScript, standard `Number` is an IEEE-754 64-bit float with a safe integer limit of $2^{53} - 1$ (`9,007,199,254,740,991`). While the total KVNC supply of $90,200,000 \times 10^9 = 90,200,000,000,000,000$ atoms exceeds this limit, 64-bit and 128-bit blockchain quantities will suffer silent bit truncation if coerced to `Number`.

To prevent precision corruption:
1. All integer quantities returned from the node (`blockNumber`, `balance`, `nonce`, `fee`, `stake`, `rewards`, `difficulty`, `target_round`) are deserialized directly into native JavaScript `bigint`.
2. Formatting and parsing helpers (`toHexQuantity`, `parseQuantity`, `formatKvnc`, `parseKvnc`) operate purely on `bigint` and string representations without floating point conversion.

---

## RPC Compatibility Matrix

All methods are mapped directly to handlers in `crates/kovanica-rpc` verified at node commit [`feab9050b178ee6d25798c0976a7fa138e90f537`](https://github.com/KovanicaDAG/kovanica/commit/feab9050b178ee6d25798c0976a7fa138e90f537):

| JSON-RPC Method | SDK Client Method | Handler in `kovanica-rpc` | Supported Chains | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `kovanica_blockNumber` | `client.blockNumber()` | `handle_block_number` | 1, 2, 3, 4, 5, 1337 | Returns committed leader height |
| `kovanica_getBlockByNumber` | `client.getBlockByNumber(n, full)` | `handle_get_block_by_number` | 1, 2, 3, 4, 5, 1337 | Takes hex quantity or bigint |
| `kovanica_getBlockByHash` | `client.getBlockByHash(h, full)` | `handle_get_block_by_hash` | 1, 2, 3, 4, 5, 1337 | 32-byte block digest |
| `kovanica_getBalance` | `client.getBalance(addr)` | `handle_get_balance` | 1, 2, 3, 4, 5, 1337 | Returns atomic balance in atoms |
| `kovanica_getNonce` | `client.getNonce(addr)` | `handle_get_nonce` | 1, 2, 3, 4, 5, 1337 | Account sequence number |
| `kovanica_getCode` | `client.getCode(addr)` | `handle_get_code` | 1, 2, 3, 4, 5, 1337 | Contract bytecode hex |
| `kovanica_getStorageAt` | `client.getStorageAt(addr, slot)` | `handle_get_storage_at` | 1, 2, 3, 4, 5, 1337 | Contract storage slot hex |
| `kovanica_getTransactionByHash` | `client.getTransactionByHash(h)` | `handle_get_transaction_by_hash` | 1, 2, 3, 4, 5, 1337 | Returns transaction details |
| `kovanica_getTransactionReceipt` | `client.getTransactionReceipt(h)` | `handle_get_transaction_receipt` | 1, 2, 3, 4, 5, 1337 | Status, block execution receipt & gasUsed |
| `kovanica_getPendingTransactions`| `client.getPendingTransactions()` | `handle_get_pending_transactions`| 1, 2, 3, 4, 5, 1337 | Mempool pending tx hashes |
| `kovanica_estimateFee` | `client.estimateFee()` | `handle_estimate_fee` | 1, 2, 3, 4, 5, 1337 | Gas fee rate in atoms per byte |
| `kovanica_getValidators` | `client.getValidators()` | `handle_get_validators` | 1, 2, 3, 4, 5, 1337 | Active validator set and stakes |
| `kovanica_getStake` | `client.getStake(addr)` | `handle_get_stake` | 1, 2, 3, 4, 5, 1337 | Bonded stake amount |
| `kovanica_getRewards` | `client.getRewards(addr)` | `handle_get_rewards` | 1, 2, 3, 4, 5, 1337 | Cumulative earned rewards |
| `kovanica_getLeaderSchedule` | `client.getLeaderSchedule(count)` | `handle_get_leader_schedule` | 1, 2, 3, 4, 5, 1337 | Leader rounds schedule |
| `kovanica_syncStatus` | `client.syncStatus()` | `handle_sync_status` | 1, 2, 3, 4, 5, 1337 | camelCase wire contract with peerId & reportedTipRound |
| `kovanica_getMiningInfo` | `client.getMiningInfo()` | `handle_get_mining_info` | 5 (Hybrid PoW) | Mining difficulty, DAA target |
| `kovanica_getDagTips` | `client.getDagTips()` | `handle_get_dag_tips` | 5 (Hybrid PoW) | Current DAG tip block hashes |

---

## Node Synchronization Contract (`kovanica_syncStatus`)

The L1 RPC returns `SyncStatus` with `#[serde(rename_all = "camelCase")]`:
- `localTipRound`: `u64` (omitted if storage unread)
- `committedHeight`: `u64` (omitted if storage unread)
- `localHeight`: `u64` (alias for `committedHeight`)
- `catchingUp`: `bool`
- `catchUpTarget`: `u64` (omitted if not catching up)
- `behindBy`: `u64` (omitted if not catching up)
- `peerCount`: `usize` (plain integer)
- `peers`: array of `SyncPeerStatus` (`peerId`: string, `reportedTipRound`: optional `u64`)
- `networkTag`: `<chain_id>-<16 hex chars>`

### Synchronization State Semantics
In Kovanica L1, **`catchingUp === false` alone is insufficient** to conclude a node is in sync:
- When a node is in the initial probing state or has zero connected peers, `catchingUp` is reported as `false`, yet the node is not in consensus sync.
- Unknown fields (missing `localTipRound`, `committedHeight`, `peerCount`, or `catchingUp`) remain `undefined` and are **never converted to `0` or false claims**.
- Explicit zeros (`localTipRound: 0`, `committedHeight: 0`, `peerCount: 0`, `reportedTipRound: 0`) are strictly preserved.
- The SDK exports `isNodeSynced(status)`: returns `true` only if `catchingUp === false`, `localTipRound !== undefined`, and `peerCount > 0`. Returns `false` if `catchingUp === true`. Returns `undefined` if status is indeterminate.

---

## Chain ID Registry

| Chain ID | Name | Consensus | Target Block | Address Rule |
| :---: | :--- | :--- | :---: | :--- |
| `1` | **Mainnet** | Mysticeti | 4 s | Strict PRO-21 base32 (`kvnc...dag`, 64 chars) |
| `2` | **Testnet** (Legacy ID) | Mysticeti | 4 s | Strict PRO-21 base32 (`kvnc...dag`, 64 chars) |
| `3` | **Devnet** | Mysticeti | 4 s | PRO-21 base32 and legacy hex allowed |
| `4` | **Testnet V2** (Internal) | Mysticeti | 4 s | PRO-21 base32 and legacy hex allowed |
| `5` | **Hybrid PoW Testnet** | Hybrid PoW + GHOSTDAG | 4 s | PRO-21 base32 and legacy hex allowed |
| `1337` | **Local Devnet** | Mysticeti | 4 s | PRO-21 base32 and legacy hex allowed |

> [!NOTE]
> Per `crates/kovanica-types/src/signing.rs`, only Chain 5 (`is_hybrid(5) == true`) executes Hybrid PoW + GHOSTDAG mining. Mainnet (1) and default Local networks (1337) run Mysticeti uncertified DAG consensus.

---

## Testing & Live RPC Verification

The test suite separates deterministic offline fixture tests from live node interoperability:

### 1. Offline / Default Mode
```bash
npm test
```
Runs all unit tests, address encoders/decoders, chain registry checks, and source-backed JSON fixture regressions. If no live node is running, live network queries are cleanly skipped with an informative notice while offline verification passes.

### 2. Required-Live Interoperability Mode
```bash
# Target an explicitly configured, isolated local node
KOVANICA_RPC_URL=http://127.0.0.1:18545/rpc npm run test:live
# or
KOVANICA_REQUIRE_LIVE=1 KOVANICA_RPC_URL=http://127.0.0.1:18545/rpc npm test
```
In required-live mode:
- The suite **fails immediately** if the configured node is unreachable or fails strict JSON-RPC readiness validation.
- **HTTP 200 alone is rejected as a readiness check:** the probe verifies that the response is valid JSON-RPC 2.0 without an error object, and conforms to the `kovanica_syncStatus` schema (`catchingUp` boolean, `peerCount` integer).
- Verifies live `syncStatus`, `blockNumber`, network identity tag (`<chain_id>-<16_hex_genesis>`), and Chain 5 mining/DAG endpoints (`kovanica_getMiningInfo`, `kovanica_getDagTips`).
- Distinguishes basic genesis readiness from stronger nonzero executed state (`[BLOCKED]` when height remains 0).

### 3. Automated Isolated Cluster Runner
```bash
npm run test:live:isolated
```
Orchestrates L1's documented isolated topology (Observer + Producer on loopback `127.0.0.1` with disposable directories) using the approved `kovanica-node` binary, verifies peering, and executes required-live verification against the Observer RPC. Tears down all processes and temporary state on exit.

---

## Compatibility Limits

1. **Read-Only Surface:** This SDK implements the read-only JSON-RPC query surface. It does not construct or sign state-mutating transactions, light client proofs, or submit mining blocks.
2. **Chain 5 Only for Mining:** `client.getMiningInfo()` and `client.getDagTips()` are exclusively supported on Chain ID 5 (Hybrid PoW testnet). On other chains, the node rejects these methods with code `-32600`.
3. **Lossless Precision Range:** Integers on the wire up to `u64::MAX` (`18446744073709551615`) and 128-bit balances are parsed losslessly into `bigint`. Direct JavaScript `number` literals exceeding `Number.MAX_SAFE_INTEGER` will throw `TypeError` to guard against precision corruption.

---

## License Basis

- **License:** MIT License (`LICENSE`).
- **Basis:** Developed from scratch as a clean TypeScript client based on public protocol constants (`kovanica-params`) and the JSON-RPC interface specification (`kovanica-rpc`) verified at node commit [`feab9050b178ee6d25798c0976a7fa138e90f537`](https://github.com/KovanicaDAG/kovanica/commit/feab9050b178ee6d25798c0976a7fa138e90f537). Contains no copied code from GPL-3.0 licensed consensus internals.
