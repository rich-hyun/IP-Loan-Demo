/* Existing token ownership is verified by the server; artwork is an app preview. */
globalThis.LoanTokenCards = (() => {
  const inFlight = new Map();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const base = () => globalThis.IPLOAN_API_BASE || (['localhost','127.0.0.1'].includes(location.hostname) ? 'http://127.0.0.1:5001/api' : 'https://iploan-api.mustree.kr/api');
  const states = { issued: '발급 완료', burned: '소각 완료', pending: '미발급' };
  function placeholder(app) {
    if (!app.appKey) return '';
    return `<section class="token-gallery" data-token-app="${esc(app.id)}" aria-label="SBT·NFT 발급 정보"><div class="token-gallery-heading"><h3>SBT · NFT</h3><span>체인 발급 기록과 표지</span></div><div class="token-gallery-content" aria-live="polite">발급 기록 확인 중…</div></section>`;
  }
  function tokenHTML(token, appId) {
    const issued = token.state === 'issued';
    const image = token.imageUrl && /^https?:\/\//.test(token.imageUrl) ? token.imageUrl : `${base()}/applications/${encodeURIComponent(appId)}/token-cards/${token.kind}.png`;
    return `<article class="token-card ${esc(token.kind)}"><div class="token-card-art"><img src="${esc(image)}" alt="${esc(token.label)} · 신청 ${esc(appId)} 표지" loading="lazy"><span class="token-state ${esc(token.state)}">${states[token.state] || '확인 필요'}</span></div>
      <div class="token-card-info"><h4>${esc(token.label)}</h4><dl><div><dt>Token ID</dt><dd>${token.state === 'pending' ? '미발급' : '#' + esc(token.tokenId)}</dd></div><div><dt>${issued ? '현재 소유 지갑' : token.state === 'burned' ? '발급 당시 평가사' : '수령 예정 지갑'}</dt><dd class="token-address">${esc(token.owner || token.recipient || '평가 통과 후 배정')}</dd></div><div><dt>토큰 계약 주소</dt><dd class="token-address">${esc(token.contractAddress)}</dd></div><div><dt>네트워크</dt><dd>Chain ${esc(token.chainId)}</dd></div></dl>
      ${token.metadataUri ? `<p class="token-address">tokenURI: ${esc(token.metadataUri)}</p>` : ''}
      <div class="token-card-actions"><button type="button" class="btn btn-outline btn-sm" data-copy="${esc(token.contractAddress)}">계약 주소 복사</button>${issued ? `<button type="button" class="btn btn-outline btn-sm" data-copy="${esc(token.tokenId)}">Token ID 복사</button>` : ''}<a class="btn btn-outline btn-sm" href="${esc(image)}" target="_blank" rel="noopener">표지 크게 보기</a></div>
      ${token.state === 'burned' ? '<p class="token-card-caption">평가 확정으로 소각된 열람권입니다.</p>' : !issued ? '<p class="token-card-caption">표지 미리보기이며 아직 발급된 토큰이 아닙니다.</p>' : ''}</div></article>`;
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
        root.querySelector('.token-gallery-content').innerHTML = `<div class="token-card-grid">${data.tokens.map(t => tokenHTML(t, app.id)).join('')}</div><p class="token-gallery-note">${data.walletImageAvailable ? '이미지와 메타데이터는 실제 IPFS에 업로드되었으며 tokenURI에 연결되어 있습니다.' : data.artworkSource === 'ipfs' ? '이미지와 메타데이터의 IPFS 업로드가 완료되었습니다. 온체인 발급은 대기 중입니다.' : '표지는 신청 정보로 생성한 앱 미리보기입니다. 기존 발급 토큰의 메타데이터에는 이미지가 없습니다.'} MetaMask에서는 수령 계정과 네트워크를 선택한 뒤 토큰 계약 주소·Token ID로 가져올 수 있습니다. 소각된 SBT는 현재 보유 토큰으로 가져올 수 없습니다.</p><p class="token-gallery-note">체인 상태 ${esc(data.chainStatus)} · 조회 블록 ${esc(data.tokens[0].chainBlock)}</p>`;
        for (const button of root.querySelectorAll('[data-copy]')) button.onclick = async () => {
          try { await navigator.clipboard.writeText(button.dataset.copy); button.textContent = '복사됨'; }
          catch { button.textContent = '직접 주소를 복사해 주세요'; }
        };
      }
    } catch (error) {
      for (const root of document.querySelectorAll('[data-token-app]')) if (root.dataset.tokenApp === app.id) {
        root.querySelector('.token-gallery-content').textContent = error.message;
      }
    }
  }
  return { placeholder, load };
})();
