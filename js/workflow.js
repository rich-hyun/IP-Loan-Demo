/* Unified loan evaluation; the server remains authoritative for every gate. */
globalThis.LoanWorkflow = (() => {
  let selected = null, poll = null, loading = false;
  // Report box copy and badges follow patent.html's evaluator report box.
  const REPORT_STATUS = {
    pending: { label: '접수 대기', badge: 'badge-pending', title: '평가 접수를 기다리고 있습니다', text: '신청은 저장되었습니다. 보고서 생성 서비스 접수를 기다립니다.' },
    submitting: { label: '접수 확인 중', badge: 'badge-verify', title: '평가 요청을 접수하고 있습니다', text: '제출한 특허자료를 보고서 생성 서비스에 전달합니다.' },
    queued: { label: '생성 대기', badge: 'badge-pending', title: '보고서 생성 순서를 기다리고 있습니다', text: '접수가 완료되었습니다. 준비된 작업은 접수 순서대로 처리됩니다.' },
    running: { label: '생성 중', badge: 'badge-review', title: '특허평가 보고서를 생성하고 있습니다', text: '특허와 기업자료를 분석 중입니다. 완료되면 보고서가 이 화면에 표시됩니다.' },
    awaiting_identity: { label: '기업 확인 필요', badge: 'badge-verify', title: '사업자등록번호를 확인해 주세요', text: '제출한 PDF는 저장되어 있습니다. 기업번호를 확인하면 같은 작업에서 보고서 생성을 이어갑니다.' },
    completed: { label: '검토 대기', badge: 'badge-approved', title: '평가보고서가 도착했습니다', text: '보고서와 근거자료를 확인하고 적용 가치를 확정할 수 있습니다.' },
    failed: { label: '생성 실패', badge: 'badge-rejected', title: '보고서 생성이 중단되었습니다', text: '아래 사유와 작업번호를 운영 담당자에게 전달해 주세요.' },
    submission_rejected: { label: '미접수', badge: 'badge-rejected', title: '신청은 저장되었지만 외부 접수가 완료되지 않았습니다', text: '아래 내용을 확인한 뒤 보관된 PDF로 다시 접수할 수 있습니다.' },
    submission_unknown: { label: '접수 확인 필요', badge: 'badge-verify', title: '외부 접수 여부를 확인하고 있습니다', text: '중복 접수를 방지하기 위해 자동 재접수를 중단했습니다. 공급자 작업번호로 접수를 복구할 수 있습니다.' },
  };
  const ACTIVE = ['pending', 'submitting', 'queued', 'running'];
  function badge(app) {
    const meta = app.evaluation?.confirmedAt ? { label: '평가 확정', badge: 'badge-approved' } : REPORT_STATUS[app.evaluation?.state] || REPORT_STATUS.pending;
    return `<span class="badge ${meta.badge}">${meta.label}</span>`;
  }
  const artifactUrl = (id, kind, download) => `${API_BASE}/applications/${encodeURIComponent(id)}/evaluation/artifacts/${kind}${download ? '?download=1' : ''}`;
  const states = {
    pending: '평가 접수 대기', submitting: '평가 API 접수 중', queued: '보고서 생성 대기',
    running: '자동평가·보고서 생성 중', awaiting_identity: '사업자번호 확인 필요',
    completed: '보고서 생성 완료 · 평가사 검토 대기', failed: '평가 실패',
    submission_rejected: '평가 접수 실패 · 재시도 가능', submission_unknown: '접수 여부 확인 필요 · 중복 재접수 차단',
  };
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
    return value;
  }
  async function hash(bytes) {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  }
  async function request(path, body, raw = false) {
    const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.message || '통합 업무 요청에 실패했습니다.');
    }
    return raw ? res.blob() : res.json();
  }
  async function sign(action, id, payload) {
    const ctx = await IPLoanChain.connect();
    const digest = await hash(new TextEncoder().encode(JSON.stringify(canonical(payload))));
    const challenge = await request('/workflow/challenge', { address: ctx.address, action, applicationId: id, digest });
    return { nonce: challenge.nonce, signature: await ctx.signer.signMessage(challenge.message) };
  }
  function requestId() {
    let id = sessionStorage.getItem('iploan-workflow-request');
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem('iploan-workflow-request', id); }
    return id;
  }
  async function attach(form, file) {
    form.append('workflow', 'integrated');
    form.append('request_id', requestId());
    const manifest = {};
    for (const [key, value] of form.entries()) if (typeof value === 'string') manifest[key] = value;
    manifest.fileSha256 = await hash(await file.arrayBuffer());
    form.append('auth', JSON.stringify(await sign('create', '', manifest)));
  }
  function clearDraft() { sessionStorage.removeItem('iploan-workflow-request'); }
  const formatTime = seconds => seconds ? new Date(seconds * 1000).toLocaleString('ko-KR', { hour12: false }) : '—';
  function reportPanel(app) {
    const evaluation = app.evaluation || {};
    const esc = escapeHtml;
    const meta = REPORT_STATUS[evaluation.state] || REPORT_STATUS.pending;
    const complete = evaluation.state === 'completed';
    const confirmed = Boolean(evaluation.confirmedAt);
    const kinds = evaluation.artifacts || [];
    const preview = kinds.includes('pdf') ? 'pdf' : kinds.includes('html') ? 'html' : null;
    const originalAllowed = currentRole === 'evaluator' && app.chainStatus === 'Evaluating';
    const failed = ['failed', 'submission_rejected', 'submission_unknown'].includes(evaluation.state);
    let body = `<div class="report-head"><div><h3 class="report-title">${esc(app.ipTitle)}</h3><div class="report-meta">${esc([app.company, app.bizNo && `사업자 ${app.bizNo}`].filter(Boolean).join(' · '))}</div><div class="report-meta">신청번호 ${esc(app.id)} · 신청금액 ${won(app.amount)}</div></div>${badge(app)}</div>
      <div class="report-request-meta"><span>작업번호 <b>${esc(evaluation.jobId || '발급 전')}</b></span><span>최근 확인 ${esc(formatTime(evaluation.updatedAt))}</span></div>`;
    if (!complete) {
      body += `<div class="job-state ${failed ? 'job-error' : ''}"><div class="job-state-icon" aria-hidden="true">${failed ? '!' : '◷'}</div>
        <div><h4>${meta.title}</h4><p>${meta.text}</p>${evaluation.stage && !['finished', 'queued'].includes(evaluation.stage) ? `<div class="job-stage">현재 단계: ${esc(evaluation.stage)}</div>` : ''}</div></div>
        ${evaluation.error ? `<div class="inline-message error-message">${esc(evaluation.error)}</div>` : ''}
        <div class="button-row">
          ${['pending','submission_rejected','failed'].includes(evaluation.state) && !confirmed ? `<button class="btn btn-outline btn-sm" onclick="LoanWorkflow.retry('${app.id}')">보관 파일로 평가 재시도</button>` : ''}
          ${evaluation.state === 'awaiting_identity' ? `<button class="btn btn-outline btn-sm" onclick="LoanWorkflow.identify('${app.id}')">사업자번호 확인</button>` : ''}
          ${evaluation.state === 'submission_unknown' ? `<button class="btn btn-outline btn-sm" onclick="LoanWorkflow.recover('${app.id}')">공급자 작업번호로 접수 복구</button>` : ''}
        </div>`;
    }
    body += `<div class="report-downloads">${kinds.map(kind => `<a class="btn btn-outline btn-sm" href="${esc(artifactUrl(app.id, kind, true))}">${{ pdf: 'PDF 다운로드', html: 'HTML 다운로드', quality: '근거·검증 자료', trace: '근거 추적 자료', timing: '소요시간', log: '진행 로그' }[kind] || esc(kind.toUpperCase())}</a>`).join('')}${originalAllowed ? `<button class="btn btn-outline btn-sm" type="button" onclick="LoanWorkflow.download('${app.id}')">특허 원본 확인 (지갑 서명)</button>` : ''}</div>`;
    if (complete && preview) {
      body += `<div class="report-preview-heading"><b>특허평가 보고서</b><a class="text-button" href="${esc(artifactUrl(app.id, preview))}" target="_blank" rel="noopener noreferrer">새 창에서 열기 ↗</a></div><iframe class="report-preview" src="${esc(artifactUrl(app.id, preview))}" title="${esc(app.ipTitle)} 평가보고서" ${preview === 'html' ? 'sandbox=""' : ''}></iframe>`;
    } else if (complete && !evaluation.artifacts) {
      body += '<div class="inline-message">보고서 정보를 확인하는 중입니다.</div>';
    } else if (complete) {
      body += '<div class="inline-message error-message">작업은 완료되었지만 PDF·HTML 보고서가 제공되지 않았습니다. 작업번호로 운영 담당자에게 확인해 주세요.</div>';
    }
    const value = `자동 산출 가치 ${evaluation.autoValue != null ? won(evaluation.autoValue) : '제공되지 않음'}${evaluation.valueMessage ? ` · ${esc(evaluation.valueMessage)}` : ''}`;
    if (confirmed) {
      body += `<div class="evaluation-confirmed"><b>✓ 가치평가가 확정되었습니다</b><div>적용 평가가치 ${won(evaluation.reviewValue || (app.appraisedValue > 0 ? app.appraisedValue : null))} · LTV ${app.ltv == null ? '판정 대기' : `${esc(app.ltv)}%`} · 여신심사 ${esc(app.creditCaseId || '미생성')}</div><div class="help">${esc(formatTime(evaluation.confirmedAt))}</div>${evaluation.reviewNote ? `<p>${esc(evaluation.reviewNote)}</p>` : ''}</div>`;
    } else if (complete && app.chainStatus === 'Evaluating') {
      body += `<div class="evaluation-confirm-form"><div class="form-section-heading"><span>✓</span><h4>평가 검토 및 확정</h4></div><p>${value}<br>보고서의 산정 근거와 가정을 확인한 후 적용 가치와 검토 사유를 입력하세요. 기존 v2 계약의 데모 기준(신청금액 ≤ 적용 평가가치 × 70%)을 통과한 건만 여신심사에 전달합니다.</p>
        <div class="form-grid"><div class="field"><label for="workflowValue">평가사 적용 가치 (원)<span class="req">*</span></label><input id="workflowValue" type="number" min="1" step="1" value="${evaluation.reviewValue || (evaluation.autoValue > 0 ? evaluation.autoValue : '')}"></div>
        <div class="field full"><label for="workflowNote">보고서 검토 결과·가치 적용 사유<span class="req">*</span></label><textarea id="workflowNote" rows="3" maxlength="2000">${esc(evaluation.reviewNote || '')}</textarea></div></div>
        ${evaluation.preparedHash ? '<p>확정 내용이 저장되었습니다. 같은 적용 가치·검토 사유로 확정을 재시도하거나 체인 확인·복구를 실행하세요.</p>' : ''}
        <button class="btn btn-primary" type="button" onclick="LoanWorkflow.confirm('${app.id}')">평가사 검토·온체인 확정</button></div>`;
    } else if (complete) {
      body += `<div class="inline-message">${value}</div>`;
    }
    body += `${evaluation.attempts?.length > 1 ? `<details><summary>평가 접수·재시도 이력 ${evaluation.attempts.length}건</summary><ul>${evaluation.attempts.map(attempt => `<li>${esc(attempt.attempt)}차 · ${esc(states[attempt.state] || attempt.state)} · ${esc(attempt.jobId || '작업번호 없음')} ${esc(attempt.error || '')}</li>`).join('')}</ul></details>` : ''}
      <div class="button-row"><button class="text-button" type="button" onclick="retryApplicationChain('${app.id}', true)">체인 확정 확인·복구</button></div>
      <p id="workflowMessage" role="status"></p>
      ${typeof LoanTokenCards !== 'undefined' ? LoanTokenCards.placeholder(app) : ''}`;
    document.getElementById('evalReportPanel').innerHTML = `<div class="panel-body">${body}</div>`;
    if (typeof LoanTokenCards !== 'undefined') LoanTokenCards.load(app);
  }
  function panel(app, target = 'evalReportPanel') {
    selected = { id: app.id, target };
    if (target === 'evalReportPanel') return reportPanel(app);
    const evaluation = app.evaluation || {};
    const esc = escapeHtml;
    const complete = evaluation.state === 'completed';
    const confirmed = Boolean(evaluation.confirmedAt);
    const reportKinds = evaluation.artifacts || [];
    const originalAllowed = currentRole === 'borrower' || (currentRole === 'evaluator' && app.chainStatus === 'Evaluating') ||
      (currentRole === 'lender' && ['Approved','Repaid'].includes(app.chainStatus));
    document.getElementById(target).innerHTML = `<div class="panel-body">
      <h3>${esc(app.ipTitle)} · ${esc(app.id)}</h3>
      <p>${esc(app.company)} · 신청금액 ${won(app.amount)}</p>
      <p role="status"><strong>${esc(confirmed ? '평가사 확정 완료' : (states[evaluation.state] || '평가 상태 확인 필요'))}</strong> ${esc(evaluation.stage || '')}</p>
      ${evaluation.error ? `<p class="workflow-error">${esc(evaluation.error)}</p>` : ''}
      <p>담당 평가사: ${esc(app.evaluatorWallet || '—')}</p>
      <p>자동 산출 가치: <strong>${evaluation.autoValue != null ? won(evaluation.autoValue) : '제공되지 않음 / 지갑으로 상태 조회 필요'}</strong></p>
      ${evaluation.valueSource ? `<p>금액 출처: ${esc(evaluation.valueSource)} ${esc(evaluation.valueRaw || '')}</p>` : ''}
      ${evaluation.valueMessage ? `<p>${esc(evaluation.valueMessage)}</p>` : ''}
      <p>적용 평가가치: ${won(evaluation.reviewValue || (app.appraisedValue > 0 ? app.appraisedValue : null))} · LTV ${app.ltv == null ? '판정 대기' : `${esc(app.ltv)}%`}</p>
      ${evaluation.reviewNote ? `<p>평가사 검토 결과: ${esc(evaluation.reviewNote)}</p><p>검토 지갑: ${esc(evaluation.reviewer || '—')}</p>` : ''}
      <p>기존 v2 계약의 데모 기준: 신청금액 ≤ 적용 평가가치 × 70%. 평가사 온체인 확정 후 통과 건만 여신심사에 전달합니다.</p>
      ${app.rejectReason ? `<p class="workflow-error">${esc(app.rejectReason)}</p>` : ''}
      <p>평가 작업번호: ${esc(evaluation.jobId || '상태 조회 후 표시')} · 여신심사 번호: ${esc(app.creditCaseId || '미생성')}</p>
      <div class="workflow-actions">
        <button class="btn btn-outline" onclick="LoanWorkflow.load('${app.id}')">상태 새로고침</button>
        ${originalAllowed ? `<button class="btn btn-outline" onclick="LoanWorkflow.download('${app.id}')">같은 특허 원본 확인</button>` : '<span>은행 원본 열람은 최종 승인·NFT 발급 이후 가능합니다.</span>'}
        ${['pending','submission_rejected','failed'].includes(evaluation.state) && !confirmed ? `<button class="btn btn-outline" onclick="LoanWorkflow.retry('${app.id}')">보관 파일로 평가 재시도</button>` : ''}
        ${evaluation.state === 'awaiting_identity' ? `<button class="btn btn-outline" onclick="LoanWorkflow.identify('${app.id}')">사업자번호 확인</button>` : ''}
        ${evaluation.state === 'submission_unknown' ? `<button class="btn btn-outline" onclick="LoanWorkflow.recover('${app.id}')">공급자 작업번호로 접수 복구</button>` : ''}
      </div>
      <div class="workflow-actions">${reportKinds.map(kind => `<a class="btn btn-outline" href="${esc(artifactUrl(app.id, kind))}" target="_blank" rel="noopener noreferrer">${esc(kind.toUpperCase())} 보고서·근거 확인</a>`).join('')}</div>
      ${evaluation.attempts?.length ? `<details><summary>평가 접수·재시도 이력 ${evaluation.attempts.length}건</summary><ul>${evaluation.attempts.map(attempt => `<li>${esc(attempt.attempt)}차 · ${esc(states[attempt.state] || attempt.state)} · ${esc(attempt.jobId || '작업번호 없음')} ${esc(attempt.error || '')}</li>`).join('')}</ul></details>` : ''}
      ${complete && !confirmed && app.chainStatus === 'Evaluating' ? `<div class="form-grid">
        <div class="form-group"><label for="workflowValue">평가사 적용 가치 (원)</label><input id="workflowValue" type="number" min="1" step="1" value="${evaluation.reviewValue || evaluation.autoValue || ''}"></div>
        <div class="form-group"><label for="workflowNote">보고서 검토 결과·가치 적용 사유 (필수)</label><textarea id="workflowNote" maxlength="2000">${esc(evaluation.reviewNote || '')}</textarea></div>
        <button class="btn btn-primary" onclick="LoanWorkflow.confirm('${app.id}')">평가사 검토·온체인 확정</button>
      </div>` : ''}
      ${evaluation.preparedHash && !confirmed ? '<p>확정 내용이 저장되었습니다. 같은 적용 가치·검토 사유로 확정을 재시도하거나 체인 확인·복구를 실행하세요.</p>' : ''}
      <button class="btn btn-outline" onclick="retryApplicationChain('${app.id}', true)">체인 확정 확인·복구</button>
      <p id="workflowMessage" role="status"></p>
    </div>`;
  }
  function merge(updated) {
    const app = findApp(updated.id);
    const before = JSON.stringify([app.evaluation, app.chainStatus]);
    // Chain sync returns only the public evaluation summary; keep the report fields already loaded.
    if (updated.evaluation && !updated.evaluation.artifacts && app.evaluation) updated = { ...updated, evaluation: { ...app.evaluation, ...updated.evaluation } };
    Object.assign(app, updated);
    renderDashboard(); renderListTable(); renderEvalList(); renderReviewList();
    // Re-render only on change so the report preview is not reloaded by every poll.
    if (selected?.id === app.id && before !== JSON.stringify([app.evaluation, app.chainStatus])) panel(app, selected.target);
    return app;
  }
  function message(error) {
    const el = document.getElementById('workflowMessage');
    if (el) el.textContent = error.message;
    showToast(error.message);
  }
  // The server asks the provider for progress; no wallet is needed to read status or reports.
  async function status(id) {
    const res = await fetch(`${API_BASE}/applications/${encodeURIComponent(id)}/evaluation`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || '평가 상태를 확인하지 못했습니다.');
    return merge(data);
  }
  async function load(id) {
    if (loading) return;
    loading = true;
    try {
      const updated = await status(id);
      clearInterval(poll);
      if (ACTIVE.includes(updated.evaluation.state)) {
        poll = setInterval(async () => {
          if (loading || selected?.id !== id || document.hidden) return;
          loading = true;
          try {
            const next = await status(id);
            if (!ACTIVE.includes(next.evaluation.state)) clearInterval(poll);
          } catch (error) { clearInterval(poll); message(error); }
          finally { loading = false; }
        }, 10000);
      }
    } catch (error) { message(error); }
    finally { loading = false; }
  }
  async function refresh(apps) {
    const button = document.getElementById('refreshReportsBtn');
    if (button) { button.disabled = true; button.textContent = '확인 중…'; }
    try {
      const results = await Promise.allSettled(apps.filter(a => a.workflow && (a.id === selected?.id || ACTIVE.includes(a.evaluation?.state))).map(a => status(a.id)));
      const failed = results.find(r => r.status === 'rejected');
      if (failed) message(failed.reason);
    } finally { if (button) { button.disabled = false; button.textContent = '상태 새로고침'; } }
  }
  async function mutate(id, action, extra = {}) {
    if (loading) return;
    loading = true;
    try {
      const body = { action, ...extra };
      merge(await request(`/applications/${encodeURIComponent(id)}/evaluation`, { ...body, auth: await sign(action, id, body) }));
    } catch (error) { message(error); }
    finally { loading = false; }
  }
  // Only the patent original needs a wallet signature; reports open through plain links.
  async function download(id) {
    try {
      const auth = await sign('document', id, {});
      const blob = await request(`/applications/${encodeURIComponent(id)}/evaluation/document`, { auth }, true);
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `${id}-patent.pdf`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) { message(error); }
  }
  async function confirmReview(id) {
    if (loading || chainOperationBusy) return;
    const app = findApp(id);
    const value = Number(document.getElementById('workflowValue').value);
    const note = document.getElementById('workflowNote').value.trim();
    if (!Number.isSafeInteger(value) || value <= 0 || value > 9e15 || !note) return message(new Error('양의 정수 적용 가치와 검토 사유를 입력하세요.'));
    chainOperationBusy = true;
    try {
      await IPLoanChain.connect('EVALUATOR_ROLE', app.evaluatorWallet);
      const body = { appraisedValue: value, reviewerNote: note };
      const report = await request(`/applications/${encodeURIComponent(id)}/evaluation-report`, { ...body, auth: await sign('review', id, body) });
      const updated = await IPLoanChain.evaluate(app, report);
      merge(updated);
      showToast(updated.creditCaseId ? '평가 확정·LTV 통과 · 여신심사 전달 완료' : '평가 확정 · LTV 기준 초과로 여신심사 전달 차단');
      clearInterval(poll);
    } catch (error) { message(error); }
    finally { chainOperationBusy = false; }
  }
  return { attach, clearDraft, panel, load, refresh, badge, download, confirm: confirmReview,
    retry: id => mutate(id, 'retry'),
    identify: id => { const number = prompt('사업자번호 10자리를 입력하세요.'); if (number) return mutate(id, 'identity', { business_number: number.replace(/\D/g, '') }); },
    recover: id => { const jobId = prompt('공급자에서 확인한 기존 작업번호를 입력하세요. 원본 해시와 사업자번호가 일치해야 연결되며 새 작업은 만들지 않습니다.'); if (jobId) return mutate(id, 'recover', { job_id: jobId.trim() }); },
  };
})();
