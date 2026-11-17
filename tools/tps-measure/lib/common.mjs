// Shared helpers: config, test wallets, JSON-RPC, signed transactions, API login.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { HDNodeWallet, Interface, Mnemonic, Wallet, id as keccakText } from 'ethers';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.resolve(ROOT, '..', '..');
export const RUN_DIR = path.join(ROOT, 'run');
export const config = JSON.parse(readFileSync(path.join(ROOT, 'tps.config.json'), 'utf8'));
export const ENV = config.environment;

export function loadJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }
export function runState() {
  const file = path.join(RUN_DIR, 'env.json');
  if (!existsSync(file)) throw new Error('run/env.json 이 없습니다. 먼저 node start-env.mjs 로 시험 환경을 띄우세요.');
  return loadJson(file);
}

// Wallets. Private keys come from TPS_*_KEY or a mnemonic in TPS_MNEMONIC. The public Hardhat test
// mnemonic is used only when nothing is set AND the target chain is the local test chain 31337.
export function wallets() {
  const fromKey = name => process.env[`TPS_${name.toUpperCase()}_KEY`];
  let phrase = process.env[ENV.mnemonicEnv];
  if (!phrase) {
    if (ENV.chainId !== 31337 || !/^http:\/\/127\.0\.0\.1[:/]/.test(ENV.rpcUrl)) throw new Error('로컬 시험 체인이 아니면 TPS_MNEMONIC 또는 TPS_*_KEY 를 직접 설정하세요.');
    phrase = ENV.defaultMnemonicLocalOnly;
  }
  const mnemonic = Mnemonic.fromPhrase(phrase);
  const derive = i => HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${i}`);
  const out = { admin: derive(0), borrower: derive(1), evaluator: derive(2), bank: derive(3) };
  for (const name of Object.keys(out)) {
    const key = fromKey(name);
    if (key) out[name] = new Wallet(key);
  }
  return out;
}

// ---------------------------------------------------------------- JSON-RPC
let rpcId = 0;
export async function rpc(method, params = [], url = ENV.rpcUrl) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const body = await response.json();
  if (body.error) throw Object.assign(new Error(body.error.message || 'RPC error'), { rpc: body.error });
  return body.result;
}

export const managerAbi = () => loadJson(path.join(REPO, 'blockchain', 'artifacts', 'IPLoanManager.json')).abi;
export const managerInterface = () => new Interface(managerAbi());

// Per-wallet sender: nonce is assigned and the raw tx sent under a lock (one in flight to the node per wallet,
// as a single wallet would); the receipt is awaited outside the lock.
export class Sender {
  constructor(wallet, chainId, to) { this.wallet = wallet; this.chainId = chainId; this.to = to; this.nonce = null; this.lock = Promise.resolve(); }
  async sync() { this.nonce = Number(BigInt(await rpc('eth_getTransactionCount', [this.wallet.address, 'pending']))); }
  async send(data, gasLimit = 3_000_000n) {
    let release; const previous = this.lock; this.lock = new Promise(r => (release = r));
    await previous;
    let hash;
    try {
      if (this.nonce === null) await this.sync();
      const tx = { type: 2, chainId: this.chainId, nonce: this.nonce, to: this.to, data, gasLimit,
                   maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, value: 0n };
      const raw = await this.wallet.signTransaction(tx);
      try {
        hash = await rpc('eth_sendRawTransaction', [raw]);
        this.nonce += 1;
      } catch (error) {
        // A reverted call may still be mined (nonce used); resync either way.
        await this.sync();
        throw error;
      }
    } finally { release(); }
    return waitReceipt(hash);
  }
}

export async function waitReceipt(hash, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    if (receipt) {
      if (receipt.status !== '0x1') throw Object.assign(new Error('transaction reverted'), { receipt });
      return receipt;
    }
    if (Date.now() > end) throw new Error('receipt timeout ' + hash);
    await new Promise(r => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------- API
export async function api(base, method, route, { json, form, token } = {}) {
  const headers = {};
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(base + route, { method, headers, body });
  const buffer = Buffer.from(await response.arrayBuffer());
  let data = null;
  if ((response.headers.get('content-type') || '').includes('json')) { try { data = JSON.parse(buffer.toString('utf8')); } catch { data = null; } }
  return { status: response.status, ok: response.ok, data, bytes: buffer.length };
}

export async function login(base, wallet) {
  const challenge = await api(base, 'POST', '/auth/challenge', { json: { address: wallet.address } });
  if (!challenge.ok) throw new Error('challenge failed: ' + JSON.stringify(challenge.data));
  const signature = await wallet.signMessage(challenge.data.message);
  const result = await api(base, 'POST', '/auth/login', { json: { address: wallet.address, nonce: challenge.data.nonce, signature } });
  if (!result.ok) throw new Error('login failed: ' + JSON.stringify(result.data));
  return result.data.token;
}

export const randomId = (n = 24) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
export const fakeCid = () => 'bafy' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
export const appKeyOf = text => keccakText(text);
export const GATEWAY = 'https://rwa-gw.mustree.kr/ipfs/';
