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
const API_BASE = IS_LOCAL ? 'http://127.0.0.1:5000/api' : 'https://iploan-api.mustree.kr/api';

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

/* 큐레이션된 예시 3건 + 신규 신청은 자동 생성되는 예비 평가보고서 */
const STATIC_EVAL_REPORTS = {
  'LN-2026-0097': {
    genDate:'2026-09-21 09:14', genTime:'8분 42초', appraisedValue:132000000, similarity:0.91,
    summary:'출원번호 10-2024-0088231, 등록번호 10-2601122호로 등록된 비침습 방식 혈당측정 센서 특허입니다. 청구항은 총 12개항으로 구성되며, 피부 접촉면의 다중 전극 배열과 신호보정 알고리즘을 핵심 구성으로 합니다. 등록일 기준 잔존 권리기간은 약 17년입니다.',
    similar:'국내외 공개특허 데이터베이스에서 관련 분류(A61B5/145) 특허 214건을 검색해 상위 유사특허 8건과 청구범위를 비교했습니다. 신호보정 알고리즘 구성에서 선행기술 대비 차별점이 확인되며, 회피설계 가능성은 낮은 것으로 분석됩니다.',
    market:'웨어러블 헬스케어 센서 시장은 성장이 지속되는 분야로, 비침습 혈당측정 기술은 관련 의료기기 인증(식약처 등급 분류) 획득 여부가 상용화의 주요 변수로 확인됩니다.',
    basis:'수익접근법과 시장접근법을 가중 평균하여 산정했습니다. 유사 라이선스 거래 사례, 잔존 권리기간, 특허 청구항의 방어력을 반영했습니다.',
  },
  'LN-2026-0102': {
    genDate:'2026-09-20 16:02', genTime:'6분 05초', appraisedValue:46000000, similarity:0.88,
    summary:'출원번호 40-2023-0142098, 등록번호 40-1987234호로 등록된 문자·도형 결합상표입니다. 지정상품은 제9류(농업용 IoT 센서 기기) 및 제42류(소프트웨어 서비스업)이며, 등록일로부터 10년간 보호되며 갱신 가능합니다.',
    similar:'동일·유사 지정상품군 내 선등록 상표 176건과 대조한 결과 외관·호칭·관념 유사도가 낮아 식별력에 문제가 없는 것으로 분석됩니다.',
    market:'스마트팜 관련 브랜드 인지도는 최근 업계 전시회·조달 등록 이력을 통해 점진적으로 형성되는 추세이며, 상표 가치는 매출 연동형으로 평가됩니다.',
    basis:'로열티공제법을 적용해 예상 매출액에 업종 평균 로열티율을 적용하고, 상표 사용기간을 반영하여 산정했습니다.',
  },
  'LN-2026-0103': {
    genDate:'2026-09-20 11:47', genTime:'7분 18초', appraisedValue:71000000, similarity:0.86,
    summary:'출원번호 20-2024-0031452, 등록번호 20-0512873호로 등록된 협동로봇 관절부 안전 커버 구조에 관한 실용신안입니다. 충격 흡수 이중 구조와 탈부착형 결합 방식을 핵심 청구항으로 합니다.',
    similar:'관련 분류(B25J19) 실용신안·특허 93건을 검토한 결과 결합 방식의 구체적 실시예에서 선행기술과 구별되는 구성이 확인됩니다.',
    market:'협동로봇 안전 규격(KS/ISO) 강화 추세에 따라 관련 안전부품 수요가 증가하는 분야로, 완제품 업체 대상 라이선스·부품 공급 형태의 사업화가 유력합니다.',
    basis:'원가접근법과 시장접근법을 병행 적용했습니다. 실용신안권의 상대적으로 짧은 존속기간(10년)을 반영해 보수적으로 산정했습니다.',
  },
};

