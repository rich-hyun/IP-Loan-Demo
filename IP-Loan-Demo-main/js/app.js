/* ==========================================================================
   LLM 기반 기술평가 자동대출 시스템 — 프론트엔드 로직
   모든 신청·평가·심사 데이터는 서버 API(../server/app.py)를 통해
   저장되고 모든 방문자에게 동일하게 보입니다.
   ========================================================================== */

/* 서버 API 주소 — 배포 전 실제 도메인으로 교체하세요.
   http://IP:포트 는 https 프론트엔드에서 차단되니(mixed content) 반드시
   https:// 도메인을 사용하세요. 자세한 내용은 server/README.md 참고.
   localhost에서 열면 로컬 API(server/app.py, 5000번 포트)를 사용합니다. */
const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const API_BASE = (window.IPLOAN_API_BASE || (IS_LOCAL ? location.origin + '/api' : 'https://iploan-api.mustree.kr/api')).replace(/\/$/, '');
let API_TOKEN = sessionStorage.getItem('iploan-demo-key') || '';
let SERVICE_CONFIG = { demoMode: true, llmConfigured: false, chainMode: 'demo' };

/* ---------------- Status labels ---------------- */
const STATUS_META = {
  pending:    { label: '대기',     badge: 'badge-pending'  },
  doc_verify: { label: '서류검증', badge: 'badge-verify'   },
  evaluating: { label: '평가중',   badge: 'badge-review'   },
  review:     { label: '심사중',   badge: 'badge-review'   },
  approved:   { label: '승인',     badge: 'badge-approved' },
  rejected:   { label: '거절',     badge: 'badge-rejected' },
};

/* 서버에 연결할 수 없을 때만 쓰는 화면 표시용 대체 데이터(js/seed-data.js).
   서버가 정상이면 항상 API 응답으로 대체됩니다. */
const SEED_APPS = typeof SEED_APPLICATIONS !== 'undefined' ? SEED_APPLICATIONS : [];  // js/seed-data.js를 불러오지 않으면 빈 목록
const FALLBACK_APPLICATIONS = SEED_APPS;

/* 기존 정적 평가보고서/임의 유사도는 제거했습니다. API에서 생성한 보고서만 표시합니다. */

/* ---------------- API 통신: 값 변경은 반드시 서버 전용 업무 API 사용 */
async function apiRequest(path, {method='GET', body, form=false}={}) {
  const headers = {};
  if (API_TOKEN) headers['X-API-Key'] = API_TOKEN;
  if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {method, headers,
      body: body === undefined ? undefined : (form ? body : JSON.stringify(body))});
  } catch (err) { throw new Error('API 서버 연결 실패. Flask 서버와 API 주소를 확인하세요.'); }
  let result = {};
  try { result = await res.json(); } catch (err) { /* HTTP 응답에 JSON 없음 */ }
  if (!res.ok) throw new Error(result.error || `${res.status} HTTP 오류`);
  return result;
}
async function apiFetchApplications() { return apiRequest('/applications'); }
async function apiCreateApplication(payload) { return apiRequest('/applications', {method:'POST', body:payload}); }
async function apiUploadDocuments(id, files) {
  const fd = new FormData();
  files.forEach(file => fd.append('files', file, file.name));
  return apiRequest(`/applications/${encodeURIComponent(id)}/documents`, {method:'POST', body:fd, form:true});
}
async function apiAction(id, name, body={}) {
  return apiRequest(`/applications/${encodeURIComponent(id)}/${name}`, {method:'POST', body});
}
async function apiReset() { return apiRequest('/reset', {method:'POST', body:{}}); }
async function apiReload() {
  APPLICATIONS = await apiFetchApplications();
  renderDashboard(); renderListTable(); renderEvalList(); renderReviewList();
}
function demoInfo() { return SERVICE_CONFIG.demoMode ? ' [시연/가상 데이터]' : ''; }
function setBusy(button, message='처리 중…') {
  if (button) { button.disabled=true; button.textContent=message; }
}
function errToast(err) { showToast(err.message || '요청 실패'); console.error(err); }


