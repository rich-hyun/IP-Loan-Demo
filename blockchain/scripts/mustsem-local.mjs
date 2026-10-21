/* Local UI/API for real Mustsem; never creates a local chain or signs transactions. */
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {JsonRpcProvider,Contract,isAddress} from 'ethers';

const root=fileURLToPath(new URL('../..',import.meta.url));
const bootstrap=process.argv.includes('--bootstrap');
const deploymentPath=path.join(root,'blockchain/deployments',bootstrap?'mustsem.json':'mustsem-https.json');
const deployment=JSON.parse(await readFile(deploymentPath,'utf8'));
const port=Number(process.env.IPLOAN_UI_PORT||8008);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid UI port');
const manager=bootstrap?'':deployment.managerAddress;
if(!bootstrap&&!isAddress(manager))throw Error('Invalid deployed Manager');
const rpc='https://block.mustree.kr';
const provider=new JsonRpcProvider(rpc);
if((await provider.getNetwork()).chainId!==7601n)throw Error('Mustsem chain ID mismatch');
if(!bootstrap){
  const abi=JSON.parse(await readFile(path.join(root,'blockchain/artifacts/IPLoanManager.json'),'utf8')).abi;
  const contract=new Contract(manager,abi,provider);
  if(await contract.contractVersion()!==2n||await contract.tokenMediaVersion()!==2n||await contract.tokenMediaGateway()!=='https://rwa-gw.mustree.kr/ipfs/')throw Error('HTTPS metadata contract verification failed');
}
provider.destroy();
const dataDir=path.join(root,'output/mustsem-https-local',bootstrap?'bootstrap':manager.toLowerCase());
await mkdir(dataDir,{recursive:true});
const child=spawn(process.env.IPLOAN_TEST_PYTHON||path.join(root,'server/venv/Scripts/python.exe'),[path.join(root,'server/local_runner.py')],{cwd:root,env:{...process.env,
  PYTHONUNBUFFERED:'1',IPLOAN_RPC_URL:rpc,IPLOAN_CHAIN_ID:'7601',IPLOAN_MANAGER_ADDRESS:manager,IPLOAN_ZERO_GAS_PRICE:'0',
  IPLOAN_ASSIGNMENT_EVALUATOR:deployment.initialEvaluator,IPLOAN_ASSIGNMENT_BANK:deployment.initialBank,
  IPLOAN_DB_PATH:path.join(dataDir,'iploan.db'),IPLOAN_PATENT_DB_PATH:path.join(dataDir,'patents.db'),IPLOAN_PATENT_UPLOAD_DIR:path.join(dataDir,'patent-uploads')}});
child.stderr.on('data',d=>process.stderr.write(d));
process.once('exit',()=>child.kill());
const api=await new Promise((resolve,reject)=>{let out='';child.stdout.on('data',d=>{out+=d;if(out.includes('\n')){try{resolve(JSON.parse(out.split('\n')[0]).url);}catch(e){reject(e);}}});child.once('error',reject);child.once('exit',c=>reject(Error('API exited '+c)));});
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname.startsWith('/api/')){
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>22*1024*1024)throw Error('Request too large');chunks.push(chunk);}
      const response=await fetch(api+url.pathname.slice(4)+url.search,{method:req.method,headers:req.headers['content-type']?{'Content-Type':req.headers['content-type']}:{},...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
      res.writeHead(response.status,Object.fromEntries([...response.headers].filter(([k])=>!['content-length','transfer-encoding','connection','content-encoding'].includes(k))));res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    const file=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname);
    if(file.includes('..')||!(/^\/(index|patent|admin)\.html$/.test(file)||/^\/(js|css)\/[A-Za-z0-9_./-]+$/.test(file)||/^\/blockchain\/artifacts\/IPLoan(Manager|AccessSBT|DebtNFT)\.json$/.test(file))){res.writeHead(404);res.end();return;}
    let data=await readFile(path.join(root,file.slice(1)));
    if(file.endsWith('.html'))data=Buffer.from(data.toString().replace('<head>',`<head><script>globalThis.IPLOAN_API_BASE='/api';globalThis.IPLOAN_PATENT_API_BASE='/api/patent';addEventListener('DOMContentLoaded',()=>{const b=document.createElement('div');b.style='padding:10px;background:#e2f4e8';b.textContent='실제 Mustsem 7601 · ${bootstrap?'신규 HTTPS 계약 배포 준비':manager} · 실제 IPFS·평가 API';document.body.prepend(b);});</script>`));
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html; charset=utf-8');res.end(data);
  }catch(error){res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({message:error.message}));}
});
let stopping=false;function close(){if(stopping)return;stopping=true;child.kill();server.closeAllConnections();server.close();}
process.once('SIGINT',()=>{close();process.exit(0);});process.once('SIGTERM',()=>{close();process.exit(0);});child.once('exit',()=>{if(!stopping){close();process.exit(1);}});
server.once('error',error=>{console.error(error.message);close();process.exitCode=1;});
server.listen(port,'127.0.0.1');await once(server,'listening');
const info={url:`http://127.0.0.1:${port}`,adminUrl:`http://127.0.0.1:${port}/admin.html`,api,rpcUrl:rpc,chainId:7601,manager,dataDir,bootstrap};
await writeFile(path.join(dataDir,'local-config.json'),JSON.stringify(info,null,2));console.log(JSON.stringify(info));
