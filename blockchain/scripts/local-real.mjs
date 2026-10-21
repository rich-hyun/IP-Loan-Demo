/* Local development chain; real browser wallet, IPFS and report service.
 * All unlocked development keys and RPC endpoints are loopback-only.
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { network } from 'hardhat';
import { BrowserProvider, ContractFactory, HDNodeWallet, isAddress } from 'ethers';
import { compile } from './compile.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const port = Number(process.env.IPLOAN_LOCAL_PORT || 8003);
const rpcPort = Number(process.env.IPLOAN_LOCAL_RPC_PORT || 8545);
for (const p of [port, rpcPort]) if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('Invalid local port');
const origin = `http://127.0.0.1:${port}`;
const rpcUrl = `http://127.0.0.1:${rpcPort}`;
const output = path.join(root, 'output', 'local-real');
await mkdir(output, { recursive: true });
const dataDir = await mkdtemp(path.join(output, 'session-'));
const connection = await network.connect('localTest');
const provider = new BrowserProvider(connection.provider);
provider.pollingInterval = 50;
const signers = await Promise.all([0, 1, 2, 3].map(i => provider.getSigner(i)));
const [admin, borrower, evaluator, bank] = signers;
const artifacts = compile();
await mkdir(path.join(root, 'blockchain', 'artifacts'), { recursive: true });
for (const [name, value] of Object.entries(artifacts)) await writeFile(path.join(root, 'blockchain', 'artifacts', name + '.json'), JSON.stringify(value));
const manager = await new ContractFactory(artifacts.IPLoanManager.abi, artifacts.IPLoanManager.bytecode, admin).deploy(admin.address, evaluator.address, bank.address);
await manager.waitForDeployment();
await (await manager.grantRole(await manager.BORROWER_ROLE(), borrower.address)).wait();
const roles = { borrower: borrower.address, evaluator: evaluator.address, bank: bank.address };
for (const [role, envName] of Object.entries({ borrower: 'IPLOAN_LOCAL_BORROWER', evaluator: 'IPLOAN_LOCAL_EVALUATOR', bank: 'IPLOAN_LOCAL_BANK' })) {
  const address = process.env[envName];
  if (!address) continue;
  if (!isAddress(address) || /^0x0{40}$/i.test(address)) throw new Error(`Invalid ${envName}`);
  roles[role] = address;
  await connection.provider.request({ method: 'hardhat_setBalance', params: [address, '0x56BC75E2D63100000'] });
  await (await manager.grantRole(await manager[role === 'borrower' ? 'BORROWER_ROLE' : role === 'evaluator' ? 'EVALUATOR_ROLE' : 'BANK_ROLE'](), address)).wait();
}
if (new Set(Object.values(roles).map(a => a.toLowerCase())).size !== 3) throw new Error('Borrower, evaluator and bank must use different wallets');
let child, apiUrl;
let closing = false;
const servers = [];
async function close() {
  if (closing) return;
  closing = true;
  child?.kill();
  for (const server of servers) { server.closeAllConnections(); server.close(); }
  provider.destroy(); await connection.close();
}
process.once('SIGINT', async () => { await close(); process.exit(0); });
process.once('SIGTERM', async () => { await close(); process.exit(0); });
async function listen(server, p) { servers.push(server); server.listen(p, '127.0.0.1'); await once(server, 'listening'); }
async function body(req, limit = 22 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('Request too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
const rpc = http.createServer(async (req, res) => {
  const allowed = !req.headers.origin || req.headers.origin === origin || req.headers.origin.startsWith('chrome-extension://');
  if (!allowed) { res.writeHead(403); res.end(); return; }
  if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  try {
    const call = JSON.parse((await body(req, 1024 * 1024)).toString());
    async function execute(c) {
      try { return { jsonrpc: '2.0', id: c.id, result: await connection.provider.request({ method: c.method, params: c.params || [] }) }; }
      catch (error) { return { jsonrpc: '2.0', id: c.id, error: { code: error.code || -32000, message: error.message, ...(error.data ? { data: error.data } : {}) } }; }
    }
    const result = Array.isArray(call) ? await Promise.all(call.map(execute)) : await execute(call);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  } catch { res.writeHead(400); res.end(); }
});
const startupScript = `globalThis.IPLOAN_API_BASE='/api';globalThis.IPLOAN_PATENT_API_BASE='/api/patent';
addEventListener('DOMContentLoaded',()=>{const box=document.createElement('div');box.style='padding:12px;background:#e2f4e8;position:sticky;top:0;z-index:99';box.innerHTML='<b>MetaMask 직접 승인 · 실제 IPFS · 실제 평가 API · 로컬 개발 체인 (실제 자금 없음)</b> <a href="/local-setup.html" target="_blank">지갑·네트워크 설정 안내</a>';document.body.prepend(box);});`;
const mnemonic = 'test test test test test test test test test test test junk';
const devAccounts = signers.map((s, i) => ({ role: ['관리자', '차주', '평가사', '은행'][i], address: s.address,
  privateKey: HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${i}`).privateKey }));
for (const [i, account] of devAccounts.entries()) if (HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${i}`).address !== account.address) throw new Error('Development account configuration mismatch');
const setupHtml = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>실제 연동 로컬 설정</title><style>body{font-family:system-ui;max-width:1000px;margin:32px auto;line-height:1.7}code{overflow-wrap:anywhere}td,th{border:1px solid #ddd;padding:8px}table{border-collapse:collapse}</style>
<h1>MetaMask · 실제 IPFS 연동</h1><p>MetaMask 확장이 설치된 Chrome/Edge에서 <a href="${origin}">${origin}</a>를 여세요. Codex 내장 브라우저에는 확장이 없을 수 있습니다.</p>
<p>네트워크: Local MVP, RPC <code>${rpcUrl}</code>, 체인 ID <b>31337</b>, 통화 ETH. 신청 화면의 MetaMask 연결 버튼으로 네트워크 전환을 승인하세요.</p>
<p>아래 키는 Hardhat의 공개된 로컬 개발 키입니다. 기존 계정의 비밀키나 복구 구문을 입력할 필요가 없습니다. MetaMask의 계정 가져오기에서 개발 계정만 추가하세요. 이 계정에 실제 자산을 입금하지 마세요.</p>
<table><tr><th>역할</th><th>개발 지갑 주소 / 로컬 전용 키</th></tr>${devAccounts.map(a => `<tr><td>${a.role}</td><td><code>${a.address}</code><br><code>${a.privateKey}</code></td></tr>`).join('')}</table>
<p>차주로 신청 → MetaMask 메시지 서명 → 실제 IPFS 암호문 업로드 → MetaMask 거래 승인 → 실제 평가 API 접수. 평가사 검토 시 평가사 계정, 은행 심사 시 은행 계정으로 전환하며 화면 우측 역할도 맞춰 주세요. UI 역할 선택은 지갑 계정 전환을 대신하지 않습니다.</p>
<p>준비된 실제 특허: 10-2877748, 두부 자극용 전위치료장치. 기업 주식회사 미브레스 / 사업자번호 550-81-02614. PDF는 프로젝트의 demo-files/real-patent/KR102877748B1.pdf 입니다. 그린파머스 등 예전 시연 프로필을 선택하지 말고 새 프로필을 만드세요.</p>
<p>실제 IPFS 업로드 서버: ${process.env.IPLOAN_IPFS_UPLOAD_URL || 'https://api.mustree.kr/upload'}. 실제 평가 API는 서버 인증 설정을 사용합니다. 외부 접수는 실제 작업을 생성합니다. 기존 보고서의 자동 산출값은 0원이며 근거 없이 양의 값으로 바꾸지 않습니다.</p>
<p>계약 <code>${await manager.getAddress()}</code>. 실행 종료 시 로컬 체인은 초기화됩니다. 이번 실행 DB는 <code>${dataDir}</code>에 보존되지만 다음 실행은 새 DB·체인을 사용합니다.</p></html>`;
const web = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (url.pathname.startsWith('/api/')) {
      if (!apiUrl) { res.writeHead(503); res.end(); return; }
      const response = await fetch(apiUrl + url.pathname.slice(4) + url.search, { method: req.method,
        headers: req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {},
        ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: await body(req) }) });
      res.writeHead(response.status, Object.fromEntries([...response.headers].filter(([k]) => !['content-length', 'transfer-encoding', 'connection', 'content-encoding'].includes(k))));
      res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/local-config.js') { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(startupScript); return; }
    if (url.pathname === '/local-setup.html') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(setupHtml); return; }
    const file = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    if (file.includes('..') || !(/^\/(index|patent|admin)\.html$/.test(file) || /^\/(js|css)\/[A-Za-z0-9_./-]+$/.test(file))) { res.writeHead(404); res.end(); return; }
    let bytes = await readFile(path.join(root, file.slice(1)));
    if (file.endsWith('.html')) bytes = Buffer.from(bytes.toString().replace('<head>', '<head><script src="/local-config.js"></script>'));
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8'); res.end(bytes);
  } catch (error) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: error.message })); }
});
try {
  await listen(rpc, rpcPort);
  const childEnv = { ...process.env, PYTHONUNBUFFERED: '1', IPLOAN_RPC_URL: rpcUrl, IPLOAN_CHAIN_ID: '31337',
    IPLOAN_MANAGER_ADDRESS: await manager.getAddress(), IPLOAN_ASSIGNMENT_EVALUATOR: roles.evaluator, IPLOAN_ASSIGNMENT_BANK: roles.bank,
    IPLOAN_DB_PATH: path.join(dataDir, 'iploan.db'), IPLOAN_PATENT_DB_PATH: path.join(dataDir, 'patents.db'), IPLOAN_PATENT_UPLOAD_DIR: path.join(dataDir, 'patent-uploads') };
  for (const key of ['IPLOAN_TEST_WORKFLOW_FIXTURE', 'IPLOAN_TEST_REAL_PROVIDER', 'IPLOAN_TEST_DATA_DIR']) delete childEnv[key];
  child = spawn(process.env.IPLOAN_TEST_PYTHON || path.join(root, 'server', 'venv', 'Scripts', 'python.exe'), [path.join(root, 'server', 'local_runner.py')], { cwd: root, env: childEnv });
  child.stderr.on('data', data => process.stderr.write(data));
  const startup = await new Promise((resolve, reject) => {
    let output = ''; child.stdout.on('data', data => { output += data; if (output.includes('\n')) { try { resolve(JSON.parse(output.split('\n')[0])); } catch (error) { reject(error); } } });
    child.once('error', reject); child.once('exit', code => reject(new Error('Application server exited: ' + code)));
  });
  apiUrl = startup.url;
  await listen(web, port);
  const config = { url: origin, setup: origin + '/local-setup.html', rpcUrl, chainId: 31337, manager: await manager.getAddress(), roles, dataDir,
    wallet: 'real MetaMask extension required', ipfs: 'real', evaluation: 'real', chain: 'local development EVM' };
  await writeFile(path.join(output, 'latest.json'), JSON.stringify(config, null, 2));
  await writeFile(path.join(dataDir, 'config.json'), JSON.stringify(config, null, 2));
  console.log(JSON.stringify(config));
  child.once('exit', async () => { if (!closing) { await close(); process.exit(1); } });
} catch (error) { await close(); throw error; }
