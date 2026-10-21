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
      if (options.method === 'DELETE') return { status: 'deleted' };
      if (path === '/documents/fields') return { ipType: '실용신안권', ipTitle: '접이식 거치대', ipRegNo: '20-2023-0001234' };
      if (path.endsWith('/evaluation')) return applications.find(a => path.includes(a.id));
      throw new Error('unexpected ' + path);
    },
  };
  let currentSession = session;
  const chain = {
    ended: null,
    async init(base, onChange) { chain.ended = onChange; },
    setSession(value) { currentSession = value; },
    session: () => currentSession,
    async restore() { return currentSession; },
    async login(options) { calls.push(['login', options]); currentSession = loginSession; return currentSession; },
    async watchNft(address, tokenId) { calls.push(['watchNft', address, String(tokenId)]); },
    async logout() { currentSession = null; calls.push(['logout']); },
    authHeaders: () => currentSession ? { Authorization: 'Bearer session-token' } : {},
    config: () => ({ enabled: true, networkName: 'Mustsem', blockNumber: 4200, contractVersion: 3, rwaTokenAddress: '0xrwa', accessSBTAddress: '0xsbt' }),
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
  class FakeDataTransfer { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } }
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
    console, IPLoanChain: chain, FormData: FakeFormData, XMLHttpRequest: FakeXHR, DataTransfer: FakeDataTransfer,
    window: { addEventListener: () => {} },
    URL: { createObjectURL: () => 'blob:preview', revokeObjectURL: () => {} },
    location: { hostname: '127.0.0.1' },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    confirm: message => { calls.push(['confirm', message]); return true; },
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

test('a restored session opens the work screen and menus of the chosen on-chain role', async () => {
  const h = await boot({ session: { address: WALLET, roles: ['borrower'] }, profiles: [{ id: 'p1', company: '저장 기업', bizNo: '123-45-67890', ceo: '대표', contact: '010' }] });
  assert.equal(h.activeView(), 'apply');  // a borrower without applications starts on the application form
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
  h.chain.ended('ended');
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
  assert.equal(h.element('genChainState').textContent, '등록 완료');
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
  assert.match(h.element('evalReportPanel').innerHTML, /신청 서명이 끝나면/);
});

