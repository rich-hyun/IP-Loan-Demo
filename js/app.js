/* ==========================================================================
   LLM 기반 기술평가 자동대출 시스템 — 프론트엔드 로직 (v3)
   지갑 로그인 → 차주 신청 → 담당 평가사의 LLM 보고서 확정 → 담당 은행의 대출약정·RWA 토큰 → 상환 기록.
   서버는 로그인한 지갑이 담당하는 신청만 돌려주고, 체인 거래는 각 담당자가 MetaMask로 서명합니다.
   ========================================================================== */

/* 서버 API 주소. localhost에서 열면 로컬 API(server/app.py, 5001번 포트)를 사용합니다. */
const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const API_BASE = IS_LOCAL ? 'http://127.0.0.1:5001/api' : 'https://iploan-api.mustree.kr/api';

/* ---------------- Status labels ---------------- */
const STATUS_META = {
  pending:    { label: '등록 대기',   badge: 'badge-pending'  },
  doc_verify: { label: '서류 불일치', badge: 'badge-rejected' },
  evaluating: { label: '평가중',      badge: 'badge-review'   },
  review:     { label: '심사중',      badge: 'badge-review'   },
  approved:   { label: '약정 체결',   badge: 'badge-approved' },
  repaid:     { label: '상환 완료',   badge: 'badge-approved' },
  rejected:   { label: '거절',        badge: 'badge-rejected' },
  archived:   { label: '보관',        badge: 'badge-pending'  },
};
const REPORT_STATUS = {
  submitting: { label: '접수 확인 중', badge: 'badge-verify', title: '평가 요청을 접수하고 있습니다', text: '제출한 특허 공고전문을 보고서 생성 서비스에 전달합니다.' },
  queued: { label: '생성 대기', badge: 'badge-pending', title: '보고서 생성 순서를 기다리고 있습니다', text: '접수가 완료되었습니다. 준비된 작업은 접수 순서대로 처리됩니다.' },
  running: { label: '생성 중', badge: 'badge-review', title: 'LLM 가치평가보고서를 생성하고 있습니다', text: '특허와 기업자료를 분석 중입니다. 완료되면 담당 평가사가 검토할 수 있습니다.' },
  awaiting_identity: { label: '기업 확인 필요', badge: 'badge-verify', title: '사업자등록번호를 확인해 주세요', text: '제출한 PDF는 저장되어 있습니다. 기업번호를 확인하면 같은 작업에서 보고서 생성을 이어갑니다.' },
  completed: { label: '보고서 도착', badge: 'badge-approved', title: '가치평가보고서가 도착했습니다', text: '담당 평가사가 보고서와 근거자료를 확인하고 평가액을 확정할 수 있습니다.' },
  failed: { label: '생성 실패', badge: 'badge-rejected', title: '보고서 생성이 중단되었습니다', text: '아래 사유와 작업번호를 운영 담당자에게 전달해 주세요.' },
  submission_rejected: { label: '미접수', badge: 'badge-rejected', title: '신청은 저장되었지만 보고서 접수가 완료되지 않았습니다', text: '아래 내용을 확인한 뒤 보관된 PDF로 다시 접수할 수 있습니다.' },
  submission_unknown: { label: '접수 확인 필요', badge: 'badge-verify', title: '보고서 접수 여부를 확인하고 있습니다', text: '중복 접수를 방지하기 위해 자동 재접수를 중단했습니다. 신청번호와 접수 시각으로 운영 담당자에게 확인해 주세요.' },
};
const ACTIVE_REPORT_STATUSES = new Set(['submitting', 'queued', 'running', 'awaiting_identity']);
const EVALUATED_STAGES = ['Eligible', 'RuleRejected', 'Approved', 'Rejected', 'Repaid'];
const ARTIFACT_LABELS = { pdf: 'PDF 보고서', html: 'HTML 보고서', quality: '근거·검증 자료', trace: '근거 추적 자료', timing: '소요시간', log: '진행 로그' };
const ARTIFACT_SUFFIX = { quality: 'json', timing: 'json', trace: 'md', log: 'txt' };

/* ---------------- Roles & views ---------------- */
const ROLE_ORDER = ['borrower', 'evaluator', 'bank', 'admin'];
const ROLE_META = {
  borrower:  { label: '차주기업',       avatar: '차주', views: ['dashboard', 'list', 'apply', 'detail'] },
  evaluator: { label: 'IP 가치평가사',  avatar: '평가', views: ['dashboard', 'evaluate', 'archive'] },
  bank:      { label: '은행 여신심사역', avatar: '은행', views: ['dashboard', 'list', 'review', 'archive'] },
  admin:     { label: '관리자',         avatar: '관리', views: ['dashboard', 'list', 'detail', 'archive'] },
};
const VIEW_META = {
  login:     { title: '지갑 인증 로그인',   sub: '등록된 지갑으로 로그인하면 담당 업무 화면이 열립니다' },
  dashboard: { title: '대시보드',           sub: 'LLM·블록체인 기반 IP담보 자동대출 업무 현황' },
  list:      { title: '대출 신청 내역',     sub: '담당하는 대출 신청 건의 진행 상태를 확인합니다' },
  apply:     { title: '대출 신청',          sub: '지식재산권을 담보로 등록하고 대출을 신청합니다' },
  evaluate:  { title: 'IP 가치평가',        sub: 'LLM이 생성한 가치평가보고서를 검토하고 평가액을 확정합니다' },
  review:    { title: '여신 심사·약정',     sub: '자동심사 결과를 확인하고 신용등급·금리·기간으로 대출약정을 체결합니다' },
  archive:   { title: '이전 보고서 보관함', sub: '이전에 작성된 가치평가보고서를 열람합니다' },
  detail:    { title: '신청 진행 상황',     sub: '' },
};
const ROLE_STORAGE_KEY = 'iploan-role';
const BORROWER_STORAGE_KEY = 'iploan-borrower-profile';

let APPLICATIONS = [];
let BORROWER_PROFILES = [];
let currentRole = null;
let currentView = 'login';
let currentBorrowerProfileId = '';
let profilesLoaded = false;
let applicationSubmitting = false;
let chainOperationBusy = false;
let lastChainApplication = null;
let selectedEvalId = null, selectedReviewId = null, selectedArchiveId = null, detailId = null;
let previewUrl = null;
let refreshing = false;
try { currentBorrowerProfileId = localStorage.getItem(BORROWER_STORAGE_KEY) || ''; } catch { /* 기본 프로필 */ }

