/* Existing token ownership is verified by the server; artwork is an app preview. */
globalThis.LoanTokenCards = (() => {
  const inFlight = new Map();
  const walletRequests = new Set();
  // Each recipient role sees only its own token: evaluator → SBT, lender → debt NFT.
  const ROLE_TOKEN = { evaluator: 'sbt', lender: 'debt' };
  const roleKind = () => typeof currentRole === 'undefined' ? undefined : ROLE_TOKEN[currentRole];
  function walletError(error) {
    if (error.code === 4001) return '토큰 추가를 취소했습니다. 다시 누를 수 있습니다.';
    if (error.code === -32002) return 'MetaMask에 대기 중인 요청을 먼저 확인해 주세요.';
    if (error.code === -32601 || error.code === 4200) return '이 지갑은 NFT 추가 요청을 지원하지 않습니다. MetaMask 확장 프로그램에서 다시 시도해 주세요.';
    return error.message;
  }
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const base = () => globalThis.IPLOAN_API_BASE || (['localhost','127.0.0.1'].includes(location.hostname) ? 'http://127.0.0.1:5001/api' : 'https://iploan-api.mustree.kr/api');
  const states = { issued: '발급 완료', burned: '소각 완료' };
  function placeholder(app) {
    const kind = roleKind();
    if (!app.appKey || !kind) return '';
    return `<section class="token-gallery" data-token-app="${esc(app.id)}" data-token-kind="${kind}" aria-label="${kind === 'sbt' ? 'SBT' : 'NFT'} 발급 정보"><div class="token-gallery-heading"><h3>${kind === 'sbt' ? 'SBT' : 'NFT'}</h3><span>체인 발급 기록과 표지</span><span class="token-gallery-action" data-token-action></span></div><div class="token-gallery-content" aria-live="polite">발급 기록 확인 중…</div></section>`;
  }
  function tokenHTML(token, appId) {
    const issued = token.state === 'issued';
    const image = token.imageUrl && /^https?:\/\//.test(token.imageUrl) ? token.imageUrl : `${base()}/applications/${encodeURIComponent(appId)}/token-cards/${token.kind}.png`;
    return `<article class="token-card ${esc(token.kind)}"><div class="token-card-art"><img src="${esc(image)}" alt="${esc(token.label)} · 신청 ${esc(appId)} 표지" loading="lazy"><span class="token-state ${esc(token.state)}">${states[token.state] || '확인 필요'}</span></div>
      <div class="token-card-info"><h4>${esc(token.label)}</h4><dl><div><dt>Token ID</dt><dd>#${esc(token.tokenId)}</dd></div><div><dt>${issued ? '현재 소유 지갑' : '발급 당시 평가사'}</dt><dd class="token-address">${esc(token.owner || token.recipient)}</dd></div><div><dt>토큰 계약 주소</dt><dd class="token-address">${esc(token.contractAddress)}</dd></div><div><dt>네트워크</dt><dd>Chain ${esc(token.chainId)}</dd></div></dl>
      ${token.metadataUri ? `<p class="token-address">tokenURI: ${esc(token.metadataUri)}</p>` : ''}
      ${issued ? '<p class="token-card-caption" data-wallet-status role="status"></p>' : ''}
      ${token.state === 'burned' ? '<p class="token-card-caption">평가 확정으로 소각된 열람권입니다.</p>' : ''}</div></article>`;
  }
  async function addToWallet(token) {
    if (token.state !== 'issued' || !token.owner) throw new Error('현재 보유 중인 발급 토큰만 추가할 수 있습니다.');
    if (!globalThis.ethereum) throw new Error('MetaMask가 설치된 브라우저에서 열어 주세요.');
    if (BigInt(await ethereum.request({ method: 'eth_chainId' })) !== BigInt(token.chainId)) {
      throw new Error(`MetaMask 네트워크를 Chain ${token.chainId}로 전환한 뒤 다시 눌러 주세요.`);
    }
    let accounts = await ethereum.request({ method: 'eth_accounts' });
    if (!accounts.length) accounts = await ethereum.request({ method: 'eth_requestAccounts' });
    if (accounts[0]?.toLowerCase() !== token.owner.toLowerCase()) {
      throw new Error(`수령 지갑 ${token.owner}를 이 사이트에 연결한 뒤 다시 눌러 주세요.`);
    }
    // ERC721 metadata and image are read from the actual on-chain tokenURI.
    return await ethereum.request({ method: 'wallet_watchAsset', params: {
      type: 'ERC721', options: { address: token.contractAddress, tokenId: String(token.tokenId) }
    } });
  }
  async function load(app) {
    let work = inFlight.get(app.id);
    if (!work) {
      work = fetch(`${base()}/applications/${encodeURIComponent(app.id)}/tokens`).then(async res => {
        const data = await res.json(); if (!res.ok) throw new Error(data.message || '토큰 발급 기록을 확인하지 못했습니다.'); return data;
      }).finally(() => inFlight.delete(app.id));
      inFlight.set(app.id, work);
    }
    try {
      const data = await work;
      for (const root of document.querySelectorAll('[data-token-app]')) {
        if (root.dataset.tokenApp !== app.id) continue;
        // A token that has not been minted yet is not shown at all.
        const tokens = data.tokens.filter(t => t.kind === root.dataset.tokenKind && t.state !== 'pending');
        root.hidden = !tokens.length;
        if (!tokens.length) continue;
        const note = data.walletImageAvailable ? '' : '표지는 신청 정보로 생성한 앱 미리보기입니다. 기존 발급 토큰의 메타데이터에는 이미지가 없습니다.';
        root.querySelector('.token-gallery-content').innerHTML = `<div class="token-card-grid">${tokens.map(t => tokenHTML(t, app.id)).join('')}</div>${note ? `<p class="token-gallery-note">${note}</p>` : ''}<p class="token-gallery-note">체인 상태 ${esc(data.chainStatus)} · 조회 블록 ${esc(data.tokens[0].chainBlock)}</p>`;
        const issuedToken = tokens.find(t => t.state === 'issued');
        root.querySelector('[data-token-action]').innerHTML = issuedToken ? `<button type="button" class="btn btn-primary btn-sm" data-watch-token="${esc(issuedToken.kind)}">MetaMask에 추가</button>` : '';
        for (const button of root.querySelectorAll('[data-watch-token]')) button.onclick = async () => {
          const token = tokens.find(t => t.kind === button.dataset.watchToken);
          const key = `${token.chainId}:${token.contractAddress}:${token.tokenId}`;
          const status = root.querySelector('[data-wallet-status]');
          if (walletRequests.size) { status.textContent = 'MetaMask에 대기 중인 요청을 먼저 확인해 주세요.'; return; }
          walletRequests.add(key); button.disabled = true; status.textContent = 'MetaMask의 토큰 추가 창을 확인해 주세요.';
          try {
            const added = await addToWallet(token);
            status.textContent = added ? 'MetaMask 추가 요청이 승인됐습니다. 지갑 NFT 목록에서 이미지를 확인해 주세요.' : '토큰 추가를 취소했습니다. 다시 누를 수 있습니다.';
          } catch (error) {
            status.textContent = walletError(error);
          } finally { walletRequests.delete(key); button.disabled = false; }
        };
      }
    } catch (error) {
      for (const root of document.querySelectorAll('[data-token-app]')) if (root.dataset.tokenApp === app.id) {
        root.querySelector('.token-gallery-content').textContent = error.message;
      }
    }
  }
  return { placeholder, load, addToWallet };
})();
