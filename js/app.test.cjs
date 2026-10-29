// Lightweight DOM/API harness. Real browser/IPFS integration is tested separately.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');

async function boot(storage = new Map([['iploan-role', 'borrower']]), server = null, chain = null) {
  server ||= {
    profiles: [
      { id: 'green', company: '(주)그린파머스', bizNo: '208-86-41029', ceo: '김대표', contact: '010-1111-2222' },
      { id: 'other', company: '다른 기업', bizNo: '123-45-67890', ceo: '박대표', contact: '02-1234-5678' },
    ],
    applications: [
      { id: 'LN-1', company: '옛 기업명', borrowerProfileId: 'green', ceo: '옛 대표', status: 'pending' },
      { id: 'LN-2', company: '다른 기업', borrowerProfileId: 'other', status: 'pending' },
    ],
  };
  const elements = new Map();
  const timers = [];
  function element(id) {
    // Removed HTML must not leave any JS references that would cause a null access.
    if (id === 'saveBorrowerProfileBtn') return null;
    if (elements.has(id)) return elements.get(id);
    const classes = new Set();
    const el = {
      value: '', textContent: '', innerHTML: '', disabled: false, hidden: false,
      files: [], dataset: {}, listeners: {},
      classList: {
        add: (...names) => names.forEach(n => classes.add(n)),
        remove: (...names) => names.forEach(n => classes.delete(n)),
        contains: name => classes.has(name),
        toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
      },
      addEventListener: (name, fn) => { el.listeners[name] = fn; },
      querySelectorAll: () => [],
      setAttribute: () => {},
      reportValidity: () => Boolean(el.value.trim()),
      reset: () => {
        let prevented = false;
        el.listeners.reset?.({ preventDefault: () => { prevented = true; } });
        if (!prevented) {
          for (const field of ['fCompany', 'fBizNo', 'fCeo', 'fPhone', 'fIpTitle']) element(field).value = '';
          element('fileInput').files = [];
          element('borrowerProfileSelect').value = 'green';
        }
      },
    };
    elements.set(id, el);
    return el;
  }
  const steps = Array.from({ length: 4 }, (_, i) => element(`step${i}`));
  const clone = value => JSON.parse(JSON.stringify(value));
  let uploadedFields;
  let uploadCount = 0;
  const context = vm.createContext({
    console,
    ...(chain ? { IPLoanChain: chain } : {}),
    location: { hostname: '127.0.0.1' },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    document: {
      getElementById: element,
      querySelector: element,
      querySelectorAll: selector => selector === '#applySteps .step' ? steps : [],
      addEventListener: () => {},
    },
    window: { addEventListener: () => {} },
    DataTransfer: class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } },
    Event: class { constructor(type) { this.type = type; } },
    setTimeout: fn => { timers.push(fn); return timers.length; },
    clearTimeout: () => {}, setInterval: () => {},
    fetch: async (url, options = {}) => {
      let body;
      if (url.endsWith('/documents/fields')) {
        server.fieldRequests = [...(server.fieldRequests || []), options];
        body = server.pdfFields || {};
      } else if (url.endsWith('/applications')) body = server.applications;
      else if (url.endsWith('/evaluation')) body = server.evaluation;
      else if (options.method === 'PATCH' || options.method === 'POST') {
        const id = options.method === 'PATCH' ? url.split('/').pop() : 'new-profile';
        const old = server.profiles.find(p => p.id === id);
        body = { ...old, ...JSON.parse(options.body), id };
        if (old) Object.assign(old, body);
        else server.profiles.push(body);
      } else body = server.profiles;
      return { ok: true, json: async () => clone(body) };
    },
    FormData: class { constructor() { this.fields = {}; } append(key, value) { this.fields[key] = value; } },
    XMLHttpRequest: class {
      constructor() { this.upload = {}; }
      open() {}
      send(form) {
        uploadCount++;
        uploadedFields = form.fields;
        if (server.uploadError) {
          this.status = 504;
          this.responseText = JSON.stringify({ message: server.uploadError });
          this.onload();
          return;
        }
        const id = form.fields.borrowerProfileId || 'new-profile';
        const profile = { id, ...Object.fromEntries(['company', 'bizNo', 'ceo', 'contact'].map(k => [k, form.fields[k]])) };
        const old = server.profiles.find(p => p.id === id);
        if (old) Object.assign(old, profile);
        else server.profiles.push(profile);
        const application = { id: 'LN-3', ...form.fields, borrowerProfileId: id, status: 'doc_verify', docCid: 'test-cid', docFileHash: 'test-hash', ...server.chainFields };
        server.applications.push(application);
        this.status = 201;
        this.responseText = JSON.stringify({ ...application, borrowerProfile: profile });
        this.onload();
      }
    },
  });
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return {
    element, server, storage,
    run: expression => vm.runInContext(expression, context),
    flushTimers: () => { while (timers.length) timers.shift()(); },
    uploaded: () => uploadedFields,
    uploads: () => uploadCount,
  };
}