/* ---------------- Helpers ---------------- */
function won(n) { return n == null || isNaN(n) ? NA_HTML : n.toLocaleString('ko-KR') + '원'; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

/* ---------------- 값 표시 ---------------- */
const NA_HTML = '<span class="val-na">-</span>';

/* 필드 값을 HTML로: 값이 없으면 "-". fmt는 HTML을 돌려주는 포맷 함수 */
function fieldHTML(app, key, fmt) {
  const v = appField(app, key);
  if (v == null || v === '') return NA_HTML;
  return fmt ? fmt(v) : escapeHtml(v);
}
function findApp(id) { return APPLICATIONS.find(a => a.id === id); }
function statusBadge(status) {
  const m = STATUS_META[status] || STATUS_META.pending;
  return `<span class="badge ${m.badge}">${m.label}</span>`;
}
/* 보고서는 실제 서버에 생성·저장된 최신 평가 결과만 사용합니다. */
function evalQueue() {
  return APPLICATIONS.filter(a => ['pending','doc_verify','evaluating'].includes(a.status) || (a.status === 'review' && !a._report));
}
function getEvalReport(app) { return app._report || null; }


/* ---------------- 연결 오류 알림 ---------------- */
function showConnNotice() { document.getElementById('connNotice').classList.add('show'); }
function hideConnNotice() { document.getElementById('connNotice').classList.remove('show'); }

/* ---------------- Navigation ---------------- */
const VIEW_META = {
  dashboard: { title:'대시보드',        sub:'LLM·블록체인 기반 IP담보 자동대출 서비스 현황' },
  list:      { title:'대출 신청 리스트', sub:'전체 대출 신청 건의 심사 진행 상태를 확인합니다' },
  apply:     { title:'대출 신청',        sub:'지식재산권을 담보로 등록하고 대출을 신청합니다' },
  evaluate:  { title:'IP 가치평가',      sub:'LLM이 자동 생성한 IP 가치평가보고서를 검토·확정합니다' },
  review:    { title:'대출 심사',        sub:'서버 규칙으로 모의 자동심사를 실행하고 결과를 기록합니다' },
  detail:    { title:'신청 진행 상황',   sub:'' },
};

let evalInitDone = false;
let reviewInitDone = false;

/* ---------------- 역할(프로필) ---------------- */
/* 차주기업 역할의 시연 회사: js/seed-data.js가 있으면 DEMO_BORROWERS 첫 회사, 없으면 서버 데이터의 (주)그린파머스. 회사 식별은 기업명으로만 한다 */
const BORROWER_COMPANY = (typeof DEMO_BORROWERS !== 'undefined' && DEMO_BORROWERS[0] && DEMO_BORROWERS[0].company) || '(주)그린파머스';

/* 대시보드는 모든 역할 공통. 역할별 대시보드는 추후 분리 예정 */
const ROLES = {
  lender:    { name:'김민준', avatar:'김민', role:'여신심사역 · NH농협은행',            views:['dashboard','list','review','evaluate','detail'] },
  evaluator: { name:'박도윤', avatar:'박도', role:'IP 가치평가자 · 지정 평가기관', views:['dashboard','evaluate','list','detail'] },
  borrower:  { name:'이서연', avatar:'이서', role:`차주기업 담당자 · ${BORROWER_COMPANY}`, views:['dashboard','list','apply','detail'] },
};
const ROLE_STORAGE_KEY = 'iploan-role';

/* 차주기업 기본 정보는 시연 회사의 최근 신청 건(서버 데이터)에서 가져온다. 서버에 없는 칸(대표자·연락처)은 appField로 시드에서 찾는다 */
function borrowerProfile() {
  const latest = APPLICATIONS
    .filter(a => a.company === BORROWER_COMPANY)
    .sort((a, b) => (b.appliedDate || '').localeCompare(a.appliedDate || ''))[0];
  return latest && { company: latest.company, bizNo: appField(latest, 'bizNo'), ceo: appField(latest, 'ceo'), contact: appField(latest, 'contact') };
}

/* 차주기업은 자기 회사 건만 본다 */
function visibleApps() {
  return currentRole === 'borrower' ? APPLICATIONS.filter(a => a.company === BORROWER_COMPANY) : APPLICATIONS; // 시연 UI 필터: 서버 권한통제 아님
}

/* 대출 신청 폼에 저장된 차주기업 정보를 미리 채운다(직접 수정 가능).
   차주기업의 사업자번호·대표자·연락처가 없으면(null) 빈칸을 선택 입력으로 바꾼다 */
function fillBorrowerInfo() {
  const profile = borrowerProfile();
  if (currentRole !== 'borrower' || !profile) return;
  document.getElementById('fCompany').value = profile.company;
  [['fBizNo', 'bizNo'], ['fCeo', 'ceo'], ['fPhone', 'contact']].forEach(([id, key]) => {
    const input = document.getElementById(id);
    const value = profile[key];
    if (input.dataset.placeholder == null) input.dataset.placeholder = input.placeholder;
    input.value = value == null ? '' : value;
    input.required = value != null;
    input.placeholder = value == null ? '선택 입력' : input.dataset.placeholder;
    const req = input.closest('.field').querySelector('.req');
    if (req) req.hidden = value == null;
  });
}

let currentRole = 'lender';
try {
  const saved = localStorage.getItem(ROLE_STORAGE_KEY);
  if (ROLES[saved]) currentRole = saved;
} catch (err) { /* 저장소를 쓸 수 없으면 기본 역할 */ }

function canView(name) { return ROLES[currentRole].views.includes(name); }

function applyRole() {
  const r = ROLES[currentRole];
  document.getElementById('userAvatar').textContent = r.avatar;
  document.getElementById('userName').textContent = r.name;
  document.getElementById('userRole').textContent = r.role;
  document.querySelector('.role-option[data-role="borrower"]').textContent = ROLES.borrower.role;
  document.querySelectorAll('.nav-item').forEach(b => { b.parentElement.hidden = !canView(b.dataset.view); });
  document.querySelectorAll('.role-option').forEach(o => o.setAttribute('aria-checked', String(o.dataset.role === currentRole)));
  document.getElementById('dashListBtn').hidden = !canView('list');
  document.getElementById('statusPanelTitle').textContent = currentRole === 'borrower' ? '대출 신청 현황' : '오늘의 처리 현황';
  fillBorrowerInfo();
}

function setRole(key) {
  currentRole = key;
  try { localStorage.setItem(ROLE_STORAGE_KEY, key); } catch (err) { /* 무시 */ }
  applyRole();
  renderDashboard();
  renderListTable();
  goView('dashboard');
  showToast(`${ROLES[key].role.split(' · ')[0]}(으)로 전환했습니다`);
}

const userChip = document.getElementById('userChip');
const roleMenu = document.getElementById('roleMenu');

function toggleRoleMenu(open) {
  roleMenu.hidden = !open;
  userChip.setAttribute('aria-expanded', String(open));
}

userChip.addEventListener('click', () => toggleRoleMenu(roleMenu.hidden));
roleMenu.querySelectorAll('.role-option').forEach(o => {
  o.addEventListener('click', () => { toggleRoleMenu(false); setRole(o.dataset.role); });
});
document.addEventListener('click', (e) => {
  if (!roleMenu.hidden && !document.getElementById('profile').contains(e.target)) toggleRoleMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !roleMenu.hidden) { toggleRoleMenu(false); userChip.focus(); }
});

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function goView(name) {
  if (!canView(name)) {
    showToast('현재 역할에서는 볼 수 없는 화면입니다');
    name = 'dashboard';
  }
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  const navName = name === 'detail' ? 'list' : name;  // 진행 상황 화면은 리스트 메뉴를 강조
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === navName));
  document.getElementById('topbarDate').textContent = new Date().toLocaleDateString('ko-KR');
  document.getElementById('topbarTitle').textContent = VIEW_META[name].title;
  document.getElementById('topbarSub').textContent = VIEW_META[name].sub;

  if (name === 'evaluate' && !evalInitDone) {
    const first = evalQueue()[0];
    if (first) selectEvalItem(first.id);
    else document.getElementById('evalReportPanel').innerHTML = `<div class="empty-hint">평가 대기 중인 건이 없습니다.</div>`;
    evalInitDone = true;
  }
  if (name === 'review' && !reviewInitDone) {
    const first = reviewQueue()[0];
    if (first) loadReviewCase(first.id);
    else document.getElementById('reviewBody').innerHTML = `<div class="panel"><div class="empty-hint">심사 대기 중인 건이 없습니다.</div></div>`;
    reviewInitDone = true;
  }
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => goView(btn.dataset.view));
});

/* ---------------- Dashboard ---------------- */
function renderDashboard() {
  const apps = visibleApps();
  const counts = {};
  Object.keys(STATUS_META).forEach(k => counts[k] = 0);
  apps.forEach(a => counts[a.status] = (counts[a.status] || 0) + 1);
  document.getElementById('statusTotal').textContent = `전체 ${apps.length}건`;

  const order = ['pending','doc_verify','evaluating','review','approved','rejected'];
  document.getElementById('statusRow').innerHTML = order.map(k => `
    <div class="status-pill">
      <div class="status-pill-count">${counts[k]}</div>
      <div class="status-pill-label">${STATUS_META[k].label}</div>
    </div>`).join('');

  const recent = [...apps].sort((a,b) => (b.appliedDate || '').localeCompare(a.appliedDate || '')).slice(0,4);
  document.querySelector('#miniTable tbody').innerHTML = recent.map(a => `
    <tr onclick="goView('list')">
      <td class="cell-company">${escapeHtml(a.company)}</td>
      <td>${escapeHtml(a.ipTitle)}</td>
      <td class="cell-amount">${fieldHTML(a, 'amount', won)}</td>
      <td>${statusBadge(a.status)}</td>
    </tr>`).join('');
}

