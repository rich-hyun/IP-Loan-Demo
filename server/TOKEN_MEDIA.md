# SBT·NFT 카드 UI

`feat/token-card-design`의 `e55b582` 이미지 생성기를 통합했다. `server/token_media.py`는 번들 IBM Plex 글꼴(Plex Sans KR·Mono, SIL OFL 1.1)과 Pillow로 1200×1200 PNG를 생성한다. 외부 AI나 별도 API 키는 필요 없다.

## 현재 구현

- 신청 상세, 통합 평가사 검토, 은행 심사 화면에 SBT·NFT 카드 두 장을 표시한다.
- 실제 로컬/설정 RPC의 계약 상태와 소유권을 검증한 뒤 발급 완료·소각 완료·미발급을 구분한다. 카드 그림이 준비됐다는 이유로 발급 완료로 표시하지 않는다.
- 토큰 계약 주소, Token ID, 수령/소유 지갑과 체인 ID를 표시한다. 계약 주소·발급된 ID 복사와 원본 카드 크게 보기를 제공한다. Manager 주소와 토큰 계약 주소를 구분한다.
- 평가 확정으로 소각된 SBT는 발급 이력용 표지이며 현재 소유 지갑은 없다. 승인/완납한 채권 NFT만 은행의 현재 보유 토큰으로 표시한다.
- `GET /api/applications/<id>/tokens`는 계약과 DB의 바인딩을 검증한다. RPC 실패나 상태 불일치를 발급 완료로 대체하지 않는다.
- `GET /api/applications/<id>/token-cards/sbt.png`, `debt.png`는 앱 미리보기 PNG다. 입력은 기존 공개 신청 정보 중 신청번호·기업명·대표자명·IP 제목 네 필드로 제한한다. 원본 PDF·사업자번호·연락처·AES 키·salt를 렌더러에 전달하지 않는다. 렌더링 결과는 제한된 메모리 캐시와 ETag를 사용한다.

## 최소 HTTPS 이미지 연결 (`997f3ae` 기준)

신규 메타데이터 지원 계약(`tokenMediaVersion=2`)을 사용하는 경우, 기존 신청 접수 경로에서 생성기 `prepare(..., https=True)`를 호출한다. PNG와 JSON은 기존 IPFS 업로드 함수로 저장한다. JSON의 image와 두 토큰의 tokenURI는 모두 `https://rwa-gw.mustree.kr/ipfs/<CID>`이다. 기존 공개 HTTPS 게이트웨이가 IPFS 파일을 제공하며, 사용자 MetaMask의 IPFS 게이트웨이 설정 변경은 필요 없다. 별도 운영 서버나 CDN은 이번 변경에서 배포하지 않는다.

차주의 기존 신청 등록 거래 `submitApplicationWithMetadata`에서 SBT·채권 NFT의 HTTPS JSON URI를 함께 고정한다. 기존 SBT 발급·평가사 확정·LTV·은행 최종승인 순서는 그대로다. 최종승인은 기존 `finalApprove`를 사용하며 메타데이터 전용 추가 거래는 없다. URI는 변경할 수 없고 고정 게이트웨이의 영숫자 CID 경로만 허용한다. 다른 호스트·HTTP·추가 경로·쿼리는 거부한다. 계약과 서버의 게이트웨이가 다르면 신규 접수를 실패 처리한다.

두 PNG·두 JSON 업로드가 모두 끝나야 신청을 저장한다. 재요청은 기존 중복 방지 로직에 따라 저장된 URI를 재사용한다. 부분 업로드 실패 시 원격 IPFS에 일부 자산은 남을 수 있지만 신청·평가 작업은 생성하지 않는다. 공개 JSON에는 기존 카드의 신청번호·기업명·테스트 대표자명·IP 제목만 사용하며 문서·보고서·암호키는 넣지 않는다.

기존 승인 토큰과 DB는 소급 변경하지 않는다. capability가 없는 기존 계약은 원래 제출 방식과 base64 tokenURI를 유지하며 앱 미리보기만 제공한다. 새 계약이 필요한 이유는 기존 계약에 URI 변경 함수가 없기 때문이다. 기존 서명·인증·평가·심사 코드는 `997f3ae`와 동일하다. 지갑 계정 선택 버튼, 읽기 인증 변경, 새 로컬 체인 옵션 등 이후 시도의 변경은 포함하지 않았다.

MetaMask는 tokenURI를 조회하여 이미지를 가져온다. HTTPS 연결이 되어도 지갑 자체의 NFT 미디어 차단·가져오기·캐시 동작까지 앱이 강제할 수는 없다. 소각된 SBT는 현재 보유 NFT로 가져올 수 없다. MetaMask의 'NFT 미디어 표시' 설정이 꺼져 있으면 https tokenURI를 조회하지 않아 이미지와 이름 없이 표시된다.

## 로컬 실행

새 로컬 실행은 저장소 루트의 `start-local.ps1`을 사용한다. 이미 최종승인한 8003 세션을 유지하며 UI·API만 갱신하려면 다음을 실행한다.

```powershell
cd blockchain
node scripts/local-ui.mjs
# http://127.0.0.1:8004/
```

이 명령은 `output/local-real/latest.json`의 기존 DB·RPC에 연결하고 저장된 신청의 체인 바인딩을 검증한다. 기존 8003 프로세스가 개발 체인을 제공하므로 계속 실행해 둔다. 8004를 종료해도 기존 체인을 종료하지 않는다. 이전 로컬 DB를 새로 초기화된 체인에 연결하면 검증이 실패한다.

## 검증

```powershell
$env:PYTHONPATH="$PWD/server"
server/venv/Scripts/python.exe -m unittest server.test_token_media server.test_token_cards_api -q
node --test js/token-cards.test.cjs js/app.test.cjs js/chain.test.cjs js/admin.test.cjs
```

렌더링·ETag·개인 필드 배제·잘못된 신청·RPC 실패·미발급/소각/발급 상태·HTML 이스케이프를 검사한다. 기존 승인 건 LN-2026-4233에 대해 브라우저에서 생성 PNG 두 장과 NFT 계약 주소·Token ID 1·은행 소유권 표시를 확인했다. 운영 배포나 새 NFT 거래를 만들지 않았다.