test('double click while wallet is connecting does not upload or prompt twice', async () => {
  let resolveWallet, connections = 0;
  const chain = { init: async () => {}, connect: () => { connections++; return new Promise(resolve => { resolveWallet = resolve; }); } };
  const page = await boot(undefined, null, chain);
  page.element('fileInput').files = [{ name: 'test.pdf' }];
  const submit = page.element('applyForm').listeners.submit;
  const first = submit({ preventDefault() {} });
  await submit({ preventDefault() {} });
  assert.equal(connections, 1); assert.equal(page.uploads(), 0);
  resolveWallet({ address: '0xborrower' }); await first;
  assert.equal(page.uploads(), 1);
});

test('cancelled post-upload registration retries same application without reupload; form reset clears stale result', async () => {
  let attempts = 0;
  const chain = { init: async () => {}, connect: async () => ({ address: '0xborrower' }),
    register: async app => { if (++attempts === 1) throw new Error('MetaMask 취소'); return { ...app, chainStatus: 'Evaluating', sbtTokenId: '1' }; } };
  const page = await boot(undefined, null, chain);
  page.server.chainFields = { appKey: '0xkey', chainStatus: 'None' };
  page.element('fileInput').files = [{ name: 'test.pdf' }];
  await page.element('applyForm').listeners.submit({ preventDefault() {} });
  assert.equal(page.uploads(), 1); assert.equal(page.element('retryChainBtn').hidden, false);
  await page.run('retryApplicationChain()');
  assert.equal(page.uploads(), 1); assert.equal(attempts, 2);
  assert.equal(page.run('findApp("LN-3").chainStatus'), 'Evaluating');
  page.run('resetApplyUI()');
  assert.equal(page.run('lastChainApplication'), null); assert.equal(page.element('retryChainBtn').hidden, true);
});

test('startup fills from server profile, not historical application; selection survives reload', async () => {
  const page = await boot();
  assert.equal(page.element('fCeo').value, '김대표');
  assert.equal(page.element('fBizNo').value, '208-86-41029');
  assert.equal(page.run('visibleApps()[0].id'), 'LN-1');
  const select = page.element('borrowerProfileSelect');
  select.value = 'other';
  select.listeners.change({ target: select });
  page.flushTimers();
  assert.equal(page.element('fCeo').value, '박대표');
  assert.equal(page.run('visibleApps()[0].id'), 'LN-2');
  const reloaded = await boot(page.storage, page.server);
  assert.equal(reloaded.element('borrowerProfileSelect').value, 'other');
  assert.equal(reloaded.element('fPhone').value, '02-1234-5678');
});

test('submission saves company details without changing historical applications', async () => {
  const page = await boot();
  page.element('fCompany').value = '새 기업명';
  page.element('fCeo').value = '새 대표';
  page.element('fileInput').files = [{ name: 'test.pdf' }];
  await page.element('applyForm').listeners.submit({ preventDefault() {} });
  assert.equal(page.server.profiles[0].ceo, '새 대표');
  assert.equal(page.server.profiles[0].company, '새 기업명');
  assert.equal(page.run('visibleApps()[0].id'), 'LN-1');
  assert.equal(page.server.applications[0].ceo, '옛 대표');
  assert.equal(page.server.profiles[1].ceo, '박대표');
  const reloaded = await boot(page.storage, page.server);
  assert.equal(reloaded.element('fCeo').value, '새 대표');
});

