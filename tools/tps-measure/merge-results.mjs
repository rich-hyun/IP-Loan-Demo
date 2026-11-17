// Merges result folders of separate runs (one fresh environment per run) into one summary.
// Each input folder holds summary.json from tps-measure.mjs --runs 1. Folders are given in run order.
// Usage: node merge-results.mjs <out-name> <dir1>[#runs] <dir2> ...
import { mkdirSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT, config, loadJson } from './lib/common.mjs';

const [outName, ...dirs] = process.argv.slice(2);
if (!outName || !dirs.length) throw new Error('usage: node merge-results.mjs <out-name> <dir...>');
const outDir = path.join(ROOT, 'results', outName);
mkdirSync(path.join(outDir, 'raw'), { recursive: true });
const runsById = {}, environments = [];
for (const spec of dirs) {
  // "<dir>#1,2" keeps only those runs of that folder (e.g. to drop runs invalidated by pool exhaustion).
  const [dir, pick] = spec.split('#');
  const keep = pick ? pick.split(',').map(Number) : null;
  const { environment, summary } = loadJson(path.join(dir, 'summary.json'));
  environments.push({ dir: path.basename(dir), ...environment });
  for (const s of summary) {
    for (const r of s.runs.filter(r => !keep || keep.includes(r.run))) {
      const list = (runsById[s.id] ||= { meta: s, runs: [] }).runs;
      const run = list.length + 1;
      list.push({ ...r, run, source: path.basename(dir) });
      copyFileSync(path.join(dir, 'raw', `${s.id}_run${r.run}.csv`), path.join(outDir, 'raw', `${s.id}_run${run}.csv`));
    }
  }
}
const summary = config.endpoints.filter(e => runsById[e.id]).map(e => {
  const { meta, runs } = runsById[e.id];
  const mean = k => runs.reduce((a, r) => a + (r[k] ?? 0), 0) / runs.length;
  const valid = runs.every(r => !r.poolExhausted);
  return { id: e.id, api: meta.api, name: meta.name, kind: meta.kind, request: meta.request, target: meta.target,
    tpsMean: mean('tps'), avgMsMean: mean('avgMs'), p95MsMean: mean('p95Ms'), successRateMean: mean('successRate'),
    success: runs.reduce((a, r) => a + r.success, 0), total: runs.reduce((a, r) => a + r.total, 0),
    verdict: !valid ? '무효(pool 소진)' : mean('tps') >= meta.target ? '달성' : '미달', runs };
});
writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ environments, summary }, null, 2));
const f = (v, d = 2) => (v == null ? '-' : v.toFixed(d));
const all = summary.flatMap(s => s.runs);
const md = [`# TPS 측정 결과 (자체 네트워크 항목, 로컬 시험 환경)`, '',
  `측정 시각(UTC): ${all.map(r => r.start).sort()[0]} ~ ${all.map(r => r.end).sort().at(-1)}`, '',
  `가상 사용자 ${environments[0].virtualUsers}명, 회차당 ${environments[0].durationSeconds}초, 3회. 회차별 결과 폴더(같은 폴더 = 같은 시험 환경)는 회차별 표의 '결과 폴더' 열에 적는다.`, '',
  '| ID | API | 엔드포인트 | 측정 요청 | 목표 TPS | 실측 TPS(평균) | 판정 | 평균 응답(ms) | p95(ms) | 성공률(%) | 정상/전체 |', '|---|---|---|---|---|---|---|---|---|---|---|',
  ...summary.map(s => `| ${s.id} | ${s.api} | ${s.name} | \`${s.request}\` | ${s.target} | ${f(s.tpsMean)} | ${s.verdict} | ${f(s.avgMsMean, 1)} | ${f(s.p95MsMean, 1)} | ${f(s.successRateMean)} | ${s.success}/${s.total} |`),
  '', '## 회차별', '', '| ID | 회차 | 시작(UTC) | 정상/전체 | TPS | 평균(ms) | p95(ms) | 성공률(%) | 오류 | 결과 폴더 |', '|---|---|---|---|---|---|---|---|---|---|',
  ...summary.flatMap(s => s.runs.map(r => `| ${s.id} | ${r.run} | ${r.start} | ${r.success}/${r.total} | ${f(r.tps)} | ${f(r.avgMs, 1)} | ${f(r.p95Ms, 1)} | ${f(r.successRate)} | ${Object.keys(r.errors).length ? JSON.stringify(r.errors).replace(/\|/g, '/') : '-'} | ${r.source} |`)),
  '', '## 측정 환경', '', '```json', JSON.stringify(environments[0], null, 2), '```', ''].join('\n');
writeFileSync(path.join(outDir, 'summary.md'), md);
console.log(md);
console.log('\nmerged:', outDir, readdirSync(path.join(outDir, 'raw')).length, 'raw files');