/* ---------------- API 통신 ---------------- */
async function apiFetchApplications() {
  const res = await fetch(`${API_BASE}/applications`);
  if (!res.ok) throw new Error('fetch failed');
  return res.json();
}
async function apiCreateApplication(payload) {
  const res = await fetch(`${API_BASE}/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('create failed');
  return res.json();
}
async function apiPatchApplication(id, fields) {
  const res = await fetch(`${API_BASE}/applications/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error('update failed');
  return res.json();
}
async function apiReset() {
  const res = await fetch(`${API_BASE}/reset`, { method: 'POST' });
  if (!res.ok) throw new Error('reset failed');
  return res.json();
}

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
  const m = STATUS_META[status];
  return `<span class="badge ${m.badge}">${m.label}</span>`;
}
function randHex(len) {
  const chars = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
}
function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

/* ---------------- 평가보고서: 큐레이션 3건 + 신규 신청 자동 생성 ---------------- */
/* 평가 대기 목록: 평가중 건만 */
function evalQueue() {
  return APPLICATIONS.filter(a => a.status === 'evaluating');
}
function getEvalReport(app) {
  if (app._report) return app._report;  // 재산정으로 다시 만든 초안이 있으면 우선
  if (typeof SEED_EVAL_REPORTS !== 'undefined' && SEED_EVAL_REPORTS[app.id]) return SEED_EVAL_REPORTS[app.id];
  if (STATIC_EVAL_REPORTS[app.id]) return STATIC_EVAL_REPORTS[app.id];
  app._report = generateEvalReport(app);
  return app._report;
}
function generateEvalReport(app) {
  const h = hashCode(app.id);
  const multiplier = 1.15 + (h % 30) / 100;
  const appraisedValue = app.amount == null ? null : Math.round(app.amount * multiplier / 100000) * 100000;  // 금액이 없으면 산정 안 함
  const similarity = ((84 + (h % 11)) / 100).toFixed(2);
  const minutes = 5 + (h % 6);
  const seconds = h % 60;
  return {
    genDate: '2026-09-22 ' + String(10 + (h % 8)).padStart(2, '0') + ':' + String(h % 60).padStart(2, '0'),
    genTime: `${minutes}분 ${String(seconds).padStart(2, '0')}초`,
    appraisedValue, similarity, generated: true,
    summary: `${app.ipTitle}(${app.ipType})의 출원·등록 정보를 기반으로 권리범위와 청구항 구성을 LLM이 1차 분석했습니다. 신청 시 등록된 서류를 기준으로 한 예비 검토 결과입니다.`,
    similar: `관련 기술·상품 분류 내 선행 IP를 검색해 유사도를 비교했습니다. 신청 정보만으로 산출한 예비 결과이며, 정식 심사 단계에서 세부 비교가 추가로 진행됩니다.`,
    market: `${app.ipType}이 속한 분야의 최근 시장 동향과 사업화 가능성을 반영해 예비 가치를 산정했습니다.`,
    basis: `수익접근법과 시장접근법을 가중 평균하여 예비 담보가치를 산정했습니다. 평가자 확정 시 세부 근거가 보강됩니다.`,
  };
}

/* ---------------- 연결 오류 알림 ---------------- */
function showConnNotice() { document.getElementById('connNotice').classList.add('show'); }
function hideConnNotice() { document.getElementById('connNotice').classList.remove('show'); }

/* ---------------- Navigation ---------------- */
const VIEW_META = {
  dashboard: { title:'대시보드',        sub:'LLM·블록체인 기반 IP담보 자동대출 서비스 현황' },
  list:      { title:'대출 신청 리스트', sub:'전체 대출 신청 건의 심사 진행 상태를 확인합니다' },
  apply:     { title:'대출 신청',        sub:'지식재산권을 담보로 등록하고 대출을 신청합니다' },
  evaluate:  { title:'IP 가치평가',      sub:'LLM이 자동 생성한 IP 가치평가보고서를 검토·확정합니다' },
  review:    { title:'대출 심사',        sub:'스마트컨트랙트 기반 자동심사 결과를 확인하고 최종 승인합니다' },
  detail:    { title:'신청 진행 상황',   sub:'' },
};

