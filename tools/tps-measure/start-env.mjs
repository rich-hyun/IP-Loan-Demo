// Starts the local TPS test environment and keeps it running until Ctrl+C:
//   1. Hardhat node (local test chain 31337, automine) on environment.rpcUrl
//   2. v2 IPLoanManager deployed fresh, one wallet per role (borrower / evaluator / bank) as in operation
//   3. The real Flask API (env/tps_server.py) with test doubles for IPFS, the LLM evaluation API and the
//      patent register API, on environment.apiBase
// Writes run/env.json for prepare-pool.mjs and tps-measure.mjs. Never touches production chain, DB or IPFS.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ContractFactory, id } from 'ethers';
import { ENV, REPO, ROOT, RUN_DIR, config, loadJson, managerInterface, rpc, Sender, wallets } from './lib/common.mjs';

const children = [];
const stop = () => { for (const c of children) { try { c.kill(); } catch { /* already gone */ } } };
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('exit', stop);

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(check, label, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try { const v = await check(); if (v) return v; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(label + ' 기동 시간 초과');
    await wait(300);
  }
}

const rpcPort = new URL(ENV.rpcUrl).port || '8545';
try { await rpc('eth_chainId'); throw new Error(`${ENV.rpcUrl} 에 이미 노드가 있습니다. 기존 시험 환경을 먼저 종료하세요.`); }
catch (e) { if (!e.message.includes('fetch failed') && !e.cause) throw e; }

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const node = spawn(npx, ['hardhat', 'node', '--port', rpcPort, '--hostname', '127.0.0.1'],
  { cwd: path.join(REPO, 'blockchain'), shell: process.platform === 'win32', stdio: ['ignore', 'ignore', 'inherit'] });
children.push(node);
node.on('exit', code => { console.error('Hardhat node exited', code); process.exit(1); });
await until(async () => (await rpc('eth_chainId')) === '0x' + ENV.chainId.toString(16), 'Hardhat node');
console.log('chain   ', ENV.rpcUrl, 'chainId', ENV.chainId);

const w = wallets();
const artifact = loadJson(path.join(REPO, 'blockchain', 'artifacts', 'IPLoanManager.json'));
const deployData = new ContractFactory(artifact.abi, artifact.bytecode).interface.encodeDeploy([w.admin.address, w.evaluator.address, w.bank.address]);
const admin = new Sender(w.admin, ENV.chainId, null);
const receipt = await admin.send(artifact.bytecode + deployData.slice(2), 29_000_000n);
const manager = receipt.contractAddress;
const iface = managerInterface();
admin.to = manager;
await admin.send(iface.encodeFunctionData('grantRole', [id('BORROWER_ROLE'), w.borrower.address]));
for (const role of ['borrower', 'evaluator', 'bank']) {
  const balance = BigInt(await rpc('eth_getBalance', [w[role].address, 'latest']));
  if (balance < 10n ** 20n) {
    const fund = { type: 2, chainId: ENV.chainId, nonce: Number(BigInt(await rpc('eth_getTransactionCount', [w.admin.address, 'pending']))),
                   to: w[role].address, value: 10n ** 21n, gasLimit: 21000n, maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
    await rpc('eth_sendRawTransaction', [await w.admin.signTransaction(fund)]);
  }
}
console.log('manager ', manager);
console.log('roles    borrower', w.borrower.address, '/ evaluator', w.evaluator.address, '/ bank', w.bank.address);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dataDir = path.join(RUN_DIR, 'data-' + stamp);
mkdirSync(dataDir, { recursive: true });
const api = new URL(ENV.apiBase);
const python = process.env.TPS_PYTHON || path.join(REPO, 'server', process.platform === 'win32' ? 'venv/Scripts/python.exe' : 'venv/bin/python');
if (!existsSync(python)) throw new Error('Python 가상환경이 없습니다: ' + python);
const serverEnv = { ...process.env, IPLOAN_RPC_URL: ENV.rpcUrl, IPLOAN_CHAIN_ID: String(ENV.chainId), IPLOAN_MANAGER_ADDRESS: manager,
  IPLOAN_TPS_DATA_DIR: dataDir, IPLOAN_TPS_PORT: api.port, IPLOAN_TPS_THREADS: String(ENV.serverThreads), PYTHONIOENCODING: 'utf-8' };
for (const key of ['IPLOAN_ASSIGNMENT_EVALUATOR', 'IPLOAN_ASSIGNMENT_BANK', 'IPLOAN_ASSIGNMENT_BY_BORROWER', 'IPLOAN_ZERO_GAS_PRICE', 'IPLOAN_DB_PATH']) delete serverEnv[key];
const apiBases = [];
for (let worker = 0; worker < ENV.serverWorkers; worker++) {
  const port = String(Number(api.port) + worker);
  const server = spawn(python, [path.join(ROOT, 'env', 'tps_server.py')], { cwd: REPO, env: { ...serverEnv, IPLOAN_TPS_PORT: port }, stdio: ['ignore', 'inherit', 'inherit'] });
  children.push(server);
  server.on('exit', code => { console.error('API server exited', code); process.exit(1); });
  const base = `${api.protocol}//${api.hostname}:${port}${api.pathname}`;
  await until(async () => (await fetch(base + '/health')).ok, 'API server ' + port);
  const cfg = await (await fetch(base + '/chain/config')).json();
  if (cfg.managerAddress?.toLowerCase() !== manager.toLowerCase()) throw new Error('API 가 다른 계약을 보고 있습니다.');
  apiBases.push(base);
}
console.log('api     ', apiBases.join(' '), `(${ENV.serverWorkers} processes x ${ENV.serverThreads} threads, waitress)`);

const nodeVersion = await rpc('web3_clientVersion');
writeFileSync(path.join(RUN_DIR, 'env.json'), JSON.stringify({
  startedAt: new Date().toISOString(), apiBase: apiBases[0], apiBases, rpcUrl: ENV.rpcUrl, chainId: ENV.chainId, manager,
  nodeVersion, serverWorkers: ENV.serverWorkers, serverThreads: ENV.serverThreads, dataDir,
  wallets: { borrower: w.borrower.address, evaluator: w.evaluator.address, bank: w.bank.address },
  pids: { node: node.pid }, config: config.measurement,
}, null, 2));
console.log('ready    run/env.json written. Ctrl+C to stop.');
setInterval(() => {}, 1 << 30);