/* ---------------- Helpers ---------------- */
const NA_HTML = '<span class="val-na">-</span>';
function won(n) { return n == null || isNaN(n) ? NA_HTML : Number(n).toLocaleString('ko-KR') + '원'; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
/* 필드 값을 HTML로: 값이 없으면 "-". fmt는 HTML을 돌려주는 포맷 함수 */
function fieldHTML(app, key, fmt) {
  const v = app[key];
  if (v == null || v === '') return NA_HTML;
  return fmt ? fmt(v) : escapeHtml(v);
}
function findApp(id) { return APPLICATIONS.find(a => a.id === id); }
function statusBadge(status) {
  const m = STATUS_META[status] || STATUS_META.pending;
  return `<span class="badge ${m.badge}">${m.label}</span>`;
}
function reportMeta(app) {
  if (!app.evaluation) return { label: '보고서 없음', badge: 'badge-pending' };
  if (app.evaluation.confirmed_at || (app.chainStatus && EVALUATED_STAGES.includes(app.chainStatus))) return { label: '평가 확정', badge: 'badge-approved' };
  return REPORT_STATUS[app.evaluation.status] || REPORT_STATUS.submitting;
}
function reportBadge(app) {
  const meta = reportMeta(app);
  return `<span class="badge ${meta.badge}">${meta.label}</span>`;
}
function formatDate(value) {
  if (!value) return '—';
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('ko-KR', { hour12: false });
}
function shortAddress(address) { return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '—'; }
function rateText(bps) { return bps == null ? NA_HTML : `${(bps / 100).toFixed(2)}%`; }
/* 계약과 같은 기준: 신청금액 × 100 ≤ 평가액 × 70 이면 자동심사 통과. 경계값이 계약과 같도록 정수로 계산한다. */
function passesLtv(amount, value) { return BigInt(amount) * 100n <= BigInt(value) * 70n; }
function minimumPassingValue(amount) { return Number((BigInt(amount) * 100n + 69n) / 70n); }
function ltvPreview(amount, value) {
  return `담보인정비율 ${Math.round(amount / value * 1000) / 10}% · ${passesLtv(amount, value) ? '자동심사 통과 예상' : '자동심사 거절 예상 (70% 초과)'}`;
}
function months(v) { return `${escapeHtml(v)}개월`; }
function upsertApplication(application) {
  const index = APPLICATIONS.findIndex(a => a.id === application.id);
  if (index >= 0) APPLICATIONS[index] = application;
  else APPLICATIONS.unshift(application);
  return application;
}
function readOnlyNote(app) {
  return app.contractOutdated ? '<div class="notice-box warn"><span>이전 시스템에서 접수된 신청이라 <b>열람만</b> 할 수 있습니다. 새로 신청해 주세요.</span></div>' : '';
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}
function showConnNotice() { document.getElementById('connNotice').classList.add('show'); }
function hideConnNotice() { document.getElementById('connNotice').classList.remove('show'); }

/* ---------------- API ---------------- */
const api = (path, options) => IPLoanChain.api(path, options);
const postJSON = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function apiCreateApplication(formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/applications`);
    for (const [name, value] of Object.entries(IPLoanChain.authHeaders())) xhr.setRequestHeader(name, value);
    xhr.timeout = 660000;
    xhr.upload.onprogress = (event) => {
      onProgress(event.lengthComputable ? Math.round(event.loaded / event.total * 100) : null);
    };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* handled below */ }
      if (xhr.status >= 200 && xhr.status < 300 && data) return resolve(data);
      reject(Object.assign(new Error(data?.message || '신청 처리에 실패했습니다. 잠시 후 다시 시도하세요.'), { status: xhr.status, data }));
    };
    xhr.onerror = () => reject(new Error('신청 서버에 연결하지 못했습니다. 네트워크 상태를 확인해 주세요.'));
    xhr.ontimeout = () => reject(new Error('서류 업로드 시간이 초과되었습니다. 잠시 후 다시 시도하세요.'));
    xhr.onabort = () => reject(new Error('업로드를 취소했습니다.'));
    xhr.send(formData);
  });
}

/* ---------------- 로그인·역할 ---------------- */
function session() { return IPLoanChain.session(); }
function heldRoles() { return ROLE_ORDER.filter(role => session()?.roles?.includes(role)); }
function chooseRole() {
  const held = heldRoles();
  let saved = null;
  try { saved = localStorage.getItem(ROLE_STORAGE_KEY); } catch { /* 기본 역할 */ }
  currentRole = held.includes(saved) ? saved : held[0] || null;
}
function canView(name) {
  if (!session() || !currentRole) return name === 'login';
  return ROLE_META[currentRole].views.includes(name);
}
function hasAccess(app, ...capacities) { return capacities.some(c => app.access?.includes(c)); }

function applyRole() {
  const user = session();
  const meta = ROLE_META[currentRole];
  document.body.classList.toggle('logged-out', !user || !currentRole);
  document.getElementById('loginBtnTop').hidden = Boolean(user);
  document.getElementById('userChip').hidden = !user;
  document.getElementById('userAvatar').textContent = meta?.avatar || '—';
  document.getElementById('userName').textContent = shortAddress(user?.address);
  document.getElementById('userRole').textContent = meta?.label || '등록된 역할 없음';
  document.getElementById('roleOptions').innerHTML = heldRoles().map(role =>
    `<button class="role-option" type="button" role="menuitemradio" data-role="${role}" aria-checked="${role === currentRole}">${ROLE_META[role].label}</button>`).join('')
    || '<div class="role-option">등록된 역할이 없습니다</div>';
  document.getElementById('adminLink').hidden = !heldRoles().includes('admin');
  document.querySelectorAll('.nav-item').forEach(b => { b.parentElement.hidden = !canView(b.dataset.view); });
}

function setRole(role) {
  if (applicationSubmitting || chainOperationBusy) return showToast('현재 지갑 작업 완료 후 역할을 전환해 주세요');
  currentRole = role;
  try { localStorage.setItem(ROLE_STORAGE_KEY, role); } catch { /* 무시 */ }
  applyRole();
  renderAll();
  goHome();
  showToast(`${ROLE_META[role].label} 업무로 전환했습니다`);
}
/* Each role starts on its own work: the borrower's applications (or the form for a first one), the case to evaluate or to review. */
function goHome() {
  if (currentRole === 'borrower') return goView(APPLICATIONS.some(a => hasAccess(a, 'borrower')) ? 'list' : 'apply');
  goView({ evaluator: 'evaluate', bank: 'review' }[currentRole] || 'dashboard');
}

let loginBusy = false;
async function doLogin({ pick = true } = {}) {
  if (loginBusy) return;
  loginBusy = true;
  const buttons = ['loginBtn', 'loginBtnTop', 'connectAccountsBtn'].map(id => document.getElementById(id));
  buttons.forEach(b => { b.disabled = true; });
  document.getElementById('loginBtn').textContent = 'MetaMask에서 서명해 주세요…';
  try {
    await IPLoanChain.login({ pick });
    await onLoggedIn();
    showToast(currentRole ? `${ROLE_META[currentRole].label}(으)로 로그인했습니다` : '로그인했지만 등록된 역할이 없습니다');
  } catch (error) {
    document.getElementById('loginHelp').textContent = error.message;
    showToast(error.message);
  } finally {
    loginBusy = false;
    buttons.forEach(b => { b.disabled = false; });
    document.getElementById('loginBtn').textContent = 'MetaMask 지갑으로 로그인';
  }
}
/* Switching accounts in MetaMask: a wallet that signed in before resumes at once; a new one is asked to sign in. */
async function onSessionChange(reason) {
  if (reason === 'ended') return onLoggedOut('로그인이 만료되어 다시 로그인해 주세요');
  onLoggedOut();
  if (reason === 'switched') {
    try {
      if (await IPLoanChain.restore()) {
        await onLoggedIn();
        return showToast(currentRole ? `${ROLE_META[currentRole].label}(으)로 전환했습니다` : '이 지갑에 등록된 역할이 없습니다');
      }
    } catch { return showConnNotice(); }
  }
  await doLogin({ pick: false });
}

async function onLoggedIn() {
  chooseRole();
  applyRole();
  if (!currentRole) {
    document.getElementById('loginHelp').textContent = `${session().address} 지갑에 등록된 역할이 없습니다. 관리자에게 주소 등록을 요청하세요.`;
    goView('login');
    return;
  }
  try {
    await loadServerData();
    hideConnNotice();
  } catch (error) {
    if (!session()) return;
    showConnNotice();
  }
  renderAll();
  goHome();
}

function onLoggedOut(message = '') {
  APPLICATIONS = []; BORROWER_PROFILES = []; profilesLoaded = false; currentRole = null;
  selectedEvalId = selectedReviewId = selectedArchiveId = detailId = null;
  applyRole();
  goView('login');
  if (message) showToast(message);
}

// Sign in with the account selected in MetaMask; the account picker is only for connecting more accounts to this site.
document.getElementById('loginBtn').addEventListener('click', () => doLogin({ pick: false }));
document.getElementById('loginBtnTop').addEventListener('click', () => doLogin({ pick: false }));
document.getElementById('connectAccountsBtn').addEventListener('click', () => doLogin({ pick: true }));
document.getElementById('logoutBtn').addEventListener('click', async () => {
  toggleRoleMenu(false);
  if (applicationSubmitting || chainOperationBusy) return showToast('현재 지갑 작업 완료 후 로그아웃해 주세요');
  await IPLoanChain.logout();
  onLoggedOut('로그아웃했습니다');
});

const userChip = document.getElementById('userChip');
const roleMenu = document.getElementById('roleMenu');
/* The RWA token minted to the bank at approval, shown in MetaMask's NFT list. */
async function showRwaToken(tokenId) {
  try {
    await IPLoanChain.watchNft(IPLoanChain.config().rwaTokenAddress, tokenId);
    showToast('MetaMask에서 RWA 토큰을 확인할 수 있습니다');
  } catch (error) { showToast(error.message); }
}
function toggleRoleMenu(open) {
  roleMenu.hidden = !open;
  userChip.setAttribute('aria-expanded', String(open));
}
userChip.addEventListener('click', () => toggleRoleMenu(roleMenu.hidden));
document.getElementById('roleOptions').addEventListener('click', (e) => {
  const option = e.target.closest('[data-role]');
  if (option) { toggleRoleMenu(false); setRole(option.dataset.role); }
});
document.addEventListener('click', (e) => {
  if (!roleMenu.hidden && !document.getElementById('profile').contains(e.target)) toggleRoleMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !roleMenu.hidden) { toggleRoleMenu(false); userChip.focus(); }
});

/* ---------------- Navigation ---------------- */
function goView(name) {
  if (!canView(name)) name = session() && currentRole ? 'dashboard' : 'login';
  currentView = name;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  const navName = name === 'detail' ? 'list' : name;  // 진행 상황 화면은 신청 내역 메뉴를 강조
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === navName));
  document.getElementById('topbarTitle').textContent = VIEW_META[name].title;
  document.getElementById('topbarSub').textContent = VIEW_META[name].sub;
  document.getElementById('breadcrumbCurrent').textContent = VIEW_META[name].title;
  if (name === 'evaluate') openFirst(evalQueue(), selectedEvalId, selectEvalItem, 'evalReportPanel', '배정된 평가 건이 없습니다.');
  if (name === 'review') openFirst(reviewQueue(), selectedReviewId, loadReviewCase, 'reviewBody', '배정된 심사 건이 없습니다.', true);
  if (name === 'archive') openFirst(archiveQueue(), selectedArchiveId, selectArchiveItem, 'archivePanel', '보관된 보고서가 없습니다.');
}
function openFirst(queue, selected, open, panelId, emptyText, wrapPanel = false) {
  const target = queue.find(a => a.id === selected) || queue[0];
  if (target) open(target.id);
  else document.getElementById(panelId).innerHTML = wrapPanel ? `<div class="panel"><div class="empty-hint">${emptyText}</div></div>` : `<div class="empty-hint">${emptyText}</div>`;
}
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => goView(btn.dataset.view));
});

/* ---------------- Data ---------------- */
async function loadServerData() {
  APPLICATIONS = await api('/applications');
  if (heldRoles().includes('borrower')) {
    BORROWER_PROFILES = await api('/borrower-profiles');
    profilesLoaded = true;
    if (!BORROWER_PROFILES.some(p => p.id === currentBorrowerProfileId)) selectBorrowerProfile(BORROWER_PROFILES[0]?.id || '');
    renderBorrowerProfiles();
    fillBorrowerInfo();
  }
}
/* 역할별로 이 화면에서 다루는 신청. 서버가 이미 로그인한 지갑의 담당 건만 돌려준다. */
function visibleApps() {
  if (!currentRole) return [];
  if (currentRole === 'admin') return APPLICATIONS.filter(a => a.status !== 'archived');
  // Bank reviewers also see applications the contract rejected automatically (read-only, no bank assigned).
  return APPLICATIONS.filter(a => hasAccess(a, currentRole) || (currentRole === 'bank' && hasAccess(a, 'bank_notice')));
}
function renderAll() {
  renderChainStatus();
  renderDashboard();
  renderFilterChips();
  renderListTable();
  renderEvalList();
  renderReviewList();
  renderArchiveList();
}
function renderChainStatus() {
  const cfg = IPLoanChain.config();
  document.getElementById('chainDot').classList.toggle('off', !cfg?.enabled);
  document.getElementById('chainNetwork').textContent = cfg?.enabled ? `${cfg.networkName} 네트워크 연결` : '블록체인 계약 미설정';
  document.getElementById('blockNo').textContent = cfg?.blockNumber ? `Block #${Number(cfg.blockNumber).toLocaleString('ko-KR')}` : 'Block —';
}

/* ---------------- Dashboard ---------------- */
function renderDashboard() {
  const apps = visibleApps();
  const counts = {};
  Object.keys(STATUS_META).forEach(k => { counts[k] = 0; });
  apps.forEach(a => { counts[a.status] = (counts[a.status] || 0) + 1; });
  document.getElementById('statusTotal').textContent = `전체 ${apps.length}건`;
  const order = ['pending', 'evaluating', 'review', 'approved', 'repaid', 'rejected'];
  document.getElementById('statusRow').innerHTML = order.map(k => `
    <div class="status-pill">
      <div class="status-pill-count">${counts[k]}</div>
      <div class="status-pill-label">${STATUS_META[k].label}</div>
    </div>`).join('');
  const recent = [...apps].sort((a, b) => (b.appliedDate || '').localeCompare(a.appliedDate || '')).slice(0, 5);
  document.querySelector('#miniTable tbody').innerHTML = recent.map(a => `
    <tr data-open="${escapeHtml(a.id)}">
      <td class="cell-company">${escapeHtml(a.company)}</td>
      <td>${escapeHtml(a.ipTitle || '')}</td>
      <td class="cell-amount">${fieldHTML(a, 'amount', won)}</td>
      <td>${statusBadge(a.status)}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="empty-hint">담당 신청 건이 없습니다.</td></tr>';
  document.querySelectorAll('#miniTable tbody tr[data-open]').forEach(tr => tr.addEventListener('click', () => openApplication(tr.dataset.open)));

  const welcome = {
    borrower: [`진행 중인 신청 ${apps.filter(a => !['approved', 'repaid', 'rejected'].includes(a.status)).length}건`, '새 대출 신청', 'apply'],
    evaluator: [`평가 확정을 기다리는 보고서 ${evalQueue().filter(a => a.chainStatus === 'Evaluating' && a.evaluation?.status === 'completed').length}건`, '평가 배정 목록', 'evaluate'],
    bank: [`약정 체결을 기다리는 신청 ${apps.filter(a => a.chainStatus === 'Eligible').length}건`, '심사 배정 목록', 'review'],
    admin: [`전체 신청 ${apps.length}건 · 역할 주소는 관리자 화면에서 관리합니다`, '신청 내역', 'list'],
  }[currentRole];
  if (!welcome) return;
  document.getElementById('welcomeTitle').textContent = `${ROLE_META[currentRole].label} 업무`;
  document.getElementById('welcomeText').textContent = welcome[0];
  const action = document.getElementById('welcomeAction');
  action.hidden = false;
  action.textContent = welcome[1];
  action.onclick = () => goView(welcome[2]);
}
function openApplication(id) {
  if (currentRole === 'evaluator') { selectedEvalId = id; goView('evaluate'); }
  else if (currentRole === 'bank') { selectedReviewId = id; goView('review'); }
  else openDetail(id);
}

/* ---------------- List view ---------------- */
let activeFilter = 'all';
const FILTERS = [['all', '전체'], ['pending', '등록 대기'], ['evaluating', '평가중'], ['review', '심사중'], ['approved', '약정 체결'], ['repaid', '상환 완료'], ['rejected', '거절']];
function renderFilterChips() {
  document.getElementById('filterChips').innerHTML = FILTERS.map(([key, label]) => `
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
    <tr data-id="${escapeHtml(a.id)}">
      <td class="cell-hash">${escapeHtml(a.id)}</td>
      <td class="cell-company">${escapeHtml(a.company)}<div class="cell-sub">${fieldHTML(a, 'bizNo')}</div></td>
      <td>${escapeHtml(a.ipTitle || '')}<div class="cell-sub">${escapeHtml(a.ipType || '')} · ${fieldHTML(a, 'ipRegNo')}</div></td>
      <td class="cell-amount">${fieldHTML(a, 'amount', won)}</td>
      <td>${statusBadge(a.status)}</td>
      <td>${reportBadge(a)}</td>
      <td>${fieldHTML(a, 'appliedDate')}</td>
      <td class="row-arrow">›</td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty-hint">조건에 맞는 신청이 없습니다.</td></tr>';
  document.querySelectorAll('#listTableBody tr[data-id]').forEach(tr => {
    tr.addEventListener('click', () => openApplication(tr.dataset.id));
  });
}
document.getElementById('listSearch').addEventListener('input', renderListTable);

/* ---------------- LLM 보고서 작업 상태 (평가사·차주 공용) ---------------- */
function statusContent(app) {
  const job = app.evaluation;
  const meta = REPORT_STATUS[job.status] || REPORT_STATUS.submitting;
  const failed = ['failed', 'submission_rejected'].includes(job.status);
  let html = `<div class="job-state ${failed ? 'job-error' : ''}">
    <div class="job-state-icon" aria-hidden="true">${job.status === 'completed' ? '✓' : failed || job.status === 'submission_unknown' ? '!' : '◷'}</div>
    <div><h4>${meta.title}</h4><p>${meta.text}</p>${job.stage && !['finished', ''].includes(job.stage) ? `<div class="job-stage">현재 단계: ${escapeHtml(job.stage)}</div>` : ''}</div></div>`;
  if (job.error) html += `<div class="inline-message error-message">${escapeHtml(job.error)}</div>`;
  if (job.detail) html += `<details class="error-detail"><summary>오류 상세 보기</summary><pre>${escapeHtml(typeof job.detail === 'string' ? job.detail : JSON.stringify(job.detail, null, 2))}</pre></details>`;
  if (job.read_error) html += `<div class="inline-message">${escapeHtml(job.read_error)} 다음 조회에서 다시 확인합니다.</div>`;
  const canFix = hasAccess(app, 'borrower', 'evaluator');
  if (job.status === 'awaiting_identity' && canFix) html += `<form class="identity-form" data-app-id="${escapeHtml(app.id)}">
    <div class="field"><label>기업 사업자등록번호<input name="business_number" value="${escapeHtml(app.bizNo || '')}" placeholder="000-00-00000" inputmode="numeric" pattern="[0-9]{10}|[0-9]{3}-[0-9]{2}-[0-9]{5}" required></label></div>
    <button class="btn btn-primary btn-sm" type="submit">번호 확인하고 이어서 생성</button><div class="identity-error inline-message error-message" role="alert" hidden></div></form>`;
  if (job.identity_message && job.status === 'awaiting_identity') html += `<p class="help">${escapeHtml(job.identity_message)}</p>`;
  if (job.status === 'submission_rejected' && canFix) html += `<div class="button-row"><button class="btn btn-outline btn-sm" type="button" data-retry-app="${escapeHtml(app.id)}">보관된 PDF로 다시 접수</button>${job.retry_after ? `<span class="help">${job.retry_after}초 대기 후 재접수할 수 있습니다.</span>` : ''}</div>`;
  return html;
}
function artifactPath(app, kind) { return `/applications/${encodeURIComponent(app.id)}/evaluation/artifacts/${kind}`; }
function reportDownloadsHTML(app) {
  return `<div class="report-downloads">${['pdf', 'html', 'quality', 'trace', 'timing', 'log'].filter(k => app.evaluation.artifacts.includes(k))
    .map(k => `<button class="btn btn-outline btn-sm" type="button" data-artifact="${k}" data-app-id="${escapeHtml(app.id)}">${ARTIFACT_LABELS[k]} 다운로드</button>`).join('')}</div>`;
}
function reportPreviewHTML(app, frameId) {
  const kind = app.evaluation.artifacts.includes('pdf') ? 'pdf' : app.evaluation.artifacts.includes('html') ? 'html' : null;
  if (!kind) return '<div class="inline-message error-message">작업은 완료되었지만 PDF·HTML 보고서가 제공되지 않았습니다. 작업번호로 운영 담당자에게 확인해 주세요.</div>';
  return `<div class="report-preview-heading"><b>LLM 가치평가보고서</b><span class="help">로그인한 담당자에게만 표시됩니다</span></div>
    <iframe class="report-preview" id="${frameId}" data-path="${escapeHtml(artifactPath(app, kind))}" title="${escapeHtml(app.ipTitle || app.id)} 평가보고서" ${kind === 'html' ? 'sandbox=""' : ''}></iframe>`;
}
/* 보고서는 인증이 필요해 iframe src로 직접 열 수 없으므로 로그인 토큰으로 받아 blob URL로 보여 준다. */
async function loadPreview(frameId) {
  const frame = document.getElementById(frameId);
  if (!frame) return;
  try {
    const file = await IPLoanChain.blob(frame.dataset.path);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    if (document.getElementById(frameId) === frame) frame.src = previewUrl;
  } catch (error) {
    frame.outerHTML = `<div class="inline-message error-message">${escapeHtml(error.message)}</div>`;
  }
}

/* ---------------- 신청 진행 상황 (차주·관리자) ---------------- */
const PROGRESS_STEPS = [
  { label: '신청 접수', owner: '차주기업', done: a => true },
  { label: '신청 서명', owner: '차주 지갑', done: a => a.chainStatus && a.chainStatus !== 'None' },
  { label: 'LLM 가치평가', owner: 'LLM 보고서 생성', done: a => a.evaluation?.status === 'completed' || EVALUATED_STAGES.includes(a.chainStatus) },
  { label: '평가 확정·심사', owner: '담당 평가사', done: a => EVALUATED_STAGES.includes(a.chainStatus) && a.chainStatus !== 'RuleRejected',
    rejected: a => a.chainStatus === 'RuleRejected' },
  { label: '대출약정', owner: '은행 여신심사역', done: a => ['Approved', 'Repaid'].includes(a.chainStatus), rejected: a => a.chainStatus === 'Rejected' },
];
function openDetail(id) {
  const app = findApp(id);
  if (!app) return;
  detailId = id;
  const doneCount = PROGRESS_STEPS.filter(s => s.done(app)).length;
  document.getElementById('detailTitle').textContent = app.ipTitle || app.id;
  document.getElementById('detailHint').textContent = `${app.id} · ${app.ipType || ''}`;
  document.getElementById('detailStatus').innerHTML = `${statusBadge(app.status)}<span>${escapeHtml(app.rejectReason || {
    pending: '신청이 접수되었습니다. 지갑 서명으로 등록을 완료해 주세요.', doc_verify: '발급기관 원본과 서류가 일치하지 않습니다.',
    evaluating: 'IP 가치평가가 진행 중입니다.', review: '자동심사를 통과해 은행 약정 심사가 진행 중입니다.',
    approved: '대출약정이 체결되었습니다.', repaid: '상환이 완료되었습니다.', rejected: '대출이 승인되지 않았습니다.',
  }[app.status] || '')}</span>`;
  const stopped = PROGRESS_STEPS.findIndex(s => s.rejected?.(app));
  document.getElementById('detailSteps').innerHTML = PROGRESS_STEPS.map((s, i) => {
    const state = i === stopped ? 'rejected' : i < doneCount ? 'done' : (i === doneCount && stopped === -1 ? 'current' : '');
    return (i ? '<div class="step-line"></div>' : '') + `
      <div class="step ${state}">
        <div class="step-circle">${i + 1}</div>
        <div class="step-label">${s.label}<div class="step-owner">${s.owner}</div><div class="step-time">${{ done: '완료', current: '진행 중', rejected: '거절' }[state] || ''}</div></div>
      </div>`;
  }).join('');
  const info = [
    ['신청번호', escapeHtml(app.id)], ['신청일', fieldHTML(app, 'appliedDate')], ['신청금액', fieldHTML(app, 'amount', won)],
    ['상환 희망 기간', fieldHTML(app, 'termMonths', months)], ['담보 IP 유형', fieldHTML(app, 'ipType')], ['출원·등록번호', fieldHTML(app, 'ipRegNo')],
    ['대표자', fieldHTML(app, 'ceo')], ['연락처', fieldHTML(app, 'contact')], ['확정 평가액', fieldHTML(app, 'appraisedValue', won)],
    ['담보인정비율', fieldHTML(app, 'ltv', v => `${escapeHtml(v)}%`)], ['신용등급', fieldHTML(app, 'creditGrade')], ['약정 금리', rateText(app.rateBps)],
    ['약정 기간', fieldHTML(app, 'approvedTermMonths', months)], ['상환 기록 합계', won(app.repaidAmount || 0)],
  ];
  if (currentRole === 'admin') info.push(['RWA 토큰', fieldHTML(app, 'rwaTokenId', v => `#${escapeHtml(v)}`)]);
  document.getElementById('detailInfo').innerHTML = info.map(([k, v]) => `<div class="item"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
  const docs = app.documents || [];
  let extra = readOnlyNote(app) + (docs.length ? `<div class="k">제출 서류 ${docs.length}건</div>` + docs.map(d => `<span>${escapeHtml(d)}</span>`).join('') : '');
  if (app.evaluation) {
    const confirmed = EVALUATED_STAGES.includes(app.chainStatus)
      ? `<div class="confirmed-box"><b>✓ 담당 평가사가 가치평가를 확정했습니다</b><div>확정 평가액 ${won(app.appraisedValue)}</div></div>`
      : statusContent(app);
    extra += `<div class="section-title" style="margin-top:18px;">LLM 가치평가보고서</div>${confirmed}${app.evaluation.status === 'completed' ? reportDownloadsHTML(app) : ''}`;
  }
  if (app.appKey && !app.contractOutdated) {
    // Hashes and assigned wallets are for the administrator; the borrower only needs the actions.
    if (currentRole === 'admin') extra += `<div class="section-title" style="margin-top:18px;">블록체인 기록</div>
      <div class="hash-block show"><div class="hash-row"><span class="k">온체인 상태</span><span class="v">${escapeHtml(app.chainStatus || 'None')}</span></div>
      <div class="hash-row"><span class="k">원부 해시</span><span class="v">${fieldHTML(app, 'docFileHash')}</span></div>
      <div class="hash-row"><span class="k">평가보고서 해시</span><span class="v">${fieldHTML(app, 'reportHash')}</span></div>
      <div class="hash-row"><span class="k">담당 평가사</span><span class="v">${fieldHTML(app, 'evaluatorWallet')}</span></div>
      <div class="hash-row"><span class="k">담당 은행</span><span class="v">${escapeHtml(app.bankWallet || (app.chainStatus === 'RuleRejected' ? '배정 없음(자동심사 거절)' : '평가 통과 시 배정'))}</span></div></div>`;
    extra += `<div class="button-row" style="margin-top:12px;">
        ${app.chainStatus === 'None' && hasAccess(app, 'borrower') ? `<button class="btn btn-primary btn-sm" type="button" onclick="retryApplicationChain('${escapeHtml(app.id)}')">지갑 서명으로 등록</button>` : ''}
        <button class="btn btn-outline btn-sm" type="button" onclick="retryApplicationChain('${escapeHtml(app.id)}', true)">등록 상태 확인</button>
        ${EVALUATED_STAGES.includes(app.chainStatus) ? `<button class="btn btn-outline btn-sm" type="button" data-registered-report="${escapeHtml(app.id)}">등록된 평가보고서 열람</button>` : ''}
        ${deleteButtonHTML(app)}
      </div>`;
  }
  document.getElementById('detailDocs').innerHTML = extra;
  VIEW_META.detail.sub = `${app.id} 신청의 진행 상황을 확인합니다`;
  goView('detail');
}

/* ---------------- 대출 신청 (차주) ---------------- */
const applyForm = document.getElementById('applyForm');
function borrowerProfile() { return BORROWER_PROFILES.find(profile => profile.id === currentBorrowerProfileId); }
function selectBorrowerProfile(id) {
  currentBorrowerProfileId = id;
  try { localStorage.setItem(BORROWER_STORAGE_KEY, id); } catch { /* 선택 저장 불가 */ }
}
function renderBorrowerProfiles() {
  const select = document.getElementById('borrowerProfileSelect');
  select.innerHTML = BORROWER_PROFILES.map(profile =>
    `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.company)}</option>`
  ).join('') + '<option value="">＋ 새 차주기업 프로필</option>';
  select.value = currentBorrowerProfileId;
  select.disabled = !profilesLoaded || applicationSubmitting;
}
/* 신청 이력이 아니라 이 지갑의 서버 프로필에서 불러온다. 새 프로필의 입력란은 빈칸이다. */
function fillBorrowerInfo() {
  const profile = borrowerProfile();
  [['fCompany', 'company'], ['fBizNo', 'bizNo'], ['fCeo', 'ceo'], ['fPhone', 'contact']].forEach(([id, key]) => {
    document.getElementById(id).value = profile?.[key] || '';
  });
}
document.getElementById('borrowerProfileSelect').addEventListener('change', (e) => {
  if (applicationSubmitting) return;
  selectBorrowerProfile(e.target.value);
  fillBorrowerInfo();
});
document.getElementById('fBizNo').addEventListener('input', event => {
  const digits = event.target.value.replace(/\D/g, '').slice(0, 10);
  event.target.value = digits.length > 5 ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` : digits.length > 3 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits;
});
document.getElementById('fAmount').addEventListener('input', event => {
  const digits = event.target.value.replace(/\D/g, '');
  event.target.value = digits ? Number(digits).toLocaleString('ko-KR') : '';
});

