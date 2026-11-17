// Prepares the pools for requests that succeed only once per application (tps.config.json "pool").
//   created           E04  chain-unregistered application records (submitApplicationWithMetadata)
//   evaluating        E03  applications Evaluating on chain (confirmEvaluation)
//   eligible-E06/E09/E10  applications Eligible on chain (finalApprove / finalReject)
//   rightsChecked     E07  server applications, on chain, rights-checked, no report yet (evaluation-report)
//   reusable          E02 E05 E08  server applications with a prepared report (repeatable reads / sync)
// Chain-only pools are created directly on the contract with the same field formats the server issues;
// the measured transaction is the contract call itself. Server pools go through the real API.
// Usage: node prepare-pool.mjs --created 3000 --evaluating 3000 --eligible 3000 [--for E06,E09] --rightsChecked 600 --reusable 30
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { RUN_DIR, loadJson } from './lib/common.mjs';
import { context, http, serverApplication, tx } from './lib/flow.mjs';
import { chainItem } from './lib/workload.mjs';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map(s => { const [k, v] = s.trim().split(/\s+/); return [k, /^\d+$/.test(v ?? '') ? Number(v) : v]; }));
const poolFile = path.join(RUN_DIR, 'pools.json');
const pools = existsSync(poolFile) ? loadJson(poolFile) : {};
const c = await context();
if (pools.manager && pools.manager !== c.env.manager) throw new Error('pools.json 이 다른 계약용입니다. 삭제 후 다시 준비하세요.');
pools.manager = c.env.manager;
const save = () => writeFileSync(poolFile, JSON.stringify(pools));
const add = (name, items) => { pools[name] = [...(pools[name] || []), ...items]; save(); };
const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);

async function inBatches(count, size, make) {
  const out = [];
  for (let i = 0; i < count; i += size) {
    out.push(...await Promise.all(Array.from({ length: Math.min(size, count - i) }, make)));
    if ((i / size) % 10 === 0) log(`  ${Math.min(i + size, count)}/${count}`);
  }
  return out;
}

const evaluator = c.w.evaluator.address, bank = c.w.bank.address;
if (args.created) {
  add('created', Array.from({ length: args.created }, () => chainItem(evaluator, bank)));
  log('created', args.created);
}
if (args.evaluating) {
  log('evaluating: submit', args.evaluating);
  add('evaluating', await inBatches(args.evaluating, 100, async () => { const it = chainItem(evaluator, bank); await tx.submit(c, it); return it; }));
}
if (args.eligible) {
  for (const name of (args.for ? String(args.for).split(',') : ['E06', 'E09', 'E10']).map(e => 'eligible-' + e)) {
    log(name + ': submit + confirm', args.eligible);
    add(name, await inBatches(args.eligible, 100, async () => { const it = chainItem(evaluator, bank); await tx.submit(c, it); await tx.confirm(c, it); return it; }));
  }
}
async function serverPool(name, count, withReport) {
  log(name + ': server applications', count);
  let done = 0, failures = 0;
  const items = [];
  const worker = async () => {
    while (done < count) {
      done += 1;
      let app;
      try {
        app = await serverApplication(c);
        if (withReport) { const r = await http.report(c, app.id); if (r.status !== 200) throw new Error('report ' + r.status); }
      } catch (error) {
        // Preparation only: a transient failure discards that application and makes a new one.
        failures += 1;
        if (failures > 50) throw error;
        log('  retry after', String(error.message).slice(0, 120));
        done -= 1;
        continue;
      }
      items.push({ id: app.id, appKey: app.appKey });
      if (items.length % 100 === 0) log(`  ${items.length}/${count}`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  add(name, items);
}
if (args.reusable) await serverPool('reusable', args.reusable, true);
if (args.rightsChecked) await serverPool('rightsChecked', args.rightsChecked, false);
log('pools', Object.fromEntries(Object.entries(pools).filter(([k]) => k !== 'manager').map(([k, v]) => [k, v.length])));
