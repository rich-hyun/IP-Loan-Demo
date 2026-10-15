const API_BASE = (window.IPLOAN_API_BASE ||
  (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ? '/api' : 'https://iploan-api.mustree.kr/api/patent')).replace(/\/$/, '');

/* ---------------- Status labels ---------------- */
const STATUS_META = {
  pending:    { label: '대기',     badge: 'badge-pending'  },
  doc_verify: { label: '서류검증', badge: 'badge-verify'   },
  evaluating: { label: '평가중',   badge: 'badge-review'   },
  review:     { label: '심사중',   badge: 'badge-review'   },
  approved:   { label: '승인',     badge: 'badge-approved' },
  rejected:   { label: '거절',     badge: 'badge-rejected' },
  report_ready: { label: '보고서 도착', badge: 'badge-approved' },
  report_failed: { label: '확인 필요', badge: 'badge-rejected' },
  evaluated: { label: '평가 확정', badge: 'badge-approved' },
};

/* 서버에 연결할 수 없을 때만 쓰는 최소한의 화면 표시용 대체 데이터.
   서버가 정상이면 항상 API 응답으로 대체됩니다. */
const FALLBACK_APPLICATIONS = [
  { id:'LN-2026-0088', company:'에너지테크(주)', bizNo:'220-87-30984', ipType:'특허권', ipTitle:'고효율 태양광 인버터', amount:150000000, status:'approved', hash:'0x1fa726…c0e94b', appliedDate:'2026-09-08', appraisedValue:214000000, ltv:70, creditScore:81, rate:3.9 },
];