const UPLOADS = {
  registry: { input: 'fileInput', box: 'uploadBox', name: 'fileNameDisplay', help: 'fileHelpText', max: 20,
    hint: 'PDF · 최대 20MB' },
  patent: { input: 'patentInput', box: 'patentBox', name: 'patentNameDisplay', help: 'patentHelpText', max: 50,
    hint: 'PDF · 최대 50MB' },
};
function chosenFile(kind) { return document.getElementById(UPLOADS[kind].input).files[0] || null; }
function renderUpload(kind) {
  const u = UPLOADS[kind], file = chosenFile(kind);
  document.getElementById(u.name).textContent = file ? file.name : '클릭하거나 PDF를 끌어다 놓기';
  document.getElementById(u.help).textContent = file ? `${(file.size / 1024 / 1024).toFixed(2)}MB · 선택됨` : u.hint;
  document.getElementById(u.box).classList.toggle('has-file', Boolean(file));
}
/* The server reads the IP type, title and application number from the chosen PDF. Only empty fields, or fields
   filled from an earlier PDF, are filled, so anything the borrower typed stays. */
const PDF_FIELDS = { ipType: 'fIpType', ipTitle: 'fIpTitle', ipRegNo: 'fIpNo' };
async function fillFromPdf(file) {
  if (!file || !session()) return;
  const form = new FormData();
  form.append('document', file);
  let fields;
  try { fields = await api('/documents/fields', { method: 'POST', body: form }); } catch { return; }
  let filled = 0;
  for (const [key, id] of Object.entries(PDF_FIELDS)) {
    const el = document.getElementById(id), value = fields[key];
    if (!value || (el.value && el.value !== el.dataset.autofill)) continue;
    el.value = value;
    el.dataset.autofill = value;
    filled++;
  }
  if (filled) showToast('PDF에서 IP 정보를 채웠습니다. 확인해 주세요.');
}
for (const kind of Object.keys(UPLOADS)) {
  const u = UPLOADS[kind], box = document.getElementById(u.box), input = document.getElementById(u.input);
  box.addEventListener('click', () => { if (!applicationSubmitting) input.click(); });
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!applicationSubmitting) input.click(); } });
  input.addEventListener('change', () => { renderUpload(kind); fillFromPdf(chosenFile(kind)); });
  // Dropping a PDF on the box is the same as choosing it.
  box.addEventListener('dragover', (e) => { e.preventDefault(); if (!applicationSubmitting) box.classList.add('dragging'); });
  box.addEventListener('dragleave', () => box.classList.remove('dragging'));
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('dragging');
    if (applicationSubmitting) return;
    const file = [...(e.dataTransfer?.files || [])].find(f => /\.pdf$/i.test(f.name));
    if (!file) return showToast('PDF 파일을 놓아 주세요');
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    renderUpload(kind);
    fillFromPdf(file);
  });
}
// A file dropped beside the boxes must not open in the tab and discard the form.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
function showApplyError(message) {
  const node = document.getElementById('applyError');
  node.textContent = message;
  node.hidden = !message;
}
function setApplySteps(current, complete = false) {
  document.querySelectorAll('#applySteps .step').forEach((step, index) => {
    step.classList.toggle('done', index + 1 < current || complete);
    step.classList.toggle('current', index + 1 === current && !complete);
  });
}
function applyChainResult(updated) {
  upsertApplication(updated);
  lastChainApplication = updated;
  document.getElementById('genChainState').textContent = !updated.chainStatus || updated.chainStatus === 'None' ? '서명 대기' : '등록 완료';
  document.getElementById('genReportState').textContent = reportMeta(updated).label;
  document.getElementById('retryChainBtn').hidden = updated.chainStatus !== 'None';
  document.getElementById('syncChainBtn').hidden = false;
  renderAll();
}
async function retryApplicationChain(id, onlySync = false) {
  if (chainOperationBusy || applicationSubmitting) return;
  const app = id ? findApp(id) : lastChainApplication;
  if (!app) return;
  chainOperationBusy = true;
  try {
    applyChainResult(await (onlySync ? IPLoanChain.sync(app) : IPLoanChain.register(app)));
    if (currentView === 'detail') openDetail(app.id);
    showToast(onlySync ? '등록 상태를 확인했습니다' : '신청 등록을 완료했습니다');
  } catch (error) { showToast(error.message); }
  finally { chainOperationBusy = false; }
}
document.getElementById('retryChainBtn').addEventListener('click', () => retryApplicationChain());
document.getElementById('syncChainBtn').addEventListener('click', () => retryApplicationChain(null, true));

applyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (applicationSubmitting || chainOperationBusy) return;
  if (!profilesLoaded) return showToast('서버 연결 후 차주기업 프로필을 불러와 주세요');
  showApplyError('');
  const registry = chosenFile('registry'), patent = chosenFile('patent');
  const amountText = document.getElementById('fAmount').value.replace(/[^0-9]/g, '');
  const missing = ['fCompany', 'fBizNo', 'fCeo', 'fPhone', 'fIpType', 'fIpNo', 'fIpTitle'].find(id => !document.getElementById(id).value.trim());
  if (missing) return showApplyError('필수 항목을 모두 입력해 주세요.');
  if (!/^\d{3}-\d{2}-\d{5}$/.test(document.getElementById('fBizNo').value)) return showApplyError('사업자등록번호는 000-00-00000 형식으로 입력해 주세요.');
  if (!amountText || !Number.isSafeInteger(Number(amountText)) || Number(amountText) <= 0) return showApplyError('대출 희망 금액을 0보다 큰 원 단위 정수로 입력해 주세요.');
  for (const [kind, file] of [['registry', registry], ['patent', patent]]) {
    if (!file) return showApplyError(kind === 'registry' ? '특허등록원부 PDF를 선택해 주세요.' : '특허 공고전문 PDF를 선택해 주세요.');
    if (!/\.pdf$/i.test(file.name) || !file.size || file.size > UPLOADS[kind].max * 1024 * 1024) return showApplyError(`비어 있지 않은 ${UPLOADS[kind].max}MB 이하 PDF를 선택해 주세요.`);
  }
  const btn = document.getElementById('applySubmitBtn');
  btn.disabled = true;
  applicationSubmitting = true;
  renderBorrowerProfiles();
  btn.textContent = '지갑 확인 중…';
  try { await IPLoanChain.connect('BORROWER_ROLE'); }
  catch (error) {
    applicationSubmitting = false; btn.disabled = false; btn.textContent = '신청하고 지갑으로 서명';
    renderBorrowerProfiles(); showApplyError(error.message); return;
  }
  setApplySteps(2);
  const payload = new FormData();
  [['company', 'fCompany'], ['bizNo', 'fBizNo'], ['ceo', 'fCeo'], ['contact', 'fPhone'], ['ipType', 'fIpType'],
   ['ipTitle', 'fIpTitle'], ['ipRegNo', 'fIpNo'], ['termMonths', 'fTerm']].forEach(([key, id]) => payload.append(key, document.getElementById(id).value.trim()));
  payload.append('amount', amountText);
  if (currentBorrowerProfileId) payload.append('borrowerProfileId', currentBorrowerProfileId);
  payload.append('registryDocument', registry);
  payload.append('patentDocument', patent);
  try {
    const created = await apiCreateApplication(payload, (percent) => {
      btn.textContent = percent === 100 ? '서류 등록 중…' : percent == null ? '서류 전송 중…' : `서류 전송 중… ${percent}%`;
    });
    hideConnNotice();
    const { borrowerProfile: savedProfile, ...application } = created;
    upsertApplication(application);
    lastChainApplication = application;
    const index = BORROWER_PROFILES.findIndex(item => item.id === savedProfile.id);
    if (index === -1) BORROWER_PROFILES.push(savedProfile); else BORROWER_PROFILES[index] = savedProfile;
    selectBorrowerProfile(savedProfile.id);
    document.getElementById('genAppId').textContent = created.id;
    document.getElementById('genFiles').textContent = `${registry.name} · ${patent.name}`;
    document.getElementById('genReportState').textContent = reportMeta(created).label;
    document.getElementById('applyHashBlock').classList.add('show');
    setApplySteps(3);
    btn.textContent = 'MetaMask에서 신청 등록 서명 중…';
    renderAll();
    try {
      applyChainResult(await IPLoanChain.register(application));
      setApplySteps(4);
      btn.textContent = '신청 완료';
      showToast('신청이 등록되었습니다. LLM 가치평가가 진행됩니다.');
    } catch (error) {
      document.getElementById('genChainState').textContent = '서명 대기: ' + error.message;
      document.getElementById('retryChainBtn').hidden = false;
      document.getElementById('syncChainBtn').hidden = false;
      btn.textContent = '서류 등록 완료 · 아래에서 서명 다시 시도';
    }
  } catch (err) {
    if (err.status === 422 && err.data?.id) upsertApplication(err.data);
    showApplyError(err.message);
    setApplySteps(1);
    btn.disabled = false;
    btn.textContent = '다시 신청';
  } finally {
    applicationSubmitting = false;
    renderBorrowerProfiles();
    renderAll();
  }
});
applyForm.addEventListener('reset', (event) => {
  if (applicationSubmitting || chainOperationBusy) { event.preventDefault(); return; }
  setTimeout(() => {
    lastChainApplication = null;
    for (const id of ['genChainState', 'genReportState']) document.getElementById(id).textContent = '—';
    document.getElementById('retryChainBtn').hidden = true;
    document.getElementById('syncChainBtn').hidden = true;
    document.getElementById('applyHashBlock').classList.remove('show');
    setApplySteps(1);
    showApplyError('');
    const btn = document.getElementById('applySubmitBtn');
    btn.disabled = false;
    btn.textContent = '신청하고 지갑으로 서명';
    Object.keys(UPLOADS).forEach(renderUpload);
    document.getElementById('borrowerProfileSelect').value = currentBorrowerProfileId;
    fillBorrowerInfo();
  }, 0);
});

