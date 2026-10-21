const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(response, ok = true) {
  const content = {};
  const root = { dataset: { tokenApp: 'LN-1' }, querySelector: () => content, querySelectorAll: () => [] };
  const context = { IPLOAN_API_BASE: '/api', location: { hostname: 'localhost' },
    document: { querySelectorAll: () => [root] }, fetch: async () => ({ ok, json: async () => response }) };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(__dirname + '/token-cards.js', 'utf8'), context);
  return { module: context.LoanTokenCards, content };
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

test('unissued artwork is explicitly a preview, with no issued token number', async () => {
  const { module, content } = harness({ chainStatus: 'Eligible', tokens: [{ kind: 'debt', label: 'NFT', state: 'pending', tokenId: '7', chainBlock: 8 }] });
  await module.load({ id: 'LN-1' });
  assert.match(content.innerHTML, /아직 발급된 토큰이 아닙니다/);
  assert.doesNotMatch(content.innerHTML, /#7/);
  assert.doesNotMatch(content.innerHTML, /Token ID 복사/);
});

test('failed chain verification displays the error instead of an issued card', async () => {
  const { module, content } = harness({ message: 'RPC unavailable' }, false);
  await module.load({ id: 'LN-1' });
  assert.equal(content.textContent, 'RPC unavailable');
  assert.equal(content.innerHTML, undefined);
});
