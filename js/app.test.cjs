// Lightweight DOM/API harness for the v3 screen logic. The wallet and server are mocked; blockchain/test covers the real flow.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');

const WALLET = '0x1111111111111111111111111111111111111111';
const EVALUATOR = '0x3333333333333333333333333333333333333333';
const BANK = '0x4444444444444444444444444444444444444444';
const VIEWS = ['login', 'dashboard', 'list', 'apply', 'evaluate', 'review', 'archive', 'detail'];

function baseApplication(extra = {}) {
  return { id: 'LN-2026-100001', company: '테스트 기업', bizNo: '123-45-67890', ipType: '특허권', ipTitle: '테스트 특허', amount: 70000000,
    termMonths: 24, status: 'evaluating', appliedDate: '2026-10-20', appKey: '0xkey', chainStatus: 'Evaluating', chainId: 7601,
    borrowerWallet: WALLET, evaluatorWallet: EVALUATOR, managerAddress: '0xmanager', hashMatch: 1,
    evaluation: { status: 'completed', job_id: 'job-1', artifacts: ['pdf', 'log'] }, access: ['evaluator'], ...extra };
}

async function boot({ session = null, loginSession = null, applications = [], profiles = [], storage = new Map() } = {}) {
  const elements = new Map();
  const calls = [];
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const classes = new Set();
    const el = {
      id, value: '', textContent: '', innerHTML: '', disabled: false, hidden: false, files: [], dataset: {}, listeners: {},
      parentElement: { hidden: false },
      classList: {
        add: (...names) => names.forEach(n => classes.add(n)),
        remove: (...names) => names.forEach(n => classes.delete(n)),
        contains: name => classes.has(name),
        toggle: (name, on) => { const next = on === undefined ? !classes.has(name) : Boolean(on); next ? classes.add(name) : classes.delete(name); return next; },
      },
      addEventListener: (name, fn) => { el.listeners[name] = fn; },
      setAttribute: () => {}, focus: () => {}, contains: () => false, closest: () => null,
      querySelector: () => element(`${id}-child`), querySelectorAll: () => [],
    };
    elements.set(id, el);
    return el;
  }
  const navItems = VIEWS.filter(v => !['login', 'detail'].includes(v)).map(view => Object.assign(element(`nav-${view}`), { dataset: { view } }));
  const views = VIEWS.map(view => element(`view-${view}`));
  const steps = [0, 1, 2, 3].map(i => element(`step${i}`));
  const body = element('body');
  const server = {
    applications, profiles,
    reply(path, options = {}) {
      if (path === '/applications') return applications;
      if (path === '/borrower-profiles') return profiles;
      if (path.endsWith('/evaluation-report')) return { cid: 'bafyreport', hash: '0xreport', appraisedValue: JSON.parse(options.body).appraisedValue, bankWallet: BANK };
      if (path.endsWith('/credit-score')) return { grade: 'CC', source: '모의 신용평가 (외부 연동 전)', asOf: '2026-10-20' };
      if (path.endsWith('/evaluation')) return applications.find(a => path.includes(a.id));
      throw new Error('unexpected ' + path);
    },
  };
  let currentSession = session;
  const chain = {
    ended: null,
    async init(base, onEnd) { chain.ended = onEnd; },
    session: () => currentSession,
    async restore() { return currentSession; },
    async login() { currentSession = loginSession; return currentSession; },
    async logout() { currentSession = null; calls.push(['logout']); },
    authHeaders: () => currentSession ? { Authorization: 'Bearer session-token' } : {},
    config: () => ({ enabled: true, networkName: 'Mustsem', blockNumber: 4200, contractVersion: 3 }),
    async loadConfig() { return chain.config(); },
    async api(path, options = {}) { calls.push(['api', path, options]); return JSON.parse(JSON.stringify(server.reply(path, options))); },
    async blob() { return {}; },
    openBlob: () => {},
    async connect(role, expected) { calls.push(['connect', role, expected]); return {}; },
    async register(app) { calls.push(['register', app.id]); return { ...app, chainStatus: 'Evaluating', status: 'evaluating' }; },
    async evaluate(app, report) { calls.push(['evaluate', app.id, report]); return { ...app, chainStatus: 'Eligible', status: 'review', reportHash: report.hash }; },
    async approve(app, yes, terms) { calls.push(['approve', app.id, yes, terms]); return { ...app, chainStatus: yes ? 'Approved' : 'Rejected', status: yes ? 'approved' : 'rejected' }; },
    async sync(app) { return app; },
    async document() {},
  };
  class FakeFormData { constructor() { this.entries = []; } append(key, value) { this.entries.push([key, value]); } }
  class FakeXHR {
    open(method, url) { this.request = { method, url, headers: {} }; }
    setRequestHeader(name, value) { this.request.headers[name] = value; }
    send(form) {
      this.request.form = form;
      calls.push(['upload', this.request]);
      this.status = 201;
      this.responseText = JSON.stringify(baseApplication({ id: 'LN-2026-200002', status: 'pending', chainStatus: 'None', access: ['borrower'],
        evaluation: { status: 'queued', artifacts: [] }, docFileHash: '0xdoc', docCid: 'bafydoc',
        borrowerProfile: { id: 'profile-1', company: '테스트 기업', bizNo: '123-45-67890', ceo: '대표', contact: '010' } }));
      this.onload();
    }
  }
  FakeXHR.prototype.upload = {};
  const context = vm.createContext({
    console, IPLoanChain: chain, FormData: FakeFormData, XMLHttpRequest: FakeXHR,
    URL: { createObjectURL: () => 'blob:preview', revokeObjectURL: () => {} },
    location: { hostname: '127.0.0.1' },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    confirm: () => true,
    document: {
      body, hidden: false,
      getElementById: element,
      querySelector: selector => element(selector),
      querySelectorAll: selector => selector === '.nav-item' ? navItems : selector === '.view' ? views : selector === '#applySteps .step' ? steps : [],
      addEventListener: () => {},
    },
    setTimeout: fn => { fn(); return 1; }, clearTimeout: () => {}, setInterval: () => 1,
  });
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const run = code => vm.runInContext(code, context);
  const activeView = () => VIEWS.find(view => element(`view-${view}`).classList.contains('active'));
  const visibleNav = () => navItems.filter(item => !item.parentElement.hidden).map(item => item.dataset.view);
  return { element, calls, chain, run, activeView, visibleNav, body, storage };
}