/* ---------------- List view ---------------- */
let activeFilter = 'all';
const FILTERS = [['all','전체'], ['pending','대기'], ['doc_verify','서류검증'], ['evaluating','평가중'], ['review','심사중'], ['approved','승인'], ['rejected','거절']];

function renderFilterChips() {
  document.getElementById('filterChips').innerHTML = FILTERS.map(([key,label]) => `
    <button class="chip ${activeFilter === key ? 'active' : ''}" data-key="${key}">${label}</button>`).join('');
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => { activeFilter = chip.dataset.key; renderFilterChips(); renderListTable(); });
  });
}

function renderListTable() {
  const term = (document.getElementById('listSearch').value || '').trim().toLowerCase();
  const rows = visibleApps().filter(a => {
    const matchesStatus = activeFilter === 'all' || a.status === activeFilter;
    const matchesTerm = !term || a.company.toLowerCase().includes(term) || a.id.toLowerCase().includes(term);
    return matchesStatus && matchesTerm;
  });

  document.getElementById('listTableBody').innerHTML = rows.map(a => `
    <tr data-id="${a.id}">
      <td class="cell-hash">${a.id}</td>
      <td class="cell-company">${escapeHtml(a.company)}<div class="cell-sub">${fieldHTML(a, 'bizNo')}</div></td>
      <td>${escapeHtml(a.ipTitle)}<div class="cell-sub">${escapeHtml(a.ipType)} · ${fieldHTML(a, 'ipRegNo')}</div></td>
      <td class="cell-amount">${fieldHTML(a, 'amount', won)}</td>
      <td>${statusBadge(a.status)}</td>
      <td class="cell-hash">${escapeHtml(a.hash || '-')}</td>
      <td>${fieldHTML(a, 'appliedDate')}</td>
      <td class="row-arrow">›</td>
    </tr>`).join('');

  document.querySelectorAll('#listTableBody tr').forEach(tr => {
    tr.addEventListener('click', () => {
      openDetail(tr.dataset.id);
    });
  });
}

document.getElementById('listSearch').addEventListener('input', renderListTable);

/* ---------------- 신청 진행 상황 (차주기업) ---------------- */
const BORROWER_STATUS_DESC = {
  pending:    '신청이 접수되었습니다',
  doc_verify: '서버에 업로드한 서류를 확인하고 있습니다 (발급기관 연동 전)',
  evaluating: 'IP 가치평가가 진행 중입니다',
  review:     '은행 심사가 진행 중입니다',
  approved:   '대출이 승인되었습니다',
  rejected:   '대출이 승인되지 않았습니다',
};
/* 단계별 완료 시각은 처리 기록(history)에서 해당 단계를 끝낸 항목(doneBy)을 찾아 표시.
   owner(담당)는 IP 가치평가, 대출 심사 단계에만 표시하며 <br>로 줄을 나눈다 */
const PROGRESS_STEPS = [
  { label:'신청 접수',   doneBy:['대출 신청 접수'] },
  { label:'서류 검증',   doneBy:['문서 업로드/로컬 SHA-256 계산'] },
  { label:'IP 가치평가', doneBy:['가치평가 확정'],
    owner:'LLM 평가 에이전트<br>→ IP 가치평가자 (지정 평가기관)' },
  { label:'대출 심사',   doneBy:['자동심사 규칙 실행(시연)'],
    owner:'시연 규칙엔진<br>→ 모의 여신심사역' },
  { label:'결과',        doneBy:['최종 승인 확정 (모의)', '거절 확정 통지 (모의)'] },
];
/* 상태별 완료된 단계 수 */
const STATUS_DONE_STEPS = { pending:1, doc_verify:1, evaluating:2, review:3, approved:5, rejected:5 };

/* 서버 스키마에 없는 필드(처리 기록, 상환기간, 제출 서류 등)는 시드 데이터(js/seed-data.js)가 있으면 거기서 찾는다 */
function appField(app, key) {
  if (app[key] != null) return app[key];
  const seed = SEED_APPS.find(a => a.id === app.id);
  return seed ? seed[key] : undefined;
}
function appHistory(app) {
  const history = appField(app, 'history');
  return Array.isArray(history) ? history : [];
}
/* 'YYYY-MM-DD HH:MM' → 'M월 D일 HH:MM' */
function formatStepTime(at) {
  const m = /^\d{4}-(\d{2})-(\d{2})(?: (\d{2}:\d{2}))?/.exec(at || '');
  if (!m) return '';
  return `${+m[1]}월 ${+m[2]}일` + (m[3] ? ` ${m[3]}` : '');
}

