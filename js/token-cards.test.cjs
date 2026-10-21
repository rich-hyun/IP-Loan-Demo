const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(response, ok = true, extras = {}) {
  const content = {}, action = {};
  const root = { dataset: { tokenApp: 'LN-1', tokenKind: 'debt' }, querySelector: s => s === '[data-token-action]' ? action : content, querySelectorAll: () => [] };
  const context = { IPLOAN_API_BASE: '/api', location: { hostname: 'localhost' },
    document: { querySelectorAll: () => [root] }, fetch: async () => ({ ok, json: async () => response }), ...extras };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(__dirname + '/token-cards.js', 'utf8'), context);
  return { module: context.LoanTokenCards, content, action, root };
}

test('issued token uses the NFT contract, owner and token number and escapes markup', async () => {
  const { module, content } = harness({ chainStatus: 'Approved', tokens: [{ kind: 'debt', label: '대출채권 NFT', state: 'issued',
    contractAddress: 'nft-contract', managerAddress: 'manager-contract', owner: '<img src=x onerror=alert(1)>', tokenId: '7', chainId: 31337, chainBlock: 8 }] });
  await module.load({ id: 'LN-1' });
  assert.match(content.innerHTML, /nft-contract/);
  assert.doesNotMatch(content.innerHTML, /manager-contract/);
  assert.match(content.innerHTML, /발급 완료/);
  assert.match(content.innerHTML, /#7/);
  assert.doesNotMatch(content.innerHTML, /<img src=x/);
  assert.match(content.innerHTML, /&lt;img/);
});

test('issued token puts only the MetaMask button in the gallery heading', async () => {
  const { module, content, action } = harness({ chainStatus: 'Approved', tokens: [{ kind: 'debt', label: 'NFT', state: 'issued',
    contractAddress: '0xdef', owner: '0xabc', tokenId: '7', chainId: 7601, chainBlock: 8 }] });
  assert.match(module.placeholder.toString(), /data-token-action/);
  await module.load({ id: 'LN-1' });
  assert.match(action.innerHTML, /data-watch-token="debt"[^>]*>MetaMask에 추가/);
  assert.doesNotMatch(content.innerHTML, /<button|data-copy|계약 주소 복사|Token ID 복사|표지 크게 보기/);
});

test('uploaded IPFS media shows no IPFS or wallet guidance note', async () => {
  const { module, content } = harness({ chainStatus: 'Approved', walletImageAvailable: true, artworkSource: 'ipfs',
    tokens: [{ kind: 'debt', label: 'NFT', state: 'issued', owner: '0xabc', contractAddress: '0xdef', tokenId: '1', chainId: 7601, chainBlock: 8 }] });
  await module.load({ id: 'LN-1' });
  assert.doesNotMatch(content.innerHTML, /tokenURI에 연결|주소·Token ID 입력 없이|별도 서명/);
  assert.match(content.innerHTML, /체인 상태 Approved/);
});

test('a token that is not minted yet hides the whole card section', async () => {
  const { module, content, action, root } = harness({ chainStatus: 'Eligible', walletImageAvailable: true, artworkSource: 'ipfs',
    tokens: [{ kind: 'debt', label: 'NFT', state: 'pending', tokenId: '7', chainBlock: 8 }] });
  await module.load({ id: 'LN-1' });
  assert.equal(root.hidden, true);
  assert.equal(content.innerHTML, undefined);
  assert.equal(action.innerHTML, undefined);
});

test('evaluator sees only the SBT, lender only the debt NFT, borrower neither', async () => {
  const both = { chainStatus: 'Approved', tokens: [
    { kind: 'sbt', label: '평가보고서 열람 SBT', state: 'issued', contractAddress: 'sbt-contract', owner: '0xabc', tokenId: '1', chainId: 7601, chainBlock: 8 },
    { kind: 'debt', label: '대출채권 NFT', state: 'issued', contractAddress: 'nft-contract', owner: '0xdef', tokenId: '1', chainId: 7601, chainBlock: 8 }] };
  for (const [role, kind, shown, hidden] of [['evaluator', 'sbt', /sbt-contract/, /nft-contract/], ['lender', 'debt', /nft-contract/, /sbt-contract/]]) {
    const { module, content, root } = harness(both, true, { currentRole: role });
    assert.match(module.placeholder({ id: 'LN-1', appKey: 'key' }), new RegExp(`data-token-kind="${kind}"`));
    root.dataset.tokenKind = kind;
    await module.load({ id: 'LN-1' });
    assert.match(content.innerHTML, shown);
    assert.doesNotMatch(content.innerHTML, hidden);
  }
  assert.equal(harness(both, true, { currentRole: 'borrower' }).module.placeholder({ id: 'LN-1', appKey: 'key' }), '');
});

const issued = {kind:'sbt', label:'SBT', state:'issued', owner:'0xabc', contractAddress:'0xdef', tokenId:'1', chainId:7601};
function walletHarness(token = issued, overrides = {}) {
  const calls = [];
  const ethereum = {async request(request) {
    calls.push(request);
    if (request.method === 'eth_chainId') return overrides.chain || '0x1db1';
    if (request.method === 'eth_accounts') return [overrides.owner || '0xabc'];
    if (request.method === 'wallet_watchAsset') return true;
    throw Error('Unexpected wallet method: '+request.method);
  }};
  return {...harness({tokens:[token]}, true, {ethereum}), calls};
}
test('wallet import sends actual contract and token ID without signing or a transaction', async () => {
  const {module,calls} = walletHarness();
  assert.equal(await module.addToWallet(issued), true);
  const request = calls.find(c=>c.method==='wallet_watchAsset');
  assert.equal(JSON.stringify(request.params),JSON.stringify({type:'ERC721',options:{address:'0xdef',tokenId:'1'}}));
  assert.deepEqual(calls.map(c=>c.method),['eth_chainId','eth_accounts','wallet_watchAsset']);
});
test('wrong account, wrong chain and burned token never request wallet import', async () => {
  for (const [token,options,pattern] of [[issued,{owner:'0x123'},/수령 지갑/],[issued,{chain:'0x1'},/네트워크/],[{...issued,state:'burned'},{},/발급 토큰/]]) {
    const {module,calls} = walletHarness(token,options);
    await assert.rejects(module.addToWallet(token),pattern);
    assert.equal(calls.some(c=>c.method==='wallet_watchAsset'),false);
  }
});
test('a second click does not open another wallet prompt while one is open', async () => {
  let release; const calls = [];
  const ethereum = {async request(request) {
    calls.push(request.method);
    if (request.method === 'eth_chainId') return '0x1db1';
    if (request.method === 'eth_accounts') return ['0xabc'];
    return new Promise(resolve => { release = resolve; });
  }};
  const status = {}, button = {dataset:{watchToken:'sbt'}};
  const root = {dataset:{tokenApp:'LN-1', tokenKind:'sbt'}, querySelector:s=>s==='[data-wallet-status]'?status:{}, querySelectorAll:s=>s==='[data-watch-token]'?[button]:[]};
  const {module} = harness({tokens:[{...issued, chainBlock:8}]}, true, {ethereum, document:{querySelectorAll:()=>[root]}});
  await module.load({id:'LN-1'});
  const first = button.onclick();
  await new Promise(resolve=>setImmediate(resolve));
  await button.onclick();
  assert.equal(calls.filter(m=>m==='wallet_watchAsset').length,1);
  assert.match(status.textContent,/대기 중인 요청/);
  release(true); await first;
  assert.match(status.textContent,/승인됐습니다/);
});

test('failed chain verification displays the error instead of an issued card', async () => {
  const { module, content } = harness({ message: 'RPC unavailable' }, false);
  await module.load({ id: 'LN-1' });
  assert.equal(content.textContent, 'RPC unavailable');
  assert.equal(content.innerHTML, undefined);
});

test('legacy token without wallet image is labelled as an app preview', async () => {
  const { module, content } = harness({ chainStatus: 'Approved', walletImageAvailable: false,
    tokens: [{ kind: 'debt', label: 'NFT', state: 'issued', owner: '0xabc', contractAddress: '0xdef', tokenId: '1', chainId: 7601, chainBlock: 8 }] });
  await module.load({ id: 'LN-1' });
  assert.match(content.innerHTML, /기존 발급 토큰의 메타데이터에는 이미지가 없습니다/);
});
