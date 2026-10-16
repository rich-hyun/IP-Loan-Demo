# Flask API — 시범 MVP

Mustsem(7601, MST)에 배포한 v2 Manager 0x6D1004CB292e3ec45A4c4A0834C0eedAAbe16E38에 연결한다.
서버는 `contractVersion() == 2`인 Manager에만 연결하며, DB는 server/iploan-mustsem-v2.db를 사용한다.
IPLOAN_ZERO_GAS_PRICE=0으로 정상 수수료를 사용한다.

```bash
cd IP-Loan-Demo  # 저장소 루트
bash blockchain/scripts/start-mustsem-api.sh
```

이미 5001에서 실행 중이면 위 명령을 중복 실행하지 않는다.

설치·서버 시작·MetaMask 배포·단계별 확인은 [WSL 통합 테스트 가이드](../blockchain/README.md)를 따른다.
정적 프론트만이 아니라 계약 artifact와 web3 의존성도 필요하므로 server 폴더만 복사해 배포하지 않는다.

## 설정 (WSL Bash)

```bash
cd IP-Loan-Demo  # 저장소 루트
export IPLOAN_RPC_URL=https://block.mustree.kr
export IPLOAN_CHAIN_ID=7601
export IPLOAN_MANAGER_ADDRESS=0x6D1004CB292e3ec45A4c4A0834C0eedAAbe16E38
export IPLOAN_DB_PATH="$PWD/server/iploan-mustsem-v2.db"
export IPLOAN_ZERO_GAS_PRICE=0
export PORT=5001
server/.venv/bin/python server/app.py
```

.env.example은 참고용이며 자동 로드하지 않는다.
계약 미설정이면 기존 암호화 업로드 API는 사용 가능하지만 새 MVP 화면의 지갑 신청은 진행하지 않는다.

| 환경변수 | 기본값/의미 |
|---|---|
| PORT | 5001 |
| IPLOAN_DB_PATH | 이 worktree의 server/iploan.db |
| IPLOAN_RPC_URL | https://block.mustree.kr |
| IPLOAN_CHAIN_ID | 7601 |
| IPLOAN_MANAGER_ADDRESS | 기본 없음. 배포한 v2 Manager 필요 |
| IPLOAN_ASSIGNMENT_EVALUATOR | 비우면 등록된 평가사 중 임의 배정. 지정 시 그 주소만(역할 없으면 신청 거절) |
| IPLOAN_ASSIGNMENT_BANK | 비우면 등록된 은행 중 임의 배정. 지정 시 그 주소만(역할 없으면 보고서 준비 거절) |
| IPLOAN_IPFS_UPLOAD_URL | https://api.mustree.kr/upload |
| IPLOAN_IPFS_GATEWAY | https://rwa-gw.mustree.kr/ipfs/ |
| IPLOAN_MAX_DOCUMENT_BYTES | 20971520 |

## 연결과 보안 범위

- server/chain.py는 RPC·계약·역할·신청 내용·소유권을 읽고 확인한다. 서명 키·자동 tx 없음.
- /sync는 실제 체인 상태만 반영한다. 클라이언트 tokenId·status·상환금액을 증거로 받아들이지 않는다.
- 담당자 배정: 평가사는 신청 접수 시, 은행·여신심사역은 70% 기준을 통과하는 평가보고서 준비 시 체인의 역할 보유자 중에서 고른다.
  클라이언트가 보낸 담당자 주소는 쓰지 않으며, 차주 본인과 해당 신청의 평가사는 후보에서 제외한다.
  한 번 정한 배정은 설정을 바꿔도 유지된다. 준비된 은행이 평가 확정 전에 역할을 잃은 경우에만 다시 고른다.
- 계약은 담당자의 역할과 신청별 고정만 검증한다. 차주·평가사가 계약을 직접 호출해 다른 등록 주소를 넣으면
  /sync가 서버 배정과 다르다는 오류로 거절하고 원본 열람도 막는다. 체인에서 서버 배정을 강제하지는 않는다.
- 온체인 신청에 대한 기존 PATCH와 계약 연결 중 DB reset은 409로 거절한다.
- AES 키·salt는 SQLite에 저장한다. 신청 공개 API에는 포함하지 않는다.
- 원본은 일회성 5분 nonce·MetaMask personal_sign·현재 SBT/NFT 소유권·현재 역할 보유 확인 후 복호화해서 반환한다.
- 기업 프로필은 제출 저장 성공 시 자동 생성/갱신한다. 별도 저장 버튼 없음.
- 회사 선택·역할 UI는 인증이 아니다. 일반 목록·프로필·보고서 준비 API는 데모 공개 API다.
- 보고서 JSON은 공개 가상 내용이다. 원부 진위 대조·LLM은 mock. 실제 개인정보·영업비밀을 쓰지 않는다.
- Flask 개발 서버·메모리 nonce는 로컬/내부 시연용이다. 실제 서비스 공개 전 별도 인가·키 보호·운영 설계 필요.
- DB와 암호문을 잃으면 원본 복구가 불가능할 수 있다. SQLite 키 포함 백업도 비밀 데이터로 취급한다.
- 로컬 체인 초기화와 DB 초기화는 같은 작업이 아니다. DB 파일을 다른 네트워크에 재사용하지 않는다.

API 전체와 상태는 [설계 문서](../docs/대출신청-암호화-토큰-설계.md)에 정리했다.

## 자동 테스트

```bash
cd IP-Loan-Demo  # 저장소 루트
IPLOAN_MANAGER_ADDRESS= server/.venv/bin/python -m unittest server.test_app server.test_patent_integration server.test_participant_assignment -v
node --test js/app.test.cjs js/chain.test.cjs js/admin.test.cjs
cd blockchain
npm test
```

실제 EVM 통합 테스트는 임시 DB·임시 Flask 서버·mock IPFS를 사용한다.
수동 프론트 테스트는 실제 회사 IPFS를 호출하므로 반드시 가상 PDF만 사용한다.

## 특허 공고전문 평가 API

`patent_app.py`를 `/api/patent`에 연결하여 기존 지갑·IPFS API와 함께 제공합니다. 기존 대출 DB와 별도로 `patent-iploan.db`, `patent-uploads/`를 사용하며, 접수 및 생성 상태와 결과를 보존합니다. 서버 전용 `.env`에서 `IPLOAN_PATENT_API_URL`, `IPLOAN_PATENT_API_TOKEN`을 읽습니다. 자세한 사용법은 [PATENT_API.md](PATENT_API.md)를 참고하세요.

현재 운영 서버의 `gunicorn.conf.py`는 4개 스레드와 120초 timeout을 설정합니다. 기존 unit의 작업 디렉터리가 이 폴더이면 Gunicorn HUP으로 코드와 이 설정을 함께 읽습니다. Nginx에는 저장소의 `nginx-iploan-api.conf`에 있는 `client_max_body_size 51m`과 120초 프록시 timeout을 적용해야 50MiB PDF를 접수할 수 있습니다.
