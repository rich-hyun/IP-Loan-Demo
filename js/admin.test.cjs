const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/admin.js','utf8');
const admin='0xB3Ec5f2bbB80e90ec457165d13EF469893a54951';
const zero='0x0000000000000000000000000000000000000000';
const storageKey=`iploan-deployment:v3:7601:${admin.toLowerCase()}:build001`;
async function boot(options={}) {
  const state={deploys:0,grants:0,revokes:0,isAdmin:true,confirm:true,...options};
  const elements=new Map();
  function el(id) { if(!elements.has(id)) elements.set(id,{value:id==='adminBank'?admin:'0x1111111111111111111111111111111111111111',textContent:''});return elements.get(id); }
  el('roleName').value='EVALUATOR_ROLE';
  const storage=new Map();
  if(state.previous)storage.set(storageKey,JSON.stringify({txHash:'0xold'}));
  const provider={getNetwork:async()=>({chainId:7601n}),getTransaction:async()=>({from:admin,to:null,data:state.badData?'0xbad':'0xfeed',chainId:7601n,value:0n}),getTransactionReceipt:async()=>state.receipt||null};
  const makeTx=async()=>({hash:'0xnew',wait:async()=>({status:1})});
  const grant=async()=>{state.grants++;return makeTx();};grant.staticCall=async()=>{};
  const revoke=async()=>{state.revokes++;return makeTx();};revoke.staticCall=async()=>{};
  const cfg={chainId:7601,enabled:!!state.enabled,managerAddress:state.enabled?'0xmanager':null,abi:state.enabled?[]:undefined,roleMembers:{BORROWER_ROLE:[],EVALUATOR_ROLE:[],BANK_ROLE:[]}};
  const context=vm.createContext({location:{hostname:'127.0.0.1'},document:{getElementById:el},
    IPLoanChain:{init:async()=>{},connect:async()=>({address:admin,provider,signer:{}}),config:()=>cfg,transactionOverrides:()=>({})},
    ethers:{ZeroAddress:zero,ZeroHash:'0xzero',id:x=>x,getAddress:x=>x,keccak256:code=>code==='0xfeed'?'0xbuild001ffff':'0xbuild002ffff',
      Contract:class {contractVersion=async()=>3;hasRole=async role=>role==='0xzero'?state.isAdmin:!!state.hasRole;grantRole=grant;revokeRole=revoke;},
      ContractFactory:class {getDeployTransaction=async()=>({data:'0xfeed'});deploy=async()=>{state.deploys++;return{deploymentTransaction:()=>({hash:'0xnew',wait:async()=>({status:1})}),getAddress:async()=> '0xmanager',accessSBT:async()=> '0xsbt',rwaToken:async()=> '0xrwa',art:async()=> '0xart'};}}},
    fetch:async()=>state.noArtifact?{ok:false,json:async()=>({message:'404'})}:({ok:true,json:async()=>({abi:[{type:'function',name:'submitApplication',inputs:Array(5)},{type:'function',name:'confirmEvaluation',inputs:Array(5)},{type:'function',name:'finalApprove',inputs:Array(state.oldAbi?4:2)}],bytecode:state.bytecode||'0xfeed',compiler:{version:'0.8.24+commit.test',evmVersion:'paris'}})}),
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},confirm:()=>state.confirm});
  vm.runInContext(source,context); await vm.runInContext('adminReady',context);
  return{state,el,storage,run:s=>vm.runInContext(s,context)};
}
test('deployment uses connected admin and persists a versioned recovery hash',async()=>{
  const h=await boot(); await h.el('deployManager').onclick();
  assert.equal(h.state.deploys,1);assert.match(h.el('adminResult').textContent,/RWA 토큰: 0xrwa\n그림\(메타데이터\): 0xart/);assert.equal(JSON.parse(h.storage.get(storageKey)).txHash,'0xnew');
});
test('pending deployment blocks duplicate broadcasts',async()=>{
  const h=await boot({previous:true});await h.el('deployManager').onclick();assert.equal(h.state.deploys,0);assert.match(h.el('adminResult').textContent,/미확정/);
});
test('already mined v3 deployment is reused',async()=>{
  const h=await boot({previous:true,receipt:{status:1,contractAddress:'0xexisting'}});await h.el('deployManager').onclick();assert.equal(h.state.deploys,0);assert.equal(h.run('deployedAddress'),'0xexisting');
});
test('a deployment saved for an earlier build does not block the rebuilt contract',async()=>{
  const h=await boot({previous:true,bytecode:'0xbeef'});await h.el('deployManager').onclick();
  assert.equal(h.state.deploys,1);assert.equal(JSON.parse(h.storage.get(storageKey.replace('build001','build002'))).txHash,'0xnew');
});
test('mismatched previous deployment or cancelled approval cannot broadcast',async()=>{
  for(const opts of [{previous:true,badData:true},{confirm:false}]){const h=await boot(opts);await h.el('deployManager').onclick();assert.equal(h.state.deploys,0);}
});
test('non-admin cannot grant roles',async()=>{
  const h=await boot({enabled:true,isAdmin:false});await h.el('grantRole').onclick();assert.equal(h.state.grants,0);assert.match(h.el('adminResult').textContent,/관리자 지갑/);
});
test('registered admin can add each supported role using wallet signature',async()=>{
  for(const role of ['BORROWER_ROLE','EVALUATOR_ROLE','BANK_ROLE']){const h=await boot({enabled:true});h.el('roleName').value=role;await h.el('grantRole').onclick();assert.equal(h.state.grants,1);}
});
test('admin can revoke a role and duplicate grant is a no-op',async()=>{
  const h=await boot({enabled:true,hasRole:true});await h.el('grantRole').onclick();assert.equal(h.state.grants,0);await h.el('revokeRole').onclick();assert.equal(h.state.revokes,1);
});
test('v2 artifact without loan terms is refused before deployment',async()=>{
  const h=await boot({oldAbi:true});await h.el('deployManager').onclick();assert.equal(h.state.deploys,0);assert.match(h.el('adminResult').textContent,/컴파일/);
});
test('role management uses the API ABI where build artifacts are not published',async()=>{
  const h=await boot({enabled:true,noArtifact:true});await h.el('grantRole').onclick();assert.equal(h.state.grants,1);
});
test('role management refuses a non-v3 manager',async()=>{
  const h=await boot({enabled:true});h.run("ethers.Contract.prototype.contractVersion=undefined");
  h.run("ethers.Contract=class extends ethers.Contract{contractVersion=async()=>2}");await h.el('grantRole').onclick();
  assert.equal(h.state.grants,0);assert.match(h.el('adminResult').textContent,/v3/);
});
