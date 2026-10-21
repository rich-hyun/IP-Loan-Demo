/* TEST ONLY. Ephemeral local EVM + temporary Flask DB + in-memory IPFS.
 * --real-provider uses configured evaluation service, never production chain/DB.
 * Never expose this unlocked wallet fixture outside loopback.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { network } from 'hardhat';
import { BrowserProvider, ContractFactory } from 'ethers';
import { compile } from './compile.mjs';

const realProvider = process.argv.includes('--real-provider');
const connection = await network.connect('localTest');
const provider = new BrowserProvider(connection.provider); provider.pollingInterval = 10;
const signers = await Promise.all([0,1,2,3,4].map(i => provider.getSigner(i)));
const [admin, borrower, evaluator, bank] = signers;
const compiled = compile();
const manager = await new ContractFactory(compiled.IPLoanManager.abi, compiled.IPLoanManager.bytecode, admin).deploy(admin.address, evaluator.address, bank.address);
await manager.waitForDeployment(); await (await manager.grantRole(await manager.BORROWER_ROLE(), borrower.address)).wait();
let apiUrl;
const walletScript = `
globalThis.IPLOAN_API_BASE='/api';
localStorage.setItem('iploan-role','borrower');
const qaHandlers={};let qaAccount=1;
globalThis.ethereum={on:(event,fn)=>{(qaHandlers[event]||=[]).push(fn)},request:async({method,params=[]})=>{
const res=await fetch('/qa-wallet-rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params,account:qaAccount})});
const out=await res.json();if(out.error)throw Object.assign(new Error(out.error.message),{code:out.error.code});return out.result;
}};
addEventListener('DOMContentLoaded',()=>{const box=document.createElement('div');box.style='padding:12px;background:#fff3cf;position:sticky;top:0;z-index:99';
box.innerHTML='<b>로컬 QA 전용 · 실제 자금 없음 · ${realProvider ? '실제 보고서 API' : '보고서 API 테스트 대역'} · IPFS 테스트 대역</b> <label>테스트 지갑 <select id="qaWallet"><option value="1">차주</option><option value="2">평가사</option><option value="3">은행</option><option value="4">미배정 사용자</option></select></label>';
document.body.prepend(box);document.getElementById('qaWallet').onchange=async e=>{qaAccount=Number(e.target.value);const accounts=await ethereum.request({method:'eth_accounts'});for(const fn of qaHandlers.accountsChanged||[])fn(accounts);setRole(({1:'borrower',2:'evaluator',3:'lender',4:'evaluator'})[qaAccount]);};});`;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/qa-wallet-rpc' || url.pathname === '/qa-chain-rpc') {
      let body = ''; for await (const chunk of req) body += chunk;
      const call = JSON.parse(body);
      let result;
      if (url.pathname === '/qa-wallet-rpc' && ['eth_accounts','eth_requestAccounts'].includes(call.method)) result = [signers[Number(call.account) || 1].address];
      else result = await connection.provider.request({ method: call.method, params: call.params || [] });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id || 1, result })); return;
    }
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const response = await fetch(apiUrl + url.pathname.slice(4) + url.search, { method: req.method,
        headers: { ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}) },
        ...(['GET','HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }),
      });
      res.writeHead(response.status, Object.fromEntries([...response.headers].filter(([k]) => !['content-length','transfer-encoding','connection','content-encoding'].includes(k))));
      res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    if (url.pathname === '/qa-wallet.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(walletScript); return; }
    const path = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    if (path.includes('..') || !(/^\/(index|patent|admin)\.html$/.test(path) || /^\/(js|css)\/[A-Za-z0-9_./-]+$/.test(path))) { res.writeHead(404); res.end(); return; }
    let bytes = await readFile(new URL('../..' + path, import.meta.url));
    if (path === '/index.html') bytes = Buffer.from(bytes.toString().replace('<head>', '<head><script src="/qa-wallet.js"></script>'));
    if (path === '/patent.html') bytes = Buffer.from(bytes.toString().replace('<head>', '<head><script>globalThis.IPLOAN_PATENT_API_BASE="/api/patent";</script>'));
    const type = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8';
    res.setHeader('Content-Type', type); res.end(bytes);
  } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: error.code || -32000, message: error.message } })); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const child = spawn(process.env.IPLOAN_TEST_PYTHON || (process.platform === 'win32' ? '../server/venv/Scripts/python.exe' : '../server/.venv/bin/python'), ['../server/integration_runner.py'], { env: { ...process.env,
  IPLOAN_RPC_URL: origin + '/qa-chain-rpc', IPLOAN_CHAIN_ID: '31337', IPLOAN_MANAGER_ADDRESS: await manager.getAddress(),
  IPLOAN_TEST_WORKFLOW_FIXTURE: realProvider ? '0' : '1', IPLOAN_TEST_REAL_PROVIDER: realProvider ? '1' : '0',
} });
child.stderr.on('data', data => process.stderr.write(data));
const startup = await new Promise((resolve, reject) => {
  let output = ''; child.stdout.on('data', data => { output += data; if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0])); });
  child.once('error', reject); child.once('exit', code => reject(new Error('Flask exited: ' + code)));
});
apiUrl = startup.url;
console.log(JSON.stringify({ url: origin, apiUrl, provider: realProvider ? 'real' : 'fixture', chain: 'ephemeral local EVM', ipfs: 'fixture' }));
async function close() { child.kill(); server.closeAllConnections(); server.close(); provider.destroy(); await connection.close(); process.exit(0); }
process.on('SIGTERM', close); process.on('SIGINT', close);
