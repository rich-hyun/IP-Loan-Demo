const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/admin.js','utf8');
const admin='0xB3Ec5f2bbB80e90ec457165d13EF469893a54951';
const zero='0x0000000000000000000000000000000000000000';
const storageKey=`iploan-deployment:v2:7601:${admin.toLowerCase()}`;
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
  const cfg={chainId:7601,enabled:!!state.enabled,managerAddress:state.enabled?'0xmanager':null,roleMembers:{BORROWER_ROLE:[],EVALUATOR_ROLE:[],BANK_ROLE:[]}};
  const context=vm.createContext({location:{hostname:'127.0.0.1'},document:{getElementById:el},
    IPLoanChain:{init:async()=>{},connect:async()=>({address:admin,provider,signer:{}}),config:()=>cfg,transactionOverrides:()=>({})},
    ethers:{ZeroAddress:zero,ZeroHash:'0xzero',id:x=>x,getAddress:x=>x,
      Contract:class {contractVersion=async()=>2;hasRole=async role=>role==='0xzero'?state.isAdmin:!!state.hasRole;grantRole=grant;revokeRole=revoke;},
      ContractFactory:class {getDeployTransaction=async()=>({data:'0xfeed'});deploy=async()=>{state.deploys++;return{deploymentTransaction:()=>({hash:'0xnew',wait:async()=>({status:1})}),getAddress:async()=> '0xmanager',accessSBT:async()=> '0xsbt',debtNFT:async()=> '0xnft'};}}},
    fetch:async()=>({ok:true,json:async()=>({abi:[{type:'function',name:'submitApplication',inputs:Array(5)},{type:'function',name:'confirmEvaluation',inputs:Array(state.oldAbi?4:5)}],bytecode:'0xfeed',compiler:{version:'0.8.24+commit.test',evmVersion:'paris'}})}),
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},confirm:()=>state.confirm});
  vm.runInContext(source,context); await vm.runInContext('adminReady',context);
  return{state,el,storage,run:s=>vm.runInContext(s,context)};
}
test('deployment uses connected admin and persists a versioned recovery hash',async()=>{
  const h=await boot(); await h.el('deployManager').onclick();
  assert.equal(h.state.deploys,1);assert.equal(JSON.parse(h.storage.get(storageKey)).txHash,'0xnew');
});
test('pending deployment blocks duplicate broadcasts',async()=>{
  const h=await boot({previous:true});await h.el('deployManager').onclick();assert.equal(h.state.deploys,0);assert.match(h.el('adminResult').textContent,/미확정/);
});
test('already mined v2 deployment is reused',async()=>{
  const h=await boot({previous:true,receipt:{status:1,contractAddress:'0xexisting'}});await h.el('deployManager').onclick();assert.equal(h.state.deploys,0);assert.equal(h.run('deployedAddress'),'0xexisting');
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
test('artifact from an earlier contract signature is refused before deployment',async()=>{
  const h=await boot({oldAbi:true});await h.el('deployManager').onclick();assert.equal(h.state.deploys,0);assert.match(h.el('adminResult').textContent,/컴파일/);
});
