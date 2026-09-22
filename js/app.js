/* ==========================================================================
   LLM 기반 기술평가 자동대출 시스템 — 프로토타입 로직
   전체 데이터는 데모용 가상의 값입니다. 실제 은행/기업 데이터가 아닙니다.
   ========================================================================== */

/* ---------------- Mock data ---------------- */
const STATUS_META = {
  pending:    { label: '대기',     badge: 'badge-pending'  },
  doc_verify: { label: '서류검증', badge: 'badge-verify'   },
  evaluating: { label: '평가중',   badge: 'badge-review'   },
  review:     { label: '심사중',   badge: 'badge-review'   },
  approved:   { label: '승인',     badge: 'badge-approved' },
  rejected:   { label: '거절',     badge: 'badge-rejected' },
};

const APPLICATIONS = [
  { id:'LN-2026-0088', company:'에너지테크(주)',     bizNo:'220-87-30984', ipType:'특허권',     ipTitle:'고효율 태양광 인버터',           amount:150000000, status:'approved',   hash:'0x1fa726…c0e94b', appliedDate:'2026-09-08', appraisedValue:214000000, ltv:70,  creditScore:81, rate:3.9 },
  { id:'LN-2026-0090', company:'(주)헬스케어넷',     bizNo:'308-81-19204', ipType:'특허권',     ipTitle:'원격 재활 모니터링 시스템',       amount:70000000,  status:'rejected',   hash:'0x5c98a4…e7213f', appliedDate:'2026-09-09', appraisedValue:58000000,  ltv:121, creditScore:66,
    rejectReason:'산정 담보가치(58,000,000원) 대비 신청금액 비율(LTV 121%)이 자동심사 기준(70% 이하)을 초과하여 자동 거절 처리되었습니다.' },
  { id:'LN-2026-0091', company:'(주)그린파머스',     bizNo:'208-86-41029', ipType:'특허권',     ipTitle:'스마트 관수 제어 시스템',         amount:80000000,  status:'approved',   hash:'0x8c2f71…a93d0e', appliedDate:'2026-09-10', appraisedValue:118000000, ltv:68,  creditScore:78, rate:4.1 },
  { id:'LN-2026-0094', company:'테크비전(주)',       bizNo:'134-87-22567', ipType:'특허권',     ipTitle:'실시간 객체 추적 알고리즘',       amount:120000000, status:'review',     hash:'0x2af90c…771ac4', appliedDate:'2026-09-12', appraisedValue:171000000, ltv:70,  creditScore:74 },
  { id:'LN-2026-0097', company:'(주)바이오크래프트', bizNo:'301-88-10945', ipType:'특허권',     ipTitle:'휴대용 혈당측정 센서',           amount:95000000,  status:'evaluating', hash:'0x9d13e0…4bf27a', appliedDate:'2026-09-14' },
  { id:'LN-2026-0102', company:'스마트팜솔루션(주)', bizNo:'215-81-77320', ipType:'상표권',     ipTitle:'그린팜 GreenFarm®',              amount:40000000,  status:'doc_verify', hash:'0x4e7ac2…f10d93', appliedDate:'2026-09-16' },
  { id:'LN-2026-0103', company:'(주)로보틱스랩',     bizNo:'129-86-53012', ipType:'실용신안권', ipTitle:'협동로봇 안전 커버 구조',         amount:65000000,  status:'pending',    hash:'0x6b40d1…8ce572', appliedDate:'2026-09-17' },
  { id:'LN-2026-0106', company:'퓨처모빌리티(주)',   bizNo:'412-88-60371', ipType:'특허권',     ipTitle:'배터리 열관리 모듈',             amount:110000000, status:'review',     hash:'0x33d0f6…9a1c58', appliedDate:'2026-09-19', appraisedValue:143000000, ltv:77,  creditScore:69 },
];

const EVAL_REPORTS = {
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

/* ---------------- Helpers ---------------- */
function won(n) { return n.toLocaleString('ko-KR') + '원'; }
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

/* ---------------- Navigation ---------------- */
const VIEW_META = {
  dashboard: { title:'대시보드',        sub:'LLM·블록체인 기반 IP담보 자동대출 서비스 현황' },
  list:      { title:'대출 신청 리스트', sub:'전체 대출 신청 건의 심사 진행 상태를 확인합니다' },
  apply:     { title:'대출 신청',        sub:'지식재산권을 담보로 등록하고 대출을 신청합니다' },
  evaluate:  { title:'IP 가치평가',      sub:'LLM이 자동 생성한 IP 가치평가보고서를 검토·확정합니다' },
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

  if (name === 'evaluate' && !evalInitDone) { selectEvalItem(Object.keys(EVAL_REPORTS)[0]); evalInitDone = true; }
  if (name === 'review' && !reviewInitDone) { loadReviewCase('LN-2026-0094'); reviewInitDone = true; }
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => goView(btn.dataset.view));
});

