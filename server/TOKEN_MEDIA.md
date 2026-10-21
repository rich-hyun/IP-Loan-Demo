# SBT·NFT 카드 UI

`feat/token-card-design`의 `e55b582` 이미지 생성기를 통합했다. `server/token_media.py`는 번들 IBM Plex 글꼴(Plex Sans KR·Mono, SIL OFL 1.1)과 Pillow로 1200×1200 PNG를 생성한다. 외부 AI나 별도 API 키는 필요 없다.

## 현재 구현

- 신청 상세, 통합 평가사 검토, 은행 심사 화면에 SBT·NFT 카드 두 장을 표시한다.
- 실제 로컬/설정 RPC의 계약 상태와 소유권을 검증한 뒤 발급 완료·소각 완료·미발급을 구분한다. 카드 그림이 준비됐다는 이유로 발급 완료로 표시하지 않는다.
- 토큰 계약 주소, Token ID, 수령/소유 지갑과 체인 ID를 표시한다. 계약 주소·발급된 ID 복사와 원본 카드 크게 보기를 제공한다. Manager 주소와 토큰 계약 주소를 구분한다.
- 평가 확정으로 소각된 SBT는 발급 이력용 표지이며 현재 소유 지갑은 없다. 승인/완납한 채권 NFT만 은행의 현재 보유 토큰으로 표시한다.
- `GET /api/applications/<id>/tokens`는 계약과 DB의 바인딩을 검증한다. RPC 실패나 상태 불일치를 발급 완료로 대체하지 않는다.
- `GET /api/applications/<id>/token-cards/sbt.png`, `debt.png`는 앱 미리보기 PNG다. 입력은 기존 공개 신청 정보 중 신청번호·기업명·대표자명·IP 제목 네 필드로 제한한다. 원본 PDF·사업자번호·연락처·AES 키·salt를 렌더러에 전달하지 않는다. 렌더링 결과는 제한된 메모리 캐시와 ETag를 사용한다.

## 실제 IPFS 이미지와 신규 발급

새 Manager는 기존 `contractVersion() == 2`에 더해 `tokenMediaVersion() == 1`을 제공한다. 서버가 실제 배포 계약에서 capability를 조회한다. 대출 신청의 암호화 PDF 업로드 후 `token_media.prepare()`가 SBT PNG/JSON, 채권 NFT PNG/JSON을 실제 업로드 함수로 전송한다. JSON의 `image`는 `ipfs://<PNG CID>`이다. 두 이미지 URI·두 메타데이터 URI와 이름을 신청에 저장한다. 재제출은 같은 신청과 URI를 반환한다. 네 자산 업로드가 모두 성공해야 신청과 평가 작업을 생성한다. 부분 실패로 이미 업로드된 자산은 남을 수 있지만 신청·평가 작업은 생성되지 않는다.

차주가 MetaMask로 `submitApplicationWithMetadata` 거래를 승인하면 두 JSON URI가 신청에 함께 고정된다. SBT의 `tokenURI`와 최종승인 때 은행에 발급되는 NFT의 `tokenURI`가 각각 해당 JSON을 반환한다. URI 변경 setter는 없다. 채권 발급 시 별도 메타데이터 거래나 재업로드는 필요 없다. 계약은 `ipfs://`와 영숫자 CID 형식을 요구하며 HTTP 주소·경로·쿼리를 거부한다. 실제 CID 조회는 오프체인에서 검증한다.

**기존 배포 토큰의 tokenURI는 그대로 보존한다.** 기존 계약에 capability 함수가 없으면 legacy 경로를 유지한다. RPC 장애는 capability 미지원으로 숨기지 않는다. 기존 승인 건의 DB·체인을 새 계약으로 바꾸지 않는다. 카드 API는 실제 상태·소유권·신청과 저장된 tokenURI의 일치를 검증한다. `walletImageAvailable`은 온체인 연결 확인을 뜻하며 MetaMask의 실제 이미지 렌더링 성공을 뜻하지 않는다.