test('successful application sends profile ID, CEO and contact and prefills next application', async () => {
  const page = await boot();
  page.element('fCeo').value = '신청 대표';
  page.element('fPhone').value = '010-9876-5432';
  page.element('fileInput').files = [{ name: 'test.pdf' }];
  await page.element('applyForm').listeners.submit({ preventDefault() {} });
  assert.equal(page.uploaded().borrowerProfileId, 'green');
  assert.equal(page.uploaded().ceo, '신청 대표');
  assert.equal(page.uploaded().contact, '010-9876-5432');
  page.element('applyForm').reset();
  page.flushTimers();
  assert.equal(page.element('fCeo').value, '신청 대표');
  assert.equal(page.element('fPhone').value, '010-9876-5432');
  assert.equal(page.element('applySubmitBtn').disabled, false);
});

test('new company selection creates a separate profile only upon submission', async () => {
  const page = await boot();
  const select = page.element('borrowerProfileSelect');
  select.value = '';
  select.listeners.change({ target: select });
  page.flushTimers();
  assert.equal(page.element('fCeo').value, '');
  assert.equal(page.run('visibleApps().length'), 0);
  for (const [id, value] of Object.entries({ fCompany: '신규 기업', fBizNo: '123', fCeo: '신규 대표', fPhone: '010' })) {
    page.element(id).value = value;
  }
  assert.equal(page.server.profiles.length, 2);
  page.element('fileInput').files = [{ name: 'test.pdf' }];
  await page.element('applyForm').listeners.submit({ preventDefault() {} });
  assert.equal(page.server.profiles.length, 3);
  assert.equal(page.element('borrowerProfileSelect').value, 'new-profile');
  assert.equal(page.server.profiles[0].ceo, '김대표');
});

test('failed submission does not save company edits', async () => {
  const page = await boot();
  page.server.uploadError = 'IPFS 업로드 시간 초과';
  page.element('fCeo').value = '저장되면 안 되는 대표';
  page.element('fileInput').files = [{ name: 'test.pdf' }];
  await page.element('applyForm').listeners.submit({ preventDefault() {} });
  assert.equal(page.server.profiles[0].ceo, '김대표');
  assert.equal(page.server.applications.length, 2);
  assert.equal(page.element('applySubmitBtn').disabled, false);
  assert.equal(page.element('fileHelpText').textContent, page.server.uploadError);
  const reloaded = await boot(page.storage, page.server);
  assert.equal(reloaded.element('fCeo').value, '김대표');
});

function addReviewCase(page, changes = {}) {
  const app = { id: 'CHAIN-REVIEW', company: '심사 테스트 기업', ipTitle: '테스트 특허',
    ipRegNo: '10-2026-0000001', amount: 70000000, appraisedValue: 100000000,
    ltv: 70, status: 'review', hashMatch: 1, appKey: '0xkey', chainStatus: 'Eligible',
    bankWallet: '0xB3Ec5f2bbB80e90ec457165d13EF469893a54951', chainId: 7601,
    repaidAmount: 0, ...changes };
  page.run('APPLICATIONS.push(' + JSON.stringify(app) + ')');
  page.run('loadReviewCase(' + JSON.stringify(app.id) + ')');
  return page.element('reviewBody').innerHTML;
}

