import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { network } from 'hardhat';
import { BrowserProvider, ContractFactory, Contract, id } from 'ethers';
import { compile } from '../scripts/compile.mjs';

test('temporary Flask + actual local EVM: wallet login, LLM report registration, RWA loan agreement and repayments', { timeout: 120000 }, async t => {
  const connection=await network.connect('localTest');
  const provider=new BrowserProvider(connection.provider); provider.pollingInterval=10;
  t.after(async()=>{ provider.destroy(); await connection.close(); });
  const artifacts=compile();
  const [admin,borrower,evaluator,bank,outsider]=await Promise.all([0,1,2,3,4].map(i=>provider.getSigner(i)));
  const manager=await new ContractFactory(artifacts.IPLoanManager.abi,artifacts.IPLoanManager.bytecode,admin)
    .deploy(admin.address,evaluator.address,bank.address);
  await manager.waitForDeployment();
  await (await manager.grantRole(await manager.BORROWER_ROLE(),borrower.address)).wait();
  const rpc=http.createServer(async(req,res)=>{
    try {
      let body=''; for await(const chunk of req) body+=chunk;
      const call=JSON.parse(body);
      const result=await connection.provider.request({method:call.method,params:call.params});
      res.setHeader('content-type','application/json'); res.end(JSON.stringify({jsonrpc:'2.0',id:call.id,result}));
    } catch(e) { res.end(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:e.code||-32000,message:e.message,data:e.data}})); }
  });
  rpc.listen(0,'127.0.0.1'); await once(rpc,'listening');
  t.after(()=>{rpc.closeAllConnections();rpc.close();});
  const child=spawn('../server/.venv/bin/python',['../server/integration_runner.py'], {env:{...process.env,
    IPLOAN_RPC_URL:`http://127.0.0.1:${rpc.address().port}`,IPLOAN_CHAIN_ID:'31337',IPLOAN_MANAGER_ADDRESS:await manager.getAddress()}});
  t.after(()=>child.kill('SIGTERM'));
  let errors=''; child.stderr.on('data',c=>{errors+=c;});
  const startup=await new Promise((resolve,reject)=>{
    let output=''; child.stdout.on('data',c=>{output+=c; if(output.includes('\n'))resolve(JSON.parse(output.split('\n')[0]));});
    child.once('error',reject);child.once('exit',code=>{if(code)reject(new Error(errors));});
  });
  const tokens=new Map();
  async function login(signer) {
    if (!tokens.has(signer.address)) {
      const challenge=await (await fetch(startup.url+'/auth/challenge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({address:signer.address})})).json();
      const signature=await signer.signMessage(challenge.message);
      const response=await fetch(startup.url+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({address:signer.address,nonce:challenge.nonce,signature})});
      assert.equal(response.status,200); tokens.set(signer.address,(await response.json()).token);
    }
    return {Authorization:'Bearer '+tokens.get(signer.address)};
  }
  async function api(path, signer, body=null) {
    const headers=await login(signer);
    const options=body===null?{headers}:{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)};
    const response=await fetch(startup.url+path,options);
    return {response, data:await response.json()};
  }
  const cfg=await (await fetch(startup.url+'/chain/config')).json();
  assert.equal(cfg.chainId,31337);assert.equal(cfg.contractVersion,3);
  assert.deepEqual((await (await fetch(startup.url+'/auth/me',{headers:await login(evaluator)})).json()).roles,['evaluator']);
  assert.deepEqual((await (await fetch(startup.url+'/auth/me',{headers:await login(admin)})).json()).roles,['admin']);

  const form=new FormData();for(const[k,v]of Object.entries({company:'가상 통합테스트 기업',bizNo:'123-45-67890',ceo:'시연대표',contact:'010-0000-0000',amount:'70',termMonths:'24'}))form.append(k,v);
  const plaintext='%PDF-1.7\nlocal integration registry';
  form.append('registryDocument',new Blob([plaintext],{type:'application/pdf'}),'registry.pdf');
  form.append('patentDocument',new Blob(['%PDF-1.4\npatent gazette'],{type:'application/pdf'}),'gazette.pdf');
  assert.equal((await fetch(startup.url+'/applications',{method:'POST',body:form})).status,401);
  assert.equal((await fetch(startup.url+'/applications',{method:'POST',headers:await login(outsider),body:form})).status,403);
  const posted=await fetch(startup.url+'/applications',{method:'POST',headers:await login(borrower),body:form});assert.equal(posted.status,201);
  const application=await posted.json();assert.ok(application.appKey);assert.equal(application.evaluatorWallet,evaluator.address);assert.ok(!('bankWallet' in application));assert.equal(application.chainStatus,'None');
  assert.equal(application.borrowerWallet,borrower.address);assert.equal(application.evaluation.status,'completed');
  assert.ok(!('docKey'in application));assert.ok(!('docSalt'in application));
  assert.deepEqual((await api('/applications',outsider)).data,[]);
  const sync=async(signer=borrower)=>{const result=await api(`/applications/${application.id}/sync`,signer,{status:'approved',rwaTokenId:'999',repaidAmount:999});assert.equal(result.response.status,200,JSON.stringify(result.data));return result.data;};
  assert.equal((await sync()).chainStatus,'None');
  await (await manager.connect(borrower).submitApplication(application.appKey,application.docCid,application.docFileHash,70,application.evaluatorWallet)).wait();
  let state=await sync();assert.equal(state.chainStatus,'Evaluating');assert.equal(state.status,'evaluating');assert.equal(state.sbtTokenId,'1');assert.ok(!state.rwaTokenId);
  async function document(signer, expected) {
    const response=await fetch(startup.url+`/applications/${application.id}/document`,{headers:await login(signer)});
    assert.equal(response.status,expected);if(expected===200)assert.equal(await response.text(),plaintext);
  }
  await document(evaluator,200);await document(outsider,404);await document(borrower,403);
  assert.equal((await api(`/applications/${application.id}/evaluation-report`,borrower,{appraisedValue:100})).response.status,403);
  assert.equal(application.evaluation.valuation.ip_value_krw,100);
  assert.deepEqual(application.evaluation.financial_checks.map(c=>c.result),['pass','unknown','unknown','pass']);
  assert.equal((await api(`/applications/${application.id}/evaluation-report`,evaluator,{appraisedValue:101})).data.error,'note_required');
  const prepared=await api(`/applications/${application.id}/evaluation-report`,evaluator,{appraisedValue:100,note:'LLM 보고서 근거 확인'});assert.equal(prepared.response.status,201);
  const report=prepared.data;assert.equal(report.bankWallet,bank.address);
  const duplicate=await api(`/applications/${application.id}/evaluation-report`,evaluator,{appraisedValue:100});assert.equal(duplicate.data.cid,report.cid);assert.equal(duplicate.data.bankWallet,bank.address);
  await (await manager.connect(evaluator).confirmEvaluation(application.appKey,report.cid,report.hash,100,report.bankWallet)).wait();
  state=await sync(evaluator);assert.equal(state.chainStatus,'Eligible');assert.equal(state.status,'review');assert.equal(state.appraisedValue,100);await document(evaluator,403);
  const registered=await fetch(startup.url+`/applications/${application.id}/evaluation-report/document`,{headers:await login(bank)});
  assert.equal(registered.status,200);assert.match(await registered.text(),/^%PDF-1\.7\nLLM report job-/);
  const agreed=await api(`/applications/${application.id}/loan-terms`,bank,{creditGrade:'CC',rateBps:430,termMonths:24});assert.equal(agreed.response.status,201);
  await (await manager.connect(bank).finalApprove(application.appKey,agreed.data.termsHash)).wait();
  state=await sync(bank);assert.equal(state.chainStatus,'Approved');assert.equal(state.rwaTokenId,'1');
  assert.deepEqual([state.creditGrade,state.rateBps,state.approvedTermMonths,state.termsHash],['CC',430,24,agreed.data.termsHash]);await document(bank,200);
  const rwa=new Contract(cfg.rwaTokenAddress,artifacts.IPLoanRWAToken.abi,provider);assert.equal(await rwa.ownerOf(1),bank.address);
  // On chain only the hash: neither the stored record nor the token card carries the grade, rate or term.
  assert.equal((await manager.getApplication(application.appKey)).termsHash,agreed.data.termsHash);
  const meta=JSON.parse(Buffer.from((await rwa.tokenURI(1)).split(',')[1],'base64'));
  const svg=Buffer.from(meta.image.split(',')[1],'base64').toString();
  assert.equal(meta.termsHash,agreed.data.termsHash);assert.ok(!('creditGrade' in meta));assert.ok(!/CC|4\.30|24개월/.test(svg));
  const spoof=await fetch(startup.url+`/applications/${application.id}`,{method:'PATCH',headers:{...await login(bank),'Content-Type':'application/json'},body:JSON.stringify({status:'rejected'})});assert.equal(spoof.status,405);  // no client status writes; DELETE is admin-only
  await (await manager.connect(bank).recordRepayment(application.appKey,20,id('REF1'))).wait();state=await sync(bank);assert.equal(state.repaidAmount,20);
  await (await manager.connect(bank).recordRepayment(application.appKey,50,id('REF2'))).wait();state=await sync(bank);assert.equal(state.chainStatus,'Repaid');assert.equal(state.status,'repaid');assert.equal(state.repaidAmount,70);
  assert.equal(await provider.getBalance(await manager.getAddress()),0n);assert.equal(await rwa.ownerOf(1),bank.address);
});
