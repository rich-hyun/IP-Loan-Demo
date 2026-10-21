import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { network } from 'hardhat';
import { BrowserProvider, ContractFactory } from 'ethers';
import { compile } from '../scripts/compile.mjs';

test('unified workflow: real EVM + signed API + fixture provider; LTV, retry, duplicate and role gates', { timeout: 120000 }, async t => {
  const connection = await network.connect('localTest');
  const provider = new BrowserProvider(connection.provider); provider.pollingInterval = 10;
  t.after(async () => { provider.destroy(); await connection.close(); });
  const [admin, borrower, evaluator, bank, outsider] = await Promise.all([0,1,2,3,4].map(i => provider.getSigner(i)));
  const artifacts = compile();
  const manager = await new ContractFactory(artifacts.IPLoanManager.abi, artifacts.IPLoanManager.bytecode, admin).deploy(admin.address, evaluator.address, bank.address);
  await manager.waitForDeployment();
  await (await manager.grantRole(await manager.BORROWER_ROLE(), borrower.address)).wait();
  const rpc = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const call = JSON.parse(body);
    try {
      const result = await connection.provider.request({ method: call.method, params: call.params });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
    } catch (error) { res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: error.code || -32000, message: error.message, data: error.data } })); }
  });
  rpc.listen(0, '127.0.0.1'); await once(rpc, 'listening');
  t.after(() => { rpc.closeAllConnections(); rpc.close(); });
  const child = spawn(process.env.IPLOAN_TEST_PYTHON || (process.platform === 'win32' ? '../server/venv/Scripts/python.exe' : '../server/.venv/bin/python'), ['../server/integration_runner.py'], { env: { ...process.env,
    IPLOAN_RPC_URL: `http://127.0.0.1:${rpc.address().port}`, IPLOAN_CHAIN_ID: '31337', IPLOAN_MANAGER_ADDRESS: await manager.getAddress(), IPLOAN_TEST_WORKFLOW_FIXTURE: '1',
  } });
  t.after(() => child.kill());
  let errors = ''; child.stderr.on('data', c => { errors += c; });
  const startup = await new Promise((resolve, reject) => {
    let output = ''; child.stdout.on('data', c => { output += c; if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0])); });
    child.once('error', reject); child.once('exit', code => { if (code) reject(new Error(errors)); });
  });
  const hash = s => createHash('sha256').update(s).digest('hex');
  const canonical = data => JSON.stringify(Object.fromEntries(Object.keys(data).sort().map(k => [k, data[k]])));
  async function post(path, body) {
    const response = await fetch(startup.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  async function proof(action, applicationId, body, signer) {
    const challenge = await post('/workflow/challenge', { action, applicationId, address: signer.address, digest: hash(canonical(body)) });
    assert.equal(challenge.status, 200);
    return { nonce: challenge.data.nonce, signature: await signer.signMessage(challenge.data.message) };
  }
  async function create(amount, requestId, marker = '') {
    const pdf = `%PDF-1.4\nFICTIONAL EVM WORKFLOW ${requestId} ${marker}\n%%EOF`;
    const fields = { company: '가상 EVM 통합 기업', bizNo: '123-45-67890', amount: String(amount), borrowerWallet: borrower.address, request_id: requestId, workflow: 'integrated' };
    const auth = await proof('create', '', { ...fields, fileSha256: hash(pdf) }, borrower);
    const form = new FormData(); for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append('auth', JSON.stringify(auth));
    form.append('registryDocument', new Blob([pdf], { type: 'application/pdf' }), 'patent.pdf');
    const response = await fetch(startup.url + '/applications', { method: 'POST', body: form });
    return { status: response.status, data: await response.json() };
  }
  async function register(app) {
    await (await manager.connect(borrower).submitApplicationWithMetadata(app.appKey, app.docCid, app.docFileHash, app.amount, app.evaluatorWallet, app.sbtMetadataUri, app.debtMetadataUri)).wait();
    const synced = await post(`/applications/${app.id}/sync`, {}); assert.equal(synced.status, 200, JSON.stringify(synced.data));
    return synced.data;
  }
  async function prepare(app, signer = evaluator) {
    const body = { appraisedValue: 100, reviewerNote: '실제 로컬 EVM 테스트: fixture 보고서 검토' };
    return post(`/applications/${app.id}/evaluation-report`, { ...body, auth: await proof('review', app.id, body, signer) });
  }
  const created = await create(70, 'workflow-evm-normal-0001'); assert.equal(created.status, 201, JSON.stringify(created.data));
  const app = await register(created.data);
  assert.equal('report_ready', app.status); assert.equal(app.creditCaseId, null);
  const duplicate = await create(70, 'workflow-evm-normal-0001'); assert.equal(duplicate.status, 200); assert.equal(duplicate.data.id, app.id);
  assert.equal(409, (await create(71, 'workflow-evm-normal-0001')).status);
  const statusBody = { action: 'status' };
  const unauthorized = await post(`/applications/${app.id}/evaluation`, { ...statusBody, auth: await proof('status', app.id, statusBody, outsider) });
  assert.equal(unauthorized.status, 403);
  assert.equal((await prepare(app, borrower)).status, 403);
  const status = await post(`/applications/${app.id}/evaluation`, { ...statusBody, auth: await proof('status', app.id, statusBody, evaluator) });
  assert.equal(status.data.evaluation.autoValue, 100);
  assert.equal(status.data.evaluation.jobId.startsWith('fixture-'), true);
  const report = await prepare(app); assert.equal(report.status, 200, JSON.stringify(report.data));
  await (await manager.connect(evaluator).confirmEvaluation(app.appKey, report.data.cid, report.data.hash, 100, report.data.bankWallet)).wait();
  const eligible = await post(`/applications/${app.id}/sync`, {});
  assert.equal(eligible.status, 200, JSON.stringify(eligible.data)); assert.equal(eligible.data.creditCaseId, app.id); assert.equal(eligible.data.status, 'review');
  await (await manager.connect(bank).finalApprove(app.appKey)).wait();
  const approved = await post(`/applications/${app.id}/sync`, {}); assert.equal(approved.data.chainStatus, 'Approved'); assert.ok(approved.data.debtTokenId);
  const excess = await register((await create(71, 'workflow-evm-excess-0001')).data);
  const excessReport = await prepare(excess); assert.equal(excessReport.status, 200); assert.equal(excessReport.data.bankWallet, null);
  await (await manager.connect(evaluator).confirmEvaluation(excess.appKey, excessReport.data.cid, excessReport.data.hash, 100, '0x' + '0'.repeat(40))).wait();
  const rejected = await post(`/applications/${excess.id}/sync`, {});
  assert.equal(rejected.data.chainStatus, 'RuleRejected'); assert.equal(rejected.data.creditCaseId, null); assert.match(rejected.data.rejectReason, /70%/);
  await assert.rejects(manager.connect(bank).finalApprove(excess.appKey));
  const failed = await register((await create(70, 'workflow-evm-failed-0001', 'FAIL_EVALUATION')).data);
  assert.equal((await prepare(failed)).status, 409);
  const retryBody = { action: 'retry' };
  const retry = await post(`/applications/${failed.id}/evaluation`, { ...retryBody, auth: await proof('retry', failed.id, retryBody, borrower) });
  assert.equal(retry.status, 200); assert.equal(retry.data.id, failed.id); assert.equal(retry.data.evaluation.attempt, 2); assert.equal(retry.data.evaluation.state, 'completed');
  assert.equal(await provider.getBalance(await manager.getAddress()), 0n);
});