test('on-chain review reuses the exact legacy six-field summary and case header', async () => {
  const page = await boot();
  const chainHtml = addReviewCase(page);
  const summary = page.run('reviewSummaryHTML(findApp("CHAIN-REVIEW"))');
  const legacyHtml = addReviewCase(page, { id: 'LEGACY-REVIEW', appKey: null, creditScore: null });
  assert.ok(chainHtml.includes(summary)); assert.ok(legacyHtml.includes(summary));
  for (const label of ['신청금액', '산정 담보가치', '담보인정비율(LTV)', '신용평가 점수', '출원·등록번호', '상환기간']) assert.ok(summary.includes(label));
  assert.match(chainHtml, /심사 테스트 기업 · 테스트 특허/);
  assert.doesNotMatch(chainHtml, /시범 온체인 신청/);
  assert.match(chainHtml, /class="check-list" id="checkList"/);
  assert.match(chainHtml, /class="decision-banner show approved"/);
  assert.match(chainHtml, /은행 최종 승인 대기/);
  assert.match(chainHtml, /class="check-item not-applied"/);
  assert.match(chainHtml, /TCB 미연동/);
  assert.match(chainHtml, /미적용/);
  assert.doesNotMatch(chainHtml, /id="runReviewBtn"|finalizeDecision\(/);
});

test('on-chain selection remains active and approval controls use wallet callbacks', async () => {
  const page = await boot(); const html = addReviewCase(page);
  assert.equal(page.run('currentReviewId'), 'CHAIN-REVIEW');
  assert.match(html, /finalChainDecision\('CHAIN-REVIEW', true\)" >/);
  assert.match(html, /finalChainDecision\('CHAIN-REVIEW', false\)" >/);
  assert.match(html, /syncChainReview\('CHAIN-REVIEW'\)/);
});

test('contract rejection takes precedence over rounded 70 percent display', async () => {
  const page = await boot();
  const html = addReviewCase(page, { chainStatus: 'RuleRejected', status: 'rejected', ltv: 70 });
  assert.match(html, /LTV 70% · 거절/);
  assert.match(html, /class="decision-banner show rejected"/);
  assert.match(html, /자동심사 결과 — 거절/);
  assert.match(html, /finalChainDecision\('CHAIN-REVIEW', true\)" disabled/);
  assert.doesNotMatch(html, /id="repaymentAmount"/);
});

test('approved review preserves repayment and document actions in matching panels', async () => {
  const page = await boot();
  const html = addReviewCase(page, { chainStatus: 'Approved', status: 'approved', repaidAmount: 20000000, debtTokenId: '2' });
  assert.match(html, /최종 승인 완료/);
  assert.match(html, /블록체인 기록·상환/);
  assert.match(html, /id="repaymentAmount"[^>]*max="50000000"/);
  assert.match(html, /recordChainRepayment\('CHAIN-REVIEW'\)/);
  assert.match(html, /viewChainDocument\('CHAIN-REVIEW'\)/);
  assert.match(html, /finalChainDecision\('CHAIN-REVIEW', true\)" disabled/);
});

test('repaid review shows completion without another repayment form', async () => {
  const page = await boot();
  const html = addReviewCase(page, { chainStatus: 'Repaid', status: 'approved', repaidAmount: 70000000, debtTokenId: '2' });
  assert.match(html, /완납 기록 완료/); assert.match(html, /Repaid/);
  assert.doesNotMatch(html, /id="repaymentAmount"/);
  assert.match(html, /viewChainDocument\('CHAIN-REVIEW'\)/);
});

test('unconfirmed evaluation is pending, not rendered as rejection or approval', async () => {
  const page = await boot();
  const html = addReviewCase(page, { chainStatus: 'Evaluating', status: 'evaluating', appraisedValue: null, ltv: null });
  assert.match(html, /평가 확정 대기/);
  assert.doesNotMatch(html, /decision-banner show|최종 승인 완료/);
  assert.match(html, /finalChainDecision\('CHAIN-REVIEW', true\)" disabled/);
});

test('integrated review shows the report credit grade, financial checks and auto-review row instead of the TCB placeholder', async () => {
  const page = await boot();
  page.run(fs.readFileSync(`${__dirname}/workflow.js`, 'utf8'));
  const evaluation = { state: 'completed', confirmedAt: 1, creditRating: 'BB-', financials: [
    { year: 2025, fiscal_date: '2025-12-31', source_label: 'NICE BizAPI', total_equity_krw: -505540000, capital_impaired: true, debt_ratio_pct: null }],
    financialChecks: [{ key: 'capital', label: '자본잠식 없음', criterion: '자본총계 0원 초과', year: 2025, result: 'fail', observed: '자본잠식 (자본총계 -506백만원)' },
      { key: 'current_ratio', label: '유동비율', criterion: '유동자산이 유동부채의 100% 이상', year: 2025, result: 'unknown', observed: '자료 없음' }] };
  page.server.evaluation = { id: 'CHAIN-REVIEW', workflow: true, chainStatus: 'Eligible', evaluation };
  const html = addReviewCase(page, { workflow: true, evaluation: { state: 'completed', confirmedAt: 1, creditRating: 'BB-' } });
  assert.match(html, /<div class="k">신용등급<\/div><div class="v">BB-<\/div>/);
  assert.match(html, /check-title">신용·재무 자동심사<\/div>[\s\S]*?check-status">판정 기록 없음</);
  assert.doesNotMatch(html, /TCB 미연동|신용평가 점수/);
  await new Promise(resolve => setImmediate(resolve));
  const panel = page.element('workflowReview').innerHTML;
  assert.match(panel, /재무 참고 점검/);
  assert.match(panel, /class="check-item failed"[\s\S]*?자본잠식 \(자본총계 -506백만원\)/);
  assert.match(panel, /판정 불가 \(자료 없음\)/);
  assert.match(panel, /<td class="num">-506<\/td>/);
  assert.match(panel, /<td class="num">자본잠식<\/td>/);
  assert.match(panel, /2025년 NICE BizAPI/);

  const missing = addReviewCase(page, { id: 'NO-GRADE', workflow: true, evaluation: { state: 'completed' } });
  assert.match(missing, /<div class="k">신용등급<\/div><div class="v"><span class="val-na">/);
});

test('the evaluator sees the register beside the application and must record the rights check before confirming', async () => {
  const page = await boot();
  page.run(fs.readFileSync(`${__dirname}/workflow.js`, 'utf8'));
  page.run("currentRole = 'evaluator'");
  const register = { status: 'collected', collectedAt: '2026-10-29T00:15:32+00:00', registrationNumber: '10-2642299', applicationNumber: '10-2022-0046360',
    title: '할바흐 배열 마그네트 제조 방법', currentOwners: ['주식회사 마그트론', '<img src=x>'], expiresAt: '2042-04-14', lapsedAt: null,
    rights: [{ changedAt: '2024-02-26', cause: '설정등록' }], annuities: [{ fromYear: 1, toYear: 3, paidAt: '2024-02-27' }], exclusiveLicenses: [], nonExclusiveLicenses: [] };
  const app = { id: 'RIGHTS-1', workflow: true, rightsCheckRequired: true, chainStatus: 'Evaluating', company: '(주)마그트론', ceo: '홍길동', ipTitle: '할바흐 배열 마그네트 제조 방법',
    ipRegNo: '10-2022-0046360', amount: 70, patentRegister: register, evaluation: { state: 'completed', artifacts: [] } };
  const render = changes => { page.run(`LoanWorkflow.panel(${JSON.stringify({ ...app, ...changes })})`); return page.element('evalReportPanel').innerHTML; };
  const html = render({});
  assert.match(html, /등록원부 대조/);
  assert.match(html, /<td>권리자<\/td><td>\(주\)마그트론 · 대표 홍길동<\/td><td>주식회사 마그트론, &lt;img src=x&gt;<\/td><td><span class="badge badge-approved">일치/);
  assert.match(html, /<td>출원·등록번호<\/td><td>10-2022-0046360<\/td><td>등록 10-2642299<br>출원 10-2022-0046360<\/td><td><span class="badge badge-approved">일치/);
  assert.match(html, /LoanWorkflow.rights\('RIGHTS-1', 'confirm'\)">권리 확인/);
  assert.match(html, /LoanWorkflow.confirm\('RIGHTS-1'\)" disabled/);

  const checked = render({ rightsCheckedAt: '2026-10-29T01:00:00+00:00' });
  assert.match(checked, /✓ 권리 확인 완료/);
  assert.doesNotMatch(checked, /LoanWorkflow.confirm\('RIGHTS-1'\)" disabled/);

  const other = render({ patentRegister: { ...register, currentOwners: ['김직원'], lapsedAt: '2026-07-24', lapseReason: '등록료불납' } });
  assert.match(other, /<td>김직원<\/td><td><span class="badge badge-rejected">확인 필요/);
  assert.match(other, /소멸 \(2026-07-24 · 등록료불납\)/);
  assert.doesNotMatch(other, /'confirm'\)">권리 확인/);
  assert.match(render({ patentRegister: { status: 'failed', message: '등록원부 API에 연결하지 못했습니다.' } }), /연결하지 못했습니다[\s\S]*?'refresh'\)">등록원부 다시 조회[\s\S]*?'confirm'\)">권리 확인/);

  // An API from before the rights check: no section, and the confirm stays as it was.
  const before = render({ rightsCheckRequired: undefined, patentRegister: undefined });
  assert.doesNotMatch(before, /등록원부 대조|권리 확인/);
  assert.doesNotMatch(before, /LoanWorkflow.confirm\('RIGHTS-1'\)" disabled/);
});

test('server auto-review verdict decides which final action the bank can sign', async () => {
  const page = await boot();
  const evaluation = (decision, label) => ({ state: 'completed', confirmedAt: 1, creditRating: 'BB-',
    autoReview: { policy: 'v2-server-auto-review-1', decision, ltvPct: 70, reasons: [{ code: 'x', label }] } });
  const approve = addReviewCase(page, { id: 'AUTO-APPROVE', workflow: true, evaluation: evaluation('approve', '신용등급 BBB- 이상') });
  assert.match(approve, /check-title">신용·재무 자동심사<\/div><div class="check-desc">신용등급 BBB- 이상<\/div>[\s\S]*?check-status">승인</);
  assert.match(approve, /decision-banner show approved[\s\S]*?자동심사 결과 — 승인/);
  assert.doesNotMatch(approve, /finalChainDecision\('AUTO-APPROVE', true\)" disabled/);
  assert.match(approve, /finalChainDecision\('AUTO-APPROVE', false\)" disabled/);

  const reject = addReviewCase(page, { id: 'AUTO-REJECT', workflow: true, evaluation: evaluation('reject', '신용등급 CCC+ 이하') });
  assert.match(reject, /class="check-item failed"[\s\S]*?check-status">거절</);
  assert.match(reject, /decision-banner show rejected[\s\S]*?자동심사 결과 — 거절[\s\S]*?f-label">신청금액/);
  assert.match(reject, /finalChainDecision\('AUTO-REJECT', true\)" disabled/);
  assert.doesNotMatch(reject, /finalChainDecision\('AUTO-REJECT', false\)" disabled/);

  const review = addReviewCase(page, { id: 'AUTO-REVIEW', workflow: true, evaluation: evaluation('review', '유동비율 100% 미만') });
  assert.match(review, /decision-banner show review[\s\S]*?자동심사 결과 — 심사역 검토[\s\S]*?유동비율 100% 미만/);
  assert.doesNotMatch(review, /finalChainDecision\('AUTO-REVIEW', (true|false)\)" disabled/);

  const done = addReviewCase(page, { id: 'AUTO-DONE', workflow: true, chainStatus: 'Approved', status: 'approved', debtTokenId: '3',
    evaluation: evaluation('reject', '신용등급 CCC+ 이하') });
  assert.match(done, /최종 승인 완료/);
  assert.match(done, /finalChainDecision\('AUTO-DONE', true\)" disabled/);
});

test('review summary and chain rejection text escape user-controlled values', async () => {
  const page = await boot();
  const html = addReviewCase(page, { company: '<img src=x onerror=alert(1)>', ipTitle: '<script>bad</script>',
    chainStatus: 'Rejected', status: 'rejected', rejectReason: '<img src=x>' });
  assert.doesNotMatch(html, /<img|<script>/);
  assert.match(html, /&lt;img/); assert.match(html, /&lt;script&gt;/);
});

test('wallet login opens only the roles the chain grants and logs out back to the sign-in view', async () => {
  const address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  let current = null, logins = 0;
  const chain = { init: async () => {}, restore: async () => current, session: () => current,
    login: async () => { logins++; current = { address, token: 'token', roles: ['evaluator', 'admin'] }; return current; },
    logout: async () => { current = null; } };
  const page = await boot(new Map(), null, chain);
  assert.equal(page.run('currentRole'), null);
  assert.ok(page.element('view-login').classList.contains('active'));
  assert.equal(page.element('userChip').hidden, true);
  assert.equal(page.element('loginBtnTop').hidden, false);

  await page.element('loginBtn').listeners.click();
  assert.equal(logins, 1);
  assert.equal(page.run('currentRole'), 'evaluator');
  assert.equal(page.element('userName').textContent, '0x7099…79C8');
  assert.equal(page.element('userChip').hidden, false);
  assert.equal(page.element('loginBtnTop').hidden, true);
  assert.equal(page.element('adminLink').hidden, false);
  assert.match(page.element('roleOptions').innerHTML, /data-role="evaluator"/);
  assert.doesNotMatch(page.element('roleOptions').innerHTML, /data-role="(lender|borrower)"/);
  page.run("setRole('lender')");
  assert.equal(page.run('currentRole'), 'evaluator');

  await page.element('logoutBtn').listeners.click();
  assert.equal(page.run('currentRole'), null);
  assert.equal(page.element('userChip').hidden, true);
  assert.ok(page.element('view-login').classList.contains('active'));
});

test('a restored session resumes without signing again, and a wallet without roles stays on the sign-in view', async () => {
  let current = { address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', token: 'token', roles: ['bank'] }, logins = 0;
  const chain = { init: async () => {}, restore: async () => current, session: () => current,
    login: async () => { logins++; current = { address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', token: 't2', roles: [] }; return current; },
    logout: async () => { current = null; } };
  const page = await boot(new Map(), null, chain);
  assert.equal(logins, 0);
  assert.equal(page.run('currentRole'), 'lender');
  assert.ok(page.element('view-review').classList.contains('active'));

  await page.element('logoutBtn').listeners.click();
  await page.element('loginBtn').listeners.click();
  assert.equal(page.run('currentRole'), null);
  assert.match(page.element('loginHelp').textContent, /등록된 역할이 없습니다/);
  assert.match(page.element('roleOptions').innerHTML, /등록된 역할이 없습니다/);
});

test('a dropped PDF is attached and fills only the IP fields the borrower left empty', async () => {
  const chain = { init: async () => {}, proof: () => ({ login: 'session-token' }) };
  const page = await boot(undefined, null, chain);
  page.server.pdfFields = { ipType: '특허권', ipTitle: '두부 자극용 전위치료장치', ipRegNo: '10-2022-0132655' };
  page.element('fIpNo').value = '10-2024-9999999';
  const box = page.element('uploadBox'), input = page.element('fileInput');
  input.dispatchEvent = event => input.listeners[event.type]();
  const gazette = { name: '공고전문.PDF' };
  box.listeners.drop({ preventDefault() {}, dataTransfer: { files: [{ name: 'memo.txt' }, gazette] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(input.files[0], gazette);
  assert.equal(page.element('fileNameDisplay').textContent, '공고전문.PDF');
  assert.equal(page.server.fieldRequests[0].headers.Authorization, 'Bearer session-token');
  assert.equal(page.element('fIpType').value, '특허권');
  assert.equal(page.element('fIpTitle').value, '두부 자극용 전위치료장치');
  assert.equal(page.element('fIpNo').value, '10-2024-9999999');
});

test('a lapsed patent shows the register message and cannot be submitted until another PDF is chosen', async () => {
  const page = await boot(undefined, null, { init: async () => {}, proof: () => ({ login: 'session-token' }) });
  const message = '소멸된 특허는 신청할 수 없습니다 (2026-07-24 소멸등록 · 등록료불납).';
  page.server.pdfFields = { ipTitle: '식사 보조장치', patentRegister: { status: 'collected', lapsedAt: '2026-07-24', message } };
  const overlay = page.element('registerCheck'), input = page.element('fileInput');
  overlay.hidden = true;
  input.files = [{ name: 'lapsed.pdf' }];
  input.listeners.change();
  assert.equal(overlay.hidden, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(overlay.hidden, true);
  assert.equal(page.element('fileHelpText').textContent, message);
  assert.equal(page.element('applySubmitBtn').disabled, true);
  assert.equal(page.element('fIpTitle').value, '');
  await page.element('applyForm').listeners.submit({ preventDefault() {} });
  assert.equal(page.uploads(), 0);

  page.server.pdfFields = { patentRegister: { status: 'collected', lapsedAt: null } };
  input.files = [{ name: 'valid.pdf' }];
  input.listeners.change();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.element('applySubmitBtn').disabled, false);
  assert.equal(page.element('uploadBox').classList.contains('blocked'), false);
});

test('without a session, choosing a PDF attaches it without asking the server for fields', async () => {
  const page = await boot(undefined, null, { init: async () => {}, proof: () => null });
  page.element('fileInput').files = [{ name: 'test.pdf' }];
  page.element('fileInput').listeners.change();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.server.fieldRequests, undefined);
  assert.equal(page.element('fIpTitle').value, '');
});