test('logged out: only the login screen is available and no applications are requested', async () => {
  const h = await boot();
  assert.equal(h.activeView(), 'login');
  assert.ok(h.body.classList.contains('logged-out'));
  assert.equal(h.element('loginBtnTop').hidden, false);
  assert.ok(!h.calls.some(call => call[0] === 'api'));
  h.run("goView('apply')");
  assert.equal(h.activeView(), 'login');
});

test('a restored session opens the dashboard with the menus of the chosen on-chain role', async () => {
  const h = await boot({ session: { address: WALLET, roles: ['borrower'] }, profiles: [{ id: 'p1', company: '저장 기업', bizNo: '123-45-67890', ceo: '대표', contact: '010' }] });
  assert.equal(h.activeView(), 'dashboard');
  assert.equal(h.body.classList.contains('logged-out'), false);
  assert.deepEqual(h.visibleNav(), ['dashboard', 'list', 'apply']);
  assert.equal(h.element('userRole').textContent, '차주기업');
  assert.equal(h.element('fCompany').value, '저장 기업');
  assert.match(h.element('blockNo').textContent, /4,200/);
});

test('role menu lists only roles held on chain and switching changes the work screens', async () => {
  const h = await boot({ session: { address: WALLET, roles: ['bank', 'evaluator'] } });
  const options = h.element('roleOptions').innerHTML;
  assert.match(options, /IP 가치평가사/); assert.match(options, /은행 여신심사역/); assert.doesNotMatch(options, /차주기업/);
  assert.deepEqual(h.visibleNav(), ['dashboard', 'evaluate', 'archive']);
  h.run("setRole('bank')");
  assert.deepEqual(h.visibleNav(), ['dashboard', 'list', 'review', 'archive']);
  assert.equal(h.storage.get('iploan-role'), 'bank');
});