let evalInitDone = false;
let reviewInitDone = false;

/* ---------------- 역할(프로필) ---------------- */
/* 차주기업 역할의 시연 회사: js/seed-data.js가 있으면 DEMO_BORROWERS 첫 회사, 없으면 서버 데이터의 (주)그린파머스. 회사 식별은 기업명으로만 한다 */
const BORROWER_COMPANY = (typeof DEMO_BORROWERS !== 'undefined' && DEMO_BORROWERS[0] && DEMO_BORROWERS[0].company) || '(주)그린파머스';

/* 대시보드는 모든 역할 공통. 역할별 대시보드는 추후 분리 예정 */
const ROLES = {
  lender:    { name:'김민준', avatar:'김민', role:'여신심사역 · NH농협은행',            views:['dashboard','list','review'] },
  evaluator: { name:'박도윤', avatar:'박도', role:'IP 가치평가자 · 지정 평가기관', views:['dashboard','evaluate'] },
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
  return currentRole === 'borrower' ? APPLICATIONS.filter(a => a.company === BORROWER_COMPANY) : APPLICATIONS;
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
      <td class="cell-company">${a.company}</td>
      <td>${a.ipTitle}</td>
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
      <td class="cell-company">${a.company}<div class="cell-sub">${fieldHTML(a, 'bizNo')}</div></td>
      <td>${a.ipTitle}<div class="cell-sub">${a.ipType} · ${fieldHTML(a, 'ipRegNo')}</div></td>
      <td class="cell-amount">${fieldHTML(a, 'amount', won)}</td>
      <td>${statusBadge(a.status)}</td>
      <td class="cell-hash">${a.hash}</td>
      <td>${fieldHTML(a, 'appliedDate')}</td>
      <td class="row-arrow">›</td>
    </tr>`).join('');

  document.querySelectorAll('#listTableBody tr').forEach(tr => {
    tr.addEventListener('click', () => {
      if (currentRole === 'borrower') { openDetail(tr.dataset.id); return; }
      if (!canView('review')) return;
      goView('review');
      loadReviewCase(tr.dataset.id);
      reviewInitDone = true;
    });
  });
}

document.getElementById('listSearch').addEventListener('input', renderListTable);

/* ---------------- 신청 진행 상황 (차주기업) ---------------- */
const BORROWER_STATUS_DESC = {
  pending:    '신청이 접수되었습니다',
  doc_verify: '발급기관 원본과 서류를 대조하고 있습니다',
  evaluating: 'IP 가치평가가 진행 중입니다',
  review:     '은행 심사가 진행 중입니다',
  approved:   '대출이 승인되었습니다',
  rejected:   '대출이 승인되지 않았습니다',
};
/* 단계별 완료 시각은 처리 기록(history)에서 해당 단계를 끝낸 항목(doneBy)을 찾아 표시.
   owner(담당)는 IP 가치평가, 대출 심사 단계에만 표시하며 <br>로 줄을 나눈다 */
const PROGRESS_STEPS = [
  { label:'신청 접수',   doneBy:['대출 신청 접수'] },
  { label:'서류 검증',   doneBy:['서류검증 완료'] },
  { label:'IP 가치평가', doneBy:['가치평가 확정'],
    owner:'LLM 평가 에이전트<br>→ IP 가치평가자 (지정 평가기관)' },
  { label:'대출 심사',   doneBy:['자동심사 통과', '자동심사 불통과'],
    owner:'스마트컨트랙트<br>→ 여신심사역 (NH농협은행)' },
  { label:'결과',        doneBy:['최종 승인 확정', '거절 확정 통지'] },
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
  document.getElementById('detailHint').textContent = `${app.id} · ${app.ipType}`;
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
    ? `<div class="k">제출 서류 ${docs.length}건</div>` + docs.map(d => `<span>${d}</span>`).join('')
    : '';

  VIEW_META.detail.sub = `${app.id} 신청의 진행 상황을 확인합니다`;
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

applyForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = document.getElementById('applySubmitBtn');
  btn.disabled = true;
  btn.textContent = '처리 중…';

  const steps = document.querySelectorAll('#applySteps .step');
  steps[0].classList.add('done'); steps[0].classList.remove('current');
  steps[1].classList.add('current');

  const company = (document.getElementById('fCompany').value || '').trim() || '미입력 기업';
  const bizNo = (document.getElementById('fBizNo').value || '').trim();
  const ipType = document.getElementById('fIpType').value || '특허권';
  const ipTitle = (document.getElementById('fIpTitle').value || '').trim() || '미입력 IP 자산';
  const amountRaw = document.getElementById('fAmount').value || '';
  const amount = parseInt(amountRaw.replace(/[^0-9]/g, ''), 10) || 50000000;
  const files = Array.from(fileInput.files);
  const hash = '0x' + randHex(8) + '…' + randHex(6);

  const createPromise = apiCreateApplication({ company, bizNo, ipType, ipTitle, amount, hash });

  setTimeout(() => { steps[1].classList.add('done'); steps[1].classList.remove('current'); steps[2].classList.add('current'); }, 500);
  setTimeout(() => { steps[2].classList.add('done'); steps[2].classList.remove('current'); steps[3].classList.add('current'); }, 1200);

  setTimeout(async () => {
    try {
      const created = await createPromise;
      hideConnNotice();
      steps[3].classList.add('done'); steps[3].classList.remove('current');

      APPLICATIONS.push(created);

      document.getElementById('genAppId').textContent = created.id;
      document.getElementById('genFiles').textContent = files.length
        ? (files[0].name + (files.length > 1 ? ` 외 ${files.length - 1}건` : ''))
        : '특허등록원부.pdf (샘플)';
      document.getElementById('genHash').textContent = created.hash;
      document.getElementById('genBlock').textContent = '#' + (482912 + Math.floor(Math.random()*20));
      document.getElementById('genTime').textContent = '2026-09-22 ' +
        String(14 + Math.floor(Math.random()*3)).padStart(2,'0') + ':' +
        String(Math.floor(Math.random()*60)).padStart(2,'0') + ':' +
        String(Math.floor(Math.random()*60)).padStart(2,'0');

      document.getElementById('applyHashBlock').classList.add('show');
      btn.textContent = '제출 완료';

      renderDashboard();
      renderListTable();
      renderEvalList();
      renderReviewList();
    } catch (err) {
      showConnNotice();
      steps[3].classList.remove('current');
      btn.disabled = false;
      btn.textContent = '다시 시도';
    }
  }, 1900);
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
    <div class="eval-item" data-id="${app.id}">
      <div class="eval-item-top">
        <span class="eval-item-company">${app.company}</span>
        ${statusBadge(app.status)}
      </div>
      <div class="eval-item-sub">${app.ipTitle} · ${app.ipType}</div>
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

  /* 재산정 요청된 건은 보고서 대신 재산정 중 안내를 보여 준다 */
  if (app._reevaluating) {
    document.getElementById('evalReportPanel').innerHTML = `
      <div class="panel-body">
        <div class="report-head">
          <div>
            <div class="report-title">${app.ipTitle}</div>
            <div class="report-meta">${app.company} · ${app.ipType} · 신청번호 ${app.id}</div>
          </div>
          ${statusBadge(app.status)}
        </div>
        <div class="reeval-notice">
          <div class="reeval-notice-title"><span class="pulse"></span> 재산정 중입니다</div>
          <p>LLM이 가치평가보고서 초안을 다시 생성하고 있습니다. 새 초안이 준비되면 이 화면에서 검토·확정할 수 있습니다.</p>
          <div class="reeval-reason" id="reevalReasonView" hidden><span class="k">요청 사유</span><span class="v"></span></div>
        </div>
      </div>`;
    if (app._reevalReason) {
      const el = document.getElementById('reevalReasonView');
      el.querySelector('.v').textContent = app._reevalReason;
      el.hidden = false;
    }
    return;
  }

  document.getElementById('evalReportPanel').innerHTML = `
    <div class="panel-body">
      <div class="report-head">
        <div>
          <div class="report-title">${app.ipTitle}</div>
          <div class="report-meta">${app.company} · ${app.ipType} · 신청번호 ${app.id}</div>
          <div class="report-meta">출원·등록번호 ${fieldHTML(app, 'ipRegNo')} · 신청금액 ${fieldHTML(app, 'amount', won)}</div>
        </div>
        <span class="llm-tag"><span class="pulse"></span> LLM 자동 생성</span>
      </div>

      <div class="report-grid">
        <div class="report-stat">
          <div class="report-stat-label">산정 담보가치</div>
          <div class="report-stat-value">${won(r.appraisedValue)}</div>
        </div>
        <div class="report-stat">
          <div class="report-stat-label">전문가 평가 대비 유사도</div>
          <div class="report-stat-value">${r.similarity}</div>
          <div class="similarity-bar"><div class="similarity-bar-fill" style="width:${r.similarity*100}%"></div></div>
        </div>
        <div class="report-stat">
          <div class="report-stat-label">보고서 생성 소요시간</div>
          <div class="report-stat-value">${r.genTime}</div>
        </div>
      </div>

      <div class="report-section">
        <h4>IP 정보 요약</h4>
        <p>${r.summary}</p>
      </div>
      <div class="report-section">
        <h4>유사 IP 비교</h4>
        <p>${r.similar}</p>
      </div>
      <div class="report-section">
        <h4>시장성 분석</h4>
        <p>${r.market}</p>
      </div>
      <div class="report-section">
        <h4>가치 산정 근거</h4>
        <p>${r.basis}</p>
      </div>

      <div style="font-size:11.5px; color:var(--ink-faint); margin-bottom:16px;">생성 일시 ${r.genDate} · 결과 해시는 확정 시 블록체인에 기록됩니다</div>

      <div style="display:flex; gap:10px;">
        <button class="btn btn-primary" id="confirmEvalBtn" onclick="confirmEval('${id}')">가치평가 확정</button>
        <button class="btn btn-outline" onclick="openReevalDialog('${id}')">재산정 요청</button>
      </div>
      <div id="evalConfirmMsg" style="display:none; margin-top:12px; font-size:12.5px; color:var(--teal); font-weight:600;">✓ 평가가 확정되어 대출 심사 단계로 전달되었습니다.</div>
    </div>`;
}

/* 재산정 요청 팝업 (사유는 선택 입력) */
const reevalDialog = document.getElementById('reevalDialog');
let reevalTargetId = null;

function openReevalDialog(id) {
  const app = findApp(id);
  if (!app) return;
  reevalTargetId = id;
  document.getElementById('reevalDesc').textContent = `${app.company} · ${app.ipTitle} (${app.id})`;
  document.getElementById('reevalReason').value = '';
  reevalDialog.showModal();
}

document.getElementById('reevalCancel').addEventListener('click', () => reevalDialog.close());
reevalDialog.addEventListener('click', (e) => { if (e.target === reevalDialog) reevalDialog.close(); });  // 바깥(배경) 클릭 시 닫기
document.getElementById('reevalForm').addEventListener('submit', async () => {
  const app = findApp(reevalTargetId);
  if (!app) return;
  const reason = document.getElementById('reevalReason').value.trim();
  app._reevaluating = true;  // 상태값은 평가중 그대로 두고 이 화면에서만 재산정 중으로 표시(새로고침 시 사라짐)
  app._reevalReason = reason;  // 서버에 사유 칸이 없어 이 화면에서만 보관(새로고침 시 사라짐)
  showToast('재산정 요청이 접수되었습니다');
  scheduleReevalFinish(app.id);

  renderEvalList();
  selectEvalItem(app.id);
});

/* 재산정 완료: 몇 초 뒤 LLM 초안을 다시 만들고 보고서를 다시 보여 준다 */
const REEVAL_DURATION_MS = 5000;  // 시연용 재산정 소요시간

function nowString() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function scheduleReevalFinish(id) {
  setTimeout(() => {
    const app = findApp(id);
    if (!app || !app._reevaluating) return;
    delete app._reevaluating;
    delete app._reevalReason;
    app._report = { ...generateEvalReport(app), genDate: nowString() };
    showToast('LLM 초안을 다시 생성했습니다');

    const activeId = document.querySelector('#evalListItems .eval-item.active')?.dataset.id;
    renderEvalList();
    if (activeId) selectEvalItem(activeId);
  }, REEVAL_DURATION_MS);
}

async function confirmEval(id) {
  const app = findApp(id);
  if (!app) return;
  const r = getEvalReport(app);

  const btn = document.getElementById('confirmEvalBtn');
  if (btn) { btn.disabled = true; btn.textContent = '처리 중…'; }

  const patch = {
    appraisedValue: r.appraisedValue,
    ltv: app.amount == null || !r.appraisedValue ? null : Math.min(999, Math.round((app.amount / r.appraisedValue) * 100)),  // 금액·평가액이 없으면 계산하지 않음
    status: 'review',
  };
  if (app.creditScore == null) patch.creditScore = 65 + (hashCode(app.id + 'c') % 21);

  let updated;
  try {
    updated = await apiPatchApplication(id, patch);
    hideConnNotice();
  } catch (err) {
    showConnNotice();
    if (btn) { btn.disabled = false; btn.textContent = '가치평가 확정'; }
    return;
  }
  Object.assign(app, updated);

  const msg = document.getElementById('evalConfirmMsg');
  if (msg) msg.style.display = 'block';

  renderDashboard();
  renderListTable();
  renderReviewList();

  setTimeout(() => {
    renderEvalList();
    const next = evalQueue()[0];
    if (next) selectEvalItem(next.id);
    else document.getElementById('evalReportPanel').innerHTML = `<div class="empty-hint">평가 대기 중인 건이 없습니다. 새 신청이 들어오면 왼쪽 목록에 표시됩니다.</div>`;
  }, 1100);
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
    <div class="eval-item ${app.id === currentReviewId ? 'active' : ''}" data-id="${app.id}">
      <div class="eval-item-top">
        <span class="eval-item-company">${app.company}</span>
        ${statusBadge(app.status)}
      </div>
      <div class="eval-item-sub">${app.ipTitle} · ${won(app.amount)}</div>
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

  const beforeReview = ['pending', 'doc_verify', 'evaluating'].includes(app.status);
  if (!app.appraisedValue && beforeReview) {
    body.innerHTML = `
      <div class="panel">
        <div class="empty-hint">
          <p style="margin-bottom:14px;">${app.company}의 <b>${app.ipTitle}</b> 건은 아직 IP 가치평가가 완료되지 않아<br>스마트컨트랙트 자동심사를 실행할 수 없습니다.</p>
          ${canView('evaluate') ? `<button class="btn btn-outline" onclick="goView('evaluate')">IP 가치평가로 이동</button>` : ''}
        </div>
      </div>`;
    return;
  }
  /* 심사 단계인데 평가액(또는 신청금액)이 없어 LTV를 계산할 수 없는 건: 판정하지 않고 안내만 */
  if (!app.appraisedValue || app.amount == null || app.ltv == null) {
    body.innerHTML = `
      <div class="panel">
        <div class="panel-header"><h3>${app.company} · ${app.ipTitle}</h3><span class="hint">${app.id}</span></div>
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
  const hashOk = appField(app, 'hashMatch') !== 0;  // 0=발급기관 원본과 불일치, null·1은 통과
  const alreadyDecided = app.status === 'approved' || app.status === 'rejected';
  const approvedAmount = Math.min(app.amount, Math.round(app.appraisedValue * 0.7 / 100000) * 100000);

  body.innerHTML = `
    <div class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><h3>${app.company} · ${app.ipTitle}</h3><span class="hint">${app.id}</span></div>
      <div class="panel-body">
        <div class="review-summary">
          <div class="item"><div class="k">신청금액</div><div class="v">${fieldHTML(app, 'amount', won)}</div></div>
          <div class="item"><div class="k">산정 담보가치</div><div class="v">${fieldHTML(app, 'appraisedValue', won)}</div></div>
          <div class="item"><div class="k">담보인정비율(LTV)</div><div class="v">${fieldHTML(app, 'ltv', v => `${v}%`)}</div></div>
          <div class="item"><div class="k">신용평가 점수</div><div class="v">${fieldHTML(app, 'creditScore', v => `${v}점`)}</div></div>
          <div class="item"><div class="k">출원·등록번호</div><div class="v">${fieldHTML(app, 'ipRegNo')}</div></div>
          <div class="item"><div class="k">상환기간</div><div class="v">${fieldHTML(app, 'termMonths', v => `${escapeHtml(v)}개월`)}</div></div>
        </div>

        <div class="section-title">스마트컨트랙트 자동심사 조건</div>
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
              <div class="check-desc">기술신용평가(TCB) 연동 점수 60점 이상 여부 확인</div>
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
              <div class="check-desc">발급기관 원본 해시와 등록 서류 해시 대조</div>
            </div>
            <div class="check-status">${hashOk ? '일치' : '불일치'}</div>
          </div>
        </div>

        <div id="reviewActionArea">
          ${alreadyDecided
            ? `<div style="font-size:12.5px; color:var(--ink-faint);">이미 처리된 건입니다 · ${fieldHTML(app, 'appliedDate')} 접수</div>`
            : `<button class="btn btn-primary" id="runReviewBtn">스마트컨트랙트 자동심사 실행</button>`}
        </div>
      </div>
    </div>

    <div class="decision-banner" id="decisionBanner"></div>
  `;

  if (alreadyDecided) {
    document.querySelectorAll('#checkList .check-item').forEach(el => {
      el.classList.add(el.dataset.ok === 'true' ? 'verified' : 'failed');
    });
    showDecision(app, ltvOk && creditOk && hashOk, approvedAmount, true);
  } else {
    document.getElementById('runReviewBtn').addEventListener('click', () => runAutoReview(app, ltvOk, creditOk && hashOk, approvedAmount));
  }
}

