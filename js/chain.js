/* Wallet-only demo flow. No private keys, platform issuer or server signing. */
globalThis.IPLoanChain = (() => {
  let base, cfg = null;
  const pendingMemory = new Map();
  const messages = { AlreadySubmitted: '이미 등록된 신청입니다. 체인 상태를 동기화하세요.', WrongStage: '현재 신청 단계에서 실행할 수 없습니다.',
    WrongEvaluator: '이 신청에 배정된 평가사 지갑으로 전환하세요.', WrongBank: '이 신청에 배정된 은행 지갑으로 전환하세요.',
    AccessControlUnauthorizedAccount: '이 지갑에 필요한 역할이 없습니다.', InvalidInput: '입력값을 확인하세요.', DuplicateRepayment: '이미 기록된 상환 참조번호입니다.' };
  function message(error) {
    if (error.code === 4001 || error.code === 'ACTION_REJECTED') return 'MetaMask 서명을 취소했습니다. 다시 시도할 수 있습니다.';
    if (error.code === -32002) return 'MetaMask에 대기 중인 요청을 먼저 확인하세요.';
    if (error.code === 'INSUFFICIENT_FUNDS') return '지갑의 가스 잔액이 부족합니다.';
    try {
      const data = error.data || error.info?.error?.data?.data || error.info?.error?.data;
      const decoded = new ethers.Interface(cfg.abi).parseError(data);
      if (messages[decoded?.name]) return messages[decoded.name];
    } catch { /* Fall back to a readable message. */ }
    return error.message || '지갑·체인 요청을 처리하지 못했습니다.';
  }
  async function request(path, options = {}) {
    const response = await fetch(base + path, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '서버 요청 실패');
    return data;
  }
  async function renderWallet() {
    const label = document.getElementById('walletState');
    if (!label) return;
    if (!globalThis.ethereum) { label.textContent = 'MetaMask를 설치하세요. 시연에서도 각 역할의 지갑 서명이 필요합니다.'; return; }
    try {
      const accounts = await ethereum.request({ method: 'eth_accounts' });
      label.textContent = `${accounts[0] || '지갑 미연결'} · ${cfg?.networkName || '계약 설정 필요'} (${cfg?.chainId || '—'})`;
    } catch { label.textContent = '지갑 상태를 확인하지 못했습니다.'; }
  }
  async function init(apiBase) {
    base = apiBase;
    try {
      cfg = await request('/chain/config');
      const hint = document.getElementById('chainConfigHint');
      if (hint) hint.textContent = cfg.enabled ? '서버가 등록된 주소 중 신청 접수 시 평가사를, 평가 통과 시 은행·여신심사역을 배정합니다. 배정된 주소는 신청에 저장됩니다.' : '계약 미설정: 관리자 화면에서 배포 후 API의 IPLOAN_MANAGER_ADDRESS를 설정하세요.';
    } catch (error) {
      cfg = null;
      const hint = document.getElementById('chainConfigHint');
      if (hint) hint.textContent = error.message;
    }
    const button = document.getElementById('walletConnect');
    const accountButton = document.getElementById('walletSelectAccount');
    if (accountButton) accountButton.onclick = async () => {
      accountButton.disabled = true;
      try {
        if (!globalThis.ethereum) throw new Error('MetaMask를 설치하세요.');
        await ethereum.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
        await connect();
      } catch (error) { alert(message(error)); }
      finally { accountButton.disabled = false; await renderWallet(); }
    };
    if (button) button.onclick = async () => {
      try { await connect(); } catch (error) { alert(message(error)); }
      await renderWallet();
    };
    if (globalThis.ethereum && !ethereum.__iploanEvents) {
      ethereum.on('accountsChanged', renderWallet);
      ethereum.on('chainChanged', renderWallet);
      ethereum.__iploanEvents = true;
    }
    await renderWallet();
  }
  async function connect(role = null, expectedAddress = null) {
    if (!cfg || (role && !cfg.enabled)) throw new Error('MVP 계약·RPC를 서버에 먼저 설정하세요.');
    if (!globalThis.ethereum) throw new Error('MetaMask를 설치하세요.');
    if (!globalThis.ethers) throw new Error('먼저 npm run build:web을 실행하세요.');
    const target = ethers.toBeHex(cfg.chainId);
    const chainId = await ethereum.request({ method: 'eth_chainId' });
    if (BigInt(chainId) !== BigInt(cfg.chainId)) {
      try { await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: target }] }); }
      catch (error) {
        if (error.code !== 4902) throw error;
        await ethereum.request({ method: 'wallet_addEthereumChain', params: [{ chainId: target, chainName: cfg.networkName,
          nativeCurrency: { name: cfg.currency, symbol: cfg.currency, decimals: 18 }, rpcUrls: [cfg.rpcUrl],
          ...(cfg.explorerUrl ? { blockExplorerUrls: [cfg.explorerUrl] } : {}) }] });
        await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: target }] });
      }
    }
    const accounts = await ethereum.request({ method: 'eth_requestAccounts' });
    const address = ethers.getAddress(accounts[0]);
    if (expectedAddress && address.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error('이 신청 담당 지갑으로 전환하세요.');
    const provider = new ethers.BrowserProvider(ethereum);
    const signer = await provider.getSigner();
    const contract = cfg.enabled ? new ethers.Contract(cfg.managerAddress, cfg.abi, signer) : null;
    if (role && !(await contract.hasRole(ethers.id(role), address))) throw new Error('연결한 지갑에 ' + role + ' 권한이 없습니다.');
    await renderWallet();
    return { provider, signer, contract, address };
  }
  function key(app, action) { return `iploan-tx:${app.chainId}:${app.managerAddress}:${app.id}:${action}`; }
  function transactionOverrides() {
    // Explicit Mustsem-only zero-fee request. Never silently fall back to paid fees.
    return cfg?.chainId === 7601 && cfg.zeroGasPrice ? { type: 0, gasPrice: 0n } : {};
  }
  function savedTx(app, action) {
    try { return localStorage.getItem(key(app, action)) || pendingMemory.get(key(app, action)); }
    catch { return pendingMemory.get(key(app, action)); }
  }
  function saveTx(app, action, hash) {
    pendingMemory.set(key(app, action), hash);
    localStorage.setItem(key(app, action), hash);
  }
  function forgetTx(app, action) {
    pendingMemory.delete(key(app, action));
    try { localStorage.removeItem(key(app, action)); } catch { /* Chain state is authoritative. */ }
  }
  async function sync(app) { return request(`/applications/${encodeURIComponent(app.id)}/sync`, { method: 'POST' }); }
  async function execute(app, action, method, args, role, expectedAddress) {
    let broadcastHash;
    try {
      const ctx = await connect(role, expectedAddress);
      if (cfg.managerAddress.toLowerCase() !== app.managerAddress?.toLowerCase() || cfg.chainId !== app.chainId) throw new Error('신청 당시 계약·체인으로 서버 설정을 맞추세요.');
      const old = await ctx.contract.getApplication(app.appKey);
      const stage = Number(old.status);
      const completed = (action === 'submit' && stage > 0) || (action === 'evaluate' && stage >= 2) ||
        (action === 'approve' && [4, 6].includes(stage)) || (action === 'reject' && stage === 5);
      if (completed) { const updated = await sync(app); forgetTx(app, action); return updated; }
      const hash = savedTx(app, action);
      if (hash) {
        const receipt = await ctx.provider.getTransactionReceipt(hash);
        if (!receipt) throw Object.assign(new Error('거래가 전송됐지만 아직 미확정입니다. 같은 동작을 다시 전송하지 말고 체인 확인을 눌러주세요.'), { txHash: hash });
        if (receipt.status === 1) { const updated = await sync(app); forgetTx(app, action); return updated; }
        forgetTx(app, action);
      }
      // Refuse broadcasting if the browser cannot keep a recovery hash.
      localStorage.setItem(key(app, action), ''); localStorage.removeItem(key(app, action));
      const overrides = transactionOverrides();
      await ctx.contract[method].staticCall(...args, overrides);
      const accounts = await ethereum.request({ method: 'eth_accounts' });
      if (accounts[0]?.toLowerCase() !== ctx.address.toLowerCase() || BigInt(await ethereum.request({ method: 'eth_chainId' })) !== BigInt(app.chainId)) {
        throw new Error('계정 또는 네트워크가 변경됐습니다. 처음 지갑·네트워크로 돌아와 다시 시도하세요.');
      }
      const tx = await ctx.contract[method](...args, overrides);
      broadcastHash = tx.hash;
      saveTx(app, action, tx.hash);
      const hashLabel = document.getElementById('genTxHash');
      if (hashLabel) hashLabel.textContent = tx.hash;
      try { await tx.wait(1, 120000); }
      catch (error) { error.txHash = tx.hash; throw error; }
      const updated = await sync(app);
      forgetTx(app, action);
      return updated;
    } catch (error) {
      throw Object.assign(new Error(error.code === 'TIMEOUT' ? '영수증 대기 시간이 초과됐습니다. 재전송하지 말고 체인 확인으로 복구하세요.' : message(error)), { txHash: error.txHash || broadcastHash });
    }
  }
  async function register(app) {
    if (!app.evaluatorWallet) throw new Error('신청에 저장된 담당 평가사 주소를 확인하세요.');
    const args = [app.appKey, app.docCid, app.docFileHash, BigInt(app.amount), app.evaluatorWallet];
    if (app.sbtMetadataUri || app.debtMetadataUri) {
      if (!app.sbtMetadataUri || !app.debtMetadataUri || Number(cfg?.tokenMediaVersion || 0) < 1) throw new Error('이미지 메타데이터를 지원하는 계약과 두 토큰 URI를 확인하세요.');
      if ([app.sbtMetadataUri, app.debtMetadataUri].some(uri => uri.startsWith('https://')) && Number(cfg.tokenMediaVersion) < 2) throw new Error('HTTPS 메타데이터를 지원하는 새 계약을 확인하세요.');
      return execute(app, 'submit', 'submitApplicationWithMetadata', [...args, app.sbtMetadataUri, app.debtMetadataUri], 'BORROWER_ROLE', app.borrowerWallet);
    }
    return execute(app, 'submit', 'submitApplication', args, 'BORROWER_ROLE', app.borrowerWallet);
  }
  async function evaluate(app, report) {
    // The server assigns the bank/reviewer only for an evaluation that passes the 70% rule; otherwise it is empty.
    const bank = report.bankWallet || ethers.ZeroAddress;
    return execute(app, 'evaluate', 'confirmEvaluation', [app.appKey, report.cid, report.hash, BigInt(report.appraisedValue), bank], 'EVALUATOR_ROLE', app.evaluatorWallet);
  }
  async function approve(app, yes) {
    return execute(app, yes ? 'approve' : 'reject', yes ? 'finalApprove' : 'finalReject', [app.appKey], 'BANK_ROLE', app.bankWallet);
  }
  async function repay(app, amount, reference) {
    const paymentRef = ethers.id(reference);
    return execute(app, 'repay', 'recordRepayment', [app.appKey, BigInt(amount), paymentRef], 'BANK_ROLE', app.bankWallet);
  }
  async function readDocument(app) {
    const ctx = await connect();
    const challenge = await request(`/applications/${encodeURIComponent(app.id)}/document-nonce`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: ctx.address }) });
    const signature = await ctx.signer.signMessage(challenge.message);
    const response = await fetch(base + `/applications/${encodeURIComponent(app.id)}/document`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...challenge, address: ctx.address, signature }) });
    if (!response.ok) { const data = await response.json(); throw new Error(data.message || '열람 실패'); }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = globalThis.document.createElement('a'); link.href = url; link.download = 'registry.pdf'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  return { init, connect, register, evaluate, approve, repay, sync, transactionOverrides, document: readDocument, config: () => cfg };
})();
