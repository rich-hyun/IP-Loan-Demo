// TPS measurement. Closed loop: N virtual users each send the next request as soon as the previous one
// completes, for durationSeconds, repeated `runs` times per endpoint.
//   TPS             = successful requests completed inside the window / window seconds
//   avg response    = mean latency of those successful requests (HTTP: request -> full body; tx: send -> receipt)
//   success rate    = successful / all requests completed inside the window
// Requests still in flight when the window closes are awaited but not counted.
// Usage: node tps-measure.mjs [--network native] [--endpoints E01,E04] [--duration 60] [--runs 3] [--vus 10] [--label x]
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, RUN_DIR, api, config, loadJson, rpc } from './lib/common.mjs';
import { context, tx } from './lib/flow.mjs';
import { applicationForm, evaluationReportBody } from './lib/workload.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : fallback; };
const network = opt('network', 'native');
if (network !== 'native') throw new Error('이 시험 환경은 자체 네트워크(native) 항목만 측정합니다. 공용 네트워크는 별도 환경이 필요합니다.');
const M = config.measurement;
const duration = Number(opt('duration', M.durationSeconds));
const runs = Number(opt('runs', M.runs));
const vus = Number(opt('vus', M.virtualUsers));
const only = opt('endpoints', '') ? opt('endpoints').split(',') : null;
const endpoints = config.endpoints.filter(e => !only || only.includes(e.id));

const c = await context();
const poolFile = path.join(RUN_DIR, 'pools.json');
const usedFile = path.join(RUN_DIR, 'pool-used.json');
const pools = existsSync(poolFile) ? loadJson(poolFile) : {};
const used = existsSync(usedFile) ? loadJson(usedFile) : {};
const poolName = e => (e.pool === 'eligible' ? 'eligible-' + e.id : e.pool);

function source(e) {
  if (!e.pool) return () => ({});
  const name = poolName(e), items = pools[name] || [];
  if (e.pool === 'reusable') { let i = 0; if (!items.length) throw new Error('reusable pool 이 비었습니다.'); return () => items[i++ % items.length]; }
  return () => {
    const index = used[name] || 0;
    if (index >= items.length) return null;
    used[name] = index + 1;
    return items[index];
  };
}

let decision = 0;
function requester(e) {
  if (e.kind === 'tx') {
    return async item => {
      const method = e.contract === 'finalApprove|finalReject' ? (decision++ % 2 ? 'reject' : 'approve') : null;
      if (e.contract === 'confirmEvaluation') await tx.confirm(c, item);
      else if (e.contract === 'submitApplicationWithMetadata') await tx.submit(c, item);
      else if (method === 'reject') await tx.reject(c, item);
      else await tx.approve(c, item);
      return { ok: true, status: 'mined' };
    };
  }
  return async item => {
    const route = e.path.replace('{id}', item.id);
    let r;
    if (e.body === 'createApplication') r = await api(c.base, 'POST', route, { form: applicationForm(c.w.borrower.address, c.tokens.borrower) });
    else if (e.body === 'evaluationReport') r = await api(c.base, 'POST', route, { json: evaluationReportBody(c.tokens.evaluator) });
    else r = await api(c.base, e.method, route);
    const expected = e.body === 'createApplication' ? 201 : 200;
    return { ok: r.status === expected, status: r.status, error: r.status === expected ? undefined : JSON.stringify(r.data)?.slice(0, 200) };
  };
}