function openDetail(id) {
  const app = findApp(id);
  if (!app) return;
  const history = appHistory(app);
  const doneCount = STATUS_DONE_STEPS[app.status] || 0;

  document.getElementById('detailTitle').textContent = app.ipTitle;
  document.getElementById('detailHint').textContent = `${escapeHtml(app.id)} · ${escapeHtml(app.ipType)}`;
  document.getElementById('detailStatus').innerHTML = `${statusBadge(app.status)}<span>${BORROWER_STATUS_DESC[app.status]}</span>`;
  document.getElementById('detailSteps').innerHTML = PROGRESS_STEPS.map((s, i) => {
    const state = i < doneCount ? 'done' : (i === doneCount ? 'current' : '');
    let time = '';
    if (state === 'done') {
      const h = history.find(x => s.doneBy.some(p => x.action.startsWith(p)));
      time = h ? formatStepTime(h.at) : (i === 0 ? formatStepTime(app.appliedDate) : '완료');
    } else if (state === 'current') {
      time = app.status === 'pending' ? '대기 중' : '진행 중';
    }
    return (i ? '<div class="step-line"></div>' : '') + `
      <div class="step ${state}">
        <div class="step-circle">${i + 1}</div>
        <div class="step-label">${s.label}${s.owner ? `<div class="step-owner">${s.owner}</div>` : ''}<div class="step-time">${time}</div></div>
      </div>`;
  }).join('');

  const info = [
    ['신청번호', app.id],
    ['신청일', fieldHTML(app, 'appliedDate')],
    ['신청금액', fieldHTML(app, 'amount', won)],
    ['상환기간', fieldHTML(app, 'termMonths', v => `${escapeHtml(v)}개월`)],
    ['담보 IP 유형', app.ipType],
    ['출원·등록번호', fieldHTML(app, 'ipRegNo')],
    ['대표자', fieldHTML(app, 'ceo')],
    ['연락처', fieldHTML(app, 'contact')],
  ];
  document.getElementById('detailInfo').innerHTML = info.map(([k, v]) => `
    <div class="item"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

  const docs = appField(app, 'documents') || [];
  document.getElementById('detailDocs').innerHTML = docs.length
    ? `<div class="k">제출 서류 ${docs.length}건</div>` + docs.map(d => `<span>${escapeHtml(d)}</span>`).join('')
    : '';
  renderWorkflowActions(app);

  VIEW_META.detail.sub = `${escapeHtml(app.id)} 신청의 진행 상황을 확인합니다`;
  goView('detail');
}

/* ---------------- Apply form ---------------- */
const applyForm = document.getElementById('applyForm');
const uploadBox = document.getElementById('uploadBox');
const fileInput = document.getElementById('fileInput');

uploadBox.addEventListener('click', () => fileInput.click());
uploadBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files);
  const nameEl = document.getElementById('fileNameDisplay');
  const helpEl = document.getElementById('fileHelpText');
  if (files.length === 0) {
    nameEl.textContent = '클릭해서 파일 선택';
    helpEl.textContent = '특허등록원부, 사업자등록증 등 심사서류를 첨부하세요 · 발급기관 시스템을 통해 원본이 대조됩니다';
    return;
  }
  nameEl.textContent = files[0].name + (files.length > 1 ? ` 외 ${files.length - 1}건` : '');
  helpEl.textContent = '발급기관 시스템을 통해 원본이 대조됩니다';
});

applyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('applySubmitBtn');
  setBusy(btn);
  const company = document.getElementById('fCompany').value.trim();
  const bizNo = document.getElementById('fBizNo').value.trim();
  const ipType = document.getElementById('fIpType').value;
  const ipRegNo = document.getElementById('fIpNo').value.trim();
  const ipTitle = document.getElementById('fIpTitle').value.trim();
  const ceo = document.getElementById('fCeo').value.trim();
  const contact = document.getElementById('fPhone').value.trim();
  const termMonths = Number(document.getElementById('fTerm').value.replace(/[^0-9]/g, ''));
  const amount = Number(document.getElementById('fAmount').value.replace(/[^0-9]/g, ''));
  const files = Array.from(fileInput.files);
  let created = null;
  try {
    created = await apiCreateApplication({ company, bizNo, ipType, ipRegNo, ipTitle, ceo, contact, termMonths, amount });
    let updated = created;
    if (files.length) {
      updated = (await apiUploadDocuments(created.id, files)).application;
    }
    await apiReload();
    hideConnNotice();
    document.querySelectorAll('#applySteps .step').forEach(x => { x.classList.add('done'); x.classList.remove('current'); });
    document.getElementById('genAppId').textContent = created.id;
    document.getElementById('genFiles').textContent = files.length ? files.map(f => f.name).join(', ') : '미첨부';
    document.getElementById('genHash').textContent = updated.hash || '파일 미첨부 — 해시 없음';
    document.getElementById('genBlock').textContent = '온체인 기록 전 (평가 확정 시 처리)';
    document.getElementById('genTime').textContent = new Date().toLocaleString('ko-KR');
    document.getElementById('applyHashBlock').classList.add('show');
    btn.textContent='제출 완료';
    showToast('신청과 파일 SHA-256 저장 완료. 평가 화면에서 보고서를 생성하세요.');
  } catch (err) {
    errToast(err);
    if (created) showToast('신청은 접수됐지만 파일 업로드가 실패했습니다. 신청번호: ' + created.id);
    else showConnNotice();
    btn.disabled=false; btn.textContent='다시 시도';
  }
});


applyForm.addEventListener('reset', () => { setTimeout(resetApplyUI, 0); });

function resetApplyUI() {
  const steps = document.querySelectorAll('#applySteps .step');
  steps.forEach(s => s.classList.remove('done', 'current'));
  steps[0].classList.add('current');
  document.getElementById('applyHashBlock').classList.remove('show');
  const btn = document.getElementById('applySubmitBtn');
  btn.disabled = false;
  btn.textContent = '제출하기';
  document.getElementById('fileNameDisplay').textContent = '클릭해서 파일 선택';
  document.getElementById('fileHelpText').textContent = '특허등록원부, 사업자등록증 등 심사서류를 첨부하세요 · 발급기관 시스템을 통해 원본이 대조됩니다';
  fillBorrowerInfo();
}

/* ---------------- Evaluate view ---------------- */
function renderEvalList() {
  const queue = evalQueue();
  const container = document.getElementById('evalListItems');
  if (queue.length === 0) {
    container.innerHTML = `<div class="empty-hint">평가 대기 중인 건이 없습니다.</div>`;
    return;
  }
  container.innerHTML = queue.map(app => `
    <div class="eval-item" data-id="${escapeHtml(app.id)}">
      <div class="eval-item-top">
        <span class="eval-item-company">${escapeHtml(app.company)}</span>
        ${statusBadge(app.status)}
      </div>
      <div class="eval-item-sub">${escapeHtml(app.ipTitle)} · ${escapeHtml(app.ipType)}</div>
    </div>`).join('');

  document.querySelectorAll('#evalListItems .eval-item').forEach(el => {
    el.addEventListener('click', () => selectEvalItem(el.dataset.id));
  });
}

function selectEvalItem(id) {
  const app = findApp(id);
  if (!app) return;
  const r = getEvalReport(app);
  document.querySelectorAll('#evalListItems .eval-item').forEach(el => el.classList.toggle('active', el.dataset.id === id));
  if (!r) {
    document.getElementById('evalReportPanel').innerHTML = `
      <div class="panel-body">
        <div class="report-title">${escapeHtml(app.ipTitle)}</div>
        <p class="report-meta">${escapeHtml(app.company)} · ${escapeHtml(app.id)}</p>
        <p>서버에 저장된 가치평가보고서가 없습니다. 생성 버튼을 누르면 서버에서 보고서를 생성하고 저장합니다.</p>
        <p class="real-demo-warning">${SERVICE_CONFIG.llmConfigured ? 'OpenAI API 실호출 모드 · 단, 입력 데이터는 미검증이며 평가액은 시연용입니다.' : 'LLM API 키 미설정 · 규칙 기반 시연 보고서가 생성됩니다. 실제 LLM 호출이 아닙니다.'}</p>
        <button class="btn btn-primary" onclick="createEval('${id}',this)">가치평가보고서 생성</button>
      </div>`;
    return;
  }
  const modeLabel = r.mode === 'llm_live' ? 'LLM API 생성 (데이터 미검증)' : '규칙 기반 시연 보고서 (LLM 미사용)';
  const confirmed = !!app.reportConfirmed;
  document.getElementById('evalReportPanel').innerHTML = `
    <div class="panel-body">
      <div class="report-head"><div>
        <div class="report-title">${escapeHtml(app.ipTitle)}</div>
        <div class="report-meta">${escapeHtml(app.company)} · ${escapeHtml(app.ipType)} · 신청번호 ${escapeHtml(app.id)}</div>
        <div class="report-meta">출원·등록번호 ${fieldHTML(app, 'ipRegNo')} · 신청금액 ${fieldHTML(app, 'amount', won)}</div>
      </div><span class="llm-tag">${modeLabel}</span></div>
      <div class="report-grid">
        <div class="report-stat"><div class="report-stat-label">시연용 평가액 (실제 담보가치 아님)</div><div class="report-stat-value">${won(r.appraisedValue)}</div></div>
        <div class="report-stat"><div class="report-stat-label">전문가 평가 대비 유사도</div><div class="report-stat-value">측정 안 함</div></div>
        <div class="report-stat"><div class="report-stat-label">생성 소요시간</div><div class="report-stat-value">${escapeHtml(r.genTime || '-')}</div></div>
      </div>
      <div class="report-section"><h4>IP 정보 요약</h4><p>${escapeHtml(r.summary)}</p></div>
      <div class="report-section"><h4>유사 IP 비교</h4><p>${escapeHtml(r.similar)}</p></div>
      <div class="report-section"><h4>시장성 분석</h4><p>${escapeHtml(r.market)}</p></div>
      <div class="report-section"><h4>가치 산정 근거</h4><p>${escapeHtml(r.basis)}</p></div>
      <div class="report-section"><h4>검토 한계 및 위험요인</h4><p>${escapeHtml((r.risks || []).join(' · '))}</p></div>
      <div class="real-demo-warning">${escapeHtml(r.disclaimer || '공식 평가 아님')}<div class="mono-line">SHA-256: ${escapeHtml(app.reportHash || '미계산')} · ${escapeHtml(r.genDate || '')}</div></div>
      <div class="action-bar">
        ${confirmed ? '<span>✓ 평가 확정 완료</span>' : `<button class="btn btn-primary" onclick="confirmEval('${id}',this)">평가 확정 · 해시 기록</button>`}
        ${confirmed ? '' : `<button class="btn btn-outline" onclick="openReevalDialog('${id}')">재산정 요청</button>`}
        <button class="btn btn-outline" onclick="printEvaluation('${id}')">보고서 인쇄/PDF 저장</button>
      </div>
    </div>`;
}
async function createEval(id, btn, reason='') {
  setBusy(btn, '보고서 생성 중…');
  try {
    const result = await apiAction(id, 'evaluation', {reason});
    Object.assign(findApp(id), result);
    await apiReload();
    selectEvalItem(id);
    showToast(`보고서 생성 완료 · ${result._report.mode === 'llm_live' ? 'LLM API 호출' : '규칙 기반 시연'}`);
  } catch(err) { errToast(err); if(btn){ btn.disabled=false; btn.textContent='다시 시도'; } }
}
function printEvaluation(id) {
  const app = findApp(id), r = app && app._report;
  if (!r) return;
  const win = window.open('', '_blank');
  if (!win) return showToast('팝업 차단을 해제하세요');
  const lines = [
    ['평가 구분', r.mode === 'llm_live' ? 'LLM API 서술 생성(검증 전)' : '규칙 기반 데모(LLM 미사용)'],
    ['기업',app.company],['IP',app.ipTitle],['출원·등록번호',app.ipRegNo || '미제공'],
    ['시연용 평가액',Number(r.appraisedValue).toLocaleString('ko-KR')+'원'],
    ['IP 요약',r.summary],['유사 IP',r.similar],['시장성',r.market],['가치 산정 근거',r.basis],
    ['한계',r.disclaimer],['SHA-256',app.reportHash || ''],['생성일',r.genDate]
  ];
  const markup = lines.map(([k,v])=>`<section><h3>${escapeHtml(k)}</h3><p>${escapeHtml(v)}</p></section>`).join('');
  win.document.write(`<!doctype html><html lang="ko"><meta charset="utf-8"><title>IP 가치평가 시연보고서</title>
  <style>body{font-family:sans-serif;max-width:850px;margin:40px auto;color:#18352d}h1{border-bottom:2px solid #16845f;padding-bottom:14px}section{padding:9px 0;border-bottom:1px solid #ddd}p{white-space:pre-wrap;line-height:1.65}</style>
  <h1>IP 가치평가 시연보고서 (비공식)</h1><p><strong>외부 데이터·공인 감정평가 미검증 / 금융판단 사용 금지</strong></p>${markup}</html>`);
  win.document.close(); win.focus();
  setTimeout(()=>win.print(),300);
}


/* 재산정 요청 팝업 (사유는 선택 입력) */
const reevalDialog = document.getElementById('reevalDialog');
let reevalTargetId = null;

function openReevalDialog(id) {
  const app = findApp(id);
  if (!app) return;
  reevalTargetId = id;
  document.getElementById('reevalDesc').textContent = `${escapeHtml(app.company)} · ${escapeHtml(app.ipTitle)} (${escapeHtml(app.id)})`;
  document.getElementById('reevalReason').value = '';
  reevalDialog.showModal();
}

document.getElementById('reevalCancel').addEventListener('click', () => reevalDialog.close());
reevalDialog.addEventListener('click', (e) => { if (e.target === reevalDialog) reevalDialog.close(); });  // 바깥(배경) 클릭 시 닫기
document.getElementById('reevalForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = reevalTargetId, reason = document.getElementById('reevalReason').value.trim();
  reevalDialog.close();
  await createEval(id, null, reason);
});
async function confirmEval(id, btn) {
  setBusy(btn, '확정 및 기록 중…');
  try {
    const data = await apiAction(id, 'evaluation/confirm');
    Object.assign(findApp(id), data.application);
    await apiReload();
    renderEvalList(); renderReviewList();
    showToast(data.chain.mode === 'rpc_confirmed' ? '실제 블록체인 기록 완료' : '평가 확정. 해시는 시연 DB에 기록됨(온체인 아님)');
    const next = evalQueue()[0];
    if (next) selectEvalItem(next.id);
    else document.getElementById('evalReportPanel').innerHTML='<div class="empty-hint">평가 대기 건이 없습니다. 심사 메뉴로 이동하세요.</div>';
  } catch(err) {errToast(err); if(btn){btn.disabled=false;btn.textContent='평가 확정 · 해시 기록';}}
}


/* ---------------- Review view ---------------- */
/* 심사 대기 목록: 심사중 건만 (IP 가치평가 화면의 평가 대기 목록과 같은 구성) */
let currentReviewId = null;

function reviewQueue() {
  return APPLICATIONS.filter(a => a.status === 'review');
}

function renderReviewList() {
  const queue = reviewQueue();
  const container = document.getElementById('reviewListItems');
  if (queue.length === 0) {
    container.innerHTML = `<div class="empty-hint">심사 대기 중인 건이 없습니다.</div>`;
    return;
  }
  container.innerHTML = queue.map(app => `
    <div class="eval-item ${app.id === currentReviewId ? 'active' : ''}" data-id="${escapeHtml(app.id)}">
      <div class="eval-item-top">
        <span class="eval-item-company">${escapeHtml(app.company)}</span>
        ${statusBadge(app.status)}
      </div>
      <div class="eval-item-sub">${escapeHtml(app.ipTitle)} · ${won(app.amount)}</div>
    </div>`).join('');

  container.querySelectorAll('.eval-item').forEach(el => {
    el.addEventListener('click', () => loadReviewCase(el.dataset.id));
  });
}

function loadReviewCase(id) {
  const app = findApp(id);
  if (!app) return;
  currentReviewId = id;
  document.querySelectorAll('#reviewListItems .eval-item').forEach(el => el.classList.toggle('active', el.dataset.id === id));
  const body = document.getElementById('reviewBody');

  const beforeReview = ['pending', 'doc_verify', 'evaluating'].includes(app.status) || !app.reportConfirmed;
  if (beforeReview) {
    body.innerHTML = `
      <div class="panel">
        <div class="empty-hint">
          <p style="margin-bottom:14px;">${escapeHtml(app.company)}의 <b>${escapeHtml(app.ipTitle)}</b> 건은 아직 IP 가치평가가 완료되지 않아<br>규칙 기반 자동심사를 실행할 수 없습니다. 먼저 서버에서 평가보고서를 생성하고 확정하세요.</p>
          ${canView('evaluate') ? `<button class="btn btn-outline" onclick="goView('evaluate')">IP 가치평가로 이동</button>` : ''}
        </div>
      </div>`;
    return;
  }
  /* 심사 단계인데 평가액(또는 신청금액)이 없어 LTV를 계산할 수 없는 건: 판정하지 않고 안내만 */
  if (!app.appraisedValue || app.amount == null || app.ltv == null) {
    body.innerHTML = `
      <div class="panel">
        <div class="panel-header"><h3>${escapeHtml(app.company)} · ${escapeHtml(app.ipTitle)}</h3><span class="hint">${escapeHtml(app.id)}</span></div>
        <div class="panel-body">
          <div class="review-summary">
            <div class="item"><div class="k">신청금액</div><div class="v">${fieldHTML(app, 'amount', won)}</div></div>
            <div class="item"><div class="k">산정 담보가치</div><div class="v">${fieldHTML(app, 'appraisedValue', won)}</div></div>
          </div>
          <div class="empty-hint"><b>평가액 없음 → 판정 불가</b><br>담보가치(또는 신청금액)가 없어 담보인정비율(LTV)을 계산할 수 없으므로 자동심사를 판정하지 않습니다.</div>
        </div>
      </div>`;
    return;
  }

  const ltvOk = app.ltv <= 70;
  const creditOk = app.creditScore != null && app.creditScore >= 60;
  const hashOk = !!(app.documentDetails && app.documentDetails.length) && appField(app, 'hashMatch') !== 0;  // 참고 표시만, 실제 판정은 서버에서 파일 재검증
  const alreadyDecided = app.status === 'approved' || app.status === 'rejected';
  const approvedAmount = Math.min(app.amount, Math.round(app.appraisedValue * 0.7 / 100000) * 100000);

  body.innerHTML = `
    <div class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><h3>${escapeHtml(app.company)} · ${escapeHtml(app.ipTitle)}</h3><span class="hint">${escapeHtml(app.id)}</span></div>
      <div class="panel-body">
        <div class="review-summary">
          <div class="item"><div class="k">신청금액</div><div class="v">${fieldHTML(app, 'amount', won)}</div></div>
          <div class="item"><div class="k">산정 담보가치</div><div class="v">${fieldHTML(app, 'appraisedValue', won)}</div></div>
          <div class="item"><div class="k">담보인정비율(LTV)</div><div class="v">${fieldHTML(app, 'ltv', v => `${v}%`)}</div></div>
          <div class="item"><div class="k">신용평가 점수</div><div class="v">${fieldHTML(app, 'creditScore', v => `${v}점`)}</div></div>
          <div class="item"><div class="k">출원·등록번호</div><div class="v">${fieldHTML(app, 'ipRegNo')}</div></div>
          <div class="item"><div class="k">상환기간</div><div class="v">${fieldHTML(app, 'termMonths', v => `${escapeHtml(v)}개월`)}</div></div>
        </div>

        <div class="section-title">시연용 자동심사 규칙 (실제 스마트컨트랙트 아님)</div>
        <div class="check-list" id="checkList">
          <div class="check-item" data-ok="${ltvOk}">
            <div class="check-icon">
              <svg class="icon-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>
              <svg class="icon-x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"></path></svg>
            </div>
            <div class="check-text">
              <div class="check-title">담보인정비율(LTV) 조건 충족</div>
              <div class="check-desc">산정 담보가치 대비 신청금액 비율이 70% 이하인지 확인</div>
            </div>
            <div class="check-status">LTV ${app.ltv}%</div>
          </div>
          <div class="check-item" data-ok="${creditOk}">
            <div class="check-icon">
              <svg class="icon-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>
              <svg class="icon-x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"></path></svg>
            </div>
            <div class="check-text">
              <div class="check-title">신용평가 점수 기준 충족</div>
              <div class="check-desc">시연용 가상 신용점수 60점 이상 (TCB 실연동 아님)</div>
            </div>
            <div class="check-status">${app.creditScore == null ? '-' : app.creditScore + '점'}</div>
          </div>
          <div class="check-item" data-ok="${hashOk}">
            <div class="check-icon">
              <svg class="icon-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>
              <svg class="icon-x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"></path></svg>
            </div>
            <div class="check-text">
              <div class="check-title">서류 해시 무결성 검증</div>
              <div class="check-desc">서버 저장파일 무결성 검증 (발급기관 인증 아님)</div>
            </div>
            <div class="check-status">${hashOk ? (app.hashMatch === 1 ? '입력 참조 해시 일치(기관 미인증)' : '서버 파일 검증 예정') : '문서 없음/불일치'}</div>
          </div>
        </div>

        <div id="reviewActionArea">
          ${alreadyDecided
            ? `<div style="font-size:12.5px; color:var(--ink-faint);">이미 처리된 건입니다 · ${fieldHTML(app, 'appliedDate')} 접수</div>`
            : `<button class="btn btn-primary" id="runReviewBtn">규칙 기반 자동심사 실행</button>`}
        </div>
      </div>
    </div>

    <div class="decision-banner" id="decisionBanner"></div>
  `;

  if (alreadyDecided) {
    document.querySelectorAll('#checkList .check-item').forEach(el => {
      el.classList.add(el.dataset.ok === 'true' ? 'verified' : 'failed');
    });
    showDecision(app, app.status === 'approved', approvedAmount, true);
  } else {
    document.getElementById('runReviewBtn').addEventListener('click', () => runAutoReview(app));
  }
}

async function runAutoReview(app) {
  const btn = document.getElementById('runReviewBtn');
  setBusy(btn, '규칙 심사 진행 중…');
  try {
    const result = await apiAction(app.id, 'review');
    Object.assign(app, result.application);
    const review = result.review;
    document.querySelectorAll('#checkList .check-item').forEach((el, i) => {
      const k = ['ltv','credit','documentIntegrity'][i];
      el.dataset.ok = String(review.conditions[k]);
      el.classList.add(review.conditions[k] ? 'verified' : 'failed');
    });
    document.getElementById('reviewActionArea').innerHTML = '<div class="real-demo-warning">시연용 규칙 심사 완료 · 외부 TCB 연동/실제 대출승인 아님</div>';
    showDecision(app, review.passed, review.approvedAmount, false);
    renderDashboard(); renderListTable();
  } catch(err) { errToast(err); if(btn){ btn.disabled=false; btn.textContent='다시 심사'; } }
}


function showDecision(app, approved, approvedAmount, alreadyDecided) {
  const banner = document.getElementById('decisionBanner');
  banner.classList.add('show', approved ? 'approved' : 'rejected');

  if (approved) {
    banner.innerHTML = `
      <div class="decision-head">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="m8.5 12 2.5 2.5 4.5-5"></path></svg>
        <span class="decision-title">모의 자동심사 결과 — 승인 가능</span>
      </div>
      <div class="decision-desc">시연용 LTV·가상 신용점수·문서 무결성 규칙을 충족했습니다. 실제 은행승인은 아닙니다.</div>
      <div class="decision-figures">
        <div><div class="f-label">대출가능금액</div><div class="f-value">${won(approvedAmount)}</div></div>
        <div><div class="f-label">적용 예상금리</div><div class="f-value">${app.rate ? app.rate + '%' : (app.reviewResult && app.reviewResult.rate ? app.reviewResult.rate + '%' : '산정 전')}</div></div>
      </div>
      <div class="decision-actions">
        ${alreadyDecided
          ? `<span style="font-size:12.5px; color:var(--ink-soft);">최종 승인 처리 완료 건입니다</span>`
          : `<button class="btn btn-primary btn-sm" onclick="finalizeDecision(this,'승인','${escapeHtml(app.id)}')">최종 승인 확정</button>
             <button class="btn btn-outline btn-sm" onclick="finalizeDecision(this,'보류','${escapeHtml(app.id)}')">보류하고 재검토</button>`}
      </div>`;
  } else {
    const reason = (app.reviewResult && app.reviewResult.reasons && app.reviewResult.reasons.join('; ')) || app.rejectReason || (appField(app, 'hashMatch') === 0
      ? '업로드 파일이 존재하지 않거나 서버 저장본/입력한 참조 해시가 일치하지 않습니다.'
      : '시연용 심사기준(LTV·신용점수·문서)을 충족하지 못했습니다.');
    banner.innerHTML = `
      <div class="decision-head">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="m9.5 9.5 5 5m0-5-5 5"></path></svg>
        <span class="decision-title">모의 자동심사 결과 — 거절</span>
      </div>
      <div class="decision-desc">${escapeHtml(reason)}</div>
      <div class="decision-actions">
        ${alreadyDecided
          ? `<span style="font-size:12.5px; color:var(--ink-soft);">거절 처리 완료 건입니다</span>`
          : `<button class="btn btn-outline btn-sm" onclick="finalizeDecision(this,'거절 확정','${escapeHtml(app.id)}')">거절 확정 통지</button>
             <button class="btn btn-danger-outline btn-sm" onclick="finalizeDecision(this,'재심사 요청','${escapeHtml(app.id)}')">재심사 요청</button>`}
      </div>`;
  }
}

async function finalizeDecision(btn, label, appId) {
  const area = btn.closest('.decision-actions');
  setBusy(btn, '처리 중…');
  const action = label === '승인' ? 'approve' : label === '거절 확정' ? 'reject' : 'hold';
  try {
    const result = await apiAction(appId, 'decision', {action});
    Object.assign(findApp(appId), result);
    area.innerHTML = `<span>✓ ${escapeHtml(label)} · ${action === 'approve' ? '모의 계약 생성됨' : '시연 기록 저장'}</span>`;
    await apiReload();
    showToast('처리 완료 · 시연용 결과입니다');
  } catch(err) {errToast(err); if(btn){btn.disabled=false;btn.textContent=label;}}
}


/* ---------------- 데이터 초기화 (서버의 모든 방문자 데이터를 초기 상태로) ---------------- */
async function resetAllState() {
  if (!window.confirm('데모 DB 전체를 초기화합니다. 서버에 저장된 신규 신청·파일·보고서가 영구 삭제됩니다. 계속할까요?')) return;
  try {
    if (!API_TOKEN) { API_TOKEN = prompt('관리자 초기화 키(IPLOAN_ADMIN_KEY)를 입력하세요') || ''; }
    APPLICATIONS = await apiReset();
    hideConnNotice();
  } catch (err) {
    errToast(err); return;
  }
  evalInitDone = false;
  reviewInitDone = false;
  currentReviewId = null;
  activeFilter = 'all';
  const searchEl = document.getElementById('listSearch');
  if (searchEl) searchEl.value = '';

  renderDashboard();
  renderFilterChips();
  renderListTable();
  renderEvalList();
  renderReviewList();
  document.getElementById('evalReportPanel').innerHTML = '';
  document.getElementById('reviewBody').innerHTML = '';
  goView('dashboard');
}

/* ---------------- Init ---------------- */
let APPLICATIONS = [];

async function initApp() {
  document.getElementById('topbarDate').textContent = new Date().toLocaleDateString('ko-KR');
  try {
    APPLICATIONS = await apiFetchApplications();
    hideConnNotice();
  } catch (err) {
    APPLICATIONS = JSON.parse(JSON.stringify(FALLBACK_APPLICATIONS));
    showConnNotice();
  }
  renderDashboard();
  renderFilterChips();
  renderListTable();
  renderEvalList();
  renderReviewList();
}

document.getElementById('connNoticeRetry').addEventListener('click', async () => {
  try {
    APPLICATIONS = await apiFetchApplications();
    hideConnNotice();
    evalInitDone = false;
    reviewInitDone = false;
    renderDashboard();
    renderListTable();
    renderEvalList();
    renderReviewList();
  } catch (err) {
    showConnNotice();
  }
});

document.getElementById('resetDemoBtn').addEventListener('click', resetAllState);

applyRole();
initApp();

/* 실제 API 상태와 블록체인 모드를 표시합니다. 존재하지 않는 블록 높이는 꾸며내지 않습니다. */
async function showServiceState() {
  try {
    SERVICE_CONFIG = await apiRequest('/config');
    const element = document.getElementById('blockNo');
    element.textContent = SERVICE_CONFIG.chainMode === 'rpc' ? 'RPC 실연동 설정 (확정 기록만)' : '모의 원장(DB) · 실제 블록 아님';
    const box = document.getElementById('modeNotice');
    box.textContent = `${SERVICE_CONFIG.llmConfigured ? 'LLM API 연결 설정됨' : 'LLM 미설정 · 템플릿 보고서'} · ${SERVICE_CONFIG.chainMode === 'rpc' ? '온체인 기록 모드' : '모의 체인 기록'} · 대출/평가액/토큰 시연용`;
  } catch(err) { document.getElementById('modeNotice').textContent='API 서버 연결 전 · 백엔드 배포 확인 필요'; }
}
async function configureDemoKey() {
  const value = window.prompt('시연 API 키 (IPLOAN_API_KEY). 공개 서버 운영 인증 수단으로 사용하지 마세요.', API_TOKEN);
  if (value === null) return;
  API_TOKEN = value.trim();
  if (API_TOKEN) sessionStorage.setItem('iploan-demo-key', API_TOKEN);
  else sessionStorage.removeItem('iploan-demo-key');
  await initApp();
}
showServiceState();

/* 모의 RWA 발행·월렛이전, 상환, 문서 원본 대조 테스트 (모두 DB에 기록) */
function renderWorkflowActions(a) {
  const target = document.getElementById('workflowActions');
  if (!target) return;
  const buttons = [];
  if (!['approved','rejected'].includes(a.status)) buttons.push(`<button class="btn btn-outline btn-sm" onclick="addDocumentsToCase('${a.id}')">심사서류 추가 업로드</button>`);
  if (a._report) buttons.push(`<button class="btn btn-outline btn-sm" onclick="printEvaluation('${a.id}')">평가보고서 인쇄</button>`);
  if (a.reportConfirmed && !a.token) buttons.push(`<button class="btn btn-outline btn-sm" onclick="doWorkflow('${a.id}','rwa')">모의 RWA 발행</button>`);
  if (a.token && a.token.state === 'minted') buttons.push(`<button class="btn btn-outline btn-sm" onclick="doWorkflow('${a.id}','rwa/transfer')">은행 시연월렛 이전</button>`);
  if (a.loan && a.loan.remaining > 0) buttons.push(`<button class="btn btn-outline btn-sm" onclick="repayDemo('${a.id}')">모의 상환</button>`);
  if (canView('evaluate') && !a.reportConfirmed && !['approved','rejected'].includes(a.status)) buttons.push(`<button class="btn btn-outline btn-sm" onclick="goView('evaluate');selectEvalItem('${a.id}')">가치평가 보고서 생성</button>`);
  if (a.status === 'review' && a.reportConfirmed) buttons.push(`<button class="btn btn-outline btn-sm" onclick="goView('review');loadReviewCase('${a.id}')">심사 화면</button>`);
  const docs = (a.documentDetails || []).map(d => `
    <div class="doc-row"><span>${escapeHtml(d.filename)} · SHA-256 ${escapeHtml(d.sha256)}</span>
    <button class="btn btn-outline btn-sm" onclick="verifyDocumentDemo('${a.id}','${d.id}')">참조 해시 대조</button></div>`).join('');
  const ledger = (a.chainEvents || []).map(ev => `${escapeHtml(ev.event_type)} · ${ev.mode === 'rpc_confirmed' ? '실제 체인 기록' : '시연 DB 기록'} ${ev.tx_hash ? 'TX: '+escapeHtml(ev.tx_hash) : '(TX 없음)'}`).join('<hr>');
  target.innerHTML = `
    <div class="section-title">시연 워크플로 관리</div><p class="real-demo-warning">모의 RWA·대출계약·상환은 실제 자금이나 토큰을 전송하지 않습니다. 사용자가 직접 입력한 참조 해시는 발급기관 인증이 아닙니다.</p>
    <div class="action-bar">${buttons.join('')}</div>
    ${a.token ? `<p>RWA: ${escapeHtml(a.token.token_id)} · ${escapeHtml(a.token.state)} · ${escapeHtml(a.token.owner)}</p>` : ''}
    ${a.loan ? `<p>모의 계약: ${escapeHtml(a.loan.contract_ref)} · 잔액 ${won(a.loan.remaining)} · ${escapeHtml(a.loan.state)}</p>` : ''}
    <div class="section-title">제출 문서 SHA-256</div>${docs || '<p>제출된 문서 없음</p>'}
    <div class="section-title">기록 로그</div><div class="mono-line">${ledger || '기록 없음'}</div>`;
}
async function doWorkflow(id, task) {
  try {
    const data = await apiAction(id, task);
    Object.assign(findApp(id), data);
    openDetail(id);
    showToast('시연용 작업 기록 완료 · 실제 토큰 전송 아님');
  } catch(err) {errToast(err);}
}
async function repayDemo(id) {
  const a=findApp(id);
  const text=prompt(`모의 대출 잔액 ${Number(a.loan.remaining).toLocaleString('ko-KR')}원 · 상환액 입력`, a.loan.remaining);
  if(text===null)return;
  const amount=Number(text.replace(/[^0-9]/g,''));
  try {
    const data=await apiAction(id,'repay',{amount});
    Object.assign(a,data);openDetail(id);showToast('모의 상환 처리 완료');
  } catch(err) {errToast(err);}
}
async function verifyDocumentDemo(id, docid) {
  const input = prompt('비교할 SHA-256(64자리)을 입력하세요. 직접 입력한 참조값은 공식 발급기관 확인이 아닙니다.');
  if(input === null) return;
  try {
    const data = await apiAction(id, `documents/${docid}/verify`, {referenceSha256: input.trim()});
    Object.assign(findApp(id),data.application);
    openDetail(id);
    showToast(data.matchesSuppliedReference ? '입력한 참조값과 일치 (발급기관 미인증)' : '참조값 미일치 또는 미제공');
  } catch(err){errToast(err);}
}

async function addDocumentsToCase(id) {
  const input=document.createElement('input');
  input.type='file';input.multiple=true;input.accept='.pdf,.png,.jpg,.jpeg';
  input.addEventListener('change', async () => {
    const files=Array.from(input.files);
    if(!files.length)return;
    try {
      const response=await apiUploadDocuments(id,files);
      Object.assign(findApp(id),response.application);
      await apiReload();
      openDetail(id);
      showToast('업로드 및 SHA-256 계산 완료. 평가보고서를 생성하거나 재생성하세요.');
    }catch(err){errToast(err);}
  },{once:true});
  input.click();
}
