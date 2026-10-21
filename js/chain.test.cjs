const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(`${__dirname}/chain.js`, 'utf8');
const wallet = '0x1111111111111111111111111111111111111111';
const manager = '0x2222222222222222222222222222222222222222';
const application = { id: 'LN-TEST', appKey: '0xkey', docCid: 'bafytestcid', docFileHash: '0xhash', amount: 70,
  borrowerWallet: wallet, managerAddress: manager, chainId: 31337,
  evaluatorWallet: '0x3333333333333333333333333333333333333333', bankWallet: '0x4444444444444444444444444444444444444444' };

async function harness(options = {}) {
  const state = { stage: 0, sends: 0, syncs: 0, methods: [], ...options };
  const storage = new Map();
  if (state.pending) storage.set(`iploan-tx:31337:${manager}:LN-TEST:submit`, '0xpending');
  const send = async (...args) => {
    state.sends++;
    state.sentOverrides = args.at(-1);
    state.sentArgs = args.slice(0, -1);
    if (state.cancel) throw Object.assign(new Error('cancel'), { code: 4001 });
    state.stage = 1;
    return { hash: '0xbroadcast', wait: async () => ({ status: 1 }) };
  };
  send.staticCall = async () => {};
  const context = vm.createContext({
    console, setTimeout, alert() {},
    document: { getElementById: () => null },
    localStorage: { getItem: k => storage.get(k), removeItem: k => storage.delete(k), setItem: (k, v) => storage.set(k, v) },
    ethereum: { on() {}, request: async ({ method }) => {
      state.methods.push(method);
      if (method === 'eth_chainId') return state.wrongNetwork ? '0x1' : `0x${(state.chainId || 31337).toString(16)}`;
      if (method === 'wallet_switchEthereumChain') { state.wrongNetwork = false; return null; }
      return [state.wrongWallet ? manager : wallet];
    } },
    ethers: {
      ZeroAddress: '0x0000000000000000000000000000000000000000', getAddress: a => a, toBeHex: n => `0x${n.toString(16)}`, id: s => s,
      BrowserProvider: class { async getSigner() { return {}; } async getTransactionReceipt() { return state.receipt || null; } },
      Contract: class { hasRole = async () => state.hasRole !== false;
        getApplication = async () => ({ status: state.stage }); submitApplication = send; submitApplicationWithMetadata = send; confirmEvaluation = send; },
    },
    fetch: async url => {
      if (url.endsWith('/chain/config')) return { ok: true, json: async () => ({ enabled: true, chainId: state.chainId || 31337, tokenMediaVersion: state.tokenMediaVersion || 0, zeroGasPrice: state.zeroGasPrice, managerAddress: manager, abi: [] }) };
      state.syncs++;
      return { ok: !state.syncFailure, json: async () => state.syncFailure ? { message: 'server unavailable' } : { ...application, chainStatus: 'Evaluating' } };
    },
  });
  vm.runInContext(source, context);
  await context.IPLoanChain.init('/api');
  return { api: context.IPLoanChain, state, storage };
}

test('wallet signs once, then syncs; replay uses chain state without a second transaction', async () => {
  const h = await harness();
  await h.api.register(application); await h.api.register(application);
  assert.equal(h.state.sends, 1); assert.equal(h.state.syncs, 2); assert.equal(h.storage.size, 0);
});