test('the bank enters the credit grade (prefilled from the report when it has one) and approves with the terms', async () => {
  const eligible = baseApplication({ chainStatus: 'Eligible', status: 'review', bankWallet: BANK, access: ['bank'], appraisedValue: 100000000, ltv: 70 });
  const h = await boot({ session: { address: BANK, roles: ['bank'] }, applications: [eligible] });
  h.run("goView('review')");
  assert.doesNotMatch(h.element('reviewBody').innerHTML, /불러오기/);
  assert.match(h.element('reviewBody').innerHTML, /은행 CB 조회 결과를 입력하세요/);
  const rated = await boot({ session: { address: BANK, roles: ['bank'] },
    applications: [{ ...eligible, evaluation: { ...eligible.evaluation, credit_rating: 'BB' } }] });
  assert.match(rated.element('reviewBody').innerHTML, /id="creditGrade"[^>]*value="BB"/);
  assert.match(rated.element('reviewBody').innerHTML, /평가보고서 회사자료 기준 등급/);
  assert.equal(h.element('loanTerm').value, '');  // the template sets value="24"; the harness does not parse HTML
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
  assert.match(h.element('evalReportPanel').innerHTML, /이전 시스템에서 접수된 신청/);
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

const SUMMARY = {
  valuation: { ip_value_krw: 120000000, value_status: 'preliminary', valuation_date: '2026-10-20', report_number: 'MT-1' },
  financials: [
    { year: 2024, fiscal_date: '2024-12-31', fiscal_date_assumed: false, source_label: 'NICE BizAPI', revenue_krw: 5875000000,
      operating_income_krw: -365170000, total_equity_krw: -505540000, capital_impaired: true, debt_ratio_pct: null, current_ratio_pct: 8.84 },
    { year: 2025, fiscal_date: '2025-12-31', fiscal_date_assumed: true, source_label: '회사 제출 자료', revenue_krw: 400000,
      total_equity_krw: 10000000, capital_impaired: false, debt_ratio_pct: 85.81 },
  ],
  financial_checks: [
    { key: 'capital', label: '자본잠식 없음', criterion: '자본총계 0원 초과', year: 2025, result: 'fail', observed: '자본잠식 (자본총계 -506백만원)' },
    { key: 'interest_coverage', label: '이자보상배율', criterion: '영업이익이 금융비용의 1배 이상', year: 2025, result: 'unknown', observed: '자료 없음' },
  ],
};

test('evaluator sees the LLM figure with its LTV and must explain confirming a different value', async () => {
  const app = baseApplication({ evaluation: { status: 'completed', job_id: 'job-1', artifacts: ['pdf'], ...SUMMARY } });
  const h = await boot({ session: { address: EVALUATOR, roles: ['evaluator'] }, applications: [app] });
  h.run("goView('evaluate')");
  const panel = h.element('evalReportPanel').innerHTML;
  assert.match(panel, /120,000,000원/);
  assert.match(panel, /사전평가 초안 · 확정 평가액 아님/);
  assert.match(panel, /담보인정비율 58\.3% · 자동심사 통과 예상/);
  assert.match(panel, /LLM 산정액과 다르게 확정하면 필수/);
  h.element('useLlmValueBtn').listeners.click();
  assert.equal(h.element('appraisalValue').value, '120,000,000');
  assert.match(h.element('appraisalLtv').textContent, /58\.3%/);
  h.element('appraisalValue').value = '150,000,000';
  h.element('appraisalNote').value = '';
  await h.run("confirmEval('LN-2026-100001')");
  assert.match(h.element('toast').textContent, /평가 의견에 사유/);
  assert.ok(!h.calls.some(call => call[0] === 'connect'));
  h.element('appraisalValue').value = '120,000,000';
  await h.run("confirmEval('LN-2026-100001')");
  const request = h.calls.find(call => call[1] === '/applications/LN-2026-100001/evaluation-report')[2];
  assert.deepEqual(JSON.parse(request.body), { appraisedValue: 120000000, note: '' });
});

test('a non-positive or missing LLM figure is never offered as the collateral value', async () => {
  const negative = baseApplication({ evaluation: { status: 'completed', artifacts: ['pdf'], valuation: { ip_value_krw: -235061, value_status: 'preliminary' } } });
  const missing = baseApplication({ id: 'LN-2026-100002' });
  const h = await boot({ session: { address: EVALUATOR, roles: ['evaluator'] }, applications: [negative, missing] });
  h.run("selectEvalItem('LN-2026-100001')");
  assert.match(h.element('evalReportPanel').innerHTML, /-235,061원/);
  assert.match(h.element('evalReportPanel').innerHTML, /산정액이 0원 이하입니다/);
  assert.doesNotMatch(h.element('evalReportPanel').innerHTML, /useLlmValueBtn/);
  h.run("selectEvalItem('LN-2026-100002')");
  assert.match(h.element('evalReportPanel').innerHTML, /산정액이 없습니다/);
  assert.match(h.element('evalReportPanel').innerHTML, /<span class="optional">선택<\/span>/);
});

test('bank sees the LLM financial reference checks, and missing data is shown as undecidable', async () => {
  const eligible = baseApplication({ chainStatus: 'Eligible', status: 'review', bankWallet: BANK, access: ['bank'], appraisedValue: 100000000,
    ltv: 70, evaluation: { status: 'completed', artifacts: ['pdf'], ...SUMMARY } });
  const bare = baseApplication({ id: 'LN-2026-100002', chainStatus: 'Eligible', status: 'review', bankWallet: BANK, access: ['bank'],
    evaluation: { status: 'completed', artifacts: ['pdf'], financials: [], financial_checks: SUMMARY.financial_checks.map(c => ({ ...c, result: 'unknown' })) } });
  const h = await boot({ session: { address: BANK, roles: ['bank'] }, applications: [eligible, bare] });
  h.run("loadReviewCase('LN-2026-100001')");
  const body = h.element('reviewBody').innerHTML;
  assert.match(body, /재무 참고 점검 <span class="hint">참고용/);
  assert.match(body, /LLM 산정액 120,000,000원 \(사전평가 초안\) · 확정 평가액 100,000,000원/);
  assert.match(body, /check-item failed[\s\S]*자본잠식 \(자본총계 -506백만원\)/);
  assert.match(body, /check-item not-applied[\s\S]*판정 불가 \(자료 없음\)/);
  assert.match(body, /2025-12-31 \(추정\)/);
  assert.match(body, /<td class="num">-365<\/td>/);
  assert.match(body, /<td class="num">자본잠식<\/td>/);
  assert.match(body, /2024년 NICE BizAPI · 2025년 회사 제출 자료/);
  h.run("loadReviewCase('LN-2026-100002')");
  const financial = h.element('reviewBody').innerHTML.split('재무 참고 점검')[1];
  assert.match(financial, /재무자료가 없습니다/);
  assert.match(financial, /LLM 산정액 미제공/);
  assert.doesNotMatch(financial, /check-item (verified|failed)/);
});

test('switching MetaMask accounts resumes a signed-in wallet on its work screen and asks a new wallet to sign in', async () => {
  const mine = baseApplication({ id: 'LN-2026-100001', access: ['borrower'] });
  const assigned = baseApplication({ id: 'LN-2026-100002', access: ['evaluator'] });
  const h = await boot({ session: { address: WALLET, roles: ['borrower'] }, applications: [mine, assigned],
    loginSession: { address: BANK, roles: ['bank'] } });
  assert.equal(h.activeView(), 'list');  // the borrower starts on the application list
  h.chain.setSession({ address: EVALUATOR, roles: ['evaluator'] });
  await h.chain.ended('switched');
  assert.equal(h.activeView(), 'evaluate');
  assert.match(h.element('toast').textContent, /IP 가치평가사\(으\)로 전환/);
  assert.ok(!h.calls.some(call => call[0] === 'login'));
  h.chain.setSession(null);
  await h.chain.ended('signin');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(call => call[0] === 'login')[1])), { pick: false });
  assert.equal(h.activeView(), 'review');
});