/* ---------------- Dashboard ---------------- */
function renderDashboard() {
  const counts = {};
  Object.keys(STATUS_META).forEach(k => counts[k] = 0);
  APPLICATIONS.forEach(a => counts[a.status]++);

  const order = ['pending','doc_verify','evaluating','review','approved','rejected'];
  document.getElementById('statusRow').innerHTML = order.map(k => `
    <div class="status-pill">
      <div class="status-pill-count">${counts[k]}</div>
      <div class="status-pill-label">${STATUS_META[k].label}</div>
    </div>`).join('');

  const recent = [...APPLICATIONS].sort((a,b) => b.appliedDate.localeCompare(a.appliedDate)).slice(0,4);
  document.querySelector('#miniTable tbody').innerHTML = recent.map(a => `
    <tr onclick="goView('list')">
      <td class="cell-company">${a.company}</td>
      <td>${a.ipTitle}</td>
      <td class="cell-amount">${won(a.amount)}</td>
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
  const rows = APPLICATIONS.filter(a => {
    const matchesStatus = activeFilter === 'all' || a.status === activeFilter;
    const matchesTerm = !term || a.company.toLowerCase().includes(term) || a.id.toLowerCase().includes(term);
    return matchesStatus && matchesTerm;
  });

  document.getElementById('listTableBody').innerHTML = rows.map(a => `
    <tr data-id="${a.id}">
      <td class="cell-hash">${a.id}</td>
      <td class="cell-company">${a.company}<div class="cell-sub">${a.bizNo}</div></td>
      <td>${a.ipTitle}<div class="cell-sub">${a.ipType}</div></td>
      <td class="cell-amount">${won(a.amount)}</td>
      <td>${statusBadge(a.status)}</td>
      <td class="cell-hash">${a.hash}</td>
      <td>${a.appliedDate}</td>
      <td class="row-arrow">›</td>
    </tr>`).join('');

  document.querySelectorAll('#listTableBody tr').forEach(tr => {
    tr.addEventListener('click', () => {
      goView('review');
      document.getElementById('reviewCaseSelect').value = tr.dataset.id;
      loadReviewCase(tr.dataset.id);
      reviewInitDone = true;
    });
  });
}

document.getElementById('listSearch').addEventListener('input', renderListTable);

/* ---------------- Apply form ---------------- */
const applyForm = document.getElementById('applyForm');
applyForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = document.getElementById('applySubmitBtn');
  btn.disabled = true;
  btn.textContent = '처리 중…';

  const steps = document.querySelectorAll('#applySteps .step');
  steps[0].classList.add('done'); steps[0].classList.remove('current');
  steps[1].classList.add('current');

  setTimeout(() => { steps[1].classList.add('done'); steps[1].classList.remove('current'); steps[2].classList.add('current'); }, 500);
  setTimeout(() => { steps[2].classList.add('done'); steps[2].classList.remove('current'); steps[3].classList.add('current'); }, 1200);
  setTimeout(() => {
    steps[3].classList.add('done'); steps[3].classList.remove('current');

    const newId = 'LN-2026-01' + Math.floor(10 + Math.random()*89);
    document.getElementById('genAppId').textContent = newId;
    document.getElementById('genHash').textContent = '0x' + randHex(8) + '…' + randHex(6);
    document.getElementById('genBlock').textContent = '#' + (482912 + Math.floor(Math.random()*20));
    document.getElementById('genTime').textContent = '2026-09-22 ' +
      String(14 + Math.floor(Math.random()*3)).padStart(2,'0') + ':' +
      String(Math.floor(Math.random()*60)).padStart(2,'0') + ':' +
      String(Math.floor(Math.random()*60)).padStart(2,'0');

    document.getElementById('applyHashBlock').classList.add('show');
    btn.textContent = '제출 완료';
  }, 1900);
});

/* ---------------- Evaluate view ---------------- */
function renderEvalList() {
  document.getElementById('evalListItems').innerHTML = Object.keys(EVAL_REPORTS).map(id => {
    const app = findApp(id);
    return `
    <div class="eval-item" data-id="${id}">
      <div class="eval-item-top">
        <span class="eval-item-company">${app.company}</span>
        ${statusBadge(app.status)}
      </div>
      <div class="eval-item-sub">${app.ipTitle} · ${app.ipType}</div>
    </div>`;
  }).join('');

  document.querySelectorAll('.eval-item').forEach(el => {
    el.addEventListener('click', () => selectEvalItem(el.dataset.id));
  });
}

function selectEvalItem(id) {
  const app = findApp(id);
  const r = EVAL_REPORTS[id];

  document.querySelectorAll('.eval-item').forEach(el => el.classList.toggle('active', el.dataset.id === id));

  document.getElementById('evalReportPanel').innerHTML = `
    <div class="panel-body">
      <div class="report-head">
        <div>
          <div class="report-title">${app.ipTitle}</div>
          <div class="report-meta">${app.company} · ${app.ipType} · 신청번호 ${app.id}</div>
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
        <button class="btn btn-primary" onclick="confirmEval('${id}')">가치평가 확정</button>
        <button class="btn btn-outline">재산정 요청</button>
      </div>
      <div id="evalConfirmMsg" style="display:none; margin-top:12px; font-size:12.5px; color:var(--teal); font-weight:600;">✓ 평가가 확정되어 대출 심사 단계로 전달되었습니다.</div>
    </div>`;
}

function confirmEval(id) {
  document.getElementById('evalConfirmMsg').style.display = 'block';
}

/* ---------------- Review view ---------------- */
function renderReviewSelect() {
  const sel = document.getElementById('reviewCaseSelect');
  sel.innerHTML = APPLICATIONS.map(a => `<option value="${a.id}">${a.id} · ${a.company} · ${won(a.amount)}</option>`).join('');
  sel.addEventListener('change', () => loadReviewCase(sel.value));
}

function loadReviewCase(id) {
  const app = findApp(id);
  document.getElementById('reviewCaseSelect').value = id;
  const body = document.getElementById('reviewBody');

  if (!app.appraisedValue) {
    body.innerHTML = `
      <div class="panel">
        <div class="empty-hint">
          <p style="margin-bottom:14px;">${app.company}의 <b>${app.ipTitle}</b> 건은 아직 IP 가치평가가 완료되지 않아<br>스마트컨트랙트 자동심사를 실행할 수 없습니다.</p>
          <button class="btn btn-outline" onclick="goView('evaluate')">IP 가치평가로 이동</button>
        </div>
      </div>`;
    return;
  }

  const ltvOk = app.ltv <= 70;
  const creditOk = app.creditScore >= 60;
  const alreadyDecided = app.status === 'approved' || app.status === 'rejected';
  const approvedAmount = Math.min(app.amount, Math.round(app.appraisedValue * 0.7 / 100000) * 100000);

  body.innerHTML = `
    <div class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><h3>${app.company} · ${app.ipTitle}</h3><span class="hint">${app.id}</span></div>
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
              <div class="check-title">서류 해시 무결성 검증</div>
              <div class="check-desc">발급기관 원본 해시와 등록 서류 해시 대조</div>
            </div>
            <div class="check-status">일치</div>
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
          : `<button class="btn btn-primary btn-sm" onclick="finalizeDecision(this,'승인')">최종 승인 확정</button>
             <button class="btn btn-outline btn-sm" onclick="finalizeDecision(this,'보류')">보류하고 재검토</button>`}
      </div>`;
  } else {
    const reason = app.rejectReason || '스마트컨트랙트 자동심사 기준(LTV 70% 이하)을 충족하지 못해 자동 거절 처리되었습니다.';
    banner.innerHTML = `
      <div class="decision-head">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="m9.5 9.5 5 5m0-5-5 5"></path></svg>
        <span class="decision-title">자동심사 결과 — 거절</span>
      </div>
      <div class="decision-desc">${reason}</div>
      <div class="decision-actions">
        ${alreadyDecided
          ? `<span style="font-size:12.5px; color:var(--ink-soft);">거절 처리 완료 건입니다</span>`
          : `<button class="btn btn-outline btn-sm" onclick="finalizeDecision(this,'거절 확정')">거절 확정 통지</button>
             <button class="btn btn-danger-outline btn-sm" onclick="finalizeDecision(this,'재심사 요청')">재심사 요청</button>`}
      </div>`;
  }
}

function finalizeDecision(btn, label) {
  const area = btn.closest('.decision-actions');
  area.innerHTML = `<span style="font-size:12.5px; color:var(--ink-soft);">✓ ${label} 처리되었습니다 · 2026-09-22 처리</span>`;
}

/* ---------------- Init ---------------- */
renderDashboard();
renderFilterChips();
renderListTable();
renderEvalList();
renderReviewSelect();

/* Live-ish block counter for atmosphere */
setInterval(() => {
  const el = document.getElementById('blockNo');
  const current = parseInt(el.textContent.replace(/[^\d]/g, ''), 10);
  el.textContent = 'Block #' + (current + 1).toLocaleString('ko-KR');
}, 4000);
