const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/admin.js','utf8');
const bank='0xB3Ec5f2bbB80e90ec457165d13EF469893a54951';
async function boot(options={}){
 const state={deploys:0,nonce:0,receipt:null,confirm:true,...options};
 const elements=new Map();
 function el(id){if(!elements.has(id))elements.set(id,{value:id==='adminBank'?bank:'0xother',textContent:''});return elements.get(id);}
 const storage=new Map();
 const provider={getNetwork:async()=>({chainId:7601n}),getTransaction:async()=>({from:bank,to:null,data:state.badData?'0xbeef':'0xfeed',nonce:0,chainId:7601n,value:0n,gasPrice:0n}),
 getTransactionReceipt:async()=>state.receipt,getTransactionCount:async()=>state.nonce,getFeeData:async()=>({gasPrice:107n})};
 const context=vm.createContext({location:{hostname:'127.0.0.1'},document:{getElementById:el},
 IPLoanChain:{init:async()=>{},connect:async()=>({address:bank,provider,signer:{}}),config:()=>({chainId:7601,enabled:false,zeroGasPrice:false,pendingDeploymentTxHash:'0xold'}),transactionOverrides:()=>({})},
 ethers:{getAddress:x=>x,ContractFactory:class{getDeployTransaction=async()=>({data:'0xfeed'});deploy=async(...args)=>{state.deploys++;state.overrides=args.at(-1);return{deploymentTransaction:()=>({hash:'0xnew',wait:async()=>({status:1})}),getAddress:async()=> '0xmanager',accessSBT:async()=> '0xsbt',debtNFT:async()=> '0xnft'};}}},
 fetch:async()=>({ok:true,json:async()=>({abi:[],bytecode:'0xfeed',compiler:{version:'0.8.24+commit.test',evmVersion:'paris'}})}),
 localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
 confirm:text=>{state.confirmText=text;return state.confirm;}});
 vm.runInContext(source,context);await el('deployManager').onclick();
 return{state,el,storage,run:s=>vm.runInContext(s,context)};
}
test('pending zero-price deployment is replaced with same nonce and suggested positive legacy fee',async()=>{
 const h=await boot();assert.equal(h.state.deploys,1);assert.equal(h.state.overrides.nonce,0);assert.equal(h.state.overrides.type,0);assert.equal(h.state.overrides.gasPrice,107n);assert.match(h.state.confirmText,/같은 nonce 0/);
 assert.equal(JSON.parse(h.storage.get('iploan-deployment:7601')).txHash,'0xnew');
});
test('already mined deployment is reused without broadcasting',async()=>{
 const h=await boot({receipt:{status:1,contractAddress:'0xexisting'}});assert.equal(h.state.deploys,0);assert.equal(h.run('deployedAddress'),'0xexisting');
});
test('mismatched previous bytecode prevents replacement',async()=>{
 const h=await boot({badData:true});assert.equal(h.state.deploys,0);assert.match(h.el('adminResult').textContent,/자동 교체하지 않습니다/);
});
test('consumed nonce prevents a fresh unintended deployment',async()=>{
 const h=await boot({nonce:1});assert.equal(h.state.deploys,0);assert.match(h.el('adminResult').textContent,/nonce가 다른 거래/);
});
test('failed previous deployment does not silently send again',async()=>{
 const h=await boot({receipt:{status:0}});assert.equal(h.state.deploys,0);assert.match(h.el('adminResult').textContent,/실패한 영수증/);
});
test('cancelled confirmation never broadcasts replacement',async()=>{
 const h=await boot({confirm:false});assert.equal(h.state.deploys,0);assert.equal(h.storage.size,0);
});
