/* 신청 → 비동기 보고서 생성 → 평가자 검토 */
const REPORT_STATUS = {
  submitting: { label: '접수 확인 중', badge: 'badge-verify', title: '평가 요청을 접수하고 있습니다', text: '제출한 특허자료를 저장하고 보고서 생성 서비스에 전달합니다.' },
  queued: { label: '생성 대기', badge: 'badge-pending', title: '보고서 생성 순서를 기다리고 있습니다', text: '접수가 완료되었습니다. 준비된 작업은 접수 순서대로 처리됩니다.' },
  running: { label: '생성 중', badge: 'badge-review', title: '특허평가 보고서를 생성하고 있습니다', text: '특허와 기업자료를 분석 중입니다. 완료되면 평가자 보고서함에 표시됩니다.' },
  awaiting_identity: { label: '기업 확인 필요', badge: 'badge-verify', title: '사업자등록번호를 확인해 주세요', text: '제출한 PDF는 저장되어 있습니다. 기업번호를 확인하면 같은 작업에서 보고서 생성을 이어갑니다.' },
  completed: { label: '검토 대기', badge: 'badge-approved', title: '평가보고서가 도착했습니다', text: '평가자가 보고서와 근거자료를 확인하고 담보가치를 확정할 수 있습니다.' },
  failed: { label: '생성 실패', badge: 'badge-rejected', title: '보고서 생성이 중단되었습니다', text: '아래 사유와 작업번호를 운영 담당자에게 전달해 주세요.' },
  submission_rejected: { label: '미접수', badge: 'badge-rejected', title: '신청은 저장되었지만 외부 접수가 완료되지 않았습니다', text: '아래 내용을 확인한 뒤 보관된 PDF로 다시 접수할 수 있습니다.' },
  submission_unknown: { label: '접수 확인 필요', badge: 'badge-verify', title: '외부 접수 여부를 확인하고 있습니다', text: '중복 접수를 방지하기 위해 자동 재접수를 중단했습니다. 신청번호와 접수 시각으로 운영 담당자에게 확인해 주세요.' },
};
const ACTIVE_REPORT_STATUSES = new Set(['submitting', 'queued', 'running', 'awaiting_identity']);
let selectedEvalId = null;
let receiptAppId = null;
let selectedPatentFile = null;
let applyBusy = false;
let refreshingReports = false;
let borrowerProfiles = [];
let requestId = makeRequestId();
let toastTimer;

function makeRequestId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'request-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}
function reportMeta(application) {
  if (application.evaluation?.confirmed_at) return { label: '평가 확정', badge: 'badge-approved' };
  return REPORT_STATUS[application.evaluation?.status] || { label: '예시 데이터', badge: 'badge-pending' };
}
function reportBadge(application) {
  const meta = reportMeta(application);
  return `<span class="badge ${meta.badge}">${meta.label}</span>`;
}
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 5000);
}
function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('ko-KR', { hour12: false });
}
function upsertApplication(application) {
  const index = APPLICATIONS.findIndex(a => a.id === application.id);
  if (index >= 0) APPLICATIONS[index] = application;
  else APPLICATIONS.unshift(application);
}
function refreshApplicationViews() {
  renderDashboard();
  renderListTable();
  renderEvalList();
  updateReviewSelectOptions();
  renderReceipt();
}

const applyForm = document.getElementById('applyForm');
const uploadBox = document.getElementById('uploadBox');
const fileInput = document.getElementById('fileInput');