test('media submission sends both stored IPFS URIs and blocks incomplete or unsupported contracts', async () => {
  const app = {...application, sbtMetadataUri:'ipfs://bafysbt1234567', debtMetadataUri:'ipfs://bafydebt123456'};
  const h = await harness({tokenMediaVersion:1});
  await h.api.register(app);
  assert.equal(h.state.sentArgs.length,7);
  assert.equal(h.state.sentArgs[5],app.sbtMetadataUri);
  assert.equal(h.state.sentArgs[6],app.debtMetadataUri);
  const old = await harness(); await assert.rejects(old.api.register(app)); assert.equal(old.state.sends,0);
  const partial = await harness({tokenMediaVersion:1}); await assert.rejects(partial.api.register({...app,debtMetadataUri:null})); assert.equal(partial.state.sends,0);
});
test('wrong assigned wallet or missing role never broadcasts', async () => {
  for (const options of [{ wrongWallet: true }, { hasRole: false }]) {
    const h = await harness(options);
    await assert.rejects(h.api.register(application)); assert.equal(h.state.sends, 0);
  }
});
test('wrong network requests a switch before broadcasting', async () => {
  const h = await harness({ wrongNetwork: true }); await h.api.register(application);
  assert.ok(h.state.methods.includes('wallet_switchEthereumChain')); assert.equal(h.state.sends, 1);
});
test('cancelled MetaMask confirmation retains uploaded application and allows retry', async () => {
  const h = await harness({ cancel: true });
  await assert.rejects(h.api.register(application), /서명을 취소/);
  assert.equal(h.state.syncs, 0); h.state.cancel = false; h.state.stage = 0;
  await h.api.register(application); assert.equal(h.state.syncs, 1);
});
test('pending transaction hash prevents duplicate broadcast', async () => {
  const h = await harness({ pending: true });
  await assert.rejects(h.api.register(application), error => error.txHash === '0xpending');
  assert.equal(h.state.sends, 0);
});
test('mined saved transaction syncs without rebroadcast', async () => {
  const h = await harness({ pending: true, receipt: { status: 1 } });
  await h.api.register(application); assert.equal(h.state.sends, 0); assert.equal(h.storage.size, 0);
});
test('server sync failure preserves broadcast hash and retry does not mint twice', async () => {
  const h = await harness({ syncFailure: true });
  await assert.rejects(h.api.register(application), error => error.txHash === '0xbroadcast');
  assert.equal(h.storage.size, 1); h.state.syncFailure = false;
  await h.api.register(application); assert.equal(h.state.sends, 1); assert.equal(h.storage.size, 0);
});

test('Mustsem configured zero price is passed as legacy gasPrice=0', async () => {
  const h = await harness({ chainId: 7601, zeroGasPrice: true });
  await h.api.register({ ...application, chainId: 7601 });
  assert.equal(h.state.sentOverrides.type, 0);
  assert.equal(h.state.sentOverrides.gasPrice, 0n);
});
test('zero price never leaks to Sepolia or an unconfigured network', async () => {
  for (const options of [{ chainId: 11155111, zeroGasPrice: true }, { chainId: 7601, zeroGasPrice: false }]) {
    const h = await harness(options);
    assert.equal(Object.keys(h.api.transactionOverrides()).length, 0);
  }
});

test('registration sends only the stored server-assigned evaluator, with no per-application admin transaction', async () => {
  const h = await harness();
  await h.api.register(application);
  assert.equal(h.state.sentArgs.length, 5);
  assert.equal(h.state.sentArgs.at(-1), application.evaluatorWallet);
  assert.equal(h.state.sends, 1);
});

test('missing stored assignment is refused before asking MetaMask to broadcast', async () => {
  const h = await harness();
  await assert.rejects(h.api.register({ ...application, evaluatorWallet: '' }), /담당 평가사 주소/);
  assert.equal(h.state.sends, 0);
});

test('evaluation sends the server-assigned bank for a passing report and the zero address otherwise', async () => {
  const report = { cid: 'bafyreport', hash: '0xreport', appraisedValue: 100 };
  const evaluating = { ...application, evaluatorWallet: wallet };
  let h = await harness({ stage: 1 });
  await h.api.evaluate(evaluating, { ...report, bankWallet: application.bankWallet });
  assert.equal(h.state.sentArgs.at(-1), application.bankWallet);
  h = await harness({ stage: 1 });
  await h.api.evaluate(evaluating, { ...report, appraisedValue: 99, bankWallet: null });
  assert.equal(h.state.sentArgs.at(-1), '0x0000000000000000000000000000000000000000');
});
