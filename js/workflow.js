/* Unified loan evaluation; the server remains authoritative for every gate. */
globalThis.LoanWorkflow = (() => {
  const sessions = new Map();
  let selected = null, poll = null, loading = false;
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
  function panel(app, target = 'evalReportPanel') {
    selected = { id: app.id, target };
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
        <button class="btn btn-outline" onclick="LoanWorkflow.load('${app.id}')">지갑으로 상태 조회·자동 갱신</button>
        ${originalAllowed ? `<button class="btn btn-outline" onclick="LoanWorkflow.download('${app.id}', 'document')">같은 특허 원본 확인</button>` : '<span>은행 원본 열람은 최종 승인·NFT 발급 이후 가능합니다.</span>'}
        ${['pending','submission_rejected','failed'].includes(evaluation.state) && !confirmed ? `<button class="btn btn-outline" onclick="LoanWorkflow.retry('${app.id}')">보관 파일로 평가 재시도</button>` : ''}
        ${evaluation.state === 'awaiting_identity' ? `<button class="btn btn-outline" onclick="LoanWorkflow.identify('${app.id}')">사업자번호 확인</button>` : ''}
        ${evaluation.state === 'submission_unknown' ? `<button class="btn btn-outline" onclick="LoanWorkflow.recover('${app.id}')">공급자 작업번호로 접수 복구</button>` : ''}
      </div>
      <div class="workflow-actions">${reportKinds.map(kind => `<button class="btn btn-outline" onclick="LoanWorkflow.download('${app.id}', '${esc(kind)}')">${esc(kind.toUpperCase())} 보고서·근거 확인</button>`).join('')}</div>
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
    Object.assign(app, updated);
    renderDashboard(); renderListTable(); renderEvalList(); renderReviewList();
    if (selected?.id === app.id) panel(app, selected.target);
    return app;
  }
  function message(error) {
    const el = document.getElementById('workflowMessage');
    if (el) el.textContent = error.message;
    showToast(error.message);
  }
  async function status(id, automatic) {
    const accounts = await ethereum.request({ method: 'eth_accounts' });
    const key = `${id}:${accounts[0]?.toLowerCase()}`;
    const body = { action: 'status' };
    const auth = automatic && sessions.has(key) ? { session: sessions.get(key) } : await sign('status', id, body);
    if (automatic && !sessions.has(key)) throw new Error('지갑이 변경되었습니다. 상태 조회 버튼으로 다시 인증하세요.');
    const updated = await request(`/applications/${encodeURIComponent(id)}/evaluation`, { ...body, auth });
    if (updated.readSession) { sessions.set(key, updated.readSession); delete updated.readSession; }
    return merge(updated);
  }
  async function load(id) {
    if (loading) return;
    loading = true;
    try {
      const updated = await status(id, false);
      clearInterval(poll);
      if (['queued', 'running', 'submitting', 'pending'].includes(updated.evaluation.state)) {
        poll = setInterval(async () => {
          if (loading || selected?.id !== id) return;
          loading = true;
          try {
            const next = await status(id, true);
            if (!['queued','running','submitting'].includes(next.evaluation.state)) clearInterval(poll);
          } catch (error) { clearInterval(poll); message(error); }
          finally { loading = false; }
        }, 10000);
      }
    } catch (error) { message(error); }
    finally { loading = false; }
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
  async function download(id, kind) {
    try {
      const doc = kind === 'document';
      const payload = doc ? {} : { kind };
      const auth = await sign(doc ? 'document' : 'artifact', id, payload);
      const blob = await request(`/applications/${encodeURIComponent(id)}/evaluation/${doc ? 'document' : `artifacts/${kind}`}`, { auth }, true);
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `${id}-${doc ? 'patent.pdf' : kind + '.' + kind}`; link.click();
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
  return { attach, clearDraft, panel, load, download, confirm: confirmReview,
    retry: id => mutate(id, 'retry'),
    identify: id => { const number = prompt('사업자번호 10자리를 입력하세요.'); if (number) return mutate(id, 'identity', { business_number: number.replace(/\D/g, '') }); },
    recover: id => { const jobId = prompt('공급자에서 확인한 기존 작업번호를 입력하세요. 원본 해시와 사업자번호가 일치해야 연결되며 새 작업은 만들지 않습니다.'); if (jobId) return mutate(id, 'recover', { job_id: jobId.trim() }); },
  };
})();