async function measure(e, run) {
  const next = source(e), send = requester(e);
  const records = [];
  let exhausted = false;
  const startBlock = Number(BigInt(await rpc('eth_blockNumber')));
  const t0 = performance.now(), wallStart = new Date();
  const end = t0 + duration * 1000;
  const vu = async () => {
    while (performance.now() < end) {
      const item = next();
      if (item === null) { exhausted = true; return; }
      const s = performance.now();
      let result;
      try { result = await Promise.race([send(item), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), M.requestTimeoutMs))]); }
      catch (err) { result = { ok: false, status: 'error', error: String(err.message || err).slice(0, 200) }; }
      records.push({ start: s - t0, end: performance.now() - t0, ...result });
    }
  };
  await Promise.all(Array.from({ length: vus }, vu));
  const wallEnd = new Date(wallStart.getTime() + duration * 1000);
  const endBlock = Number(BigInt(await rpc('eth_blockNumber')));
  writeFileSync(usedFile, JSON.stringify(used));
  const inWindow = records.filter(r => r.end <= duration * 1000);
  const ok = inWindow.filter(r => r.ok);
  const lat = ok.map(r => r.end - r.start).sort((a, b) => a - b);
  const pct = p => (lat.length ? lat[Math.min(lat.length - 1, Math.ceil(p * lat.length) - 1)] : null);
  const errors = {};
  for (const r of inWindow.filter(r => !r.ok)) { const key = r.status + (r.error ? ' ' + r.error : ''); errors[key] = (errors[key] || 0) + 1; }
  return {
    endpoint: e.id, run, start: wallStart.toISOString(), end: wallEnd.toISOString(), durationSeconds: duration, virtualUsers: vus,
    total: inWindow.length, success: ok.length, tps: ok.length / duration,
    avgMs: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null, p50Ms: pct(0.5), p95Ms: pct(0.95), maxMs: lat.at(-1) ?? null,
    successRate: inWindow.length ? (ok.length / inWindow.length) * 100 : null, inFlightAtClose: records.length - inWindow.length,
    poolExhausted: exhausted, blocks: endBlock - startBlock, errors, records,
  };
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.join(ROOT, 'results', `${stamp}_${network}${opt('label') ? '_' + opt('label') : ''}`);
mkdirSync(path.join(outDir, 'raw'), { recursive: true });
const summary = [];
for (const e of endpoints) {
  const rows = [];
  for (let run = 1; run <= runs; run++) {
    const r = await measure(e, run);
    const { records, ...row } = r;
    writeFileSync(path.join(outDir, 'raw', `${e.id}_run${run}.csv`),
      'start_ms,end_ms,latency_ms,ok,status,error\n' + records.map(x => [x.start.toFixed(1), x.end.toFixed(1), (x.end - x.start).toFixed(1), x.ok, x.status, JSON.stringify(x.error || '')].join(',')).join('\n'));
    rows.push(row);
    console.log(`${e.id} ${e.name} run${run}: ${row.success}/${row.total} ok  ${row.tps.toFixed(2)} TPS  avg ${row.avgMs?.toFixed(1)} ms  p95 ${row.p95Ms?.toFixed(1)} ms${row.poolExhausted ? '  POOL EXHAUSTED' : ''}${Object.keys(row.errors).length ? '  errors ' + JSON.stringify(row.errors) : ''}`);
    if (run < runs) await new Promise(res => setTimeout(res, M.pauseBetweenRunsSeconds * 1000));
  }
  const mean = k => rows.reduce((a, r) => a + (r[k] ?? 0), 0) / rows.length;
  const target = e.target[network];
  const valid = rows.every(r => !r.poolExhausted);
  summary.push({ id: e.id, api: e.api, name: e.name, kind: e.kind, request: e.kind === 'tx' ? `contract ${e.contract}` : `${e.method} ${e.path}`,
    target, tpsMean: mean('tps'), avgMsMean: mean('avgMs'), p95MsMean: mean('p95Ms'), successRateMean: mean('successRate'),
    success: rows.reduce((a, r) => a + r.success, 0), total: rows.reduce((a, r) => a + r.total, 0),
    verdict: !valid ? '무효(pool 소진)' : mean('tps') >= target ? '달성' : '미달', runs: rows });
  await new Promise(res => setTimeout(res, M.pauseBetweenRunsSeconds * 1000));
}

const environment = {
  measuredBy: 'tools/tps-measure/tps-measure.mjs', network, chain: `${c.env.nodeVersion} (local test chain ${c.env.chainId}, automine)`,
  manager: c.env.manager, api: `${c.env.apiBases.join(', ')} (server/app.py, ${c.env.apiBases.length} processes x ${c.env.serverThreads} threads via waitress; IPFS·LLM 평가·등록원부 API 는 시험 대역)`,
  host: { os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, logicalCores: os.cpus().length, memoryGB: +(os.totalmem() / 2 ** 30).toFixed(1), node: process.version },
  virtualUsers: vus, durationSeconds: duration, runs,
};
writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ environment, summary }, null, 2));
const f = (v, d = 2) => (v == null ? '-' : v.toFixed(d));
const md = [`# TPS 측정 결과 (${network})`, '', `측정 시각: ${summary[0]?.runs[0].start} ~ ${summary.at(-1)?.runs.at(-1).end}`, '',
  '| ID | API | 엔드포인트 | 측정 요청 | 목표 TPS | 실측 TPS(평균) | 판정 | 평균 응답(ms) | p95(ms) | 성공률(%) | 정상/전체 |', '|---|---|---|---|---|---|---|---|---|---|---|',
  ...summary.map(s => `| ${s.id} | ${s.api} | ${s.name} | \`${s.request}\` | ${s.target} | ${f(s.tpsMean)} | ${s.verdict} | ${f(s.avgMsMean, 1)} | ${f(s.p95MsMean, 1)} | ${f(s.successRateMean)} | ${s.success}/${s.total} |`),
  '', '## 회차별', '', '| ID | 회차 | 시작 | 정상/전체 | TPS | 평균(ms) | p95(ms) | 성공률(%) |', '|---|---|---|---|---|---|---|---|',
  ...summary.flatMap(s => s.runs.map(r => `| ${s.id} | ${r.run} | ${r.start} | ${r.success}/${r.total} | ${f(r.tps)} | ${f(r.avgMs, 1)} | ${f(r.p95Ms, 1)} | ${f(r.successRate)} |`)),
  '', '## 측정 환경', '', '```json', JSON.stringify(environment, null, 2), '```', ''].join('\n');
writeFileSync(path.join(outDir, 'summary.md'), md);
console.log('\nresults:', outDir);
