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
  const state = { stage: 0, sends: 0, syncs: 0, methods: [], requests: [], handlers: {}, ended: 0, ...options };
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
    ethereum: { on(name, fn) { state.handlers[name] = fn; }, request: async ({ method }) => {
      state.methods.push(method);
      if (method === 'eth_chainId') return state.wrongNetwork ? '0x1' : `0x${(state.chainId || 31337).toString(16)}`;
      if (method === 'wallet_switchEthereumChain') { state.wrongNetwork = false; return null; }
      return [state.wrongWallet ? manager : wallet];
    } },
    ethers: {
      ZeroAddress: '0x0000000000000000000000000000000000000000', getAddress: a => a, toBeHex: n => `0x${n.toString(16)}`, id: s => s,
      BrowserProvider: class { async getSigner() { return { signMessage: async message => { state.signed = message; return '0xsigned'; } }; } async getTransactionReceipt() { return state.receipt || null; } },
      Contract: class { hasRole = async () => state.hasRole !== false;
        getApplication = async () => ({ status: state.stage }); submitApplication = send; confirmEvaluation = send; finalApprove = send; finalReject = send; },
    },
    fetch: async (url, options = {}) => {
      state.requests.push({ url, options });
      const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
      if (url.endsWith('/chain/config')) return reply({ enabled: true, chainId: state.chainId || 31337, zeroGasPrice: state.zeroGasPrice, managerAddress: manager, abi: [] });
      if (url.endsWith('/auth/challenge')) return reply({ nonce: 'n-1', message: 'sign in ' + JSON.parse(options.body).address });
      if (url.endsWith('/auth/login')) return reply({ token: 'session-token', address: wallet, roles: ['borrower'], expiresAt: 'later' });
      if (url.endsWith('/auth/me')) return state.expired ? reply({ message: 'login' }, 401) : reply({ address: wallet, roles: ['bank'] });
      if (url.endsWith('/auth/logout')) return reply({ status: 'ok' });
      state.syncs++;
      if (state.unauthorized) return reply({ message: '지갑으로 로그인해 주세요.' }, 401);
      return reply(state.syncFailure ? { message: 'server unavailable' } : { ...application, chainStatus: 'Evaluating' }, state.syncFailure ? 502 : 200);
    },
  });
  vm.runInContext(source, context);
  await context.IPLoanChain.init('/api', () => { state.ended++; });
  return { api: context.IPLoanChain, state, storage };
}

test('wallet signs once, then syncs; replay uses chain state without a second transaction', async () => {
  const h = await harness();
  await h.api.register(application); await h.api.register(application);
  assert.equal(h.state.sends, 1); assert.equal(h.state.syncs, 2); assert.equal(h.storage.size, 0);
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

test('login signs the server challenge once and later API calls carry the session token', async () => {
  const h = await harness();
  const session = await h.api.login();
  assert.equal(session.token, 'session-token');
  assert.equal(h.state.signed, 'sign in ' + wallet);
  assert.equal(JSON.parse(h.storage.get('iploan-session')).address, wallet);
  const login = h.state.requests.find(r => r.url.endsWith('/auth/login'));
  assert.deepEqual(JSON.parse(login.options.body), { address: wallet, nonce: 'n-1', signature: '0xsigned' });
  await h.api.sync(application);
  assert.equal(h.state.requests.at(-1).options.headers.Authorization, 'Bearer session-token');
  assert.deepEqual((await h.api.restore()).roles, ['bank']);
  await h.api.logout();
  assert.equal(h.api.session(), null); assert.equal(h.storage.has('iploan-session'), false);
});
test('switching the MetaMask account or an expired session signs out', async () => {
  const h = await harness();
  await h.api.login();
  h.state.handlers.accountsChanged([manager]);
  assert.equal(h.api.session(), null); assert.equal(h.state.ended, 1);
  await h.api.login();
  h.state.unauthorized = true;
  await assert.rejects(h.api.sync(application), /로그인/);
  assert.equal(h.api.session(), null); assert.equal(h.state.ended, 2);
  await h.api.login(); h.state.expired = true;
  assert.equal(await h.api.restore(), null);
});
test('transactions must come from the signed-in wallet', async () => {
  const h = await harness();
  await h.api.login();
  h.state.wrongWallet = true;
  await assert.rejects(h.api.register(application), /로그인한 지갑/);
  assert.equal(h.state.sends, 0);
});
test('approval sends the loan agreement terms; rejection sends only the application key', async () => {
  let h = await harness({ stage: 2 });
  await h.api.approve({ ...application, bankWallet: wallet }, true, { creditGrade: 'CC', rateBps: 430, termMonths: 24 });
  assert.deepEqual(h.state.sentArgs, ['0xkey', 'CC', 430n, 24n]);
  h = await harness({ stage: 2 });
  await h.api.approve({ ...application, bankWallet: wallet }, false);
  assert.deepEqual(h.state.sentArgs, ['0xkey']);
});