공개 JSON과 PNG에는 신청번호·기업명·대표자명·IP 제목만 사용한다. 실제 이름을 사용하는 경우 IPFS 공개 자산에 포함됨을 고려해야 한다. 현재 검증은 명시적 테스트 이름을 사용한다. MetaMask에서 수령 계정과 네트워크를 선택한 뒤 NFT 계약 주소·Token ID로 가져온다. Manager 주소와 NFT 주소는 다르다. 소각된 SBT는 현재 보유 NFT로 가져올 수 없다.

## 로컬 실행

새 로컬 실행은 저장소 루트의 `start-local.ps1`을 사용한다. 이미 최종승인한 8003 세션을 유지하며 UI·API만 갱신하려면 다음을 실행한다.

이미지 tokenURI를 신규 발급에서 검증하려면 기존 세션을 유지한 채 별도 네트워크로 실행한다.

```powershell
$env:IPLOAN_LOCAL_BORROWER = '0xcdfBfb91DE6a35f243c10c8a291B632A7F20156e'
.\start-local.ps1 -Port 8005 -RpcPort 8546 -ChainId 31338 -DataGroup local-media
```

새 실행은 새 개발 체인·DB를 만든다. 기록은 `output/local-media/session-*`, 최신 설정은 `output/local-media/latest.json`이다. 재실행이 이전 체인을 복원하지 않으므로 실행 중 프로세스를 유지한다. 실제 API는 기존 `server/.env`를 사용하며 `-Fixture`를 지정하지 않는다. 사이트 연결 계정이 다르면 상단 **MetaMask 계정 다시 선택**에서 필요한 역할 계정만 선택한다. **실제 등록특허 PDF 첨부**는 준비된 공개 등록공보 한 건만 첨부한다.

아래는 기존 승인 세션의 UI만 갱신하는 명령이다.

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

추가 테스트는 중복 업로드 방지·부분 업로드 실패·URI 불일치 거부와 immutable URI·권한·SBT 소각·은행 NFT 발급·상환 후 URI 보존·legacy 경로를 검사한다. 2026-10-21 실제 업로드 preflight에서 두 JSON과 1200×1200 PNG의 프로젝트 게이트웨이 HTTP 200 및 해시 일치를 확인했다. 증거는 Git 제외 `output/local-media/ipfs-preflight/proof.json`이다. 공용 ipfs.io는 429를 반환했다. 이 preflight는 실제 토큰 발급이 아니며 새 계약에서 MetaMask 발급·지갑 이미지 표시는 검증 진행 중이다. 지갑 게이트웨이·캐시·자동탐지 설정에 따라 실제 표시는 실패할 수 있어 별도 확인이 필요하다. 최종 검증 범위는 `LOAN_WORKFLOW_VALIDATION.md`의 최신 기록을 따른다.

### MetaMask 이미지 미표시 진단

사용자는 31338의 SBT 1 가져오기에는 성공했지만 이미지가 안 보인다고 확인했다. 현재 조회에서 프로젝트 경로형 게이트웨이는 JSON 200을 반환하지만 dweb.link는 시간 초과, ipfs.io는 403, cloudflare-ipfs.com은 DNS 실패였다. 최신 MetaMask Core는 게이트웨이 비활성 시 IPFS 메타데이터 조회를 생략하고, 기본 서브도메인 모드에서는 CIDv1을 `https://<cid>.ipfs.<gateway>/`로 변환한다. `rwa-gw.mustree.kr`의 해당 서브도메인 DNS도 실패하므로 **프로젝트 게이트웨이 주소를 설정하는 것만으로 해결된다고 보장할 수 없다.** 설치된 지갑의 실제 설정·조회 오류 확인과 게이트웨이 호환성이 남아 있다. 기존 토큰 URI를 덮어쓰거나 이미지 표시 완료로 보고하지 않는다.

근거: [NFT 조회 구현](https://github.com/MetaMask/core/blob/main/packages/assets-controllers/src/NftController.ts), [IPFS URL 변환](https://github.com/MetaMask/core/blob/main/packages/assets-controllers/src/assetsUtil.ts). 최신 UI는 설정의 Privacy에 IPFS gateway, Assets에 NFT media 표시가 있으며 설치 버전에 따라 다를 수 있다.
