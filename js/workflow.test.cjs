const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');

test('polling reuses read session and stops on wallet change without a new signature prompt', async () => {
  let account = '0xborrower', signatures = 0, interval, challenges = 0, reads = 0;
  const app = { id: 'LN-1', evaluation: {state: 'running'}, chainStatus: 'Evaluating' };
  const elements = {};
  const ctx = vm.createContext({
    crypto: webcrypto, TextEncoder, API_BASE: '/api', currentRole: 'borrower',
    escapeHtml: value => String(value ?? ''), won: value => String(value ?? '-'),
    findApp: () => app, renderDashboard(){}, renderListTable(){}, renderEvalList(){}, renderReviewList(){}, showToast(){},
    document: {getElementById: id => elements[id] ||= {}},
    ethereum: {request: async () => [account]},
    IPLoanChain: {connect: async () => ({address: account, signer: {signMessage: async () => {signatures++; return 'signature';}}})},
    setInterval: fn => {interval = fn; return 1;}, clearInterval(){},
    fetch: async (url, options) => {
      if (url.endsWith('/workflow/challenge')) {challenges++; return {ok:true,json:async()=>({nonce:'once',message:'status'})};}
      const body = JSON.parse(options.body); reads++;
      assert.ok(body.auth.session === 'read-session' || body.auth.signature === 'signature');
      return {ok:true,json:async()=>({...app,readSession:'read-session'})};
    },
  });
  vm.runInContext(fs.readFileSync(__dirname+'/workflow.js','utf8'),ctx);
  ctx.LoanWorkflow.panel(app, 'panel');
  await ctx.LoanWorkflow.load(app.id);
  await interval();
  assert.equal(signatures,1); assert.equal(challenges,1); assert.equal(reads,2);
  account='0xevaluator';
  await interval();
  assert.equal(signatures,1); assert.equal(challenges,1); assert.equal(reads,2);
  assert.match(elements.workflowMessage.textContent,/지갑이 변경/);
});
