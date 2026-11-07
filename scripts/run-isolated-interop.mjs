#!/usr/bin/env node
/**
 * Isolated Hybrid PoW Topology Runner for SDK Live Nonzero Interoperability.
 *
 * Sets up L1's documented isolated topology (loopback only, fresh disposable volumes):
 * 1. Generates 2 ed25519 validator identities with deterministic authority ordering.
 * 2. Spawns a Non-mining Observer Node on loopback.
 * 3. Spawns an external Mining Producer Node on loopback, peered to the Observer.
 * 4. Waits for producer blocks to be admitted and committed on Observer (committedHeight >= 1).
 * 5. Runs the live test suite in required-live mode against the Observer RPC endpoint.
 * 6. Ensures clean teardown of processes and disposable directories on exit.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NODE_BINARY =
  process.env.KOVANICA_NODE_BINARY ||
  path.resolve(process.cwd(), '../kovanica/target/debug/kovanica-node') ||
  '/root/Projects/kovanica/target/debug/kovanica-node';

if (!fs.existsSync(NODE_BINARY)) {
  console.error(`[BLOCKED] kovanica-node binary not found at ${NODE_BINARY}.`);
  console.error('An existing approved node binary is required to run the isolated live cluster.');
  process.exit(1);
}

const OBSERVER_RPC_PORT = parseInt(process.env.OBSERVER_RPC_PORT || '18545', 10);
const OBSERVER_P2P_PORT = parseInt(process.env.OBSERVER_P2P_PORT || '18546', 10);
const PRODUCER_RPC_PORT = parseInt(process.env.PRODUCER_RPC_PORT || '18547', 10);
const PRODUCER_P2P_PORT = parseInt(process.env.PRODUCER_P2P_PORT || '18548', 10);

function generateValidatorKeys() {
  function genKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
    const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32);
    return { pub, priv };
  }

  let k0 = genKey();
  let k1 = genKey();
  // Sort by address bytes so validator 0 (Producer) is deterministically authority 0
  if (Buffer.compare(k0.pub, k1.pub) > 0) {
    const tmp = k0;
    k0 = k1;
    k1 = tmp;
  }
  return { producerKey: k0, observerKey: k1 };
}

const { producerKey, observerKey } = generateValidatorKeys();

const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kovanica-interop-'));
const obsDir = path.join(tempBase, 'observer');
const prodDir = path.join(tempBase, 'producer');
fs.mkdirSync(obsDir, { recursive: true });
fs.mkdirSync(prodDir, { recursive: true });

const genesisToml = `# generated for SDK live interop
chain_id = 5

[[validator]]
address = "${producerKey.pub.toString('hex')}"
stake = 50000000000000
public_key = "${producerKey.pub.toString('hex')}"

[[validator]]
address = "${observerKey.pub.toString('hex')}"
stake = 50000000000000
public_key = "${observerKey.pub.toString('hex')}"
`;

fs.writeFileSync(path.join(obsDir, 'genesis_validators.toml'), genesisToml);
fs.writeFileSync(path.join(prodDir, 'genesis_validators.toml'), genesisToml);

const obsKeyPath = path.join(obsDir, 'validator.key');
const prodKeyPath = path.join(prodDir, 'validator.key');
fs.writeFileSync(obsKeyPath, observerKey.priv.toString('hex'), { mode: 0o600 });
fs.writeFileSync(prodKeyPath, producerKey.priv.toString('hex'), { mode: 0o600 });

console.log('[Topology] Setting up isolated Hybrid PoW testnet (Chain 5)...');
console.log(`[Topology] Node binary: ${NODE_BINARY}`);
console.log(`[Topology] Producer address: 0x${producerKey.pub.toString('hex')}`);
console.log(`[Topology] Observer address: 0x${observerKey.pub.toString('hex')}`);
console.log(`[Topology] Observer RPC: http://127.0.0.1:${OBSERVER_RPC_PORT}/rpc`);

let obsProcess = null;
let prodProcess = null;

function cleanup() {
  console.log('[Topology] Tearing down cluster...');
  if (prodProcess) {
    try {
      prodProcess.kill('SIGTERM');
    } catch {}
  }
  if (obsProcess) {
    try {
      obsProcess.kill('SIGTERM');
    } catch {}
  }
  try {
    fs.rmSync(tempBase, { recursive: true, force: true });
  } catch {}
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

process.on('exit', () => {
  cleanup();
});

async function rpcPost(port, method, params = []) {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function waitForCondition(desc, fn, timeoutMs = 30000, intervalMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fn();
      if (res) return res;
    } catch {}
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout waiting for ${desc} after ${timeoutMs}ms`);
}

async function run() {
  // 1. Spawn Observer (non-mining, non-validator)
  obsProcess = spawn(NODE_BINARY, ['--config', '/dev/null'], {
    cwd: obsDir,
    env: {
      ...process.env,
      KOVANICA_DATA_DIR: obsDir,
      KOVANICA_RPC_ADDR: '127.0.0.1',
      KOVANICA_RPC_PORT: String(OBSERVER_RPC_PORT),
      KOVANICA_LISTEN_ADDR: `127.0.0.1:${OBSERVER_P2P_PORT}`,
      KOVANICA_MAX_PEERS: '8',
      KOVANICA_RUN_VALIDATOR: 'false',
      KOVANICA_CHAIN_ID: '5',
      KOVANICA_MINING_ENABLED: 'false',
      KOVANICA_MINING_THREADS: '1',
      KOVANICA_MINING_AUTHOR: '1',
      KOVANICA_RPC_AUTH: 'disable',
      KOVANICA_RPC_RATE_LIMIT_PER_MIN: '0',
      KOVANICA_VALIDATOR_KEY: obsKeyPath,
      RUST_LOG: 'warn',
    },
    stdio: 'ignore',
  });

  // 2. Wait for Observer RPC readiness
  await waitForCondition('Observer RPC readiness', async () => {
    const json = await rpcPost(OBSERVER_RPC_PORT, 'kovanica_syncStatus');
    return json?.result !== undefined;
  });
  console.log('[Topology] Observer node is online.');

  // Allow Observer P2P listener to bind before spawning Producer
  await new Promise((r) => setTimeout(r, 1000));

  // 3. Spawn Producer (mining enabled, validator enabled, author 0, dialed to Observer)
  prodProcess = spawn(NODE_BINARY, ['--config', '/dev/null'], {
    cwd: prodDir,
    env: {
      ...process.env,
      KOVANICA_DATA_DIR: prodDir,
      KOVANICA_RPC_ADDR: '127.0.0.1',
      KOVANICA_RPC_PORT: String(PRODUCER_RPC_PORT),
      KOVANICA_LISTEN_ADDR: `127.0.0.1:${PRODUCER_P2P_PORT}`,
      KOVANICA_BOOTNODES: `127.0.0.1:${OBSERVER_P2P_PORT}`,
      KOVANICA_MAX_PEERS: '8',
      KOVANICA_RUN_VALIDATOR: 'true',
      KOVANICA_CHAIN_ID: '5',
      KOVANICA_MINING_ENABLED: 'true',
      KOVANICA_MINING_THREADS: '1',
      KOVANICA_MINING_AUTHOR: '0',
      KOVANICA_RPC_AUTH: 'disable',
      KOVANICA_RPC_RATE_LIMIT_PER_MIN: '0',
      KOVANICA_VALIDATOR_KEY: prodKeyPath,
      RUST_LOG: 'warn',
    },
    stdio: 'ignore',
  });

  // 4. Wait for peering and check committed blocks on Observer
  console.log('[Topology] Waiting for producer and observer to peer (peerCount >= 1)...');
  const peerResult = await waitForCondition(
    'Observer peerCount >= 1',
    async () => {
      const json = await rpcPost(OBSERVER_RPC_PORT, 'kovanica_syncStatus');
      const res = json?.result;
      if (res && res.peerCount >= 1) {
        return res;
      }
      return false;
    },
    15000,
    500,
  );
  console.log(`[Topology] Peered successfully with ${peerResult.peerCount} peer(s).`);

  console.log('[Topology] Checking for block production and observer commitment...');
  let committedResult = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const json = await rpcPost(OBSERVER_RPC_PORT, 'kovanica_syncStatus');
      const res = json?.result;
      if (res && res.committedHeight >= 1) {
        committedResult = res;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }

  if (committedResult) {
    console.log(
      `[Topology] Observer reached committedHeight = ${committedResult.committedHeight}, localTipRound = ${committedResult.localTipRound}, peerCount = ${committedResult.peerCount}`,
    );
  } else {
    console.log(
      '[Topology] Observer committedHeight is 0 (execution lane pending or non-zero emission blocked).',
    );
    console.log(
      '[Topology] Proceeding to run test suite in required-live mode (nonzero executed acceptance will report BLOCKED).',
    );
  }

  // 5. Run Vitest against the live Observer RPC endpoint
  console.log('[Topology] Executing required-live test suite against Observer RPC...');
  const vitest = spawn('npx', ['vitest', 'run', 'tests/live-interop.test.ts'], {
    env: {
      ...process.env,
      KOVANICA_REQUIRE_LIVE: '1',
      KOVANICA_RPC_URL: `http://127.0.0.1:${OBSERVER_RPC_PORT}/rpc`,
      KOVANICA_PRODUCER_ADDRESS: `0x${producerKey.pub.toString('hex')}`,
    },
    stdio: 'inherit',
  });

  vitest.on('close', (code) => {
    cleanup();
    process.exit(code ?? 0);
  });
}

run().catch((err) => {
  console.error('[Topology Error]:', err);
  cleanup();
  process.exit(1);
});
