# Flask API — 시범 MVP

현재 실행은 검증된 Mustsem 배포(7601, MST)에 연결되었으며 DB는 server/iploan-mustsem-mvp.db다.
Sepolia DB server/iploan-sepolia-mvp.db는 보존했다. Mustsem Manager는 0x385D93904D2231B59a87282c1dC9b777b3F31b57이다.
현재는 사용자 MST 준비·수수료 승인에 따라 IPLOAN_ZERO_GAS_PRICE=0으로 정상 수수료를 사용한다.

```bash
cd /mnt/c/Users/mustree/.codex/worktrees/ip-loan-mvp/IP-Loan-Demo
bash blockchain/scripts/start-mustsem-api.sh
```

이미 5001에서 실행 중이면 위 명령을 중복 실행하지 않는다.

설치·서버 시작·MetaMask 배포·단계별 확인은 [WSL 통합 테스트 가이드](../blockchain/README.md)를 따른다.
정적 프론트만이 아니라 계약 artifact와 web3 의존성도 필요하므로 server 폴더만 복사해 배포하지 않는다.

## 설정 (WSL Bash)

```bash
cd /mnt/c/Users/mustree/.codex/worktrees/ip-loan-mvp/IP-Loan-Demo
export IPLOAN_RPC_URL=https://block.mustree.kr
export IPLOAN_CHAIN_ID=7601
export IPLOAN_MANAGER_ADDRESS=0x385D93904D2231B59a87282c1dC9b777b3F31b57
export IPLOAN_DB_PATH="$PWD/server/iploan-mustsem-mvp.db"
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
| IPLOAN_MANAGER_ADDRESS | 기본 없음. 배포한 전용 Manager 필요 |
| IPLOAN_IPFS_UPLOAD_URL | https://api.mustree.kr/upload |
| IPLOAN_IPFS_GATEWAY | https://rwa-gw.mustree.kr/ipfs/ |
| IPLOAN_MAX_DOCUMENT_BYTES | 20971520 |

## 연결과 보안 범위

- server/chain.py는 RPC·계약·역할·신청 내용·소유권을 읽고 확인한다. 서명 키·자동 tx 없음.
- /sync는 실제 체인 상태만 반영한다. 클라이언트 tokenId·status·상환금액을 증거로 받아들이지 않는다.
- 온체인 신청에 대한 기존 PATCH와 계약 연결 중 DB reset은 409로 거절한다.
- AES 키·salt는 SQLite에 저장한다. 신청 공개 API에는 포함하지 않는다.
- 원본은 일회성 5분 nonce·MetaMask personal_sign·현재 SBT/NFT 소유권 확인 후 복호화해서 반환한다.
- 기업 프로필은 제출 저장 성공 시 자동 생성/갱신한다. 별도 저장 버튼 없음.
- 회사 선택·역할 UI는 인증이 아니다. 일반 목록·프로필·보고서 준비 API는 데모 공개 API다.
- 보고서 JSON은 공개 가상 내용이다. 원부 진위 대조·LLM은 mock. 실제 개인정보·영업비밀을 쓰지 않는다.
- Flask 개발 서버·메모리 nonce는 로컬/내부 시연용이다. 실제 서비스 공개 전 별도 인가·키 보호·운영 설계 필요.
- DB와 암호문을 잃으면 원본 복구가 불가능할 수 있다. SQLite 키 포함 백업도 비밀 데이터로 취급한다.
- 로컬 체인 초기화와 DB 초기화는 같은 작업이 아니다. DB 파일을 다른 네트워크에 재사용하지 않는다.

API 전체와 상태는 [설계 문서](../docs/대출신청-암호화-토큰-설계.md)에 정리했다.

## 자동 테스트

```bash
cd /mnt/c/Users/mustree/.codex/worktrees/ip-loan-mvp/IP-Loan-Demo
IPLOAN_MANAGER_ADDRESS= server/.venv/bin/python -m unittest server.test_app -v
node --test js/app.test.cjs js/chain.test.cjs js/admin.test.cjs
cd blockchain
npm test
```

실제 EVM 통합 테스트는 임시 DB·임시 Flask 서버·mock IPFS를 사용한다.
수동 프론트 테스트는 실제 회사 IPFS를 호출하므로 반드시 가상 PDF만 사용한다.