test('a wallet without roles stays on the login screen with guidance', async () => {
  const h = await boot({ loginSession: { address: WALLET, roles: [] } });
  await h.run('doLogin()');
  assert.equal(h.activeView(), 'login');
  assert.match(h.element('loginHelp').textContent, /등록된 역할이 없습니다/);
  assert.equal(h.element('userChip').hidden, false);
});

test('ending the session (account switch or expiry) returns to the login screen', async () => {
  const h = await boot({ session: { address: WALLET, roles: ['evaluator'] }, applications: [baseApplication()] });
  h.chain.ended();
  assert.equal(h.activeView(), 'login');
  assert.equal(h.run('APPLICATIONS.length'), 0);
});

test('borrower application uploads both documents with the session and then registers on chain', async () => {
  const h = await boot({ session: { address: WALLET, roles: ['borrower'] }, profiles: [] });
  h.run("goView('apply')");
  for (const [id, value] of [['fCompany', '테스트 기업'], ['fBizNo', '123-45-67890'], ['fCeo', '대표'], ['fPhone', '010'], ['fIpType', '특허권'],
    ['fIpNo', '10-2026-1'], ['fIpTitle', '테스트 특허'], ['fAmount', '70,000,000'], ['fTerm', '24']]) h.element(id).value = value;
  h.element('patentInput').files = [];
  h.element('fileInput').files = [{ name: 'registry.pdf', size: 100 }];
  await h.element('applyForm').listeners.submit({ preventDefault() {} });
  assert.match(h.element('applyError').textContent, /공고전문/);
  assert.ok(!h.calls.some(call => call[0] === 'upload'));

  h.element('patentInput').files = [{ name: 'gazette.pdf', size: 200 }];
  await h.element('applyForm').listeners.submit({ preventDefault() {} });
  const upload = h.calls.find(call => call[0] === 'upload')[1];
  assert.equal(upload.headers.Authorization, 'Bearer session-token');
  const fields = Object.fromEntries(upload.form.entries.map(([k, v]) => [k, typeof v === 'object' ? v.name : v]));
  assert.deepEqual([fields.registryDocument, fields.patentDocument, fields.termMonths, fields.amount], ['registry.pdf', 'gazette.pdf', '24', '70000000']);
  assert.ok(!('borrowerWallet' in fields));
  assert.deepEqual(h.calls.find(call => call[0] === 'connect').slice(1), ['BORROWER_ROLE', undefined]);
  assert.deepEqual(h.calls.find(call => call[0] === 'register'), ['register', 'LN-2026-200002']);
  assert.equal(h.element('genChainState').textContent, 'Evaluating');
});

test('evaluator confirms the completed LLM report: wallet first, then report registration, then the chain transaction', async () => {
  const h = await boot({ session: { address: EVALUATOR, roles: ['evaluator'] }, applications: [baseApplication()] });
  h.run("goView('evaluate')");
  assert.match(h.element('evalReportPanel').innerHTML, /가치평가 확정 \(MetaMask 서명\)/);
  assert.match(h.element('evalReportPanel').innerHTML, /report-preview/);
  h.element('appraisalValue').value = '100,000,000';
  h.element('appraisalNote').value = '근거 확인';
  await h.run("confirmEval('LN-2026-100001')");
  const order = h.calls.filter(call => ['connect', 'api', 'evaluate'].includes(call[0]) && call[1] !== '/applications').map(call => call[0] === 'api' ? call[1] : call[0]);
  assert.deepEqual(order, ['connect', '/applications/LN-2026-100001/evaluation-report', 'evaluate']);
  const request = h.calls.find(call => call[1] === '/applications/LN-2026-100001/evaluation-report')[2];
  assert.deepEqual(JSON.parse(request.body), { appraisedValue: 100000000, note: '근거 확인' });
  assert.equal(h.calls.find(call => call[0] === 'evaluate')[2].bankWallet, BANK);
  assert.equal(h.run("findApp('LN-2026-100001').chainStatus"), 'Eligible');
});

