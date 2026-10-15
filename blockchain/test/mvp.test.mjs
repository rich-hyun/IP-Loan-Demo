import { test } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { BrowserProvider, ContractFactory, Contract, Interface, id, ZeroHash } from 'ethers';
import { compile } from '../scripts/compile.mjs';
const artifacts = compile();
const cid = 'bafybeigdyrzt1234567890', reportCid = 'bafybeireport1234567890', hash = id('salted document'), reportHash = id('report');
const appKey = id('LN-2026-0011');
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
  const nft = new Contract(await manager.debtNFT(), artifacts.IPLoanDebtNFT.abi, provider);
  return { provider, admin, borrower, evaluator, bank, outsider, manager, sbt, nft };
}
async function submit(f, key=appKey, amount=70n) {
  return (await f.manager.connect(f.borrower).submitApplication(key, cid, hash, amount)).wait();
}
async function evaluate(f, value=100n, key=appKey) {
  return (await f.manager.connect(f.evaluator).confirmEvaluation(key, reportCid, reportHash, value)).wait();
}
async function revert(promise, name, artifact='IPLoanManager') {
  const selector = new Interface(artifacts[artifact].abi).getError(name).selector;
  await assert.rejects(promise, e => {
    assert.ok(e.revert?.name === name || JSON.stringify(e, (_,v) => typeof v==='bigint' ? String(v) : v).includes(selector), e.message);
    return true;
  });
}
test('submission creates record and evaluator SBT but no debt NFT', async t => {
  const f = await fixture(t); const receipt = await submit(f);
  const a = await f.manager.getApplication(appKey);
  assert.equal(a.borrower, f.borrower.address); assert.equal(a.docCid, cid); assert.equal(a.fileHash, hash);
  assert.equal(a.amount, 70n); assert.equal(a.status, 1n); assert.equal(await f.sbt.ownerOf(a.tokenId), f.evaluator.address);
  assert.equal(await f.sbt.locked(a.tokenId), true); assert.equal(await f.sbt.supportsInterface('0xb45a3c0e'), true);
  assert.equal(await f.nft.balanceOf(f.bank.address), 0n);
  assert.equal(receipt.logs.filter(l=>l.topics[0]===id('Transfer(address,address,uint256)')).length, 1);
});
test('wrong role and malformed submission cannot create application', async t => {
  const f = await fixture(t);
  await revert(f.manager.connect(f.outsider).submitApplication.staticCall(appKey,cid,hash,70), 'AccessControlUnauthorizedAccount');
  for (const args of [[ZeroHash,cid,hash,70],[appKey,'invalid"CID',hash,70],[appKey,cid,ZeroHash,70],[appKey,cid,hash,0]])
    await revert(f.manager.connect(f.borrower).submitApplication.staticCall(...args),'InvalidInput');
  assert.equal((await f.manager.getApplication(appKey)).status, 0n); assert.equal(await f.manager.nextTokenId(),1n);
});
test('same application can be submitted only once', async t => {
  const f=await fixture(t); await submit(f);
  await revert(f.manager.connect(f.borrower).submitApplication.staticCall(appKey,cid,hash,70),'AlreadySubmitted');
  assert.equal(await f.manager.nextTokenId(),2n);
});
test('evaluation confirmation burns SBT and performs boundary LTV rule in same transaction', async t => {
  const f=await fixture(t); await submit(f); const receipt=await evaluate(f);
  const a=await f.manager.getApplication(appKey); assert.equal(a.status,2n); assert.equal(a.appraisedValue,100n);
  assert.equal(a.reportCid,reportCid); assert.equal(a.reportHash,reportHash);
  await revert(f.sbt.ownerOf(1),'ERC721NonexistentToken','IPLoanAccessSBT');
  assert.equal(await f.nft.balanceOf(f.bank.address),0n);
  assert.ok(receipt.logs.some(l=>l.topics[0]===id('EvaluationConfirmed(bytes32,string,bytes32,uint256,bool)')));
});
test('only fixed evaluator can confirm even if another address was granted evaluator role', async t => {
  const f=await fixture(t); await submit(f);
  await revert(f.manager.connect(f.borrower).confirmEvaluation.staticCall(appKey,reportCid,reportHash,100),'AccessControlUnauthorizedAccount');
  await (await f.manager.grantRole(await f.manager.EVALUATOR_ROLE(),f.outsider.address)).wait();
  await revert(f.manager.connect(f.outsider).confirmEvaluation.staticCall(appKey,reportCid,reportHash,100),'WrongEvaluator');
  assert.equal(await f.sbt.ownerOf(1),f.evaluator.address);
});
test('automatic rejection removes SBT and prevents final approval/NFT', async t => {
  const f=await fixture(t); await submit(f,appKey,71n); await evaluate(f);
  assert.equal((await f.manager.getApplication(appKey)).status,3n);
  await revert(f.manager.connect(f.bank).finalApprove.staticCall(appKey),'WrongStage');
  assert.equal(await f.sbt.balanceOf(f.evaluator.address),0n); assert.equal(await f.nft.balanceOf(f.bank.address),0n);
});
test('only fixed bank/reviewer may approve; NFT is minted to that same address', async t => {
  const f=await fixture(t); await submit(f); await evaluate(f);
  await revert(f.manager.connect(f.borrower).finalApprove.staticCall(appKey),'AccessControlUnauthorizedAccount');
  await (await f.manager.grantRole(await f.manager.BANK_ROLE(),f.outsider.address)).wait();
  await revert(f.manager.connect(f.outsider).finalApprove.staticCall(appKey),'WrongBank');
  await (await f.manager.connect(f.bank).finalApprove(appKey)).wait();
  assert.equal(await f.nft.ownerOf(1),f.bank.address); assert.equal((await f.manager.getApplication(appKey)).status,4n);
  await revert(f.manager.connect(f.bank).finalApprove.staticCall(appKey),'WrongStage');
});
test('bank final rejection creates no debt NFT and cannot be reversed to approval', async t => {
  const f=await fixture(t); await submit(f); await evaluate(f);
  await (await f.manager.connect(f.bank).finalReject(appKey)).wait();
  assert.equal((await f.manager.getApplication(appKey)).status,5n);
  await revert(f.manager.connect(f.bank).finalApprove.staticCall(appKey),'WrongStage');
  assert.equal(await f.nft.balanceOf(f.bank.address),0n);
});
test('SBT transfer and direct token mint/burn are forbidden', async t => {
  const f=await fixture(t); await submit(f);
  await revert(f.sbt.connect(f.evaluator).transferFrom.staticCall(f.evaluator.address,f.bank.address,1),'Soulbound','IPLoanAccessSBT');
  await revert(f.sbt.connect(f.evaluator).burn.staticCall(1),'ManagerOnly','IPLoanAccessSBT');
  await revert(f.nft.connect(f.bank).mint.staticCall(f.bank.address,1),'ManagerOnly','IPLoanDebtNFT');
});
test('partial and full repayment update record and metadata while keeping bank NFT; no funds moved into contract', async t => {
  const f=await fixture(t); await submit(f); await evaluate(f); await (await f.manager.connect(f.bank).finalApprove(appKey)).wait();
  await (await f.manager.connect(f.bank).recordRepayment(appKey,20,id('REP-1'))).wait();
  let a=await f.manager.getApplication(appKey); assert.equal(a.repaidAmount,20n); assert.equal(a.status,4n);
  await (await f.manager.connect(f.bank).recordRepayment(appKey,50,id('REP-2'))).wait();
  a=await f.manager.getApplication(appKey); assert.equal(a.repaidAmount,70n); assert.equal(a.status,6n);
  assert.equal(await f.nft.ownerOf(1),f.bank.address); assert.equal(await f.provider.getBalance(await f.manager.getAddress()),0n);
  const metadata=JSON.parse(Buffer.from((await f.nft.tokenURI(1)).split(',')[1],'base64').toString());
  assert.equal(metadata.repaidAmount,'70'); assert.equal(metadata.cid,cid);
  assert.equal(metadata.status,6); assert.ok(!('docKey' in metadata));
  assert.equal((await f.manager.queryFilter(f.manager.filters.RepaymentRecorded())).length,2);
});
test('duplicate, overpayment, zero and wrong-wallet repayments are rejected', async t => {
  const f=await fixture(t); await submit(f); await evaluate(f); await (await f.manager.connect(f.bank).finalApprove(appKey)).wait();
  await (await f.manager.connect(f.bank).recordRepayment(appKey,20,id('REP-1'))).wait();
  await revert(f.manager.connect(f.bank).recordRepayment.staticCall(appKey,1,id('REP-1')),'DuplicateRepayment');
  await revert(f.manager.connect(f.bank).recordRepayment.staticCall(appKey,51,id('REP-2')),'InvalidInput');
  await revert(f.manager.connect(f.bank).recordRepayment.staticCall(appKey,0,id('REP-2')),'InvalidInput');
  await revert(f.manager.connect(f.borrower).recordRepayment.staticCall(appKey,1,id('REP-2')),'AccessControlUnauthorizedAccount');
  assert.equal((await f.manager.getApplication(appKey)).repaidAmount,20n);
});
test('revoked evaluator cannot act and earlier stages cannot approve or repay', async t => {
  const f=await fixture(t); await submit(f);
  await revert(f.manager.connect(f.bank).finalApprove.staticCall(appKey),'WrongStage');
  await revert(f.manager.connect(f.bank).recordRepayment.staticCall(appKey,1,id('R')),'WrongStage');
  await (await f.manager.revokeRole(await f.manager.EVALUATOR_ROLE(),f.evaluator.address)).wait();
  await revert(f.manager.connect(f.evaluator).confirmEvaluation.staticCall(appKey,reportCid,reportHash,100),'AccessControlUnauthorizedAccount');
});
