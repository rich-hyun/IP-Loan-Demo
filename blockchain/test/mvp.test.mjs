import { test } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { BrowserProvider, ContractFactory, Contract, Interface, id, ZeroAddress, ZeroHash } from 'ethers';
import { compile } from '../scripts/compile.mjs';
const artifacts = compile();
const cid = 'bafybeigdyrzt1234567890', reportCid = 'bafybeireport1234567890', hash = id('salted document'), reportHash = id('report');
const appKey = id('LN-2026-0011');
// Token cards are server-drawn PNG/JSON on IPFS; the contract only accepts the fixed HTTPS gateway with a CID.
const gateway = 'https://rwa-gw.mustree.kr/ipfs/', sbtUri = gateway + 'bafkreisbtcard0000001', rwaUri = gateway + 'bafkreirwacard0000001';
async function fixture(t) {
  const connection = await network.connect('localTest');
  const provider = new BrowserProvider(connection.provider); provider.pollingInterval = 10;
  t.after(async () => { provider.destroy(); await connection.close(); });
  const [admin, borrower, evaluator, bank, outsider] = await Promise.all([0,1,2,3,4].map(i => provider.getSigner(i)));
  const manager = await new ContractFactory(artifacts.IPLoanManager.abi, artifacts.IPLoanManager.bytecode, admin)
    .deploy(admin.address, evaluator.address, bank.address);
  await manager.waitForDeployment();
  await (await manager.grantRole(await manager.BORROWER_ROLE(), borrower.address)).wait();
  const sbt = new Contract(await manager.accessSBT(), artifacts.IPLoanAccessSBT.abi, provider);
  const nft = new Contract(await manager.rwaToken(), artifacts.IPLoanRWAToken.abi, provider);
  return { provider, admin, borrower, evaluator, bank, outsider, manager, sbt, nft };
}
async function submit(f, key=appKey, amount=70n) {
  return (await f.manager.connect(f.borrower).submitApplication(key, cid, hash, amount, f.evaluator.address, sbtUri)).wait();
}
async function evaluate(f, value=100n, key=appKey, bank=f.bank.address) {
  return (await f.manager.connect(f.evaluator).confirmEvaluation(key, reportCid, reportHash, value, bank)).wait();
}
const terms = [id('salted loan terms'), rwaUri];
async function approve(f, key=appKey) {
  return (await f.manager.connect(f.bank).finalApprove(key, ...terms)).wait();
}
async function revert(promise, name, artifact='IPLoanManager') {
  const selector = new Interface(artifacts[artifact].abi).getError(name).selector;
  await assert.rejects(promise, e => {
    assert.ok(e.revert?.name === name || JSON.stringify(e, (_,v) => typeof v==='bigint' ? String(v) : v).includes(selector), e.message);
    return true;
  });
}
test('submission creates record and evaluator SBT but no RWA token', async t => {
  const f = await fixture(t); const receipt = await submit(f);
  const a = await f.manager.getApplication(appKey);
  assert.equal(a.borrower, f.borrower.address); assert.equal(a.docCid, cid); assert.equal(a.fileHash, hash);
  assert.equal(a.amount, 70n); assert.equal(a.status, 1n); assert.equal(await f.sbt.ownerOf(a.tokenId), f.evaluator.address);
  assert.equal(await f.sbt.locked(a.tokenId), true); assert.equal(await f.sbt.supportsInterface('0xb45a3c0e'), true);
  assert.equal(await f.nft.balanceOf(f.bank.address), 0n);
  assert.equal(receipt.logs.filter(l=>l.topics[0]===id('Transfer(address,address,uint256)')).length, 1);
  assert.equal(a.sbtUri, sbtUri); assert.equal(await f.sbt.tokenURI(a.tokenId), sbtUri);
});
test('wrong role and malformed submission cannot create application', async t => {
  const f = await fixture(t);
  await revert(f.manager.connect(f.outsider).submitApplication.staticCall(appKey,cid,hash,70,f.evaluator.address,sbtUri), 'AccessControlUnauthorizedAccount');
  for (const args of [[ZeroHash,cid,hash,70],[appKey,'invalid"CID',hash,70],[appKey,cid,ZeroHash,70],[appKey,cid,hash,0]])
    await revert(f.manager.connect(f.borrower).submitApplication.staticCall(...args,f.evaluator.address,sbtUri),'InvalidInput');
  // Only <gateway><CID>: other hosts, plain http, ipfs://, paths, queries and short CIDs are refused.
  for (const uri of ['', gateway, 'https://evil.example/ipfs/bafkreisbtcard0000001', 'http://rwa-gw.mustree.kr/ipfs/bafkreisbtcard0000001',
    'ipfs://bafkreisbtcard0000001', sbtUri + '/x', sbtUri + '?a=1', gateway + 'short', gateway + '"><svg>0000000'])
    await revert(f.manager.connect(f.borrower).submitApplication.staticCall(appKey,cid,hash,70,f.evaluator.address,uri),'InvalidInput');
  assert.equal((await f.manager.getApplication(appKey)).status, 0n); assert.equal(await f.manager.nextTokenId(),1n);
});
test('same application can be submitted only once', async t => {
  const f=await fixture(t); await submit(f);
  await revert(f.manager.connect(f.borrower).submitApplication.staticCall(appKey,cid,hash,70,f.evaluator.address,sbtUri),'AlreadySubmitted');
  assert.equal(await f.manager.nextTokenId(),2n);
});
test('evaluation confirmation burns SBT and performs boundary LTV rule in same transaction', async t => {
  const f=await fixture(t); await submit(f); const receipt=await evaluate(f);
  const a=await f.manager.getApplication(appKey); assert.equal(a.status,2n); assert.equal(a.appraisedValue,100n);
  assert.equal(a.reportCid,reportCid); assert.equal(a.reportHash,reportHash);
  await revert(f.sbt.ownerOf(1),'ERC721NonexistentToken','IPLoanAccessSBT');
  assert.equal(await f.nft.balanceOf(f.bank.address),0n);
  assert.ok(receipt.logs.some(l=>l.topics[0]===id('EvaluationConfirmed(bytes32,string,bytes32,uint256,bool,address)')));
});
test('only assigned evaluator can confirm even if another address was granted evaluator role', async t => {
  const f=await fixture(t); await submit(f);
  await revert(f.manager.connect(f.borrower).confirmEvaluation.staticCall(appKey,reportCid,reportHash,100,f.bank.address),'AccessControlUnauthorizedAccount');
  await (await f.manager.grantRole(await f.manager.EVALUATOR_ROLE(),f.outsider.address)).wait();
  await revert(f.manager.connect(f.outsider).confirmEvaluation.staticCall(appKey,reportCid,reportHash,100,f.bank.address),'WrongEvaluator');
  assert.equal(await f.sbt.ownerOf(1),f.evaluator.address);
});
test('automatic rejection removes SBT and prevents final approval/NFT', async t => {
  const f=await fixture(t); await submit(f,appKey,71n);
  await revert(f.manager.connect(f.evaluator).confirmEvaluation.staticCall(appKey,reportCid,reportHash,100,f.bank.address),'InvalidInput');
  await evaluate(f,100n,appKey,ZeroAddress); assert.equal((await f.manager.getApplication(appKey)).bank,ZeroAddress);
  assert.equal((await f.manager.getApplication(appKey)).status,3n);
  await revert(f.manager.connect(f.bank).finalApprove.staticCall(appKey,...terms),'WrongStage');
  assert.equal(await f.sbt.balanceOf(f.evaluator.address),0n); assert.equal(await f.nft.balanceOf(f.bank.address),0n);
});
test('only assigned bank/reviewer may approve; RWA token is minted to that same address', async t => {
  const f=await fixture(t); await submit(f); await evaluate(f);
  await revert(f.manager.connect(f.borrower).finalApprove.staticCall(appKey,...terms),'AccessControlUnauthorizedAccount');
  await (await f.manager.grantRole(await f.manager.BANK_ROLE(),f.outsider.address)).wait();
  await revert(f.manager.connect(f.outsider).finalApprove.staticCall(appKey,...terms),'WrongBank');
  await approve(f);
  assert.equal(await f.nft.ownerOf(1),f.bank.address); assert.equal((await f.manager.getApplication(appKey)).status,4n);
  await revert(f.manager.connect(f.bank).finalApprove.staticCall(appKey,...terms),'WrongStage');
});
test('final approval fixes only the hash of the confidential loan terms, with the RWA token', async t => {
  const f=await fixture(t); await submit(f); await evaluate(f);
  const termsHash=id('salt + BB+ 4.15% 24 months');
  for (const [hash_, uri] of [[ZeroHash,rwaUri],[termsHash,''],[termsHash,'ipfs://bafkreirwacard0000001'],[termsHash,rwaUri+'/x']])
    await revert(f.manager.connect(f.bank).finalApprove.staticCall(appKey,hash_,uri),'InvalidInput');
  const receipt=await (await f.manager.connect(f.bank).finalApprove(appKey,termsHash,rwaUri)).wait();
  const a=await f.manager.getApplication(appKey);
  assert.equal(a.termsHash,termsHash); assert.equal(a.rwaUri,rwaUri); assert.equal(a.sbtUri,sbtUri);
  assert.equal(a.approvedAt,BigInt((await f.provider.getBlock(receipt.blockNumber)).timestamp));
  const event=receipt.logs.map(l=>{try{return f.manager.interface.parseLog(l);}catch{return null;}}).find(e=>e?.name==='FinalApproved');
  assert.deepEqual([event.args.termsHash,event.args.rwaTokenId],[termsHash,1n]);
  assert.equal(await f.nft.tokenURI(1),rwaUri);
  assert.equal(await f.nft.name(),'IP Loan RWA Token'); assert.equal(await f.nft.symbol(),'IPRWA');
  // Runtime code stays under EIP-170, the one deploy transaction under EIP-3860 and Mustsem's 30M block gas limit.
  assert.ok((await f.provider.getCode(await f.manager.getAddress())).length/2-1 <= 24576);
  assert.ok((artifacts.IPLoanManager.bytecode.length-2)/2 <= 49152);
  const deployment=await f.provider.getTransactionReceipt(f.manager.deploymentTransaction().hash);
  assert.ok(deployment.gasUsed < 15_000_000n, String(deployment.gasUsed));
});
test('bank final rejection creates no RWA token and cannot be reversed to approval', async t => {
  const f=await fixture(t); await submit(f); await evaluate(f);
  await (await f.manager.connect(f.bank).finalReject(appKey)).wait();
  assert.equal((await f.manager.getApplication(appKey)).status,5n);
  await revert(f.manager.connect(f.bank).finalApprove.staticCall(appKey,...terms),'WrongStage');
  assert.equal(await f.nft.balanceOf(f.bank.address),0n);
});
test('SBT transfer and direct token mint/burn are forbidden', async t => {
  const f=await fixture(t); await submit(f);
  await revert(f.sbt.connect(f.evaluator).transferFrom.staticCall(f.evaluator.address,f.bank.address,1),'Soulbound','IPLoanAccessSBT');
  await revert(f.sbt.connect(f.evaluator).burn.staticCall(1),'ManagerOnly','IPLoanAccessSBT');
  await revert(f.nft.connect(f.bank).mint.staticCall(f.bank.address,1),'ManagerOnly','IPLoanRWAToken');
});
test('partial and full repayment update record and metadata while keeping bank NFT; no funds moved into contract', async t => {
  const f=await fixture(t); await submit(f); await evaluate(f); await approve(f);
  await (await f.manager.connect(f.bank).recordRepayment(appKey,20,id('REP-1'))).wait();
  let a=await f.manager.getApplication(appKey); assert.equal(a.repaidAmount,20n); assert.equal(a.status,4n);
  await (await f.manager.connect(f.bank).recordRepayment(appKey,50,id('REP-2'))).wait();
  a=await f.manager.getApplication(appKey); assert.equal(a.repaidAmount,70n); assert.equal(a.status,6n);
  assert.equal(await f.nft.ownerOf(1),f.bank.address); assert.equal(await f.provider.getBalance(await f.manager.getAddress()),0n);
  assert.equal(await f.nft.tokenURI(1),rwaUri);  // the card is fixed at approval; repayments live in the record
  assert.equal((await f.manager.queryFilter(f.manager.filters.RepaymentRecorded())).length,2);
});
test('duplicate, overpayment, zero and wrong-wallet repayments are rejected', async t => {
  const f=await fixture(t); await submit(f); await evaluate(f); await approve(f);
  await (await f.manager.connect(f.bank).recordRepayment(appKey,20,id('REP-1'))).wait();
  await revert(f.manager.connect(f.bank).recordRepayment.staticCall(appKey,1,id('REP-1')),'DuplicateRepayment');
  await revert(f.manager.connect(f.bank).recordRepayment.staticCall(appKey,51,id('REP-2')),'InvalidInput');
  await revert(f.manager.connect(f.bank).recordRepayment.staticCall(appKey,0,id('REP-2')),'InvalidInput');
  await revert(f.manager.connect(f.borrower).recordRepayment.staticCall(appKey,1,id('REP-2')),'AccessControlUnauthorizedAccount');
  assert.equal((await f.manager.getApplication(appKey)).repaidAmount,20n);
});
test('revoked evaluator cannot act and earlier stages cannot approve or repay', async t => {
  const f=await fixture(t); await submit(f);
  await revert(f.manager.connect(f.bank).finalApprove.staticCall(appKey,...terms),'WrongStage');
  await revert(f.manager.connect(f.bank).recordRepayment.staticCall(appKey,1,id('R')),'WrongStage');
  await (await f.manager.revokeRole(await f.manager.EVALUATOR_ROLE(),f.evaluator.address)).wait();
  await revert(f.manager.connect(f.evaluator).confirmEvaluation.staticCall(appKey,reportCid,reportHash,100,f.bank.address),'AccessControlUnauthorizedAccount');
});
test('submission fixes only the evaluator; bank stays unassigned until evaluation', async t => {
  const f=await fixture(t); const E=await f.manager.EVALUATOR_ROLE();
  assert.equal(await f.manager.contractVersion(),3n);
  const call=e=>f.manager.connect(f.borrower).submitApplication.staticCall(appKey,cid,hash,70,e,sbtUri);
  await revert(call(ZeroAddress),'InvalidInput');
  await (await f.manager.grantRole(E,f.borrower.address)).wait(); await revert(call(f.borrower.address),'InvalidInput');
  await revert(call(f.bank.address),'WrongEvaluator'); await revert(call(f.outsider.address),'WrongEvaluator');
  assert.equal((await f.manager.getApplication(appKey)).status,0n); assert.equal(await f.manager.nextTokenId(),1n);
  const receipt=await submit(f); const a=await f.manager.getApplication(appKey);
  assert.equal(a.evaluator,f.evaluator.address); assert.equal(a.bank,ZeroAddress);
  const event=receipt.logs.map(l=>{try{return f.manager.interface.parseLog(l);}catch{return null;}}).find(e=>e?.name==='Submitted');
  assert.equal(event.args.evaluator,f.evaluator.address);
  await revert(f.manager.connect(f.bank).finalApprove.staticCall(appKey,...terms),'WrongStage');
});
test('passing evaluation must name a registered bank that is neither evaluator nor borrower', async t => {
  const f=await fixture(t); const [E,B]=[await f.manager.EVALUATOR_ROLE(),await f.manager.BANK_ROLE()]; await submit(f);
  const call=b=>f.manager.connect(f.evaluator).confirmEvaluation.staticCall(appKey,reportCid,reportHash,100,b);
  await revert(call(ZeroAddress),'InvalidInput'); await revert(call(f.outsider.address),'WrongBank'); await revert(call(f.borrower.address),'InvalidInput');
  await (await f.manager.grantRole(B,f.evaluator.address)).wait(); await revert(call(f.evaluator.address),'InvalidInput');
  await (await f.manager.grantRole(B,f.borrower.address)).wait(); await revert(call(f.borrower.address),'InvalidInput');
  await (await f.manager.grantRole(E,f.outsider.address)).wait(); await revert(call(f.outsider.address),'WrongBank');
  const receipt=await evaluate(f); const a=await f.manager.getApplication(appKey);
  assert.equal(a.bank,f.bank.address); assert.equal(a.status,2n);
  const event=receipt.logs.map(l=>{try{return f.manager.interface.parseLog(l);}catch{return null;}}).find(e=>e?.name==='EvaluationConfirmed');
  assert.equal(event.args.bank,f.bank.address); assert.equal(event.args.eligible,true);
});
test('admin enumerates, grants and revokes several holders per role; only admin may change roles', async t => {
  const f=await fixture(t); const [e2,b2,r2]=await Promise.all([5,6,7].map(i=>f.provider.getSigner(i)));
  const members=async role=>{const n=await f.manager.getRoleMemberCount(role);return Promise.all([...Array(Number(n)).keys()].map(i=>f.manager.getRoleMember(role,i)));};
  const [E,B,R]=await Promise.all([f.manager.EVALUATOR_ROLE(),f.manager.BANK_ROLE(),f.manager.BORROWER_ROLE()]);
  for (const [role,s] of [[E,e2],[B,b2],[R,r2]]) await (await f.manager.grantRole(role,s.address)).wait();
  assert.deepEqual(await members(E),[f.evaluator.address,e2.address]); assert.deepEqual(await members(B),[f.bank.address,b2.address]);
  assert.deepEqual(await members(R),[f.borrower.address,r2.address]);
  await revert(f.manager.connect(f.outsider).grantRole.staticCall(E,f.outsider.address),'AccessControlUnauthorizedAccount');
  await revert(f.manager.connect(f.bank).revokeRole.staticCall(E,e2.address),'AccessControlUnauthorizedAccount');
  await (await f.manager.revokeRole(R,f.borrower.address)).wait(); await (await f.manager.revokeRole(E,f.evaluator.address)).wait();
  assert.deepEqual(await members(R),[r2.address]); assert.deepEqual(await members(E),[e2.address]);
  await revert(f.manager.connect(f.borrower).submitApplication.staticCall(appKey,cid,hash,70,e2.address,sbtUri),'AccessControlUnauthorizedAccount');
  await revert(f.manager.connect(r2).submitApplication.staticCall(appKey,cid,hash,70,f.evaluator.address,sbtUri),'WrongEvaluator');
  await (await f.manager.connect(r2).submitApplication(appKey,cid,hash,70,e2.address,sbtUri)).wait();
});
test('two applications keep their own evaluator, bank, SBT and RWA token owners', async t => {
  const f=await fixture(t); const [e2,b2]=await Promise.all([5,6].map(i=>f.provider.getSigner(i)));
  await (await f.manager.grantRole(await f.manager.EVALUATOR_ROLE(),e2.address)).wait(); await (await f.manager.grantRole(await f.manager.BANK_ROLE(),b2.address)).wait();
  const key2=id('LN-2026-0012'); await submit(f);
  await (await f.manager.connect(f.borrower).submitApplication(key2,cid,hash,70,e2.address,sbtUri)).wait();
  assert.equal(await f.sbt.ownerOf((await f.manager.getApplication(appKey)).tokenId),f.evaluator.address);
  assert.equal(await f.sbt.ownerOf((await f.manager.getApplication(key2)).tokenId),e2.address);
  await revert(f.manager.connect(e2).confirmEvaluation.staticCall(appKey,reportCid,reportHash,100,b2.address),'WrongEvaluator');
  await revert(f.manager.connect(f.evaluator).confirmEvaluation.staticCall(key2,reportCid,reportHash,100,f.bank.address),'WrongEvaluator');
  await evaluate(f); await (await f.manager.connect(e2).confirmEvaluation(key2,reportCid,reportHash,100,b2.address)).wait();
  const [a1,a2]=[await f.manager.getApplication(appKey),await f.manager.getApplication(key2)];
  assert.deepEqual([a1.evaluator,a1.bank,a2.evaluator,a2.bank],[f.evaluator.address,f.bank.address,e2.address,b2.address]);
  await revert(f.manager.connect(b2).finalApprove.staticCall(appKey,...terms),'WrongBank'); await revert(f.manager.connect(f.bank).finalApprove.staticCall(key2,...terms),'WrongBank');
  await (await f.manager.connect(f.bank).finalApprove(appKey,...terms)).wait(); await (await f.manager.connect(b2).finalApprove(key2,...terms)).wait();
  assert.equal(await f.nft.ownerOf(a1.tokenId),f.bank.address); assert.equal(await f.nft.ownerOf(a2.tokenId),b2.address);
  await revert(f.manager.connect(f.bank).recordRepayment.staticCall(key2,1,id('R')),'WrongBank');
  await (await f.manager.connect(b2).recordRepayment(key2,70,id('R'))).wait(); assert.equal((await f.manager.getApplication(key2)).status,6n);
});
test('bank revoked before evaluation cannot be assigned; revoked assigned bank cannot approve or repay', async t => {
  const f=await fixture(t); const b2=await f.provider.getSigner(6); const B=await f.manager.BANK_ROLE();
  await (await f.manager.grantRole(B,b2.address)).wait(); await submit(f);
  await (await f.manager.revokeRole(B,f.bank.address)).wait();
  await revert(f.manager.connect(f.evaluator).confirmEvaluation.staticCall(appKey,reportCid,reportHash,100,f.bank.address),'WrongBank');
  await (await f.manager.grantRole(B,f.bank.address)).wait(); await evaluate(f);
  await (await f.manager.revokeRole(B,f.bank.address)).wait();
  await revert(f.manager.connect(f.bank).finalApprove.staticCall(appKey,...terms),'AccessControlUnauthorizedAccount');
  await revert(f.manager.connect(b2).finalApprove.staticCall(appKey,...terms),'WrongBank');
  assert.equal((await f.manager.getApplication(appKey)).bank,f.bank.address);
  await (await f.manager.grantRole(B,f.bank.address)).wait(); await (await f.manager.connect(f.bank).finalApprove(appKey,...terms)).wait();
  await (await f.manager.revokeRole(B,f.bank.address)).wait();
  await revert(f.manager.connect(f.bank).recordRepayment.staticCall(appKey,1,id('R')),'AccessControlUnauthorizedAccount');
});