test('report not finished or not yet registered on chain cannot be confirmed', async () => {
  const running = baseApplication({ evaluation: { status: 'running', stage: 'analysis', artifacts: [] } });
  const unregistered = baseApplication({ id: 'LN-2026-100002', chainStatus: 'None', status: 'pending' });
  const h = await boot({ session: { address: EVALUATOR, roles: ['evaluator'] }, applications: [running, unregistered] });
  h.run("selectEvalItem('LN-2026-100001')");
  assert.doesNotMatch(h.element('evalReportPanel').innerHTML, /evalConfirmForm/);
  assert.match(h.element('evalReportPanel').innerHTML, /현재 단계: analysis/);
  h.run("selectEvalItem('LN-2026-100002')");
  assert.doesNotMatch(h.element('evalReportPanel').innerHTML, /evalConfirmForm/);
  assert.match(h.element('evalReportPanel').innerHTML, /온체인 등록을 완료하지 않았습니다/);
});

test('bank loads the demo credit grade and approves with the loan agreement terms', async () => {
  const eligible = baseApplication({ chainStatus: 'Eligible', status: 'review', bankWallet: BANK, access: ['bank'], appraisedValue: 100000000, ltv: 70 });
  const h = await boot({ session: { address: BANK, roles: ['bank'] }, applications: [eligible] });
  h.run("goView('review')");
  assert.match(h.element('reviewBody').innerHTML, /신용평가 불러오기/);
  assert.equal(h.element('loanTerm').value, '');  // the template sets value="24"; the harness does not parse HTML
  await h.element('loadCreditBtn').listeners.click();
  assert.equal(h.element('creditGrade').value, 'CC');
  assert.match(h.element('creditHelp').textContent, /모의 신용평가/);
  h.element('creditGrade').value = 'bb+';
  h.element('loanRate').value = '4.35';
  h.element('loanTerm').value = '24';
  await h.run("finalChainDecision('LN-2026-100001', true)");
  // Objects built inside the VM have another realm's prototype, so compare plain JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(call => call[0] === 'approve').slice(2))), [true, { creditGrade: 'BB+', rateBps: 435, termMonths: 24 }]);
  assert.equal(h.run("findApp('LN-2026-100001').chainStatus"), 'Approved');
});

test('invalid loan terms are refused before the wallet is asked to sign', async () => {
  const eligible = baseApplication({ chainStatus: 'Eligible', status: 'review', bankWallet: BANK, access: ['bank'] });
  const h = await boot({ session: { address: BANK, roles: ['bank'] }, applications: [eligible] });
  h.run("loadReviewCase('LN-2026-100001')");
  for (const [grade, rate, term] of [['', '4', '12'], ['B B', '4', '12'], ['CC', '0', '12'], ['CC', '4', '0'], ['CC', '4', '601']]) {
    h.element('creditGrade').value = grade; h.element('loanRate').value = rate; h.element('loanTerm').value = term;
    await h.run("finalChainDecision('LN-2026-100001', true)");
  }
  assert.ok(!h.calls.some(call => call[0] === 'approve'));
});

test('applications on the previous contract are read-only', async () => {
  const old = baseApplication({ contractOutdated: true, access: ['evaluator'] });
  const h = await boot({ session: { address: EVALUATOR, roles: ['evaluator'] }, applications: [old] });
  h.run("selectEvalItem('LN-2026-100001')");
  assert.match(h.element('evalReportPanel').innerHTML, /이전 계약\(v2\)/);
  assert.doesNotMatch(h.element('evalReportPanel').innerHTML, /evalConfirmForm/);
});

test('archive lists only the imported LLM reports and shows the earlier confirmation', async () => {
  const archived = { id: 'LN-2026-348055', company: '보관 기업', ipTitle: '보관 특허', status: 'archived', appraisedValue: 100, creditScore: 80, access: ['archive'],
    evaluation: { status: 'completed', job_id: 'job-old', artifacts: ['pdf'], confirmed_at: '2026-10-20T01:00:00+00:00', reviewer_note: '검토 완료' } };
  const h = await boot({ session: { address: EVALUATOR, roles: ['evaluator'] }, applications: [archived, baseApplication()] });
  h.run("goView('archive')");
  assert.match(h.element('archiveListItems').innerHTML, /보관 기업/);
  assert.doesNotMatch(h.element('archiveListItems').innerHTML, /테스트 기업/);
  assert.match(h.element('archivePanel').innerHTML, /검토 완료/);
  assert.doesNotMatch(h.element('evalListItems').innerHTML, /보관 기업/);
});
