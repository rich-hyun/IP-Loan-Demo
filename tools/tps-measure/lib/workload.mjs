// Request builders shared by prepare-pool.mjs and tps-measure.mjs.
import { randomBytes } from 'node:crypto';
import { GATEWAY, api, appKeyOf, config, fakeCid, randomId } from './common.mjs';

const DOC = config.document;

// A valid PDF the size of the real gazette PDF (~1 MB). The padding is an unreferenced binary stream so the
// AES-GCM encryption, hashing and IPFS write cost scale like a real upload.
let pdfCache;
export function testPdf() {
  if (pdfCache) return pdfCache;
  const head = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<<>>>>endobj\n' +
    '4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 72 720 Td (TPS test patent) Tj ET\nendstream endobj\n');
  const padLength = Math.max(0, DOC.sizeBytes - head.length - 120);
  const pad = Buffer.concat([Buffer.from(`5 0 obj<</Length ${padLength}>>stream\n`), randomBytes(padLength), Buffer.from('\nendstream endobj\n')]);
  const tail = Buffer.from('trailer<</Root 1 0 R>>\n%%EOF\n');
  pdfCache = Buffer.concat([head, pad, tail]);
  return pdfCache;
}

// E01 body: integrated application (multipart) signed in with the borrower's wallet session.
export function applicationForm(borrower, token) {
  const form = new FormData();
  const fields = {
    workflow: 'integrated', borrowerWallet: borrower, company: DOC.company, bizNo: DOC.bizNo, ceo: '홍길동',
    contact: '02-0000-0000', ipType: '특허권', ipTitle: 'TPS 시험용 특허', ipRegNo: DOC.ipRegNo,
    amount: String(DOC.amount), termMonths: '12', request_id: 'tps' + randomId(24), auth: JSON.stringify({ login: token }),
  };
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('registryDocument', new Blob([testPdf()], { type: 'application/pdf' }), 'tps-test-patent.pdf');
  return form;
}

export async function createApplication(base, borrower, token) {
  const r = await api(base, 'POST', '/applications', { form: applicationForm(borrower, token) });
  if (r.status !== 201) throw new Error('create failed ' + r.status + ' ' + JSON.stringify(r.data));
  return r.data;
}

// E07 body: evaluator's reviewed value for the evaluation report (signed in with the evaluator session).
export const evaluationReportBody = token => ({ appraisedValue: DOC.appraisedValue, reviewerNote: 'TPS 시험: 보고서 검토 후 적용 가치 확정', auth: { login: token } });

// On-chain arguments for a server-created application (same as js/chain.js register()).
export const submitArgs = app => [app.appKey, app.docCid, app.docFileHash, BigInt(app.amount), app.evaluatorWallet, app.sbtMetadataUri, app.debtMetadataUri];

// Chain-only pool item: an application record with the same field formats the server issues.
export function chainItem(evaluator, bank) {
  return {
    appKey: appKeyOf('TPS-CHAIN-' + randomId(20)), docCid: fakeCid(), docFileHash: '0x' + randomBytes(32).toString('hex'),
    amount: DOC.amount, evaluatorWallet: evaluator, sbtMetadataUri: GATEWAY + fakeCid(), debtMetadataUri: GATEWAY + fakeCid(),
    reportCid: fakeCid(), reportHash: '0x' + randomBytes(32).toString('hex'), appraisedValue: DOC.appraisedValue, bankWallet: bank,
  };
}
export const confirmArgs = item => [item.appKey, item.reportCid, item.reportHash, BigInt(item.appraisedValue), item.bankWallet];