test('the bank shows the RWA token of an approved loan in MetaMask', async () => {
  const approved = baseApplication({ chainStatus: 'Approved', status: 'approved', bankWallet: BANK, rwaTokenId: '1', access: ['bank'] });
  const h = await boot({ session: { address: BANK, roles: ['bank'] }, applications: [approved] });
  assert.match(h.element('reviewBody').innerHTML, /showRwaToken\('1'\)">MetaMask에서 RWA 토큰 확인/);
  await h.run("showRwaToken('1')");
  assert.deepEqual(h.calls.filter(call => call[0] === 'watchNft'), [['watchNft', '0xrwa', '1']]);
  assert.match(h.element('toast').textContent, /MetaMask에서 RWA 토큰을 확인할 수 있습니다/);
  const evaluating = await boot({ session: { address: EVALUATOR, roles: ['evaluator'] }, applications: [baseApplication({ sbtTokenId: '7' })] });
  assert.doesNotMatch(evaluating.element('evalReportPanel').innerHTML, /MetaMask에서/);
});

test('the minimum passing value matches the contract rule exactly (amount × 100 ≤ value × 70)', async () => {
  const h = await boot({ session: { address: EVALUATOR, roles: ['evaluator'] }, applications: [baseApplication({ amount: 30000000 })] });
  assert.match(h.element('evalReportPanel').innerHTML, /42,857,143원/);
  for (const [amount, minimum] of [[21, 30], [7, 10], [70000000, 100000000]]) {
    assert.equal(h.run(`minimumPassingValue(${amount})`), minimum);
    assert.equal(h.run(`passesLtv(${amount}, ${minimum})`), true);
    assert.equal(h.run(`passesLtv(${amount}, ${minimum - 1})`), false);
  }
});

test('the confirmation shows whether the value passes the automatic review', async () => {
  const h = await boot({ session: { address: EVALUATOR, roles: ['evaluator'] }, applications: [baseApplication({ amount: 30000000 })] });
  h.run("goView('evaluate')");
  h.element('appraisalValue').value = '10,000';
  h.element('appraisalNote').value = '가치가 낮음';
  await h.run("confirmEval('LN-2026-100001')");
  assert.match(h.calls.find(call => call[0] === 'confirm')[1], /자동심사 거절 예상 \(70% 초과\)/);
});

test('bank reviewers see automatic rejections read-only, and the progress stops at the rejected step', async () => {
  const ruled = baseApplication({ chainStatus: 'RuleRejected', status: 'rejected', access: ['bank_notice'], appraisedValue: 10000, ltv: 300000,
    rejectReason: '컨트랙트 자동심사: 신청금액이 평가액의 70%를 초과했습니다.' });
  const h = await boot({ session: { address: BANK, roles: ['bank'] }, applications: [ruled] });
  assert.equal(h.activeView(), 'review');
  const body = h.element('reviewBody').innerHTML;
  assert.match(body, /자동심사 결과 — 거절/);
  assert.doesNotMatch(body, /loanTermsForm|체인 확인·복구|신용평가 불러오기/);
  assert.match(body, /등록된 평가보고서 열람/);
  assert.match(h.element('reviewListItems').innerHTML, /거절/);
  const b = await boot({ session: { address: WALLET, roles: ['borrower'] }, applications: [{ ...ruled, access: ['borrower'] }] });
  assert.equal(b.activeView(), 'list');
  b.run("openDetail('LN-2026-100001')");
  const steps = b.element('detailSteps').innerHTML;
  assert.match(steps, /step rejected[\s\S]*평가 확정·심사[\s\S]*거절/);
  assert.doesNotMatch(steps.split('평가 확정·심사')[1], /완료/);
});

test('the login button signs in with the selected account; only "다른 계정 연결" opens the account picker', async () => {
  const h = await boot({ loginSession: { address: WALLET, roles: ['borrower'] } });
  await h.element('loginBtn').listeners.click();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.filter(c => c[0] === 'login').map(c => c[1]))), [{ pick: false }]);
  await h.element('connectAccountsBtn').listeners.click();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.filter(c => c[0] === 'login').map(c => c[1]))), [{ pick: false }, { pick: true }]);
});

