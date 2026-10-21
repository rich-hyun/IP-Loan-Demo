/* Attach upgraded web/API code to a running local-real chain without resetting its DB. */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cfg = JSON.parse(await readFile(path.join(root, 'output/local-real/latest.json'), 'utf8'));
const port = Number(process.env.IPLOAN_UI_PORT || 8004);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid UI port');
if (cfg.chainId !== 31337 || !cfg.rpcUrl.startsWith('http://127.0.0.1:')) throw new Error('Only an existing local-real development session may be attached');
const check = await fetch(cfg.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}) }).then(r=>r.json());
if (check.result !== '0x7a69') throw new Error('Local chain unavailable; do not start a replacement chain with an old DB');
const child = spawn(process.env.IPLOAN_TEST_PYTHON || path.join(root, 'server/venv/Scripts/python.exe'), [path.join(root, 'server/local_runner.py')], { cwd: root, env: { ...process.env,
  PYTHONUNBUFFERED: '1', IPLOAN_RPC_URL: cfg.rpcUrl, IPLOAN_CHAIN_ID: String(cfg.chainId), IPLOAN_MANAGER_ADDRESS: cfg.manager,
  IPLOAN_ASSIGNMENT_EVALUATOR: cfg.roles.evaluator, IPLOAN_ASSIGNMENT_BANK: cfg.roles.bank,
  IPLOAN_DB_PATH: path.join(cfg.dataDir, 'iploan.db'), IPLOAN_PATENT_DB_PATH: path.join(cfg.dataDir, 'patents.db'), IPLOAN_PATENT_UPLOAD_DIR: path.join(cfg.dataDir, 'patent-uploads') } });
child.stderr.on('data', d=>process.stderr.write(d));
process.once('exit', () => child.kill());
const api = await new Promise((resolve,reject)=>{
  let out=''; child.stdout.on('data',d=>{out+=d; if(out.includes('\n')) { try {resolve(JSON.parse(out.split('\n')[0]).url);} catch(e){reject(e);} }});
  child.once('error',reject); child.once('exit',c=>reject(new Error('API exited '+c)));
});
// Validate saved application bindings before serving the shared database.
const applications = await fetch(api+'/applications').then(r=>r.json());
for (const app of applications.filter(a=>a.appKey)) {
  const response = await fetch(api+`/applications/${encodeURIComponent(app.id)}/tokens`);
  if (!response.ok) { child.kill(); throw new Error('Saved application does not match the running chain: '+app.id); }
}
const server = http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname.startsWith('/api/')) {
      const chunks=[]; let size=0; for await(const chunk of req) { size+=chunk.length; if(size>22*1024*1024)throw new Error('Request too large'); chunks.push(chunk); }
      const response=await fetch(api+url.pathname.slice(4)+url.search,{method:req.method,headers:req.headers['content-type']?{'Content-Type':req.headers['content-type']}:{},...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
      res.writeHead(response.status,Object.fromEntries([...response.headers].filter(([k])=>!['content-length','transfer-encoding','connection','content-encoding'].includes(k)))); res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    const file=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname);
    if(file.includes('..')||!(/^\/(index|patent|admin)\.html$/.test(file)||/^\/(js|css)\/[A-Za-z0-9_./-]+$/.test(file))){res.writeHead(404);res.end();return;}
    let data=await readFile(path.join(root,file.slice(1)));
    if(file.endsWith('.html'))data=Buffer.from(data.toString().replace('<head>','<head><script>globalThis.IPLOAN_API_BASE="/api";globalThis.IPLOAN_PATENT_API_BASE="/api/patent";</script>'));
    res.setHeader('Cache-Control','no-store'); res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.end(data);
  }catch(error){res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({message:error.message}));}
});
server.listen(port,'127.0.0.1'); await once(server,'listening');
console.log(JSON.stringify({url:`http://127.0.0.1:${port}`,attachedRpc:cfg.rpcUrl,dataDir:cfg.dataDir,wallet:'real MetaMask',ipfs:'real',preservedExistingChain:true}));
let stopping=false;
function close(){if(stopping)return;stopping=true;child.kill();server.closeAllConnections();server.close();}
process.once('SIGINT',()=>{close();process.exit(0);});process.once('SIGTERM',()=>{close();process.exit(0);});
child.once('exit',()=>{if(!stopping){close();process.exit(1);}});
