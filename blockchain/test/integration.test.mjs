import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { network } from 'hardhat';
import { BrowserProvider, ContractFactory, Contract, id } from 'ethers';
import { compile } from '../scripts/compile.mjs';

test('temporary Flask + actual local EVM: encrypted upload, SBT access, evaluation, bank NFT and repayments', { timeout: 120000 }, async t => {
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
  const child=spawn(process.env.IPLOAN_TEST_PYTHON || (process.platform === 'win32' ? '../server/venv/Scripts/python.exe' : '../server/.venv/bin/python'),['../server/integration_runner.py'], {env:{...process.env,
    IPLOAN_RPC_URL:`http://127.0.0.1:${rpc.address().port}`,IPLOAN_CHAIN_ID:'31337',IPLOAN_MANAGER_ADDRESS:await manager.getAddress()}});
  t.after(()=>child.kill('SIGTERM'));
  let errors=''; child.stderr.on('data',c=>{errors+=c;});
  const startup=await new Promise((resolve,reject)=>{
    let output=''; child.stdout.on('data',c=>{output+=c; if(output.includes('\n'))resolve(JSON.parse(output.split('\n')[0]));});
    child.once('error',reject);child.once('exit',code=>{if(code)reject(new Error(errors));});
  });
  async function api(path, body=null) {
    const options=body===null?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};
    const response=await fetch(startup.url+path,options);
    return {response, data:await response.json()};
  }
  const cfg=(await api('/chain/config')).data;
  assert.equal(cfg.chainId,31337);assert.equal(cfg.contractVersion,2);
  const form=new FormData();for(const[k,v]of Object.entries({company:'가상 통합테스트 기업',bizNo:'123-45-67890',ceo:'시연대표',contact:'010-0000-0000',amount:'70',borrowerWallet:borrower.address}))form.append(k,v);
  const plaintext='%PDF-1.7\nlocal integration registry';
  form.append('registryDocument',new Blob([plaintext],{type:'application/pdf'}),'registry.pdf');
  const posted=await fetch(startup.url+'/applications',{method:'POST',body:form});assert.equal(posted.status,201);
  const application=await posted.json();assert.ok(application.appKey);assert.equal(application.evaluatorWallet,evaluator.address);assert.ok(!('bankWallet' in application));assert.equal(application.chainStatus,'None');
  assert.ok(!('docKey'in application));assert.ok(!('docSalt'in application));
  const sync=async()=>{const result=await api(`/applications/${application.id}/sync`,{status:'approved',debtTokenId:'999',repaidAmount:999});assert.equal(result.response.status,200,JSON.stringify(result.data));return result.data;};
  assert.equal((await sync()).chainStatus,'None');
  await (await manager.connect(borrower).submitApplication(application.appKey,application.docCid,application.docFileHash,70,application.evaluatorWallet)).wait();
  let state=await sync();assert.equal(state.chainStatus,'Evaluating');assert.equal(state.status,'evaluating');assert.equal(state.sbtTokenId,'1');assert.ok(!state.debtTokenId);
  async function document(signer, expected) {
    const challenge=(await api(`/applications/${application.id}/document-nonce`,{address:signer.address})).data;
    const signature=await signer.signMessage(challenge.message);
    const response=await fetch(startup.url+`/applications/${application.id}/document`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...challenge,address:signer.address,signature})});
    assert.equal(response.status,expected);if(expected===200)assert.equal(await response.text(),plaintext);
    return {challenge,signature};
  }
  const proof=await document(evaluator,200);await document(outsider,403);
  const reused=await fetch(startup.url+`/applications/${application.id}/document`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...proof.challenge,address:evaluator.address,signature:proof.signature})});
  assert.equal(reused.status,403);
  const prepared=await api(`/applications/${application.id}/evaluation-report`,{appraisedValue:100,summary:'공개 가상 시연 보고서'});assert.equal(prepared.response.status,201);
  const report=prepared.data;assert.equal(report.bankWallet,bank.address);
  const duplicate=await api(`/applications/${application.id}/evaluation-report`,{appraisedValue:100,summary:'공개 가상 시연 보고서'});assert.equal(duplicate.data.cid,report.cid);assert.equal(duplicate.data.bankWallet,bank.address);
  await (await manager.connect(evaluator).confirmEvaluation(application.appKey,report.cid,report.hash,100,report.bankWallet)).wait();
  state=await sync();assert.equal(state.chainStatus,'Eligible');assert.equal(state.appraisedValue,100);await document(evaluator,403);
  await (await manager.connect(bank).finalApprove(application.appKey)).wait();
  state=await sync();assert.equal(state.chainStatus,'Approved');assert.equal(state.debtTokenId,'1');await document(bank,200);
  const nft=new Contract(cfg.debtNFTAddress,artifacts.IPLoanDebtNFT.abi,provider);assert.equal(await nft.ownerOf(1),bank.address);
  const spoof=await fetch(startup.url+`/applications/${application.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'rejected'})});assert.equal(spoof.status,409);
  await (await manager.connect(bank).recordRepayment(application.appKey,20,id('REF1'))).wait();state=await sync();assert.equal(state.repaidAmount,20);
  await (await manager.connect(bank).recordRepayment(application.appKey,50,id('REF2'))).wait();state=await sync();assert.equal(state.chainStatus,'Repaid');assert.equal(state.repaidAmount,70);
  assert.equal(await provider.getBalance(await manager.getAddress()),0n);assert.equal(await nft.ownerOf(1),bank.address);
});
