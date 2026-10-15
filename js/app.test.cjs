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
    setTimeout: fn => { timers.push(fn); return timers.length; },
    clearTimeout: () => {}, setInterval: () => {},
    fetch: async (url, options = {}) => {
      let body;
      if (url.endsWith('/applications')) body = server.applications;
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

test('review summary and chain rejection text escape user-controlled values', async () => {
  const page = await boot();
  const html = addReviewCase(page, { company: '<img src=x onerror=alert(1)>', ipTitle: '<script>bad</script>',
    chainStatus: 'Rejected', status: 'rejected', rejectReason: '<img src=x>' });
  assert.doesNotMatch(html, /<img|<script>/);
  assert.match(html, /&lt;img/); assert.match(html, /&lt;script&gt;/);
});
