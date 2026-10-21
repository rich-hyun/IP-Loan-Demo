import { test } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { BrowserProvider, ContractFactory, Contract, id } from 'ethers';
import { compile } from '../scripts/compile.mjs';
const artifacts = compile();

test('IPFS tokenURI binds at submission, survives bank approval and cannot be replaced by a replay', async t => {
  const connection = await network.connect('localTest');
  const provider = new BrowserProvider(connection.provider); provider.pollingInterval = 10;
  t.after(async()=>{provider.destroy();await connection.close();});
  const [admin,borrower,evaluator,bank,other] = await Promise.all([0,1,2,3,4].map(i=>provider.getSigner(i)));
  const manager = await new ContractFactory(artifacts.IPLoanManager.abi,artifacts.IPLoanManager.bytecode,admin).deploy(admin.address,evaluator.address,bank.address);
  await manager.waitForDeployment();
  await (await manager.grantRole(await manager.BORROWER_ROLE(),borrower.address)).wait();
  const sbt = new Contract(await manager.accessSBT(),artifacts.IPLoanAccessSBT.abi,provider);
  const nft = new Contract(await manager.debtNFT(),artifacts.IPLoanDebtNFT.abi,provider);
  const key=id('media-application'), cid='bafySource123456789', hash=id('source'), sbtUri='ipfs://bafySbtMetadata123456', debtUri='ipfs://bafyDebtMetadata12345';
  assert.equal(await manager.tokenMediaVersion(),1n);
  for(const invalid of ['https://example.com/a','ipfs://short','ipfs://bafyvalid12345/path','ipfs://bafyvalid12345?x=1']) {
    await assert.rejects(manager.connect(borrower).submitApplicationWithMetadata.staticCall(key,cid,hash,70,evaluator.address,invalid,debtUri));
  }
  await assert.rejects(manager.connect(other).submitApplicationWithMetadata.staticCall(key,cid,hash,70,evaluator.address,sbtUri,debtUri));
  await (await manager.connect(borrower).submitApplicationWithMetadata(key,cid,hash,70,evaluator.address,sbtUri,debtUri)).wait();
  assert.equal(await sbt.tokenURI(1),sbtUri);
  await assert.rejects(nft.tokenURI(1));
  await assert.rejects(manager.connect(borrower).submitApplicationWithMetadata.staticCall(key,cid,hash,70,evaluator.address,sbtUri,'ipfs://bafyReplaced123456789'));
  await (await manager.connect(evaluator).confirmEvaluation(key,'bafyReport123456789',id('report'),100,bank.address)).wait();
  await assert.rejects(sbt.tokenURI(1));
  await (await manager.connect(bank).finalApprove(key)).wait();
  assert.equal(await nft.ownerOf(1),bank.address);
  assert.equal(await nft.tokenURI(1),debtUri);
  assert.equal(await manager.metadata(1,false),sbtUri);
  await (await manager.connect(bank).recordRepayment(key,70,id('repay-media'))).wait();
  assert.equal(await nft.tokenURI(1),debtUri);
  // Existing ABI and metadata behaviour remain available for historical callers.
  const legacy=id('legacy-application');
  await (await manager.connect(borrower).submitApplication(legacy,cid,hash,70,evaluator.address)).wait();
  assert.ok((await sbt.tokenURI(2)).startsWith('data:application/json;base64,'));
});
