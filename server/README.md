# Flask API — v3 통합 MVP

한 서버(`server/app.py`)가 지갑 로그인, 대출 신청, LLM 가치평가보고서 작업, 체인 동기화를 모두 처리한다.
서버는 `contractVersion() == 3`인 Manager에만 연결하며 개인키를 갖지 않는다. 거래는 각 담당자가 MetaMask로 서명한다.
설계와 API 전체는 [설계 문서](../docs/대출신청-암호화-토큰-설계.md)에 정리했다.

```bash
cd IP-Loan-Demo  # 저장소 루트
IPLOAN_MANAGER_ADDRESS=<v3 Manager 주소> bash blockchain/scripts/start-mustsem-api.sh
```

설치·서버 시작·MetaMask 배포·단계별 확인은 [WSL 통합 테스트 가이드](../blockchain/README.md)를 따른다.
계약 artifact와 web3 의존성도 필요하므로 server 폴더만 복사해 배포하지 않는다.

## 설정

| 환경변수 | 기본값/의미 |
|---|---|
| PORT | 5001 (`python app.py`로 직접 실행할 때) |
| IPLOAN_DB_PATH | server/iploan.db |
| IPLOAN_UPLOAD_DIR | server/uploads — 특허 공고전문 보관(0600) |
| IPLOAN_PATENT_DB_PATH | server/patent-iploan.db — 이전 특허평가 화면 DB. 있으면 LLM 보고서를 보관 건으로 가져온다(읽기 전용) |
| IPLOAN_RPC_URL | https://block.mustree.kr |
| IPLOAN_CHAIN_ID | 7601 |
| IPLOAN_MANAGER_ADDRESS | 기본 없음. v3 Manager 필요(없으면 로그인·신청 불가) |
| IPLOAN_ZERO_GAS_PRICE | 0. Mustsem에서 1이면 gasPrice 0 거래를 요청 |
| IPLOAN_ASSIGNMENT_EVALUATOR | 비우면 등록된 평가사 중 임의 배정. 지정 시 그 주소만(역할 없으면 신청 거절) |
| IPLOAN_ASSIGNMENT_BANK | 비우면 등록된 은행 중 임의 배정. 지정 시 그 주소만(역할 없으면 평가 확정 준비 거절) |
| IPLOAN_ALLOWED_ORIGINS | https://iploan.mustree.kr,http://127.0.0.1:8001,http://localhost:8001 — CORS 허용 프론트 |
| IPLOAN_ROLE_CACHE_SECONDS | 30 — 체인 역할 조회 캐시 |
| IPLOAN_IPFS_UPLOAD_URL | https://api.mustree.kr/upload |
| IPLOAN_IPFS_GATEWAY | https://rwa-gw.mustree.kr/ipfs/ |
| IPLOAN_MAX_DOCUMENT_BYTES | 20971520 (원부). 공고전문은 50 MiB |
| IPLOAN_PATENT_API_URL / IPLOAN_PATENT_API_TOKEN | LLM 특허평가 API. `server/.env`에만 둔다. [PATENT_API.md](PATENT_API.md) |

.env.example은 참고용이다. `server/patent_api.py`는 `server/.env`의 `IPLOAN_PATENT_*` 값을 직접 읽는다.

## 보안 범위

- 로그인은 지갑 서명(5분 1회용 챌린지)으로 하고 세션 토큰은 해시로만 저장한다. 역할은 요청마다 체인에서 읽는다.
- 신청 목록·상태·보고서·원본은 그 신청의 차주·담당 평가사·담당 은행(관리자는 열람)만 볼 수 있다.
  계약 자동심사(70%)로 거절된 건은 담당 은행이 없으므로 은행 역할 지갑이 열람만 할 수 있다(약정·동기화 불가).
- 관리자는 신청 한 건의 서버 기록(신청·보고서 작업·등록 보고서·보관 공고전문)을 삭제할 수 있다. 체인 기록과 토큰은 지울 수 없고,
  암호화 키가 함께 삭제되어 IPFS의 원부·보고서 암호문은 다시 열 수 없다. `deleted_applications`에 신청번호·삭제자·시각만 남긴다.
- /sync는 실제 체인 상태만 반영한다. 클라이언트가 보낸 tokenId·status·상환금액·담당자 주소를 쓰지 않는다.
- 원부와 평가보고서는 AES-256-GCM으로 암호화해 IPFS에 올린다. 키·salt는 SQLite에만 있고 API로 내보내지 않는다.
  SQLite 백업도 비밀 데이터로 취급한다. DB와 암호문을 잃으면 원본 복구가 불가능할 수 있다.
- 신용등급은 심사역이 은행 CB 조회 결과를 입력한다. 평가 API가 회사자료(TCB 보고서)의 등급(`credit_rating`)을 주면 그 값을 미리 채운다.
- LLM 보고서 API의 산정액·재무는 형식을 검증해 저장한다. 재무 점검은 참고용이며 자료가 없으면 판정 불가로 둔다.
- 원부 진위 대조는 mock이다. 실제 개인정보·영업비밀을 쓰지 않는다.

## 자동 테스트

```bash
cd IP-Loan-Demo  # 저장소 루트
server/.venv/bin/python -m unittest server.test_app server.test_patent_api server.test_participant_assignment server.test_report_summary -v
node --test js/app.test.cjs js/chain.test.cjs js/admin.test.cjs
cd blockchain
npm test
```

서버 테스트는 임시 DB와 mock 체인·IPFS·LLM 서비스를 쓴다. 실제 EVM 통합 테스트(blockchain/test)는 임시 Flask 서버와
mock IPFS·LLM으로 로그인부터 약정·상환까지 실행한다. 수동 프론트 테스트는 실제 회사 IPFS를 호출하므로 반드시 가상 PDF만 사용한다.

## 운영 반영 순서 (v2 → v3)

운영 API는 이 폴더에서 바로 실행된다. 아래는 사람이 확인하며 진행한다.

1. 백업: `server/iploan.db`, `server/patent-iploan.db`, `server/patent-uploads/`, `server/.env`를 복사해 둔다.
2. 계약: 로컬 화면의 admin.html에서 관리자 지갑으로 v3 Manager를 배포하고, 차주·평가사·은행 주소에 역할을 다시 부여한다.
   배포 기록을 `blockchain/deployments/`에 남긴다.
3. 코드: 이 브랜치를 반영하고 `server/venv/bin/pip install -r server/requirements.txt`(PDF 항목 읽기용 pypdf 추가),
   `blockchain`에서 `npm run compile`로 v3 artifact를 만든다.
4. 설정: `server/.env`의 `IPLOAN_MANAGER_ADDRESS`를 v3 주소로 바꾼다. Nginx `client_max_body_size`를 75m로 올린다.
5. 재시작: `sudo systemctl restart iploan-api`. 시작할 때 시드 예시 삭제와 LLM 보고서 보관 이전이 자동으로 실행된다.
6. 프론트: GitHub Pages(iploan.mustree.kr)에 index.html·admin.html·css·js를 반영한다.
7. 확인: 각 역할 지갑으로 로그인해 신청→보고서→평가 확정→약정→상환을 한 건 진행한다.