function showApplyError(message) {
  const node = document.getElementById('applyError');
  node.textContent = message;
  node.hidden = !message;
}
function choosePatentFile(file) {
  if (applyBusy || receiptAppId || document.getElementById('applyFields').disabled) return;
  showApplyError('');
  if (file && (!/\.pdf$/i.test(file.name) || file.size > 50 * 1024 * 1024 || !file.size)) {
    choosePatentFile(null);
    showApplyError('비어 있지 않은 PDF 파일 1개를 선택해 주세요. 최대 크기는 50MiB입니다.');
    fileInput.value = '';
    return;
  }
  selectedPatentFile = file || null;
  document.getElementById('fileNameDisplay').textContent = file ? file.name : 'PDF를 끌어 놓거나 클릭해 선택하세요';
  document.getElementById('fileHelpText').textContent = file ? `${(file.size / 1024 / 1024).toFixed(2)}MiB · 특허 공고전문 PDF` : '공고전문 PDF 1개 · 최대 50MiB';
  document.getElementById('removeFileBtn').hidden = !file;
  uploadBox.classList.toggle('has-file', Boolean(file));
}
uploadBox.addEventListener('click', () => { if (!applyBusy && !receiptAppId && !document.getElementById('applyFields').disabled) fileInput.click(); });
uploadBox.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!applyBusy && !receiptAppId && !document.getElementById('applyFields').disabled) fileInput.click(); }
});
fileInput.addEventListener('change', () => choosePatentFile(fileInput.files[0]));
['dragenter', 'dragover'].forEach(name => uploadBox.addEventListener(name, event => {
  event.preventDefault();
  if (!applyBusy && !receiptAppId) uploadBox.classList.add('dragging');
}));
['dragleave', 'drop'].forEach(name => uploadBox.addEventListener(name, event => {
  event.preventDefault();
  uploadBox.classList.remove('dragging');
  if (name === 'drop' && !applyBusy && !receiptAppId) {
    if (event.dataTransfer.files.length !== 1) showApplyError('한 신청에 PDF 파일 1개를 첨부해 주세요.');
    else choosePatentFile(event.dataTransfer.files[0]);
  }
}));
document.getElementById('removeFileBtn').addEventListener('click', () => { fileInput.value = ''; choosePatentFile(null); });