function runAutoReview(app, ltvOk, creditOk, approvedAmount) {
  const btn = document.getElementById('runReviewBtn');
  btn.disabled = true;
  btn.textContent = '심사 진행 중…';

  const items = document.querySelectorAll('#checkList .check-item');
  items.forEach((el, i) => {
    setTimeout(() => el.classList.add(el.dataset.ok === 'true' ? 'verified' : 'failed'), 450 * (i + 1));
  });

  setTimeout(() => {
    document.getElementById('reviewActionArea').innerHTML = `<div style="font-size:12.5px; color:var(--ink-faint);">자동심사가 완료되었습니다</div>`;
    showDecision(app, ltvOk && creditOk, approvedAmount, false);
  }, 450 * items.length + 300);
}

function showDecision(app, approved, approvedAmount, alreadyDecided) {
  const banner = document.getElementById('decisionBanner');
  banner.classList.add('show', approved ? 'approved' : 'rejected');

  if (approved) {
    banner.innerHTML = `
      <div class="decision-head">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="m8.5 12 2.5 2.5 4.5-5"></path></svg>
        <span class="decision-title">자동심사 결과 — 승인 가능</span>
      </div>
      <div class="decision-desc">모든 스마트컨트랙트 조건을 충족하여 자동 승인 대상으로 판정되었습니다.</div>
      <div class="decision-figures">
        <div><div class="f-label">대출가능금액</div><div class="f-value">${won(approvedAmount)}</div></div>
        <div><div class="f-label">적용 예상금리</div><div class="f-value">${app.rate ? app.rate + '%' : '4.3%'}</div></div>
      </div>
      <div class="decision-actions">
        ${alreadyDecided
          ? `<span style="font-size:12.5px; color:var(--ink-soft);">최종 승인 처리 완료 건입니다</span>`
          : `<button class="btn btn-primary btn-sm" onclick="finalizeDecision(this,'승인','${app.id}')">최종 승인 확정</button>
             <button class="btn btn-outline btn-sm" onclick="finalizeDecision(this,'보류','${app.id}')">보류하고 재검토</button>`}
      </div>`;
  } else {
    const reason = app.rejectReason || (appField(app, 'hashMatch') === 0
      ? '제출 서류 해시가 발급기관 원본과 일치하지 않아(서류 해시 무결성 검증 실패) 자동 거절 처리되었습니다.'
      : '스마트컨트랙트 자동심사 기준(LTV 70% 이하)을 충족하지 못해 자동 거절 처리되었습니다.');
    banner.innerHTML = `
      <div class="decision-head">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="m9.5 9.5 5 5m0-5-5 5"></path></svg>
        <span class="decision-title">자동심사 결과 — 거절</span>
      </div>
      <div class="decision-desc">${reason}</div>
      <div class="decision-actions">
        ${alreadyDecided
          ? `<span style="font-size:12.5px; color:var(--ink-soft);">거절 처리 완료 건입니다</span>`
          : `<button class="btn btn-outline btn-sm" onclick="finalizeDecision(this,'거절 확정','${app.id}')">거절 확정 통지</button>
             <button class="btn btn-danger-outline btn-sm" onclick="finalizeDecision(this,'재심사 요청','${app.id}')">재심사 요청</button>`}
      </div>`;
  }
}

