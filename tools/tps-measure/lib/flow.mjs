// Moves applications through the workflow for pools: server application, on-chain registration, rights check,
// evaluation report, on-chain confirmation, bank decision.
import { Sender, api, login, managerInterface, runState, wallets } from './common.mjs';
import { confirmArgs, createApplication, evaluationReportBody, submitArgs } from './workload.mjs';

export async function context() {
  const env = runState();
  const w = wallets();
  const iface = managerInterface();
  const senders = Object.fromEntries(['borrower', 'evaluator', 'bank'].map(r => [r, new Sender(w[r], env.chainId, env.manager)]));
  const tokens = { borrower: await login(env.apiBase, w.borrower), evaluator: await login(env.apiBase, w.evaluator), bank: await login(env.apiBase, w.bank) };
  const c = { env, w, iface, senders, tokens };
  // Round-robin over the API processes, as the reverse proxy does in front of gunicorn workers.
  let next = 0;
  Object.defineProperty(c, 'base', { get: () => env.apiBases[next++ % env.apiBases.length] });
  return c;
}

const expect = (r, status, label) => { if (r.status !== status) throw new Error(`${label} ${r.status} ${JSON.stringify(r.data)}`); return r.data; };

export const tx = {
  submit: (c, app) => c.senders.borrower.send(c.iface.encodeFunctionData('submitApplicationWithMetadata', submitArgs(app))),
  confirm: (c, item) => c.senders.evaluator.send(c.iface.encodeFunctionData('confirmEvaluation', confirmArgs(item))),
  approve: (c, item) => c.senders.bank.send(c.iface.encodeFunctionData('finalApprove', [item.appKey])),
  reject: (c, item) => c.senders.bank.send(c.iface.encodeFunctionData('finalReject', [item.appKey])),
};

export const http = {
  sync: async (c, id) => expect(await api(c.base, 'POST', `/applications/${id}/sync`), 200, 'sync'),
  rights: async (c, id) => expect(await api(c.base, 'POST', `/applications/${id}/patent-register`, { json: { action: 'confirm', auth: { login: c.tokens.evaluator } } }), 200, 'rights'),
  report: async (c, id) => api(c.base, 'POST', `/applications/${id}/evaluation-report`, { json: evaluationReportBody(c.tokens.evaluator) }),
};

// Server application registered on chain and checked by the evaluator: chain Evaluating, rights checked.
export async function serverApplication(c) {
  const app = await createApplication(c.base, c.w.borrower.address, c.tokens.borrower);
  await tx.submit(c, app);
  const synced = await http.sync(c, app.id);
  if (synced.chainStatus !== 'Evaluating') throw new Error('not Evaluating after sync: ' + synced.chainStatus);
  await http.rights(c, app.id);
  return app;
}