/* 기존 시연 데이터에 한해 제공하는 예시 보고서 */
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
async function apiRequest(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, options);
  let payload;
  try { payload = await res.json(); } catch (_) { payload = {}; }
  if (!res.ok) {
    const err = new Error(payload.error || '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    err.status = res.status;
    err.detail = payload.detail;
    err.retryAfter = res.headers.get('Retry-After');
    throw err;
  }
  return payload;
}
async function apiFetchApplications() {
  const applications = await apiRequest('/applications');
  if (!Array.isArray(applications)) throw new Error('신청 목록 응답을 확인할 수 없습니다.');
  return applications;
}
async function apiCreateApplication(payload) {
  return apiRequest('/applications', {
    method: 'POST', body: payload,
  });
}
async function apiPatchApplication(id, fields) {
  return apiRequest(`/applications/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
}
async function apiReset() {
  const res = await fetch(`${API_BASE}/reset`, { method: 'POST' });
  if (!res.ok) throw new Error('reset failed');
  return res.json();
}

/* ---------------- Helpers ---------------- */
function won(n) { return n ? Number(n).toLocaleString('ko-KR') + '원' : '미입력'; }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
}
function findApp(id) { return APPLICATIONS.find(a => a.id === id); }
function statusBadge(status) {
  const m = STATUS_META[status] || { label: '확인 중', badge: 'badge-pending' };
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

/* ---------------- 연결 오류 알림 ---------------- */
function showConnNotice() { document.getElementById('connNotice').classList.add('show'); }
function hideConnNotice() { document.getElementById('connNotice').classList.remove('show'); }

/* ---------------- Navigation ---------------- */
const VIEW_META = {
  dashboard: { title:'대시보드',        sub:'LLM·블록체인 기반 IP담보 자동대출 서비스 현황' },
  list:      { title:'대출 신청 리스트', sub:'전체 대출 신청 건의 심사 진행 상태를 확인합니다' },
  apply:     { title:'특허평가 신청',    sub:'사업자등록번호와 특허 공고전문으로 보고서 생성을 신청합니다' },
  evaluate:  { title:'평가자 보고서함',  sub:'보고서 생성 현황을 확인하고 담보가치를 검토·확정합니다' },
  review:    { title:'대출 심사',        sub:'스마트컨트랙트 기반 자동심사 결과를 확인하고 최종 승인합니다' },
};

let evalInitDone = false;
let reviewInitDone = false;

function goView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  document.getElementById('topbarTitle').textContent = VIEW_META[name].title;
  document.getElementById('topbarSub').textContent = VIEW_META[name].sub;

  if (name === 'evaluate' && !evalInitDone) {
    const first = evalQueue()[0];
    if (first) selectEvalItem(first.id);
    else document.getElementById('evalReportPanel').innerHTML = `<div class="empty-hint">평가 대기 중인 건이 없습니다.</div>`;
    evalInitDone = true;
  }
  if (name === 'review' && !reviewInitDone && findApp('LN-2026-0094')) {
    loadReviewCase('LN-2026-0094');
    reviewInitDone = true;
  }
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => goView(btn.dataset.view));
});

/* ---------------- Dashboard ---------------- */
function renderDashboard() {
  const counts = {};
  Object.keys(STATUS_META).forEach(k => counts[k] = 0);
  APPLICATIONS.forEach(a => counts[a.status] = (counts[a.status] || 0) + 1);

  const order = ['pending','doc_verify','evaluating','report_ready','report_failed','evaluated','review','approved','rejected'];
  document.getElementById('applicationCount').textContent = `전체 ${APPLICATIONS.length}건`;
  renderDashboardReports();
  document.getElementById('statusRow').innerHTML = order.map(k => `
    <div class="status-pill">
      <div class="status-pill-count">${counts[k]}</div>
      <div class="status-pill-label">${STATUS_META[k].label}</div>
    </div>`).join('');

  const recent = [...APPLICATIONS].sort((a,b) => b.appliedDate.localeCompare(a.appliedDate)).slice(0,4);
  document.querySelector('#miniTable tbody').innerHTML = recent.map(a => `
    <tr onclick="goView('list')">
      <td class="cell-company">${escapeHtml(a.company)}</td>
      <td>${escapeHtml(a.ipTitle)}</td>
      <td class="cell-amount">${won(a.amount)}</td>
      <td>${statusBadge(a.status)}</td>
    </tr>`).join('');
}

/* ---------------- List view ---------------- */
let activeFilter = 'all';
const FILTERS = [['all','전체'], ['pending','대기'], ['doc_verify','기업 확인'], ['evaluating','보고서 생성'], ['report_ready','보고서 도착'], ['report_failed','확인 필요'], ['evaluated','평가 확정'], ['review','심사중'], ['approved','승인'], ['rejected','거절']];

function renderFilterChips() {
  document.getElementById('filterChips').innerHTML = FILTERS.map(([key,label]) => `
    <button class="chip ${activeFilter === key ? 'active' : ''}" data-key="${key}">${label}</button>`).join('');
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => { activeFilter = chip.dataset.key; renderFilterChips(); renderListTable(); });
  });
}

function renderListTable() {
  const term = (document.getElementById('listSearch').value || '').trim().toLowerCase();
  const rows = APPLICATIONS.filter(a => {
    const matchesStatus = activeFilter === 'all' || a.status === activeFilter;
    const matchesTerm = !term || [a.company, a.id, a.bizNo, a.ipTitle].some(v => String(v || '').toLowerCase().includes(term));
    return matchesStatus && matchesTerm;
  });

  document.getElementById('listTableBody').innerHTML = rows.map(a => `
    <tr data-id="${escapeHtml(a.id)}">
      <td class="cell-hash">${escapeHtml(a.id)}</td>
      <td class="cell-company">${escapeHtml(a.company)}<div class="cell-sub">${escapeHtml(a.bizNo || '-')}</div></td>
      <td>${escapeHtml(a.ipTitle)}<div class="cell-sub">${escapeHtml(a.ipType)}</div></td>
      <td class="cell-amount">${won(a.amount)}</td>
      <td>${statusBadge(a.status)}</td>
      <td class="cell-hash">${escapeHtml(a.hash || '-')}</td>
      <td>${escapeHtml(a.appliedDate)}</td>
      <td class="row-arrow">›</td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty-hint">조건에 맞는 신청이 없습니다.</td></tr>';

  document.querySelectorAll('#listTableBody tr').forEach(tr => {
    tr.addEventListener('click', () => {
      if (!tr.dataset.id) return;
      const application = findApp(tr.dataset.id);
      if (application?.evaluation) { openEvaluation(application.id); return; }
      goView('review');
      document.getElementById('reviewCaseSelect').value = tr.dataset.id;
      loadReviewCase(tr.dataset.id);
      reviewInitDone = true;
    });
  });
}

document.getElementById('listSearch').addEventListener('input', renderListTable);

/* ---------------- Review view ---------------- */
function updateReviewSelectOptions() {
  const sel = document.getElementById('reviewCaseSelect');
  const prev = sel.value;
  sel.innerHTML = APPLICATIONS.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.id)} · ${escapeHtml(a.company)} · ${won(a.amount)}</option>`).join('');
  if (prev && APPLICATIONS.some(a => a.id === prev)) sel.value = prev;
}

function renderReviewSelect() {
  updateReviewSelectOptions();
  document.getElementById('reviewCaseSelect').addEventListener('change', (e) => loadReviewCase(e.target.value));
}

function loadReviewCase(id) {
  const app = findApp(id);
  if (!app) return;
  document.getElementById('reviewCaseSelect').value = id;
  const body = document.getElementById('reviewBody');

  if (!app.appraisedValue) {
    body.innerHTML = `
      <div class="panel">
        <div class="empty-hint">
          <p style="margin-bottom:14px;">${escapeHtml(app.company)}의 <b>${escapeHtml(app.ipTitle)}</b> 건은 아직 IP 가치평가가 완료되지 않아<br>자동심사를 실행할 수 없습니다.</p>
          <button class="btn btn-outline" onclick="goView('evaluate')">IP 가치평가로 이동</button>
        </div>
      </div>`;
    return;
  }
  if (!app.amount) {
    body.innerHTML = '<div class="panel"><div class="empty-hint">특허 가치평가가 완료되었습니다. 대출 희망 금액이 입력되지 않아 대출 심사는 진행하지 않습니다.</div></div>';
    return;
  }

  const ltvOk = app.ltv <= 70;
  const creditOk = app.creditScore >= 60;
  const alreadyDecided = app.status === 'approved' || app.status === 'rejected';
  const approvedAmount = Math.min(app.amount, Math.round(app.appraisedValue * 0.7 / 100000) * 100000);

  body.innerHTML = `
    <div class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><h3>${escapeHtml(app.company)} · ${escapeHtml(app.ipTitle)}</h3><span class="hint">${escapeHtml(app.id)}</span></div>
      <div class="panel-body">
        <div class="review-summary">
          <div class="item"><div class="k">신청금액</div><div class="v">${won(app.amount)}</div></div>
          <div class="item"><div class="k">산정 담보가치</div><div class="v">${won(app.appraisedValue)}</div></div>
          <div class="item"><div class="k">담보인정비율(LTV)</div><div class="v">${app.ltv}%</div></div>
          <div class="item"><div class="k">신용평가 점수</div><div class="v">${app.creditScore}점</div></div>
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
            <div class="check-status">${app.creditScore}점</div>
          </div>
          <div class="check-item" data-ok="true">
            <div class="check-icon">
              <svg class="icon-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>
              <svg class="icon-x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"></path></svg>
            </div>
            <div class="check-text">
              <div class="check-title">${app.evaluation ? '평가자 검토 및 확정 완료' : '서류 해시 무결성 검증'}</div>
              <div class="check-desc">${app.evaluation ? '평가보고서를 검토한 평가자가 담보가치를 최종 확정' : '발급기관 원본 해시와 등록 서류 해시 대조'}</div>
            </div>
            <div class="check-status">${app.evaluation ? '확정 완료' : '일치'}</div>
          </div>
        </div>

        <div id="reviewActionArea">
          ${alreadyDecided
            ? `<div style="font-size:12.5px; color:var(--ink-faint);">이미 처리된 건입니다 · ${app.appliedDate} 접수</div>`
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
    showDecision(app, ltvOk && creditOk, approvedAmount, true);
  } else {
    document.getElementById('runReviewBtn').addEventListener('click', () => runAutoReview(app, ltvOk, creditOk, approvedAmount));
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
    const reason = app.rejectReason || '스마트컨트랙트 자동심사 기준(LTV 70% 이하)을 충족하지 못해 자동 거절 처리되었습니다.';
    banner.innerHTML = `
      <div class="decision-head">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="m9.5 9.5 5 5m0-5-5 5"></path></svg>
        <span class="decision-title">자동심사 결과 — 거절</span>
      </div>
      <div class="decision-desc">${escapeHtml(reason)}</div>
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
    updateReviewSelectOptions();
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
  activeFilter = 'all';
  const searchEl = document.getElementById('listSearch');
  if (searchEl) searchEl.value = '';

  renderDashboard();
  renderFilterChips();
  renderListTable();
  renderEvalList();
  updateReviewSelectOptions();
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
  renderReviewSelect();
  apiRequest('/borrower-profiles').then(profiles => { if (Array.isArray(profiles)) borrowerProfiles = profiles; }).catch(() => {});
  if (document.querySelector('#view-evaluate.active') && !selectedEvalId) {
    const first = evalQueue()[0];
    if (first) selectEvalItem(first.id);
  }
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
    updateReviewSelectOptions();
  } catch (err) {
    showConnNotice();
  }
});

document.getElementById('resetDemoBtn').addEventListener('click', resetAllState);

document.getElementById('todayDate').textContent = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
initApp().then(() => { const initial = location.hash.slice(1); goView(['apply','evaluate','list','review','dashboard'].includes(initial) ? initial : 'apply'); });

/* Live-ish block counter for atmosphere */
setInterval(() => {
  const el = document.getElementById('blockNo');
  const current = parseInt(el.textContent.replace(/[^\d]/g, ''), 10);
  el.textContent = 'Block #' + (current + 1).toLocaleString('ko-KR');
}, 4000);