async function finalizeDecision(btn, label, appId) {
  const area = btn.closest('.decision-actions');
  area.innerHTML = `<span style="font-size:12.5px; color:var(--ink-soft);">처리 중…</span>`;

  const app = findApp(appId);
  if (!app) return;

  const patch = {};
  if (label === '승인') {
    patch.status = 'approved';
    if (!app.rate) patch.rate = Number((3.8 + (hashCode(app.id + 'r') % 8) / 10).toFixed(1));
  } else if (label === '거절 확정') {
    patch.status = 'rejected';
  }

  try {
    if (Object.keys(patch).length) {
      const updated = await apiPatchApplication(appId, patch);
      Object.assign(app, updated);
    }
    hideConnNotice();
    area.innerHTML = `<span style="font-size:12.5px; color:var(--ink-soft);">✓ ${label} 처리되었습니다</span>`;
    renderDashboard();
    renderListTable();
    renderReviewList();
  } catch (err) {
    showConnNotice();
    area.innerHTML = `<span style="font-size:12.5px; color:var(--danger);">처리에 실패했습니다. 다시 시도해주세요.</span>`;
  }
}

/* ---------------- 데이터 초기화 (서버의 모든 방문자 데이터를 초기 상태로) ---------------- */
async function resetAllState() {
  if (!window.confirm('저장된 데이터를 초기 상태로 되돌릴까요? 이 사이트를 보는 모든 사람에게 적용되며, 되돌릴 수 없습니다.')) return;
  try {
    APPLICATIONS = await apiReset();
    hideConnNotice();
  } catch (err) {
    showConnNotice();
    return;
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

/* Live-ish block counter for atmosphere */
setInterval(() => {
  const el = document.getElementById('blockNo');
  const current = parseInt(el.textContent.replace(/[^\d]/g, ''), 10);
  el.textContent = 'Block #' + (current + 1).toLocaleString('ko-KR');
}, 4000);
