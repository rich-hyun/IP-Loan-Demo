/* Wallet sign-in and wallet-signed transactions. No private keys, platform issuer or server signing. */
globalThis.IPLoanChain = (() => {
  let base, cfg = null, session = null, onSessionChange = null, signingIn = false;
  // One sign-in per wallet: switching MetaMask accounts moves to that wallet's session without signing again.
  const SESSIONS_KEY = 'iploan-sessions';
  let sessions = {};
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
  function saveSession(value) {
    if (value) sessions[value.address.toLowerCase()] = value;
    else if (session) delete sessions[session.address.toLowerCase()];
    session = value;
    try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions)); }
    catch { /* Sessions then last only for this page. */ }
  }
  function endSession() {
    if (!session) return;
    saveSession(null);
    onSessionChange?.('ended');
  }
  function authHeaders(headers = {}) {
    return session ? { ...headers, Authorization: `Bearer ${session.token}` } : headers;
  }
  // Authenticated API call; an expired or revoked session signs the user out.
  async function api(path, options = {}) {
    const response = await fetch(base + path, { ...options, headers: authHeaders(options.headers) });
    if (response.status === 401 && session) endSession();
    const data = await response.json().catch(() => ({ message: `서버 응답을 확인하지 못했습니다. (HTTP ${response.status})` }));
    if (!response.ok) throw Object.assign(new Error(data.message || '서버 요청 실패'), { status: response.status, data });
    return data;
  }
  async function blob(path) {
    const response = await fetch(base + path, { headers: authHeaders() });
    if (response.status === 401 && session) endSession();
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.message || '파일을 불러오지 못했습니다.'); }
    return response.blob();
  }
  const postJSON = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function renderWallet() {
    const label = document.getElementById('walletState');
    if (!label) return;
    if (!globalThis.ethereum) { label.textContent = 'MetaMask를 설치하세요. 각 담당자의 지갑 서명이 필요합니다.'; return; }
    try {
      const accounts = await ethereum.request({ method: 'eth_accounts' });
      label.textContent = `${accounts[0] || '지갑 미연결'} · ${cfg?.networkName || '계약 설정 필요'} (${cfg?.chainId || '—'})`;
    } catch { label.textContent = '지갑 상태를 확인하지 못했습니다.'; }
  }
  function accountsChanged(accounts) {
    // A session belongs to one wallet. Another account resumes its own session, or has to sign in first.
    const next = accounts[0]?.toLowerCase() || null;
    if (!signingIn && next !== (session?.address.toLowerCase() || null)) {
      session = (next && sessions[next]) || null;
      onSessionChange?.(session ? 'switched' : next ? 'signin' : 'ended');
    }
    renderWallet();
  }
  // Network, contract, role holders and latest block; reloaded so status panels do not go stale.
  async function loadConfig() {
    try {
      const response = await fetch(base + '/chain/config');
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '체인 설정을 불러오지 못했습니다.');
      cfg = data;
      const hint = document.getElementById('chainConfigHint');
      if (hint) hint.textContent = cfg.enabled ? '서버가 등록된 주소 중 신청 접수 시 평가사를, 평가 통과 시 은행·여신심사역을 배정합니다. 배정된 주소는 신청에 저장됩니다.' : '계약 미설정: 관리자 화면에서 배포 후 API의 IPLOAN_MANAGER_ADDRESS를 설정하세요.';
    } catch (error) {
      cfg = null;
      const hint = document.getElementById('chainConfigHint');
      if (hint) hint.textContent = error.message;
    }
    return cfg;
  }
  async function init(apiBase, sessionChanged = null) {
    base = apiBase;
    onSessionChange = sessionChanged;
    try { sessions = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '{}') || {}; } catch { sessions = {}; }
    await loadConfig();
    const button = document.getElementById('walletConnect');
    if (button) button.onclick = async () => {
      try { await connect(); } catch (error) { alert(message(error)); }
      await renderWallet();
    };
    if (globalThis.ethereum && !ethereum.__iploanEvents) {
      ethereum.on('accountsChanged', accountsChanged);
      ethereum.on('chainChanged', renderWallet);
      ethereum.__iploanEvents = true;
    }
    await renderWallet();
  }
  async function connect(role = null, expectedAddress = null) {
    if (!cfg || (role && !cfg.enabled)) throw new Error('계약·RPC를 서버에 먼저 설정하세요.');
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
    if (session && address.toLowerCase() !== session.address.toLowerCase()) throw new Error('로그인한 지갑으로 MetaMask 계정을 전환하세요.');
    if (expectedAddress && address.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error('이 신청 담당 지갑으로 전환하세요.');
    const provider = new ethers.BrowserProvider(ethereum);
    const signer = await provider.getSigner();
    const contract = cfg.enabled ? new ethers.Contract(cfg.managerAddress, cfg.abi, signer) : null;
    if (role && !(await contract.hasRole(ethers.id(role), address))) throw new Error('연결한 지갑에 ' + role + ' 권한이 없습니다.');
    await renderWallet();
    return { provider, signer, contract, address };
  }
  // Sign-in proves wallet ownership with a free message signature; roles come from the chain on every request.
  // pick: open MetaMask's account picker first. Without it MetaMask answers with the account already connected to
  // this site, even after switching to another one. Several accounts can be connected there at once.
  async function login({ pick = true } = {}) {
    session = null;
    signingIn = true;
    try {
      if (pick && globalThis.ethereum) {
        try { await ethereum.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }); }
        catch (error) { if (error.code === 4001 || error.code === -32002) throw error; }
      }
      const ctx = await connect();
      const challenge = await postJSON('/auth/challenge', { address: ctx.address });
      const signature = await ctx.signer.signMessage(challenge.message);
      saveSession(await postJSON('/auth/login', { address: ctx.address, nonce: challenge.nonce, signature }));
      return session;
    } catch (error) { throw new Error(message(error)); }
    finally { signingIn = false; }
  }
  // The active session is the one of the account MetaMask currently gives this site.
  async function restore() {
    let account = null;
    try { account = globalThis.ethereum ? (await ethereum.request({ method: 'eth_accounts' }))[0]?.toLowerCase() || null : null; }
    catch { account = null; }
    session = (account && sessions[account]) || null;
    if (!session) return null;
    try { saveSession({ ...session, ...(await api('/auth/me')) }); }
    catch (error) { if (error.status === 401) saveSession(null); else throw error; }
    return session;
  }
  async function logout() {
    try { if (session) await api('/auth/logout', { method: 'POST' }); }
    catch { /* The session is dropped locally either way. */ }
    saveSession(null);
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
  async function sync(app) { return api(`/applications/${encodeURIComponent(app.id)}/sync`, { method: 'POST' }); }
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
    return execute(app, 'submit', 'submitApplication', args, 'BORROWER_ROLE', app.borrowerWallet);
  }
  async function evaluate(app, report) {
    // The server assigns the bank/reviewer only for an evaluation that passes the 70% rule; otherwise it is empty.
    const bank = report.bankWallet || ethers.ZeroAddress;
    return execute(app, 'evaluate', 'confirmEvaluation', [app.appKey, report.cid, report.hash, BigInt(report.appraisedValue), bank], 'EVALUATOR_ROLE', app.evaluatorWallet);
  }
  // Approval creates the loan agreement on chain and the bank's RWA token. The credit grade, rate and term are
  // confidential, so the chain gets only the salted hash the server prepared for them.
  async function approve(app, yes, terms = null) {
    const args = yes ? [app.appKey, terms.termsHash] : [app.appKey];
    return execute(app, yes ? 'approve' : 'reject', yes ? 'finalApprove' : 'finalReject', args, 'BANK_ROLE', app.bankWallet);
  }
  async function repay(app, amount, reference) {
    const paymentRef = ethers.id(reference);
    return execute(app, 'repay', 'recordRepayment', [app.appKey, BigInt(amount), paymentRef], 'BANK_ROLE', app.bankWallet);
  }
  function openBlob(file, filename) {
    const url = URL.createObjectURL(file);
    const link = globalThis.document.createElement('a'); link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function readDocument(app) {
    openBlob(await blob(`/applications/${encodeURIComponent(app.id)}/document`), `${app.id}-registry.pdf`);
  }
  // Shows a token the signed-in wallet owns in MetaMask's NFT list (MetaMask checks ownership itself).
  async function watchNft(address, tokenId) {
    await connect();
    try { return await ethereum.request({ method: 'wallet_watchAsset', params: { type: 'ERC721', options: { address, tokenId: String(tokenId) } } }); }
    catch (error) {
      if (error.code === 4001) throw new Error('NFT 확인을 취소했습니다.');
      throw new Error(`MetaMask의 NFT 가져오기에서 주소 ${address}, 번호 ${tokenId}를 입력하세요.`);
    }
  }
  return { init, loadConfig, connect, login, logout, restore, api, blob, openBlob, register, evaluate, approve, repay, sync, transactionOverrides, watchNft,
    document: readDocument, config: () => cfg, session: () => session, authHeaders };
})();
