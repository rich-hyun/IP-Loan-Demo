// One application through the whole workflow against the running test environment, to check the
// tool before measuring: create -> chain submit -> sync -> rights -> report -> chain confirm -> sync -> approve -> sync,
// plus one of each measured GET.
import { api } from './lib/common.mjs';
import { context, http, serverApplication, tx } from './lib/flow.mjs';

const c = await context();
const t = async (label, fn) => { const s = performance.now(); const v = await fn(); console.log(label.padEnd(28), (performance.now() - s).toFixed(1), 'ms'); return v; };
const app = await t('create+submit+sync+rights', () => serverApplication(c));
console.log('  id', app.id, 'evaluator', app.evaluatorWallet);
const report = await t('evaluation-report', () => http.report(c, app.id));
if (report.status !== 200) throw new Error('report ' + report.status + ' ' + JSON.stringify(report.data));
console.log('  report', report.data);
const again = await http.report(c, app.id);
console.log('  report again ->', again.status);
for (const route of [`/applications/${app.id}/evaluation`, `/applications/${app.id}/evaluation/artifacts/pdf`]) {
  const r = await t('GET ' + route.split('/').slice(3).join('/'), () => api(c.base, 'GET', route));
  console.log('  ', r.status, r.bytes, 'bytes', r.data?.evaluation ? 'creditRating=' + r.data.evaluation.creditRating + ' autoReview=' + r.data.evaluation.autoReview?.decision : '');
}
await t('chain confirmEvaluation', () => tx.confirm(c, { appKey: app.appKey, ...report.data, reportCid: report.data.cid, reportHash: report.data.hash }));
console.log('  sync ->', (await http.sync(c, app.id)).chainStatus);
await t('chain finalApprove', () => tx.approve(c, app));
const done = await http.sync(c, app.id);
console.log('  sync ->', done.chainStatus, 'debtTokenId', done.debtTokenId);
