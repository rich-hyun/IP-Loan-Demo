import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { network } from 'hardhat';
import { BrowserProvider, ContractFactory, Contract, id, ZeroAddress } from 'ethers';
import { compile } from '../scripts/compile.mjs';

// Temporary Flask (restarted with different assignment settings on one temp DB) + actual local EVM.
test('multi-role: evaluator assigned at application, bank at passing evaluation; tampering, owners and revocation', { timeout: 240000 }, async t => {
  const connection=await network.connect('localTest');
  const provider=new BrowserProvider(connection.provider); provider.pollingInterval=10;
  t.after(async()=>{ provider.destroy(); await connection.close(); });
  const artifacts=compile();

  const [admin,borrower1,borrower2,evalA,evalB,bankA,bankB,outsider]=await Promise.all([0,1,2,3,4,5,6,7].map(i=>provider.getSigner(i)));
  const v2=await new ContractFactory(artifacts.IPLoanManager.abi,artifacts.IPLoanManager.bytecode,admin).deploy(admin.address,evalA.address,bankA.address);
  await v2.waitForDeployment();
  const [R,E,B]=await Promise.all(['BORROWER_ROLE','EVALUATOR_ROLE','BANK_ROLE'].map(r=>v2[r]()));
  for (const [role,s] of [[R,borrower1],[R,borrower2],[E,evalB],[B,bankB]]) await (await v2.grantRole(role,s.address)).wait();
  const sbt=new Contract(await v2.accessSBT(),artifacts.IPLoanAccessSBT.abi,provider), nft=new Contract(await v2.debtNFT(),artifacts.IPLoanDebtNFT.abi,provider);

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
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'iploan-multi-role-'));
  t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));

  let child=null, base=null;
  async function stop() { if (!child) return; const exited=once(child,'exit'); child.kill('SIGTERM'); await exited; child=null; }
  t.after(stop);
  async function start(manager, evaluator='', bank='') {
    await stop();
    child=spawn(process.env.IPLOAN_TEST_PYTHON || (process.platform === 'win32' ? '../server/venv/Scripts/python.exe' : '../server/.venv/bin/python'),['../server/integration_runner.py'],{env:{...process.env,
      IPLOAN_RPC_URL:`http://127.0.0.1:${rpc.address().port}`,IPLOAN_CHAIN_ID:'31337',IPLOAN_TEST_DATA_DIR:dataDir,
      IPLOAN_MANAGER_ADDRESS:await manager.getAddress(),IPLOAN_ASSIGNMENT_EVALUATOR:evaluator,IPLOAN_ASSIGNMENT_BANK:bank}});
    let errors=''; child.stderr.on('data',c=>{errors+=c;});
    base=(await new Promise((resolve,reject)=>{
      let output=''; child.stdout.on('data',c=>{output+=c; if(output.includes('\n'))resolve(JSON.parse(output.split('\n')[0]));});
      child.once('error',reject); child.once('exit',code=>{if(code)reject(new Error(errors));});
    })).url;
  }
  async function api(urlPath, body=null) {
    const options=body===null?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};
    const response=await fetch(base+urlPath,options);
    return {response, data:await response.json()};
  }
  const plaintexts={};
  async function apply(borrower, extra={}) {
    const form=new FormData();
    for (const [k,v] of Object.entries({company:'가상 다중담당 기업',bizNo:'123-45-67890',ceo:'시연대표',contact:'010-0000-0000',amount:'70',borrowerWallet:borrower.address,...extra})) form.append(k,v);
    const plaintext=`%PDF-1.7\nmulti-role ${Math.random()}`;
    form.append('registryDocument',new Blob([plaintext],{type:'application/pdf'}),'registry.pdf');
    const response=await fetch(base+'/applications',{method:'POST',body:form});
    const data=await response.json();
    if (response.status===201) plaintexts[data.id]=plaintext;
    return {response,data};
  }
  const sync=a=>api(`/applications/${a.id}/sync`,{status:'approved',evaluatorWallet:outsider.address,bankWallet:outsider.address});
  const synced=async(a,stage)=>{const r=await sync(a);assert.equal(r.response.status,200,JSON.stringify(r.data));assert.equal(r.data.chainStatus,stage);return r.data;};
  async function documentStatus(a, signer) {
    const challenge=(await api(`/applications/${a.id}/document-nonce`,{address:signer.address})).data;
    const signature=await signer.signMessage(challenge.message);
    const response=await fetch(base+`/applications/${a.id}/document`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...challenge,address:signer.address,signature})});
    if (response.status===200) assert.equal(await response.text(),plaintexts[a.id]);
    return response.status;
  }
  const prepare=(a,value=100,extra={})=>api(`/applications/${a.id}/evaluation-report`,{appraisedValue:value,summary:'공개 가상 시연 보고서',...extra});
  async function prepared(a,value=100,extra={}) { const r=await prepare(a,value,extra); assert.ok([200,201].includes(r.response.status),JSON.stringify(r.data)); return r.data; }
  async function confirm(a, evaluator, report, bank=report.bankWallet||ZeroAddress) {
    await (await v2.connect(evaluator).confirmEvaluation(a.appKey,report.cid,report.hash,report.appraisedValue,bank)).wait();
  }
  const submit=(a,borrower,evaluator=a.evaluatorWallet)=>v2.connect(borrower).submitApplication(a.appKey,a.docCid,a.docFileHash,70,evaluator).then(tx=>tx.wait());
  const signerOf=address=>[evalA,evalB,bankA,bankB,borrower1,borrower2].find(s=>s.address===address);
  const stored=async a=>(await api('/applications')).data.find(x=>x.id===a.id);
  async function reverts(promise, name, abi=artifacts.IPLoanManager.abi) {
    const selector=new Contract(await v2.getAddress(),abi).interface.getError(name).selector;
    await assert.rejects(promise,e=>e.revert?.name===name||JSON.stringify(e,(_,v)=>typeof v==='bigint'?String(v):v).includes(selector));
  }

  // Phase 1: specific evaluator/bank settings; client-supplied participant fields are ignored.
  await start(v2, evalB.address, bankB.address);
  let cfg=(await api('/chain/config')).data;
  assert.equal(cfg.contractVersion,2);
  assert.deepEqual(cfg.roleMembers,{BORROWER_ROLE:[borrower1.address,borrower2.address],EVALUATOR_ROLE:[evalA.address,evalB.address],BANK_ROLE:[bankA.address,bankB.address]});
  const L2=(await apply(borrower1,{evaluatorWallet:evalA.address,bankWallet:bankA.address})).data;
  assert.deepEqual([L2.evaluatorWallet,L2.managerAddress],[evalB.address,await v2.getAddress()]); assert.ok(!('bankWallet' in L2));
  let refused=await apply(outsider); assert.equal(refused.response.status,400); assert.equal(refused.data.error,'chain_not_ready');
  await submit(L2,borrower1);
  assert.equal((await synced(L2,'Evaluating')).bankWallet,undefined);
  const r2=await prepared(L2,100,{bankWallet:bankA.address}); assert.equal(r2.bankWallet,bankB.address);
  assert.equal((await prepared(L2)).bankWallet,bankB.address); assert.equal((await stored(L2)).bankWallet,bankB.address);
  // A failing draft gets no bank; the bank already prepared for this application is kept for a later passing draft.
  assert.equal((await prepared(L2,99)).bankWallet,null);

  // Phase 2: changed settings apply to new assignments only.
  await start(v2, evalA.address, bankA.address);
  const L3=(await apply(borrower2)).data, L4=(await apply(borrower2)).data;
  assert.deepEqual([L3.evaluatorWallet,L4.evaluatorWallet],[evalA.address,evalA.address]);
  assert.deepEqual([(await stored(L2)).evaluatorWallet,(await stored(L2)).bankWallet],[evalB.address,bankB.address]);
  assert.equal((await prepared(L2)).bankWallet,bankB.address);
  await submit(L3,borrower2);
  // Borrower bypasses the app and names another registered evaluator on chain.
  await submit(L4,borrower2,evalB.address);
  const s3=await synced(L3,'Evaluating'), s2=await synced(L2,'Evaluating');
  assert.equal(await sbt.ownerOf(s2.sbtTokenId),evalB.address); assert.equal(await sbt.ownerOf(s3.sbtTokenId),evalA.address);
  let bad=await sync(L4); assert.equal(bad.response.status,409); assert.equal(bad.data.error,'chain_verification_failed');
  assert.equal(await documentStatus(L4,evalB),403); assert.equal(await documentStatus(L4,evalA),403);
  assert.equal((await prepare(L4)).response.status,409);
  const r3=await prepared(L3); assert.equal(r3.bankWallet,bankA.address);

  // Phase 3: invalid settings are refused, never silently replaced (incl. borrower or evaluator as its own reviewer).
  for (const e of [outsider.address,bankA.address,'not-an-address']) {
    await start(v2, e, '');
    refused=await apply(borrower1); assert.equal(refused.response.status,400,JSON.stringify(refused.data)); assert.equal(refused.data.error,'chain_not_ready');
  }
  await (await v2.grantRole(E,borrower1.address)).wait();
  await start(v2, borrower1.address, '');
  refused=await apply(borrower1); assert.equal(refused.response.status,400); assert.equal(refused.data.error,'chain_not_ready');
  await (await v2.revokeRole(E,borrower1.address)).wait();
  await start(v2, evalA.address, evalB.address);
  const L8=(await apply(borrower1)).data; await submit(L8,borrower1);
  let failed=await prepare(L8); assert.equal(failed.response.status,409,JSON.stringify(failed.data));
  await (await v2.grantRole(B,evalA.address)).wait(); await (await v2.grantRole(B,borrower1.address)).wait();
  for (const b of [evalA.address,borrower1.address]) {
    await start(v2, '', b); failed=await prepare(L8); assert.equal(failed.response.status,409,JSON.stringify(failed.data));
  }
  await (await v2.revokeRole(B,evalA.address)).wait(); await (await v2.revokeRole(B,borrower1.address)).wait();
  assert.ok(!('bankWallet' in await stored(L8)));

  // Phase 4: random assignment (no setting); every chain transaction is signed by the assigned participant.
  await start(v2);
  for (let i=0;i<4;i++) assert.ok([evalA.address,evalB.address].includes((await apply(borrower1)).data.evaluatorWallet));
  const r8=await prepared(L8); assert.ok([bankA.address,bankB.address].includes(r8.bankWallet));
  // Evaluator bypasses the app and names the other registered bank on chain.
  const other=r8.bankWallet===bankA.address?bankB:bankA;
  await confirm(L8,evalA,r8,other.address);
  bad=await sync(L8); assert.equal(bad.response.status,409); assert.equal(bad.data.error,'chain_verification_failed');

  assert.equal(await documentStatus(L2,evalA),403); assert.equal(await documentStatus(L2,evalB),200);
  assert.equal(await documentStatus(L3,evalB),403); assert.equal(await documentStatus(L3,evalA),200);
  await reverts(v2.connect(evalA).confirmEvaluation.staticCall(L2.appKey,r2.cid,r2.hash,100,bankB.address),'WrongEvaluator');
  await confirm(L2,evalB,await prepared(L2)); await confirm(L3,evalA,r3);
  assert.equal((await synced(L2,'Eligible')).bankWallet,bankB.address); assert.equal((await synced(L3,'Eligible')).bankWallet,bankA.address);
  await reverts(v2.connect(bankA).finalApprove.staticCall(L2.appKey),'WrongBank');
  await (await v2.connect(bankB).finalApprove(L2.appKey)).wait(); await (await v2.connect(bankA).finalApprove(L3.appKey)).wait();
  const a2=await synced(L2,'Approved'), a3=await synced(L3,'Approved');
  assert.equal(await nft.ownerOf(a2.debtTokenId),bankB.address); assert.equal(await nft.ownerOf(a3.debtTokenId),bankA.address);
  assert.equal(await documentStatus(L2,bankA),403); assert.equal(await documentStatus(L2,bankB),200); assert.equal(await documentStatus(L3,bankA),200);
  await (await v2.connect(bankB).recordRepayment(L2.appKey,70,id('REF-L2'))).wait();
  assert.equal((await synced(L2,'Repaid')).repaidAmount,70);

  // A rule-rejected evaluation is confirmed with no bank and clears any bank prepared for an earlier draft.
  const L9=(await apply(borrower2)).data; await submit(L9,borrower2);
  await prepared(L9); const fail9=await prepared(L9,99); assert.equal(fail9.bankWallet,null);
  await confirm(L9,signerOf(L9.evaluatorWallet),fail9);
  assert.ok(!('bankWallet' in await synced(L9,'RuleRejected'))); assert.ok(!('bankWallet' in await stored(L9)));

  // Revocation: revoked participants lose execution and document access; recorded assignments stay fixed.
  await (await v2.revokeRole(B,bankA.address)).wait();
  await reverts(v2.connect(bankA).recordRepayment.staticCall(L3.appKey,1,id('REF-L3')),'AccessControlUnauthorizedAccount');
  assert.equal(await documentStatus(L3,bankA),403); assert.equal((await synced(L3,'Approved')).bankWallet,bankA.address);
  const L5=(await apply(borrower2)).data; await submit(L5,borrower2);
  assert.equal((await prepared(L5)).bankWallet,bankB.address);
  // A prepared bank that loses its role before the evaluator confirms is re-chosen from current holders.
  await (await v2.revokeRole(B,bankB.address)).wait(); await (await v2.grantRole(B,bankA.address)).wait();
  const r5=await prepared(L5); assert.equal(r5.bankWallet,bankA.address);
  await confirm(L5,signerOf(L5.evaluatorWallet),r5); assert.equal((await synced(L5,'Eligible')).bankWallet,bankA.address);
  const L6=(await apply(borrower1)).data; await submit(L6,borrower1);
  const evaluator6=signerOf(L6.evaluatorWallet);
  await (await v2.revokeRole(E,evaluator6.address)).wait();
  await reverts(v2.connect(evaluator6).confirmEvaluation.staticCall(L6.appKey,r5.cid,r5.hash,100,bankA.address),'AccessControlUnauthorizedAccount');
  assert.equal(await documentStatus(L6,evaluator6),403);
  cfg=(await api('/chain/config')).data;
  assert.ok(!cfg.roleMembers.EVALUATOR_ROLE.includes(evaluator6.address)); assert.deepEqual(cfg.roleMembers.BANK_ROLE,[bankA.address]);
  const L7=(await apply(borrower1)).data; assert.notEqual(L7.evaluatorWallet,evaluator6.address);
  // With no bank holder left, applications are still accepted but a passing evaluation cannot be prepared.
  await (await v2.revokeRole(B,bankA.address)).wait(); await submit(L7,borrower1);
  failed=await prepare(L7); assert.equal(failed.response.status,409); assert.ok(!('bankWallet' in await stored(L7)));
  assert.equal(await provider.getBalance(await v2.getAddress()),0n);
});
