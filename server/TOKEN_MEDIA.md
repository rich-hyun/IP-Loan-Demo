# NFT·SBT 이미지 발급

신규 온체인 신청에서는 서버가 신청번호·기업명·대표자명·IP 제목을 사용해 1200×1200 PNG 두 장을 생성한다. 열람 SBT는 네이비, 채권 NFT는 코퍼 색이며, 두 장을 SBT·NFT 순으로 나란히 놓으면 배경 동심원이 이어진다. 외부 AI 호출이나 별도 API 키는 사용하지 않는다. 카드 본문에는 신청 IP 제목만 표시하며, `평가보고서` 문구를 덧붙이지 않는다. 메타데이터의 보고서 속성에는 보고서 종류를 함께 기록한다.

각 이미지와 공개 메타데이터 JSON을 기존 `IPLOAN_IPFS_UPLOAD_URL`로 업로드한다. JSON은 `name`, `description`, `image: ipfs://<image CID>`, `attributes`를 포함한다. JSON CID를 SQLite 신청에 저장하고 지갑 거래에서 계약에 전달한다. 이미지나 JSON 업로드가 실패하면 신청 접수를 완료하지 않으며 지갑 발급으로 진행하지 않는다. 업로드 일부가 성공한 뒤 실패하면 미참조 IPFS 파일이 남을 수 있다.

- 신청 등록: 차주의 `submitApplicationWithMetadata(..., sbtMetadataUri)` 거래가 평가자에게 SBT를 발급한다.
- 평가 확정: 기존대로 SBT가 소각된다. 소각된 SBT는 메타마스크의 현재 보유 NFT로 표시할 수 없다.
- 최종 승인: 은행의 `finalApproveWithMetadata(appKey, debtMetadataUri)` 거래가 은행에게 NFT를 발급한다.
- `tokenURI(tokenId)`는 해당 공개 JSON의 IPFS URI를 반환한다.
- 메타데이터와 이미지는 신청 시 미리 준비한다. 실제 발급 여부·현재 상태·상환금액은 계약 및 신청 화면에서 확인한다. 공개 JSON은 최초 발급용 표지이며 상환 때 갱신하지 않는다.

기존 ABI 함수는 이전 흐름의 호환성을 위해 보존한다. 새 웹은 이미지 메타데이터가 있는 새 발급 함수만 사용한다. 기존 함수로 직접 발급한 토큰은 기존 기본 메타데이터를 반환한다. 배포 계약은 `contractVersion() == 2`, `tokenMediaVersion() == 1`이어야 한다.

## 설치와 새 계약 연결

1. `server/requirements.txt`를 설치한다(Pillow 추가).
2. 카드 글꼴(IBM Plex Sans KR·Mono, SIL OFL 1.1)은 `server/fonts/`에 포함되어 있어 OS와 관계없이 같은 이미지가 생성된다. 별도 설치나 환경변수는 필요 없다. 글꼴 파일이 없으면 명확한 오류를 반환한다.
3. `blockchain` 폴더에서 `npm run compile`을 실행한다.
4. `admin.html`에서 관리자 지갑으로 새 Manager를 배포한다. 기존 Mustsem 배포 주소는 이 기능이 없는 이전 계약이다. 새 계약에는 차주 등 필요한 역할을 다시 등록한다.
5. 서버 환경변수 `IPLOAN_MANAGER_ADDRESS`를 새 주소로 설정한다. 기존 신청이 이전 계약에 묶여 있으므로 새 DB 경로도 지정한다(예: `IPLOAN_DB_PATH=/절대경로/iploan-mustsem-media.db`). 이전 DB·배포 증적은 보존한다. 서버를 다시 시작한다.
6. `/api/chain/config`의 `tokenMediaVersion`이 `1`인지 확인하고 새 신청으로 발급한다.

이 변경은 이미 배포된 계약 또는 이미 발급한 토큰을 수정하지 않는다. 실제 체인의 배포·지갑 서명과 메타마스크 표시 검증은 운영 지갑에서 수행해야 한다. 서버는 거래를 대신 서명하지 않는다.

## 메타마스크 확인

신청 상세·통합 평가·은행 심사 화면에 이미지 미리보기, NFT 이름, 발급된 Token ID 및 NFT 계약 주소를 표시한다. 웹 미리보기의 게이트웨이는 `IPLOAN_IPFS_GATEWAY`를 사용한다(기본 `https://rwa-gw.mustree.kr/ipfs/`).

메타마스크에서 해당 네트워크와 수령자 계정을 선택한다. 자동 표시되지 않으면 NFT 탭의 **NFT 가져오기**에 **SBT 또는 NFT 계약 주소**와 Token ID를 입력한다. Manager 주소와 구분한다. Mustsem에서는 자동 탐지를 전제로 하지 않는다. IPFS 파일이 공개적으로 조회 가능하고 지속적으로 보관되어야 하며, 지갑 캐시·게이트웨이·네트워크 지원에 따라 표시가 지연되거나 제한될 수 있다.

이미지와 JSON에 포함되는 기업명·대표자명·IP 제목은 공개된다. 원본 PDF, 전화번호, 사업자번호, AES 키, salt는 공개 이미지·메타데이터에 넣지 않는다.

## 검증

- `server/venv/Scripts/python.exe -m unittest server.test_token_media server.test_app server.test_loan_workflow -q` (Windows)
- `node --test js/chain.test.cjs js/admin.test.cjs js/app.test.cjs`
- `blockchain` 폴더에서 `node --test test/mvp.test.mjs test/integration.test.mjs test/workflow.test.mjs`

검증은 임시 DB·로컬 EVM·가짜 IPFS로 수행한다. 실제 IPFS 업로드나 Mustsem 거래를 발생시키지 않는다.