/* ---------------- IP 가치평가 (평가사) ---------------- */
/* 확정할 수 있는 건 → 보고서 생성·등록 대기 건 → 평가가 끝난 건 순서 */
function evalQueue() {
  return APPLICATIONS.filter(a => hasAccess(a, 'evaluator'))
    .sort((a, b) => evalRank(b) - evalRank(a) || (b.appliedDate || '').localeCompare(a.appliedDate || ''));
}
function isEvalActionable(app) { return app.chainStatus === 'Evaluating' && app.evaluation?.status === 'completed' && !app.contractOutdated; }
function evalRank(app) { return isEvalActionable(app) ? 2 : EVALUATED_STAGES.includes(app.chainStatus) || app.contractOutdated ? 0 : 1; }
function evalBadge(app) {
  if (app.chainStatus === 'None') return statusBadge('pending');
  return reportBadge(app);
}
function renderEvalList() {
  const queue = evalQueue();
  document.getElementById('evalListCount').textContent = `${queue.length}건`;
  document.getElementById('evalListItems').innerHTML = queue.map(app => `
    <button class="eval-item ${app.id === selectedEvalId ? 'active' : ''}" type="button" data-eval="${escapeHtml(app.id)}">
      <span class="eval-item-top"><span class="eval-item-company">${escapeHtml(app.company)}</span>${evalBadge(app)}</span>
      <span class="eval-item-sub">${escapeHtml(app.ipTitle || '')} · ${won(app.amount)}</span>
    </button>`).join('') || '<div class="empty-hint">배정된 평가 건이 없습니다.</div>';
}
document.getElementById('evalListItems').addEventListener('click', (e) => {
  const item = e.target.closest('[data-eval]');
  if (item) selectEvalItem(item.dataset.eval);
});
function reportHeading(app, badge) {
  return `<div class="report-head"><div><h3 class="report-title">${escapeHtml(app.ipTitle || app.id)}</h3>
    <div class="report-meta">${escapeHtml(app.company)} · ${fieldHTML(app, 'bizNo')} · ${escapeHtml(app.ipType || '')}</div>
    <div class="report-meta">신청번호 ${escapeHtml(app.id)} · 출원·등록번호 ${fieldHTML(app, 'ipRegNo')}</div></div>${badge}</div>`;
}
function selectEvalItem(id) {
  const app = findApp(id);
  if (!app) return;
  selectedEvalId = id;
  document.querySelectorAll('#evalListItems .eval-item').forEach(el => el.classList.toggle('active', el.dataset.eval === id));
  const job = app.evaluation;
  let body = reportHeading(app, evalBadge(app)) + readOnlyNote(app);
  body += `<div class="report-grid">
    <div class="report-stat"><div class="report-stat-label">신청금액</div><div class="report-stat-value">${won(app.amount)}</div></div>
    <div class="report-stat"><div class="report-stat-label">통과 최소 평가액 (70%)</div><div class="report-stat-value">${app.amount ? won(minimumPassingValue(app.amount)) : NA_HTML}</div></div>
    <div class="report-stat"><div class="report-stat-label">상환 희망 기간</div><div class="report-stat-value">${fieldHTML(app, 'termMonths', months)}</div></div></div>`;
  if (app.chainStatus === 'None') body += '<div class="notice-box warn"><span>차주의 신청 서명이 끝나면 평가액을 확정할 수 있습니다.</span></div>';
  if (!job) body += '<div class="empty-hint">이 신청에 연결된 LLM 보고서 작업이 없습니다.</div>';
  else {
    body += `<div class="report-request-meta"><span>작업번호 <b>${escapeHtml(job.job_id || '발급 전')}</b></span><span>최근 확인 ${escapeHtml(formatDate(job.updated_at))}</span></div>`;
    if (job.status !== 'completed') body += statusContent(app);
    else body += llmValuationHTML(app, isEvalActionable(app)) + reportDownloadsHTML(app) + reportPreviewHTML(app, 'evalPreview');
  }
  if (EVALUATED_STAGES.includes(app.chainStatus)) {
    body += `<div class="confirmed-box"><b>✓ 가치평가가 확정되어 블록체인에 기록되었습니다</b>
      <div>확정 평가액 ${won(app.appraisedValue)} · 담보인정비율 ${fieldHTML(app, 'ltv', v => `${escapeHtml(v)}%`)} · 자동심사 ${app.chainStatus === 'RuleRejected' ? '거절' : '통과'}</div>
      <div class="help">보고서 해시 ${fieldHTML(app, 'reportHash')}</div>
      ${app.evaluationReport?.note ? `<p>${escapeHtml(app.evaluationReport.note)}</p>` : ''}
      <button class="btn btn-outline btn-sm" type="button" data-registered-report="${escapeHtml(app.id)}">등록된 평가보고서 열람</button></div>`;
  } else if (isEvalActionable(app)) {
    body += `<form class="decision-form" id="evalConfirmForm" data-app-id="${escapeHtml(app.id)}">
      <div class="form-section-heading"><span>✓</span><h4>평가 검토 및 확정</h4></div>
      <p>보고서의 산정 근거를 확인한 뒤 담보 평가액을 입력하세요. 확정 후에는 수정할 수 없습니다.</p>
      <div class="form-grid">
        <div class="field"><label for="appraisalValue">확정 평가액 (원)<span class="req">*</span></label><input id="appraisalValue" type="text" inputmode="numeric" placeholder="예: 120,000,000" required><span class="help" id="appraisalLtv">평가액을 입력하면 담보인정비율을 계산합니다.</span></div>
        <div class="field full"><label for="appraisalNote">평가 의견 <span class="optional">${job?.valuation ? 'LLM 산정액과 다르게 확정하면 필수' : '선택'}</span></label><textarea id="appraisalNote" rows="3" maxlength="2000" placeholder="확인한 근거와 보완할 내용을 기록하세요."></textarea></div>
      </div>
      <div class="button-row">
        <button class="btn btn-primary" type="submit" id="confirmEvalBtn">가치평가 확정 (MetaMask 서명)</button>
        <button class="btn btn-outline" type="button" onclick="viewChainDocument('${escapeHtml(app.id)}')">등록원부 열람</button>
      </div></form>`;
  }
  document.getElementById('evalReportPanel').innerHTML = `<div class="panel-body">${body}</div>`;
  loadPreview('evalPreview');
  const valueInput = document.getElementById('appraisalValue');
  if (!valueInput) return;
  const showValue = () => {
    const digits = valueInput.value.replace(/\D/g, '');
    valueInput.value = digits ? Number(digits).toLocaleString('ko-KR') : '';
    const value = Number(digits);
    document.getElementById('appraisalLtv').textContent = value ? ltvPreview(app.amount, value) : '평가액을 입력하면 담보인정비율을 계산합니다.';
  };
  valueInput.addEventListener('input', showValue);
  document.getElementById('useLlmValueBtn')?.addEventListener('click', () => {
    valueInput.value = String(job.valuation.ip_value_krw);
    showValue();
  });
}
/* 보고서 API가 보낸 LLM 산정액. 평가사가 검토해 확정하기 전의 초안이며, 0원 이하이면 담보가치로 쓰지 않는다. */
function llmValuationHTML(app, actionable) {
  const valuation = app.evaluation?.valuation;
  if (!valuation) return '<div class="notice-box"><span>산정액이 없습니다. 보고서를 확인해 입력하세요.</span></div>';
  const value = valuation.ip_value_krw;
  return `<div class="llm-value">
    <div class="llm-value-head"><span class="llm-tag">LLM 산정액</span>
      <span class="help">${valuation.value_status === 'confirmed' ? '확인자료 반영 기준' : '사전평가 초안 · 확정 평가액 아님'}</span></div>
    <div class="llm-value-amount">${won(value)}</div>
    <div class="help">평가기준일 ${escapeHtml(valuation.valuation_date || '—')} · 문서번호 ${escapeHtml(valuation.report_number || '—')}</div>
    <div class="help">${value > 0 ? ltvPreview(app.amount, value) : '산정액이 0원 이하입니다. 보고서를 검토해 평가액을 정하세요.'}</div>
    ${actionable && value > 0 ? '<button class="btn btn-outline btn-sm" type="button" id="useLlmValueBtn">이 금액을 확정 평가액에 입력</button>' : ''}
  </div>`;
}
async function confirmEval(id) {
  const app = findApp(id);
  if (!app || chainOperationBusy) return;
  const appraisedValue = Number(document.getElementById('appraisalValue').value.replace(/\D/g, ''));
  const note = document.getElementById('appraisalNote').value.trim();
  if (!Number.isSafeInteger(appraisedValue) || appraisedValue <= 0) return showToast('확정 평가액을 원 단위 양의 정수로 입력하세요.');
  const draft = app.evaluation?.valuation?.ip_value_krw;
  if (draft != null && appraisedValue !== draft && !note) return showToast('LLM 산정액과 다른 금액으로 확정하려면 평가 의견에 사유를 적어 주세요.');
  if (!confirm(`평가액 ${appraisedValue.toLocaleString('ko-KR')}원으로 확정합니다.\n${ltvPreview(app.amount, appraisedValue)}\n확정 후에는 수정할 수 없습니다. 진행할까요?`)) return;
  chainOperationBusy = true;
  const btn = document.getElementById('confirmEvalBtn');
  btn.disabled = true;
  try {
    btn.textContent = '지갑 확인 중…';
    await IPLoanChain.connect('EVALUATOR_ROLE', app.evaluatorWallet);
    btn.textContent = '보고서 등록 중…';
    const report = await postJSON(`/applications/${encodeURIComponent(id)}/evaluation-report`, { appraisedValue, note });
    btn.textContent = 'MetaMask에서 평가 확정 서명 중…';
    upsertApplication(await IPLoanChain.evaluate(app, report));
    renderAll();
    selectEvalItem(id);
    showToast(findApp(id).chainStatus === 'Eligible' ? '자동심사 통과 · 은행 약정 심사로 전달했습니다' : '자동심사 결과 거절로 기록되었습니다');
  } catch (error) {
    showToast(error.message);
    btn.disabled = false;
    btn.textContent = '가치평가 확정 (MetaMask 서명)';
  } finally { chainOperationBusy = false; }
}