document.getElementById('fBizNo').addEventListener('input', event => {
  const digits = event.target.value.replace(/\D/g, '').slice(0, 10);
  event.target.value = digits.length > 5 ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` : digits.length > 3 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits;
  const profile = borrowerProfiles.find(p => String(p.bizNo || '').replace(/\D/g, '') === digits);
  if (profile && !document.getElementById('fCompany').value) document.getElementById('fCompany').value = profile.company;
});
document.getElementById('fAmount').addEventListener('input', event => {
  const digits = event.target.value.replace(/\D/g, '');
  event.target.value = digits ? Number(digits).toLocaleString('ko-KR') : '';
});

applyForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (applyBusy || receiptAppId) return;
  if (!applyForm.reportValidity()) return;
  if (!selectedPatentFile) { showApplyError('평가할 특허 공고전문 PDF를 첨부해 주세요.'); uploadBox.focus(); return; }
  const amountText = document.getElementById('fAmount').value.replace(/,/g, '').trim();
  if (amountText && (!/^\d+$/.test(amountText) || !Number.isSafeInteger(Number(amountText)) || Number(amountText) <= 0)) {
    showApplyError('대출 희망 금액은 0보다 큰 정수로 입력해 주세요.'); return;
  }
  const body = new FormData();
  body.append('request_id', requestId);
  body.append('patent_pdf', selectedPatentFile, selectedPatentFile.name);
  [['bizNo','fBizNo'], ['company','fCompany'], ['ipTitle','fIpTitle'], ['ipRegNo','fIpNo'], ['ceo','fCeo'], ['contact','fPhone']].forEach(([key,id]) => body.append(key, document.getElementById(id).value.trim()));
  body.append('amount', amountText || '0');
  applyBusy = true;
  showApplyError('');
  document.getElementById('applyFields').disabled = true;
  document.getElementById('applyResetBtn').disabled = true;
  const button = document.getElementById('applySubmitBtn');
  button.disabled = true;
  button.textContent = '특허자료 업로드 및 접수 중…';
  setApplySteps(2);
  try {
    const created = await apiCreateApplication(body);
    upsertApplication(created);
    receiptAppId = created.id;
    button.textContent = '신청 저장 완료';
    hideConnNotice();
    refreshApplicationViews();
    document.getElementById('applyReceipt').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    const uncertain = !error.status || error.status >= 500;
    showApplyError(uncertain ? '접수 응답을 확인하지 못했습니다. “같은 신청 확인”을 누르면 중복 생성 없이 저장된 신청을 확인합니다. ' + error.message : error.message);
    button.textContent = uncertain ? '같은 신청 확인' : '입력 확인 후 다시 신청';
    button.disabled = false;
    document.getElementById('applyFields').disabled = uncertain;
    setApplySteps(uncertain ? 2 : 1);
  } finally {
    applyBusy = false;
    document.getElementById('applyResetBtn').disabled = false;
  }
});
applyForm.addEventListener('reset', event => {
  if (applyBusy) { event.preventDefault(); return; }
  receiptAppId = null;
  requestId = makeRequestId();
  document.getElementById('applyFields').disabled = false;
  document.getElementById('applyReceipt').hidden = true;
  choosePatentFile(null);
  fileInput.value = '';
  showApplyError('');
  const button = document.getElementById('applySubmitBtn');
  button.disabled = false;
  button.textContent = '보고서 생성 신청 →';
  setApplySteps(1);
});
function setApplySteps(current, complete = false) {
  document.querySelectorAll('#applySteps .step').forEach((step, index) => {
    step.classList.toggle('done', index + 1 < current || complete);
    step.classList.toggle('current', index + 1 === current && !complete);
  });
}

function statusContent(application) {
  const job = application.evaluation;
  const meta = REPORT_STATUS[job.status] || REPORT_STATUS.submitting;
  let html = `<div class="job-state ${['failed','submission_rejected'].includes(job.status) ? 'job-error' : ''}">
    <div class="job-state-icon" aria-hidden="true">${job.status === 'completed' ? '✓' : ['failed','submission_rejected','submission_unknown'].includes(job.status) ? '!' : '◷'}</div>
    <div><h4>${meta.title}</h4><p>${meta.text}</p>${job.stage && !['finished', ''].includes(job.stage) ? `<div class="job-stage">현재 단계: ${escapeHtml(job.stage)}</div>` : ''}</div></div>`;
  if (job.error) html += `<div class="inline-message error-message">${escapeHtml(job.error)}</div>`;
  if (job.detail) html += `<details class="error-detail"><summary>오류 상세 보기</summary><pre>${escapeHtml(typeof job.detail === 'string' ? job.detail : JSON.stringify(job.detail, null, 2))}</pre></details>`;
  if (job.read_error) html += `<div class="inline-message">${escapeHtml(job.read_error)} 다음 조회에서 다시 확인합니다.</div>`;
  if (job.status === 'awaiting_identity' && !globalThis.IPLOAN_LEGACY_HISTORY_ONLY) html += `<form class="identity-form" data-app-id="${escapeHtml(application.id)}">
    <div class="field"><label>기업 사업자등록번호<input name="business_number" value="${escapeHtml(application.bizNo || '')}" placeholder="000-00-00000" inputmode="numeric" pattern="[0-9]{10}|[0-9]{3}-[0-9]{2}-[0-9]{5}" required></label></div>
    <button class="btn btn-primary btn-sm" type="submit">번호 확인하고 이어서 생성</button><div class="identity-error error-message" role="alert" hidden></div></form>`;
  if (job.identity_message && job.status === 'awaiting_identity') html += `<p class="help">${escapeHtml(job.identity_message)}</p>`;
  if (job.status === 'submission_rejected' && !globalThis.IPLOAN_LEGACY_HISTORY_ONLY) html += `<div class="button-row"><button class="btn btn-outline btn-sm" type="button" data-retry-app="${escapeHtml(application.id)}">보관된 PDF로 다시 접수</button>${job.retry_after ? `<span class="help">${job.retry_after}초 대기 후 재접수할 수 있습니다.</span>` : ''}</div>`;
  return html;
}
function renderReceipt() {
  if (!receiptAppId) return;
  const application = findApp(receiptAppId);
  if (!application?.evaluation) return;
  const job = application.evaluation;
  setApplySteps(job.status === 'completed' ? 4 : ['queued','running'].includes(job.status) ? 3 : 2, Boolean(job.confirmed_at));
  const receipt = document.getElementById('applyReceipt');
  if (receipt.contains(document.activeElement) && receipt.dataset.status === job.status && document.activeElement.closest('.identity-form')) return;
  receipt.dataset.status = job.status;
  receipt.hidden = false;
  receipt.innerHTML = `<div class="receipt-heading"><h3>저장된 신청</h3>${reportBadge(application)}</div>
    <div class="receipt-meta"><span>신청번호 <b>${escapeHtml(application.id)}</b></span><span>접수 시각 ${escapeHtml(formatDate(job.submitted_at))}</span></div>
    ${statusContent(application)}
    <button class="btn btn-outline btn-sm" type="button" data-open-evaluation="${escapeHtml(application.id)}">평가자 보고서함에서 확인 →</button>`;
}

function evalQueue() {
  const includeConfirmed = document.getElementById('showEvaluated').checked;
  return APPLICATIONS.filter(a => includeConfirmed ? a.evaluation || !a.appraisedValue : !a.appraisedValue)
    .sort((a, b) => Number(Boolean(b.evaluation)) - Number(Boolean(a.evaluation)) || String(b.evaluation?.submitted_at || b.appliedDate).localeCompare(String(a.evaluation?.submitted_at || a.appliedDate)));
}
function renderDashboardReports() {
  const records = APPLICATIONS.filter(a => a.evaluation && !a.evaluation.confirmed_at);
  const container = document.getElementById('dashboardReports');
  container.hidden = !records.length;
  const ready = records.filter(a => a.evaluation.status === 'completed').length;
  const active = records.filter(a => ACTIVE_REPORT_STATUSES.has(a.evaluation.status)).length;
  const issues = records.length - ready - active;
  container.innerHTML = `<div><b>특허평가 보고서</b><span>검토 대기 <strong>${ready}</strong>건</span><span>접수·생성 중 <strong>${active}</strong>건</span>${issues ? `<span>확인 필요 <strong>${issues}</strong>건</span>` : ''}</div><button class="text-button" type="button" onclick="goView('evaluate')">보고서함 열기 →</button>`;
}
function renderEvalList() {
  const queue = evalQueue();
  document.getElementById('evalListCount').textContent = `${queue.length}건`;
  const ready = APPLICATIONS.filter(a => a.evaluation?.status === 'completed' && !a.evaluation.confirmed_at).length;
  document.getElementById('evalQueueSummary').textContent = `검토를 기다리는 보고서 ${ready}건 · 생성 중인 작업은 10초 간격으로 확인합니다.`;
  document.getElementById('evalListItems').innerHTML = queue.map(application => `<button class="eval-item ${selectedEvalId === application.id ? 'active' : ''}" type="button" data-open-evaluation="${escapeHtml(application.id)}">
    <span class="eval-item-top"><span class="eval-item-company">${escapeHtml(application.company)}</span>${reportBadge(application)}</span>
    <span class="eval-item-sub">${escapeHtml(application.ipTitle)}</span><span class="eval-item-id">${escapeHtml(application.id)} · ${escapeHtml(application.bizNo || '번호 미입력')}</span></button>`).join('') || '<div class="empty-hint">평가 대기 중인 신청이 없습니다.<br><button class="text-button" type="button" onclick="goView(\'apply\')">특허평가 신청하기 →</button></div>';
}
function openEvaluation(id) {
  const application = findApp(id);
  if (!application) return;
  if (application.appraisedValue) document.getElementById('showEvaluated').checked = true;
  selectedEvalId = id;
  evalInitDone = true;
  goView('evaluate');
  renderEvalList();
  selectEvalItem(id);
}
function artifactUrl(application, kind, download = false) {
  return `${API_BASE}/applications/${encodeURIComponent(application.id)}/evaluation/artifacts/${kind}${download ? '?download=1' : ''}`;
}
function selectEvalItem(id) {
  const application = findApp(id);
  if (!application) return;
  selectedEvalId = id;
  document.querySelectorAll('.eval-item').forEach(node => node.classList.toggle('active', node.dataset.openEvaluation === id));
  const panel = document.getElementById('evalReportPanel');
  const job = application.evaluation;
  const company = String(application.company || '').trim();
  const bizNo = String(application.bizNo || '').trim();
  const companyNumber = company.match(/^(?:사업자\s*)?(\d{3}-?\d{2}-?\d{5})$/)?.[1];
  const sameBusiness = bizNo && companyNumber?.replace(/\D/g, '') === bizNo.replace(/\D/g, '');
  const companyMeta = sameBusiness || !company
    ? (bizNo ? `사업자 ${bizNo}` : '기업 정보 미입력')
    : [company, bizNo].filter(Boolean).join(' · ');
  const heading = `<div class="report-head"><div><h3 class="report-title">${escapeHtml(application.ipTitle)}</h3><div class="report-meta">${escapeHtml(companyMeta)}</div><div class="report-meta">신청번호 ${escapeHtml(application.id)}</div></div>${reportBadge(application)}</div>`;
  if (!job) { renderLegacyReport(application, heading); return; }
  let body = `${heading}${globalThis.IPLOAN_LEGACY_HISTORY_ONLY ? '<p class="inline-message">기존 이력 조회 전용입니다. 새 신청과 확정은 대출·평가 통합 화면에서 진행하세요.</p>' : ''}<div class="report-request-meta"><span>작업번호 <b>${escapeHtml(job.job_id || '발급 전')}</b></span><span>최근 확인 ${escapeHtml(formatDate(job.updated_at))}</span></div>`;
  if (job.status !== 'completed') {
    body += statusContent(application);
  } else {
    const kind = job.artifacts.pdf ? 'pdf' : job.artifacts.html ? 'html' : null;
    body += `<div class="report-downloads">${['pdf','html','quality','trace','timing','log'].filter(k => job.artifacts[k]).map(k => `<button class="btn btn-outline btn-sm" type="button" data-artifact="${k}" data-app-id="${escapeHtml(id)}">${{pdf:'PDF 다운로드',html:'HTML 다운로드',quality:'근거·검증 자료',trace:'근거 추적 자료',timing:'소요시간',log:'진행 로그'}[k]}</button>`).join('')}</div>`;
    if (kind) {
      body += `<div class="report-preview-heading"><b>특허평가 보고서</b><a class="text-button" href="${escapeHtml(artifactUrl(application, kind))}" target="_blank" rel="noopener noreferrer">새 창에서 열기 ↗</a></div><iframe class="report-preview" src="${escapeHtml(artifactUrl(application, kind))}" title="${escapeHtml(application.ipTitle)} 평가보고서" ${kind === 'html' ? 'sandbox=""' : ''}></iframe>`;
      if (job.confirmed_at) {
        body += `<div class="evaluation-confirmed"><b>✓ 가치평가가 확정되었습니다</b><div>확정 담보가치 ${won(application.appraisedValue)} · 신용평가 ${application.creditScore}점</div><div class="help">${escapeHtml(formatDate(job.confirmed_at))}</div>${job.reviewer_note ? `<p>${escapeHtml(job.reviewer_note)}</p>` : ''}${application.amount && !globalThis.IPLOAN_LEGACY_HISTORY_ONLY ? `<button type="button" class="btn btn-outline btn-sm" data-review-app="${escapeHtml(id)}">대출 심사로 이동 →</button>` : '<p class="help">대출 희망 금액을 입력하지 않은 평가 신청입니다.</p>'}</div>`;
      } else if (!globalThis.IPLOAN_LEGACY_HISTORY_ONLY) {
        body += `<form id="evaluationConfirmForm" data-app-id="${escapeHtml(id)}" class="evaluation-confirm-form"><div class="form-section-heading"><span>✓</span><h4>평가 검토 및 확정</h4></div><p>보고서의 산정 근거와 가정을 확인한 후 최종 담보가치와 신용평가 점수를 입력하세요.</p><div class="form-grid"><div class="field"><label for="confirmedValue">확정 담보가치 (원)<span class="req">*</span></label><input id="confirmedValue" name="appraisedValue" type="text" inputmode="numeric" placeholder="예: 120,000,000" required></div><div class="field"><label for="confirmedCredit">신용평가 점수<span class="req">*</span></label><input id="confirmedCredit" name="creditScore" type="number" min="0" max="100" step="1" placeholder="0~100" required></div><div class="field full"><label for="reviewerNote">평가 검토 의견 <span class="optional">선택</span></label><textarea id="reviewerNote" name="reviewerNote" rows="3" maxlength="2000" placeholder="확인한 근거와 보완할 내용을 기록하세요."></textarea></div></div><div class="confirm-error inline-message error-message" role="alert" hidden></div><button class="btn btn-primary" type="submit">${application.amount ? '가치평가 확정 및 대출 심사 전달' : '가치평가 확정'}</button></form>`;
      }
    } else body += '<div class="inline-message error-message">작업은 완료되었지만 PDF·HTML 보고서가 제공되지 않았습니다. 작업번호로 운영 담당자에게 확인해 주세요.</div>';
  }
  panel.innerHTML = `<div class="panel-body">${body}</div>`;
}

function renderLegacyReport(application, heading) {
  const report = STATIC_EVAL_REPORTS[application.id];
  document.getElementById('evalReportPanel').innerHTML = `<div class="panel-body">${heading}<div class="inline-message">기존 시연용 신청입니다. 실제 API 보고서는 새 특허평가 신청에서 생성합니다.</div>${report ? `<div class="report-grid"><div class="report-stat"><div class="report-stat-label">예시 담보가치</div><div class="report-stat-value">${won(report.appraisedValue)}</div></div></div>${[['IP 정보 요약',report.summary],['유사 IP 비교',report.similar],['시장성 분석',report.market],['가치 산정 근거',report.basis]].map(([title,text]) => `<div class="report-section"><h4>${title}</h4><p>${escapeHtml(text)}</p></div>`).join('')}<button class="btn btn-outline" type="button" data-confirm-demo="${escapeHtml(application.id)}">예시 가치평가 확정</button>` : '<div class="empty-hint">이 신청에 연결된 평가보고서가 없습니다.</div>'}</div>`;
  if (globalThis.IPLOAN_LEGACY_HISTORY_ONLY) document.querySelectorAll('[data-confirm-demo]').forEach(button => button.remove());
}

async function refreshReports(manual = false) {
  if (refreshingReports || (!manual && document.hidden)) return;
  refreshingReports = true;
  const button = document.getElementById('refreshReportsBtn');
  if (manual) { button.disabled = true; button.textContent = '확인 중…'; }
  const viewKey = a => a?.evaluation ? JSON.stringify([a.evaluation.status, a.evaluation.stage, a.evaluation.error, a.evaluation.read_error, a.evaluation.artifacts, a.evaluation.confirmed_at]) : '';
  const oldSelected = viewKey(findApp(selectedEvalId));
  try {
    APPLICATIONS = await apiFetchApplications();
    const active = APPLICATIONS.filter(a => ACTIVE_REPORT_STATUSES.has(a.evaluation?.status));
    const results = await Promise.allSettled(active.map(a => apiRequest(`/applications/${encodeURIComponent(a.id)}/evaluation`)));
    let failures = 0;
    results.forEach(result => { if (result.status === 'fulfilled') upsertApplication(result.value); else failures += 1; });
    refreshApplicationViews();
    if (selectedEvalId && oldSelected !== viewKey(findApp(selectedEvalId))) selectEvalItem(selectedEvalId);
    if (document.querySelector('#view-evaluate.active') && !evalQueue().some(a => a.id === selectedEvalId)) {
      const first = evalQueue()[0];
      if (first) selectEvalItem(first.id);
    }
    if (manual) showToast(failures ? '일부 작업의 상태를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.' : '보고서 상태를 확인했습니다.');
    if (!failures) hideConnNotice();
  } catch (error) {
    if (manual) showToast(error.message);
    showConnNotice();
  } finally {
    refreshingReports = false;
    if (manual) { button.disabled = false; button.textContent = '상태 새로고침'; }
  }
}

document.addEventListener('click', async event => {
  const open = event.target.closest('[data-open-evaluation]');
  if (open) { openEvaluation(open.dataset.openEvaluation); return; }
  const review = event.target.closest('[data-review-app]');
  if (review) { goView('review'); loadReviewCase(review.dataset.reviewApp); return; }
  const retry = event.target.closest('[data-retry-app]');
  if (retry) {
    retry.disabled = true;
    try {
      const application = await apiRequest(`/applications/${encodeURIComponent(retry.dataset.retryApp)}/evaluation`, { method: 'POST' });
      upsertApplication(application); refreshApplicationViews();
      if (selectedEvalId === application.id) selectEvalItem(application.id);
    } catch (error) { showToast(error.message); retry.disabled = false; }
    return;
  }
  const download = event.target.closest('[data-artifact]');
  if (download) {
    const application = findApp(download.dataset.appId);
    const kind = download.dataset.artifact;
    download.disabled = true;
    try {
      const response = await fetch(artifactUrl(application, kind, true));
      if (!response.ok) { const error = await response.json(); throw new Error(error.error || '보고서를 내려받지 못했습니다.'); }
      const blobUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = `${application.id}-${kind}.${{quality:'json', timing:'json', trace:'md', log:'txt'}[kind] || kind}`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
    } catch (error) { showToast(error.message); }
    finally { download.disabled = false; }
    return;
  }
  const demo = event.target.closest('[data-confirm-demo]');
  if (demo) {
    const application = findApp(demo.dataset.confirmDemo);
    const value = STATIC_EVAL_REPORTS[application.id].appraisedValue;
    demo.disabled = true;
    try {
      const updated = await apiPatchApplication(application.id, { appraisedValue: value, ltv: Math.round(application.amount / value * 100), creditScore: 75, status: 'review' });
      upsertApplication(updated); refreshApplicationViews();
      const next = evalQueue()[0];
      if (next) selectEvalItem(next.id); else document.getElementById('evalReportPanel').innerHTML = '<div class="empty-hint">평가 대기 중인 신청이 없습니다.</div>';
      showToast('시연용 가치평가가 확정되었습니다.');
    } catch (error) { showToast(error.message); demo.disabled = false; }
  }
});

document.addEventListener('submit', async event => {
  const form = event.target;
  if (!form.matches('.identity-form, #evaluationConfirmForm')) return;
  event.preventDefault();
  const id = form.dataset.appId;
  const button = form.querySelector('button[type="submit"]');
  const errorNode = form.querySelector('.identity-error, .confirm-error');
  errorNode.hidden = true;
  const data = new FormData(form);
  const identity = form.matches('.identity-form');
  let payload;
  if (identity) payload = { business_number: data.get('business_number') };
  else {
    const value = String(data.get('appraisedValue')).replace(/,/g, '').trim();
    const credit = String(data.get('creditScore')).trim();
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0 || !/^\d+$/.test(credit) || Number(credit) > 100) {
      errorNode.textContent = '담보가치는 0보다 큰 정수, 신용평가 점수는 0~100의 정수로 입력해 주세요.'; errorNode.hidden = false; return;
    }
    payload = { appraisedValue: Number(value), creditScore: Number(credit), reviewerNote: data.get('reviewerNote') };
  }
  button.disabled = true;
  try {
    const application = await apiRequest(`/applications/${encodeURIComponent(id)}/evaluation/${identity ? 'identity' : 'confirm'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    upsertApplication(application);
    if (!identity) document.getElementById('showEvaluated').checked = true;
    refreshApplicationViews();
    if (selectedEvalId === id) selectEvalItem(id);
    showToast(identity ? '같은 작업에서 보고서 생성을 이어갑니다.' : '가치평가가 확정되었습니다.');
  } catch (error) { errorNode.textContent = error.message; errorNode.hidden = false; button.disabled = false; }
});
document.getElementById('showEvaluated').addEventListener('change', () => {
  renderEvalList();
  if (!evalQueue().some(a => a.id === selectedEvalId)) {
    const first = evalQueue()[0];
    if (first) selectEvalItem(first.id);
    else document.getElementById('evalReportPanel').innerHTML = '<div class="empty-hint">평가 대기 중인 신청이 없습니다.</div>';
  }
});
document.getElementById('refreshReportsBtn').addEventListener('click', () => refreshReports(true));
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshReports(); });
setInterval(() => refreshReports(), 10000);
