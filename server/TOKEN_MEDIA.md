# SBT·NFT 카드 UI

`feat/token-card-design`의 `e55b582` 이미지 생성기를 통합했다. `server/token_media.py`는 번들 IBM Plex 글꼴(Plex Sans KR·Mono, SIL OFL 1.1)과 Pillow로 1200×1200 PNG를 생성한다. 외부 AI나 별도 API 키는 필요 없다.

## 현재 구현

- 신청 상세, 통합 평가사 검토, 은행 심사 화면에 SBT·NFT 카드 두 장을 표시한다.
- 실제 로컬/설정 RPC의 계약 상태와 소유권을 검증한 뒤 발급 완료·소각 완료·미발급을 구분한다. 카드 그림이 준비됐다는 이유로 발급 완료로 표시하지 않는다.
- 토큰 계약 주소, Token ID, 수령/소유 지갑과 체인 ID를 표시한다. 계약 주소·발급된 ID 복사와 원본 카드 크게 보기를 제공한다. Manager 주소와 토큰 계약 주소를 구분한다.
- 평가 확정으로 소각된 SBT는 발급 이력용 표지이며 현재 소유 지갑은 없다. 승인/완납한 채권 NFT만 은행의 현재 보유 토큰으로 표시한다.
- `GET /api/applications/<id>/tokens`는 계약과 DB의 바인딩을 검증한다. RPC 실패나 상태 불일치를 발급 완료로 대체하지 않는다.
- `GET /api/applications/<id>/token-cards/sbt.png`, `debt.png`는 앱 미리보기 PNG다. 입력은 기존 공개 신청 정보 중 신청번호·기업명·대표자명·IP 제목 네 필드로 제한한다. 원본 PDF·사업자번호·연락처·AES 키·salt를 렌더러에 전달하지 않는다. 렌더링 결과는 제한된 메모리 캐시와 ETag를 사용한다.

## 지갑 이미지와의 구분

**현재 발급된 v2 토큰의 tokenURI에는 image 필드가 없다. 이번 UI는 그 메타데이터나 기존 계약을 변경하지 않는다.** 화면에 표시하는 생성 표지는 앱 미리보기이며 MetaMask에서 동일 이미지가 표시된다고 주장하지 않는다. 발급된 NFT는 MetaMask 수령 계정과 네트워크를 선택한 뒤 토큰 계약 주소·Token ID로 가져올 수 있다. 소각된 SBT는 현재 보유 NFT로 가져올 수 없다.

이미지 JSON을 tokenURI에 연결하려면 별도로 계약의 메타데이터 지원과 신규 발급 흐름을 설계·배포해야 한다. `e55b582`의 이전 문서에 적혀 있던 `tokenMediaVersion`, `submitApplicationWithMetadata`, `finalApproveWithMetadata`는 해당 커밋에 구현되어 있지 않아 완료 기능으로 안내하지 않는다. 생성기의 `prepare()`는 PNG와 JSON을 IPFS에 업로드할 수 있는 재사용 함수이며 현재 신청 접수 경로에서 자동 호출하지 않는다.

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