/* ---------------- 여신 심사·약정 (은행) ---------------- */
function reviewQueue() {
  return APPLICATIONS.filter(a => hasAccess(a, 'bank', 'bank_notice'))
    .sort((a, b) => Number(b.chainStatus === 'Eligible') - Number(a.chainStatus === 'Eligible') || (b.appliedDate || '').localeCompare(a.appliedDate || ''));
}
function renderReviewList() {
  const queue = reviewQueue();
  document.getElementById('reviewListCount').textContent = `${queue.length}건`;
  document.getElementById('reviewListItems').innerHTML = queue.map(app => `
    <button class="eval-item ${app.id === selectedReviewId ? 'active' : ''}" type="button" data-review="${escapeHtml(app.id)}">
      <span class="eval-item-top"><span class="eval-item-company">${escapeHtml(app.company)}</span>${statusBadge(app.status)}</span>
      <span class="eval-item-sub">${escapeHtml(app.ipTitle || '')} · ${won(app.amount)}</span>
    </button>`).join('') || '<div class="empty-hint">배정된 심사 건이 없습니다.</div>';
}
document.getElementById('reviewListItems').addEventListener('click', (e) => {
  const item = e.target.closest('[data-review]');
  if (item) loadReviewCase(item.dataset.review);
});
function reviewSummaryHTML(app) {
  const fields = [
    ['신청금액', 'amount', won], ['확정 평가액', 'appraisedValue', won], ['담보인정비율(LTV)', 'ltv', v => `${escapeHtml(v)}%`],
    ['상환 희망 기간', 'termMonths', months], ['출원·등록번호', 'ipRegNo'], ['차주 지갑', 'borrowerWallet', shortAddress],
  ];
  return `<div class="review-summary">${fields.map(([label, key, fmt]) =>
    `<div class="item"><div class="k">${label}</div><div class="v">${fieldHTML(app, key, fmt)}</div></div>`).join('')}</div>`;
}
function reviewCheckHTML(title, description, status, result) {
  const state = result === true ? 'verified' : result === false ? 'failed' : 'not-applied';
  return `<div class="check-item ${state}">
    <div class="check-icon">
      <svg class="icon-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>
      <svg class="icon-x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"></path></svg>
    </div><div class="check-text"><div class="check-title">${escapeHtml(title)}</div><div class="check-desc">${escapeHtml(description)}</div></div>
    <div class="check-status">${escapeHtml(status)}</div></div>`;
}
/* 보고서 API의 최근 결산 재무(원 단위)를 백만원 표로 보여준다. 값이 없으면 '-'이고 점검에서는 판정 불가다. */
const FINANCIAL_ROWS = [
  ['매출액', 'revenue_krw'], ['영업이익', 'operating_income_krw'], ['당기순이익', 'net_income_krw'], ['자산총계', 'total_assets_krw'],
  ['부채총계', 'total_liabilities_krw'], ['자본총계', 'total_equity_krw'], ['총차입금', 'total_borrowings_krw'], ['금융비용', 'finance_costs_krw'],
  ['부채비율 (%)', 'debt_ratio_pct', true], ['유동비율 (%)', 'current_ratio_pct', true], ['차입금의존도 (%)', 'debt_dependency_pct', true],
  ['이자보상배율 (배)', 'interest_coverage_times', true],
];
const CHECK_RESULT = { pass: true, fail: false, unknown: null };
function millionCell(amount) {
  if (amount == null) return NA_HTML;
  const value = Math.round(amount / 1e6);
  return (value === 0 ? 0 : value).toLocaleString('ko-KR');
}
function ratioCell(value) { return value == null ? NA_HTML : Number(value).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function financialSectionHTML(app) {
  const job = app.evaluation;
  if (job?.status !== 'completed') return '';
  const rows = job.financials || [];
  const valuation = job.valuation;
  const checks = (job.financial_checks || []).map(check => reviewCheckHTML(
    check.label, `${check.criterion}${check.year ? ` · ${check.year}년 결산` : ''}`,
    check.result === 'unknown' ? '판정 불가 (자료 없음)' : check.observed, CHECK_RESULT[check.result])).join('');
  const table = rows.length ? `<div class="table-wrap"><table class="data-table fin-table">
      <thead><tr><th>항목 (백만원)</th>${rows.map(row => `<th>${escapeHtml(row.year)}년<span class="fin-date">${escapeHtml(row.fiscal_date || '결산일 미상')}${row.fiscal_date_assumed ? ' (추정)' : ''}</span></th>`).join('')}</tr></thead>
      <tbody>${FINANCIAL_ROWS.map(([label, key, ratio]) => `<tr><td>${label}</td>${rows.map(row =>
        `<td class="num">${key === 'debt_ratio_pct' && row.capital_impaired ? '자본잠식' : ratio ? ratioCell(row[key]) : millionCell(row[key])}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>
    <p class="help">출처: ${rows.map(row => `${escapeHtml(row.year)}년 ${escapeHtml(row.source_label)}`).join(' · ')}. (추정): 결산일 미확인</p>`
    : '<div class="empty-hint">보고서에 재무자료가 없습니다. 직접 확인해 주세요.</div>';
  return `<div class="section-title">재무 참고 점검 <span class="hint">참고용</span></div>
    <p class="help fin-value">LLM 산정액 ${valuation ? `${won(valuation.ip_value_krw)} (${valuation.value_status === 'confirmed' ? '확인자료 반영' : '사전평가 초안'})` : '미제공'} · 확정 평가액 ${won(app.appraisedValue)}</p>
    <div class="check-list">${checks}</div>${table}`;
}
function chainDecisionHTML(app) {
  const decisions = {
    Eligible: ['자동심사 결과 — 통과', '70% 담보인정비율 기준을 통과했습니다. 신용등급·금리·기간을 정해 약정을 체결하세요.', 'approved'],
    Approved: ['대출약정 체결 완료', '약정 조건이 블록체인에 기록되고 은행 지갑에 RWA 토큰이 발급되었습니다.', 'approved'],
    Repaid: ['상환 완료', '원금 전액의 상환 기록을 완료했습니다. RWA 토큰은 은행에 유지됩니다.', 'approved'],
    RuleRejected: ['자동심사 결과 — 거절', app.rejectReason || '신청금액이 평가액의 70%를 초과했습니다.', 'rejected'],
    Rejected: ['최종 심사 결과 — 거절', app.rejectReason || '은행 지갑이 최종 거절했습니다. RWA 토큰은 발급되지 않습니다.', 'rejected'],
  };
  const decision = decisions[app.chainStatus];
  if (!decision) return '';
  const [title, description, style] = decision;
  const icon = style === 'approved' ? '<path d="m7.5 12.5 3 3 6-7"></path>' : '<path d="m9.5 9.5 5 5m0-5-5 5"></path>';
  const agreed = ['Approved', 'Repaid'].includes(app.chainStatus);
  return `<div class="decision-banner ${style}">
    <div class="decision-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle>${icon}</svg><span class="decision-title">${title}</span></div>
    <div class="decision-desc">${escapeHtml(description)}</div>
    <div class="decision-figures">
      <div><div class="f-label">${agreed ? '약정 금액' : '신청금액'}</div><div class="f-value">${won(app.amount)}</div></div>
      ${agreed ? `<div><div class="f-label">신용등급</div><div class="f-value">${fieldHTML(app, 'creditGrade')}</div></div>
      <div><div class="f-label">약정 금리</div><div class="f-value">${rateText(app.rateBps)}</div></div>
      <div><div class="f-label">약정 기간</div><div class="f-value">${fieldHTML(app, 'approvedTermMonths', months)}</div></div>` : ''}
    </div></div>`;
}
function loadReviewCase(id) {
  const app = findApp(id);
  if (!app) return;
  selectedReviewId = id;
  document.querySelectorAll('#reviewListItems .eval-item').forEach(el => el.classList.toggle('active', el.dataset.review === id));
  const eligible = app.chainStatus === 'Eligible' && !app.contractOutdated;
  const approved = app.chainStatus === 'Approved' && !app.contractOutdated;
  const evaluated = EVALUATED_STAGES.includes(app.chainStatus);
  const repaid = app.repaidAmount || 0;
  const hashPass = app.hashMatch === 1 ? true : app.hashMatch === 0 ? false : null;
  const agreed = ['Approved', 'Repaid'].includes(app.chainStatus);
  document.getElementById('reviewBody').innerHTML = `<div class="panel" style="margin-bottom:16px;">
    <div class="panel-header"><h3>${escapeHtml(app.company)} · ${escapeHtml(app.ipTitle || '')}</h3><span class="hint">${escapeHtml(app.id)}</span></div>
    <div class="panel-body">
      ${readOnlyNote(app)}
      ${reviewSummaryHTML(app)}
      <div class="section-title">스마트컨트랙트 심사 조건</div>
      <div class="check-list">
        ${reviewCheckHTML('담보인정비율(LTV) 조건 충족', '신청금액이 확정 평가액의 70% 이하인지 계약에서 판정', evaluated ? `LTV ${app.ltv == null ? '—' : app.ltv}% · ${app.chainStatus === 'RuleRejected' ? '거절' : '통과'}` : '평가 확정 대기', evaluated ? app.chainStatus !== 'RuleRejected' : null)}
        ${reviewCheckHTML('평가보고서 등록', '확정된 평가보고서의 블록체인 등록 여부', app.reportHash ? '등록됨' : '평가 확정 대기', app.reportHash ? true : null)}
        ${reviewCheckHTML('서류 무결성 검증', '등록 서류와 블록체인 기록 일치 여부', hashPass === true ? '일치' : hashPass === false ? '불일치' : '확인 대기', hashPass)}
        ${reviewCheckHTML('신용평가', '심사역이 신용등급을 확인해 약정에 기록', agreed ? `${app.creditGrade} 등급` : '약정 시 입력', agreed ? true : null)}
      </div>
      ${financialSectionHTML(app)}
      ${eligible ? `<form class="decision-form" id="loanTermsForm" data-app-id="${escapeHtml(app.id)}">
        <div class="form-section-heading"><span>✓</span><h4>대출약정 조건</h4></div>
        <p>입력한 조건은 최종 승인 거래로 블록체인에 기록되며 수정할 수 없습니다. 승인과 함께 이 은행 지갑에 RWA 토큰이 발급됩니다.</p>
        <div class="form-grid">
          <div class="field"><label for="creditGrade">신용등급<span class="req">*</span></label>
            <input id="creditGrade" maxlength="8" placeholder="예: BBB+" autocomplete="off" value="${escapeHtml(app.evaluation?.credit_rating || '')}" required>
            <span class="help" id="creditHelp">${app.evaluation?.credit_rating ? '평가보고서 회사자료 기준 등급입니다. 확인 후 필요하면 수정하세요.' : '은행 CB 조회 결과를 입력하세요 (AAA, BB+ 등)'}</span></div>
          <div class="field"><label for="loanRate">약정 금리 (연 %)<span class="req">*</span></label><input id="loanRate" type="number" min="0.01" max="100" step="0.01" placeholder="예: 4.30" required></div>
          <div class="field"><label for="loanTerm">약정 기간 (개월)<span class="req">*</span></label><input id="loanTerm" type="number" min="1" max="600" step="1" value="${escapeHtml(app.termMonths || 12)}" required></div>
          <div class="field"><label>약정 금액</label><input value="${escapeHtml(Number(app.amount).toLocaleString('ko-KR'))}원" disabled></div>
        </div>
        <div class="button-row">
          <button class="btn btn-primary" type="submit" id="approveBtn">최종 승인·약정 체결 (RWA 토큰 발급)</button>
          <button class="btn btn-danger-outline" type="button" onclick="finalChainDecision('${escapeHtml(app.id)}', false)">최종 거절</button>
        </div></form>` : ''}
      <div class="button-row" style="margin-top:16px;">
        ${evaluated ? `<button class="btn btn-outline btn-sm" type="button" data-registered-report="${escapeHtml(app.id)}">등록된 평가보고서 열람</button>` : ''}
        ${agreed ? `<button class="btn btn-outline btn-sm" type="button" onclick="viewChainDocument('${escapeHtml(app.id)}')">등록원부 원본 열람</button>` : ''}
        ${app.rwaTokenId && app.bankWallet?.toLowerCase() === session()?.address?.toLowerCase() ? `<button class="btn btn-outline btn-sm" type="button" onclick="showRwaToken('${escapeHtml(app.rwaTokenId)}')">MetaMask에서 RWA 토큰 확인</button>` : ''}
        ${hasAccess(app, 'bank') ? `<button class="btn btn-outline btn-sm" type="button" onclick="syncChainReview('${escapeHtml(app.id)}')">체인 확인·복구</button>` : ''}
        ${deleteButtonHTML(app)}
      </div>
      ${chainDecisionHTML(app)}
    </div></div>
    <div class="panel review-chain-records">
      <div class="panel-header"><h3>블록체인 약정·상환 기록</h3><span class="hint">RWA 토큰</span></div>
      <div class="panel-body">
        <div class="review-summary">
          <div class="item"><div class="k">온체인 상태</div><div class="v">${escapeHtml(app.chainStatus || 'None')}</div></div>
          <div class="item"><div class="k">RWA 토큰 번호</div><div class="v">${app.rwaTokenId ? '#' + escapeHtml(app.rwaTokenId) : '미발급'}</div></div>
          <div class="item"><div class="k">약정 체결 시각</div><div class="v">${app.approvedAt ? escapeHtml(formatDate(app.approvedAt)) : NA_HTML}</div></div>
          <div class="item"><div class="k">상환 기록 합계</div><div class="v">${won(repaid)}</div></div>
          <div class="item"><div class="k">남은 원금</div><div class="v">${app.amount == null ? NA_HTML : won(app.amount - repaid)}</div></div>
          <div class="item"><div class="k">은행 수령 지갑</div><div class="v">${fieldHTML(app, 'bankWallet', shortAddress)}</div></div>
        </div>
      ${approved ? `<div class="section-title">상환 기록 추가</div><div class="form-grid">
        <div class="field"><label for="repaymentAmount">상환금액 (원)</label><input id="repaymentAmount" type="number" min="1" max="${app.amount - repaid}" placeholder="남은 금액: ${app.amount - repaid}"></div>
        <div class="field"><label for="repaymentReference">상환 참조번호 (중복 방지)</label><input id="repaymentReference" maxlength="100" placeholder="예: REP-2026-001"></div>
        <div class="button-row"><button class="btn btn-primary" type="button" onclick="recordChainRepayment('${escapeHtml(app.id)}')">MetaMask로 상환 기록 추가</button></div></div>` : ''}
      <p class="review-chain-note">상환은 송금 없이 기록만 남습니다.</p>
    </div></div>`;
}
/* Administrator: removes an application's records from the server (the chain record stays). */
function deleteButtonHTML(app) {
  return hasAccess(app, 'admin') ? `<button class="btn btn-danger-outline btn-sm" type="button" onclick="deleteApplication('${escapeHtml(app.id)}')">신청 기록 삭제</button>` : '';
}
async function deleteApplication(id) {
  if (chainOperationBusy) return;
  if (!confirm(`${id} 신청의 기록과 서류를 서버에서 삭제합니다.\n블록체인 기록은 남고, 암호화된 원본은 다시 열 수 없게 됩니다. 되돌릴 수 없습니다. 진행할까요?`)) return;
  try {
    await api(`/applications/${encodeURIComponent(id)}`, { method: 'DELETE' });
    APPLICATIONS = APPLICATIONS.filter(a => a.id !== id);
    if (selectedReviewId === id) selectedReviewId = null;
    if (selectedEvalId === id) selectedEvalId = null;
    if (detailId === id) detailId = null;
    renderAll();
    goView(currentView === 'detail' ? 'list' : currentView);
    showToast(`${id} 신청 기록을 삭제했습니다`);
  } catch (error) { showToast(error.message); }
}
async function syncChainReview(id) {
  if (chainOperationBusy) return;
  chainOperationBusy = true;
  try { upsertApplication(await IPLoanChain.sync(findApp(id))); renderAll(); loadReviewCase(id); showToast('체인 상태를 확인했습니다'); }
  catch (error) { showToast(error.message); }
  finally { chainOperationBusy = false; }
}
async function finalChainDecision(id, yes) {
  if (chainOperationBusy) return;
  const app = findApp(id);
  let terms = null;
  if (yes) {
    const creditGrade = document.getElementById('creditGrade').value.trim().toUpperCase();
    const rateBps = Math.round(Number(document.getElementById('loanRate').value) * 100);
    const termMonths = Number(document.getElementById('loanTerm').value);
    if (!/^[A-Z+-]{1,8}$/.test(creditGrade)) return showToast('신용등급은 대문자·+·- 최대 8자로 입력하세요 (예: BB+).');
    if (!Number.isInteger(rateBps) || rateBps < 1 || rateBps > 10000) return showToast('약정 금리는 0.01%~100% 사이로 입력하세요.');
    if (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 600) return showToast('약정 기간은 1~600개월 정수로 입력하세요.');
    terms = { creditGrade, rateBps, termMonths };
    if (!confirm(`신용등급 ${creditGrade}, 연 ${(rateBps / 100).toFixed(2)}%, ${termMonths}개월로 약정을 체결하고 RWA 토큰을 발급합니다. 진행할까요?`)) return;
  } else if (!confirm('이 신청을 최종 거절할까요? 되돌릴 수 없습니다.')) return;
  chainOperationBusy = true;
  try {
    upsertApplication(await IPLoanChain.approve(app, yes, terms));
    renderAll(); loadReviewCase(id);
    showToast(yes ? '대출약정 체결 · RWA 토큰 발급 완료' : '최종 거절을 기록했습니다');
  } catch (error) { showToast(error.message); }
  finally { chainOperationBusy = false; }
}
async function recordChainRepayment(id) {
  if (chainOperationBusy) return;
  const app = findApp(id), amount = Number(document.getElementById('repaymentAmount').value);
  const reference = document.getElementById('repaymentReference').value.trim();
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > app.amount - (app.repaidAmount || 0) || !reference) {
    return showToast('남은 금액 이하의 양의 정수와 고유 참조번호를 입력하세요');
  }
  if (!confirm('실제 송금 없이 은행이 확인한 상환 내역을 기록할까요?')) return;
  chainOperationBusy = true;
  try {
    upsertApplication(await IPLoanChain.repay(app, amount, reference));
    renderAll(); loadReviewCase(id);
    showToast(findApp(id).chainStatus === 'Repaid' ? '완납 기록 완료' : '상환 기록 완료');
  } catch (error) { showToast(error.message); }
  finally { chainOperationBusy = false; }
}
async function viewChainDocument(id) {
  try { await IPLoanChain.document(findApp(id)); }
  catch (error) { showToast(error.message); }
}

/* ---------------- 이전 보고서 보관함 ---------------- */
function archiveQueue() { return APPLICATIONS.filter(a => a.status === 'archived' && a.evaluation); }
function renderArchiveList() {
  const queue = archiveQueue();
  document.getElementById('archiveListCount').textContent = `${queue.length}건`;
  document.getElementById('archiveListItems').innerHTML = queue.map(app => `
    <button class="eval-item ${app.id === selectedArchiveId ? 'active' : ''}" type="button" data-archive="${escapeHtml(app.id)}">
      <span class="eval-item-top"><span class="eval-item-company">${escapeHtml(app.company)}</span>${reportBadge(app)}</span>
      <span class="eval-item-sub">${escapeHtml(app.ipTitle || '')} · ${escapeHtml(app.id)}</span>
    </button>`).join('') || '<div class="empty-hint">보관된 보고서가 없습니다.</div>';
}
document.getElementById('archiveListItems').addEventListener('click', (e) => {
  const item = e.target.closest('[data-archive]');
  if (item) selectArchiveItem(item.dataset.archive);
});
function selectArchiveItem(id) {
  const app = findApp(id);
  if (!app) return;
  selectedArchiveId = id;
  document.querySelectorAll('#archiveListItems .eval-item').forEach(el => el.classList.toggle('active', el.dataset.archive === id));
  const job = app.evaluation;
  let body = reportHeading(app, reportBadge(app));
  body += `<div class="report-request-meta"><span>작업번호 <b>${escapeHtml(job.job_id || '발급 전')}</b></span><span>접수 ${escapeHtml(formatDate(job.submitted_at))}</span></div>`;
  body += job.status === 'completed' ? reportDownloadsHTML(app) + reportPreviewHTML(app, 'archivePreview') : statusContent(app);
  if (job.confirmed_at) body += `<div class="confirmed-box"><b>이전 화면에서 확정된 평가</b>
    <div>담보가치 ${won(app.appraisedValue)} · 신용평가 ${fieldHTML(app, 'creditScore', v => `${escapeHtml(v)}점`)}</div>
    <div class="help">${escapeHtml(formatDate(job.confirmed_at))}</div>${job.reviewer_note ? `<p>${escapeHtml(job.reviewer_note)}</p>` : ''}</div>`;
  document.getElementById('archivePanel').innerHTML = `<div class="panel-body">${body}</div>`;
  loadPreview('archivePreview');
}

/* ---------------- 공용 이벤트: 보고서 다운로드·재접수·사업자번호·평가 확정 ---------------- */
document.addEventListener('click', async (event) => {
  const download = event.target.closest('[data-artifact]');
  if (download) {
    const app = findApp(download.dataset.appId), kind = download.dataset.artifact;
    download.disabled = true;
    try { IPLoanChain.openBlob(await IPLoanChain.blob(artifactPath(app, kind) + '?download=1'), `${app.id}-${kind}.${ARTIFACT_SUFFIX[kind] || kind}`); }
    catch (error) { showToast(error.message); }
    finally { download.disabled = false; }
    return;
  }
  const registered = event.target.closest('[data-registered-report]');
  if (registered) {
    const app = findApp(registered.dataset.registeredReport);
    registered.disabled = true;
    try {
      const file = await IPLoanChain.blob(`/applications/${encodeURIComponent(app.id)}/evaluation-report/document?download=1`);
      IPLoanChain.openBlob(file, `${app.id}-registered-report.${app.evaluationReport?.kind || 'pdf'}`);
      showToast('체인에 기록된 해시와 일치하는 보고서입니다');
    } catch (error) { showToast(error.message); }
    finally { registered.disabled = false; }
    return;
  }
  const retry = event.target.closest('[data-retry-app]');
  if (retry) {
    retry.disabled = true;
    try { upsertApplication(await api(`/applications/${encodeURIComponent(retry.dataset.retryApp)}/evaluation`, { method: 'POST' })); refreshOpenViews(true); }
    catch (error) { showToast(error.message); retry.disabled = false; }
  }
});
document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (form.id === 'evalConfirmForm') { event.preventDefault(); confirmEval(form.dataset.appId); return; }
  if (form.id === 'loanTermsForm') { event.preventDefault(); finalChainDecision(form.dataset.appId, true); return; }
  if (!form.matches('.identity-form')) return;
  event.preventDefault();
  const errorNode = form.querySelector('.identity-error');
  const button = form.querySelector('button[type="submit"]');
  errorNode.hidden = true;
  button.disabled = true;
  try {
    upsertApplication(await postJSON(`/applications/${encodeURIComponent(form.dataset.appId)}/evaluation/identity`,
      { business_number: new FormData(form).get('business_number') }));
    refreshOpenViews(true);
    showToast('같은 작업에서 보고서 생성을 이어갑니다.');
  } catch (error) { errorNode.textContent = error.message; errorNode.hidden = false; button.disabled = false; }
});