test('choosing a PDF fills the empty IP fields and keeps what the borrower typed', async () => {
  const h = await boot({ session: { address: WALLET, roles: ['borrower'] }, profiles: [] });
  h.element('fIpTitle').value = '직접 입력한 명칭';
  h.element('patentInput').files = [{ name: 'gazette.pdf', size: 100 }];
  await h.element('patentInput').listeners.change();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.calls.some(call => call[1] === '/documents/fields'));
  assert.equal(h.element('fIpType').value, '실용신안권');
  assert.equal(h.element('fIpNo').value, '20-2023-0001234');
  assert.equal(h.element('fIpTitle').value, '직접 입력한 명칭');
  assert.match(h.element('toast').textContent, /PDF에서 IP 정보를 채웠습니다/);
});

test('dropping a PDF on an upload box chooses it and fills the IP fields; other files are refused', async () => {
  const h = await boot({ session: { address: WALLET, roles: ['borrower'] }, profiles: [] });
  const drop = files => h.element('patentBox').listeners.drop({ preventDefault() {}, dataTransfer: { files } });
  drop([{ name: 'notes.txt', size: 10 }]);
  assert.match(h.element('toast').textContent, /PDF 파일을 놓아 주세요/);
  assert.equal(h.element('patentInput').files.length, 0);
  drop([{ name: 'Gazette.PDF', size: 100 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.element('patentInput').files[0].name, 'Gazette.PDF');
  assert.equal(h.element('patentNameDisplay').textContent, 'Gazette.PDF');
  assert.equal(h.element('fIpTitle').value, '접이식 거치대');
});

test('an administrator can delete an application from the review list or the detail screen', async () => {
  const eligible = baseApplication({ chainStatus: 'Eligible', status: 'review', bankWallet: BANK, access: ['bank', 'admin'] });
  const h = await boot({ session: { address: BANK, roles: ['bank', 'admin'] }, applications: [eligible] });
  assert.equal(h.activeView(), 'review');
  assert.match(h.element('reviewBody').innerHTML, /신청 기록 삭제/);
  await h.run("deleteApplication('LN-2026-100001')");
  const request = h.calls.find(call => call[1] === '/applications/LN-2026-100001' && call[2].method === 'DELETE');
  assert.ok(request);
  assert.equal(h.run('APPLICATIONS.length'), 0);
  assert.match(h.element('reviewBody').innerHTML, /배정된 심사 건이 없습니다/);
  assert.match(h.element('toast').textContent, /삭제했습니다/);
  const bank = await boot({ session: { address: BANK, roles: ['bank'] }, applications: [{ ...eligible, access: ['bank'] }] });
  assert.doesNotMatch(bank.element('reviewBody').innerHTML, /신청 기록 삭제/);
  const admin = await boot({ session: { address: WALLET, roles: ['admin'] }, applications: [{ ...eligible, access: ['admin'] }] });
  admin.run("openDetail('LN-2026-100001')");
  assert.match(admin.element('detailDocs').innerHTML, /신청 기록 삭제/);
});
