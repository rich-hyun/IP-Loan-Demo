const LOCAL_ADMIN = ['127.0.0.1', 'localhost'].includes(location.hostname);
const ADMIN_API = LOCAL_ADMIN ? 'http://127.0.0.1:5001/api' : 'https://iploan-api.mustree.kr/api';
let deploying = false, deployedAddress = null;
const result = document.getElementById('adminResult');
const el = id => document.getElementById(id);
const allowedRoles = ['BORROWER_ROLE', 'EVALUATOR_ROLE', 'BANK_ROLE'];
async function getJSON(url) {
  const response = await fetch(url, { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '서버 조회 실패');
  return data;
}
async function action(work) {
  if (deploying) return;
  deploying = true;
  try { await work(); }
  catch (error) { result.textContent += '\n' + (error.code === 4001 ? 'MetaMask 승인을 취소했습니다.' : error.shortMessage || error.message); }
  finally { deploying = false; }
}
async function refreshAdmin() {
  await IPLoanChain.init(ADMIN_API);
  const cfg = IPLoanChain.config();
  if (!cfg?.enabled) return;
  el('roleMembers').textContent = allowedRoles.map(role => role + '\n' + (cfg.roleMembers[role] || []).join('\n')).join('\n\n');
}
async function managerContext() {
  const ctx = await IPLoanChain.connect();
  const cfg = IPLoanChain.config();
  const target = cfg?.managerAddress || deployedAddress;
  if (!target) throw new Error('먼저 새 계약을 배포하고 API에 계약 주소를 설정하세요.');
  // The API serves the connected Manager's ABI, so role management works where build artifacts are not published.
  const abi = cfg?.enabled ? cfg.abi : (await getJSON('blockchain/artifacts/IPLoanManager.json')).abi;
  const manager = new ethers.Contract(target, abi, ctx.signer);
  if (Number(await manager.contractVersion()) !== 3) throw new Error('v3 대출약정 계약이 아닙니다.');
  if (!(await manager.hasRole(ethers.ZeroHash, ctx.address))) throw new Error('이 계약의 관리자 지갑으로 전환하세요.');
  return { ...ctx, manager };
}
el('deployManager').onclick = () => action(async () => {
  if (!LOCAL_ADMIN) throw new Error('새 계약 배포는 로컬 화면에서 진행하세요.');
  const ctx = await IPLoanChain.connect();
  if (IPLoanChain.config()?.enabled) throw new Error('API의 IPLOAN_MANAGER_ADDRESS를 비운 상태에서 배포하세요. 기존 계약은 유지됩니다.');
  if (Number((await ctx.provider.getNetwork()).chainId) !== 7601) throw new Error('Mustsem(7601)에서 배포하세요.');
  const evaluator = ethers.getAddress(el('adminEvaluator').value.trim());
  const bank = ethers.getAddress(el('adminBank').value.trim());
  if ([evaluator, bank].includes(ethers.ZeroAddress) || evaluator === bank) throw new Error('평가사와 은행은 서로 다른 영주소가 아닌 주소여야 합니다.');
  const artifact = await getJSON('blockchain/artifacts/IPLoanManager.json');
  // v3: evaluator fixed at submission, bank at a passing evaluation, the hash of the loan terms at final approval.
  const inputs = name => artifact.abi.find(a => a.type === 'function' && a.name === name)?.inputs.length;
  if (!artifact.compiler?.version?.startsWith('0.8.24+') || artifact.compiler.evmVersion !== 'paris' || inputs('submitApplication') !== 5
    || inputs('confirmEvaluation') !== 5 || inputs('finalApprove') !== 2) throw new Error('v3 대출약정 계약을 먼저 컴파일하세요.');
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, ctx.signer);
  const request = await factory.getDeployTransaction(ctx.address, evaluator, bank);
  // Keyed by build: a pending deploy of this code is never sent twice, while a rebuilt contract starts fresh.
  const storageKey = `iploan-deployment:v3:7601:${ctx.address.toLowerCase()}:${ethers.keccak256(artifact.bytecode).slice(2, 10)}`;
  const previous = JSON.parse(localStorage.getItem(storageKey) || 'null');
  if (previous) {
    const old = await ctx.provider.getTransaction(previous.txHash);
    if (!old || old.from.toLowerCase() !== ctx.address.toLowerCase() || old.to !== null || old.chainId !== 7601n || old.value !== 0n || old.data.toLowerCase() !== request.data.toLowerCase()) throw new Error('이전 배포와 현재 설정이 다릅니다. 이전 거래 상태를 먼저 확인하세요.');
    const receipt = await ctx.provider.getTransactionReceipt(previous.txHash);
    if (!receipt) throw new Error('이전 배포가 미확정입니다. 중복 배포하지 말고 거래 확정을 기다리세요.');
    if (receipt.status !== 1) throw new Error('이전 배포가 실패했습니다. 실패 원인을 확인하세요.');
    deployedAddress = receipt.contractAddress;
    result.textContent = `기존 새 계약 배포 확인: ${deployedAddress}\n거래: ${previous.txHash}\nAPI의 IPLOAN_MANAGER_ADDRESS를 이 주소로 설정하고 다시 시작하세요.`;
    return;
  }
  localStorage.setItem(storageKey, 'null'); localStorage.removeItem(storageKey);
  if (!confirm(`Mustsem에 v3 계약 4개(Manager·평가 SBT·RWA 토큰·NFT 그림)를 생성합니다. 관리자 ${ctx.address}, 첫 평가사 ${evaluator}, 첫 은행 ${bank}. MetaMask에서 가스 요금을 확인하고 승인하세요.`)) return;
  const manager = await factory.deploy(ctx.address, evaluator, bank, IPLoanChain.transactionOverrides());
  const tx = manager.deploymentTransaction();
  deployedAddress = await manager.getAddress();
  result.textContent = `배포 전송: ${tx.hash}\nManager: ${deployedAddress}\n확정 대기 중…`;
  localStorage.setItem(storageKey, JSON.stringify({ address: deployedAddress, txHash: tx.hash }));
  await tx.wait(1, 120000);
  result.textContent = `배포 완료\nManager: ${deployedAddress}\nSBT: ${await manager.accessSBT()}\nRWA 토큰: ${await manager.rwaToken()}\n그림(메타데이터): ${await manager.art()}\n거래: ${tx.hash}\n\nAPI의 IPLOAN_MANAGER_ADDRESS를 이 주소로 설정해 다시 시작한 후 차주·평가사·은행 주소를 추가하세요. 서버가 신청 시 평가사를, 평가 통과 시 은행·여신심사역을 배정합니다.`;
});
for (const [button, grant] of [['grantRole', true], ['revokeRole', false]]) {
  el(button).onclick = () => action(async () => {
    const { manager } = await managerContext();
    const role = el('roleName').value;
    if (!allowedRoles.includes(role)) throw new Error('관리할 역할을 선택하세요.');
    const address = ethers.getAddress(el('roleAddress').value.trim());
    if (address === ethers.ZeroAddress) throw new Error('영주소는 등록할 수 없습니다.');
    const roleId = ethers.id(role);
    if (await manager.hasRole(roleId, address) === grant) { result.textContent = '이미 요청한 권한 상태입니다.'; return; }
    if (!confirm(`${role}: ${address} 권한을 ${grant ? '추가' : '회수'}합니다. ${grant ? '' : '진행 중인 담당 신청의 실행도 중단됩니다. '}MetaMask에서 승인하세요.`)) return;
    const overrides = IPLoanChain.transactionOverrides();
    const fn = grant ? manager.grantRole : manager.revokeRole;
    await fn.staticCall(roleId, address, overrides);
    const tx = await fn(roleId, address, overrides);
    result.textContent = `권한 변경 전송: ${tx.hash}`;
    await tx.wait(1, 120000);
    result.textContent += '\n권한 변경 완료';
    await refreshAdmin();
  });
}
el('refreshAdmin').onclick = () => action(refreshAdmin);
const adminReady = action(refreshAdmin);