/* ---------------- 자동 새로고침 ---------------- */
/* 열린 상세 화면은 내용이 바뀐 경우에만 다시 그려 입력 중인 값과 보고서 미리보기를 지킨다. */
function viewKey(app) {
  return app ? JSON.stringify([app.status, app.chainStatus, app.evaluation?.status, app.evaluation?.stage, app.evaluation?.error,
    app.evaluation?.artifacts, app.reportHash, app.bankWallet, app.repaidAmount]) : '';
}
function refreshOpenViews(force = false, before = {}) {
  renderAll();
  const changed = id => force || before[id] !== viewKey(findApp(id));
  if (currentView === 'evaluate' && selectedEvalId && changed(selectedEvalId)) selectEvalItem(selectedEvalId);
  if (currentView === 'review' && selectedReviewId && changed(selectedReviewId)) loadReviewCase(selectedReviewId);
  if (currentView === 'archive' && selectedArchiveId && changed(selectedArchiveId)) selectArchiveItem(selectedArchiveId);
  if (currentView === 'detail' && detailId && changed(detailId)) openDetail(detailId);
}
async function refreshData() {
  if (refreshing || !session() || !currentRole || document.hidden || applicationSubmitting || chainOperationBusy) return;
  refreshing = true;
  const before = Object.fromEntries([selectedEvalId, selectedReviewId, selectedArchiveId, detailId].filter(Boolean).map(id => [id, viewKey(findApp(id))]));
  try {
    APPLICATIONS = await api('/applications');
    const active = APPLICATIONS.filter(a => ACTIVE_REPORT_STATUSES.has(a.evaluation?.status));
    const results = await Promise.allSettled(active.map(a => api(`/applications/${encodeURIComponent(a.id)}/evaluation`)));
    results.forEach(result => { if (result.status === 'fulfilled') upsertApplication(result.value); });
    hideConnNotice();
    refreshOpenViews(false, before);
  } catch (error) {
    if (session()) showConnNotice();
  } finally { refreshing = false; }
}
document.getElementById('connNoticeRetry').addEventListener('click', refreshData);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshData(); });
setInterval(refreshData, 10000);
// The block number in the side panel; role holders and contract details rarely change.
setInterval(async () => { if (!document.hidden) { await IPLoanChain.loadConfig(); renderChainStatus(); } }, 60000);

/* ---------------- Init ---------------- */
async function initApp() {
  const today = new Date();
  document.getElementById('todayDate').textContent = today.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  applyRole();
  goView('login');
  await IPLoanChain.init(API_BASE, onSessionChange);
  renderChainStatus();
  try {
    if (await IPLoanChain.restore()) await onLoggedIn();
  } catch {
    showConnNotice();
  }
}
initApp();
