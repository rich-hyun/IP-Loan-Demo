# IP Loan MVP — Mustsem 실행·검증 가이드

현재 시연 네트워크는 Mustsem 7601(MST)이다. 로컬 프론트/API는 실제 Mustsem 계약에 연결한다.
원부 대조·평가 초안은 mock이며 실제 자금 이동·법적 채권 효력은 구현하지 않는다.

## 1. 배포 계약과 지갑

Solidity 0.8.24, EVM Paris, optimizer 200, viaIR 설정을 사용한다.
2026-10-21 배포한 HTTPS 메타데이터 계약(`contractVersion() == 2`, `tokenMediaVersion() == 2`)을 사용한다. 배포·코드 검증 증거는 deployments/mustsem-https.json에 있다. 기존 deployments/mustsem.json의 계약·데이터는 보존하며 신규 계약으로 덮어쓰지 않는다.

| 구분 | 주소 |
|---|---|
| Manager | 0x65C40E399b145A9f9021652192C3e781dadbD2FA |
| 평가 SBT | 0x8B06c5bfc253414BA29fa98B762Adc7AD9730f75 |
| 채권 NFT | 0x8d819dcb3EB5aC2C113D7E0f6199d7498cb8EccE |
| 배포자·관리자 | 0xB3Ec5f2bbB80e90ec457165d13EF469893a54951 |
| 테스트 차주 | 0x5C921C1a2A25a05996Ce465Dbc36262bcdEfb207 |
| 첫 평가사 (생성자 등록) | 0x28b53A7a9ce4905F81F258913E6056a53c670cdE |
| 첫 은행·여신심사역 (생성자 등록) | 0xB3Ec5f2bbB80e90ec457165d13EF469893a54951 |

차주·평가사·은행 주소는 관리자가 admin.html에서 MetaMask로 여러 개 추가·회수한다.
서버가 등록된 주소 중에서 신청 접수 시 평가사를, 평가가 70% 기준을 통과하면 은행·여신심사역을 배정한다.
`IPLOAN_ASSIGNMENT_EVALUATOR`/`IPLOAN_ASSIGNMENT_BANK`를 지정하면 그 주소만, 비우면 임의 선택한다.
차주 본인은 담당자가 될 수 없고 평가사는 같은 신청의 은행이 될 수 없다(서버·계약 모두 검사).

RPC: https://block.mustree.kr
배포 증적(배포 거래, 생성자 인자·런타임 코드 검증): deployments/mustsem-https.json. 사용자 설명과 별개로 배포자 주소는 실제 거래 발신자로 기록했다. 테스트 관리자와 은행 주소가 같지만 차주는 별도 주소이며, 기존 차주·평가사·은행 분리 규칙을 유지한다.
deployments/sepolia.json은 이전 단일 담당자 계약의 검증 기록이며 현재 설정이 아니다.
정상 네트워크 수수료를 사용한다. 각 거래 지갑에 MST가 필요하다.

## 2. 설치·컴파일 (WSL Bash)

저장소 루트에서 실행한다. Node.js 22.10 이상, Python 3.10 이상이 필요하다.

```bash
python3 -m venv server/.venv
server/.venv/bin/python -m pip install -r server/requirements.txt
cd blockchain
npm ci --ignore-scripts --no-audit --no-fund
npm run compile
npm run build:web
cd ..
```

컴파일은 API와 관리자 페이지에서 사용하는 artifacts/*.json을 생성한다.
컴파일 산출물·node_modules는 Git에 포함하지 않는다. 설치 후 반드시 컴파일한다.
서버는 지갑 개인키를 저장하거나 대신 거래를 서명하지 않는다.

## 3. 실행

현재 Windows 로컬 테스트는 저장소 루트에서 `.\start-mustsem-local.ps1`을 실행한다. 이미 실행 중인 주소는 **http://127.0.0.1:8008/**, 관리자는 http://127.0.0.1:8008/admin.html 이다. 이 실행기는 실제 Mustsem·실제 IPFS·실제 평가 API를 사용하며 로컬 체인을 만들지 않는다. API는 loopback 임시 포트로 실행되고 UI와 같은 origin의 /api로 연결된다. DB는 `output/mustsem-https-local/<manager주소>/`에 보존되어 재실행 시 재사용한다. `.\start-local.ps1`은 로컬 EVM용 별도 실행기다.

현재 8008이 실행 중이면 중복 실행하지 않는다. 최초 설치 시 Node 의존성과 컴파일·build:web 및 Python 의존성이 필요하다. `server/.env`에는 평가 API 인증 설정이 있어야 한다. `-Bootstrap`은 계약 주소를 비운 신규 배포 준비 전용이며 이미 배포한 계약을 사용한 테스트에는 지정하지 않는다.

아래는 기존 Linux/WSL 실행 방법이다.

저장소 루트의 WSL 터미널 A:

```bash
bash blockchain/scripts/start-mustsem-api.sh
```

터미널 B:

```bash
server/.venv/bin/python -m http.server 8001 --bind 127.0.0.1
```

API는 5001, 프론트는 http://127.0.0.1:8001/index.html 이다.
이미 실행 중인 포트에 중복 실행하지 않는다.
새 HTTPS 계약의 기본 DB는 server/iploan-mustsem-https.db다. 기존 server/iploan-mustsem-v2.db는 보존한다. 신청은 등록한 계약에 묶이므로 다른 계약의 DB를 재사용하지 않는다. systemd 등에서 기존 환경변수를 지정했다면 새 계약 주소와 새 DB 경로를 명시적으로 설정해야 한다.
.env.example은 참고용이며 자동 로드하지 않는다. IPFS 설정은 ../server/README.md를 참고한다.

MetaMask 확장이 있는 Chrome/Edge에서 Mustsem RPC·chainId 7601·MST를 확인한다.
기본 8건은 미온체인 예시다. 새로 제출한 신청으로 실제 체인 동작을 검증한다.
admin.html은 역할 관리(차주·평가사·은행 주소 추가·회수)와 신규 배포용이다. 역할 관리는 공개 사이트에서도 API가 내려주는 ABI로 동작한다.
배포 버튼은 API의 IPLOAN_MANAGER_ADDRESS가 비어 있는 로컬 화면에서만 동작한다. 기존 배포로 시연할 때 누르지 않는다.
역할을 회수하면 그 주소가 담당인 진행 중 신청은 더 진행할 수 없다(담당자는 신청별로 고정).

## 4. 자동 검증

```bash
IPLOAN_MANAGER_ADDRESS= server/.venv/bin/python -m unittest server.test_app server.test_patent_integration server.test_participant_assignment -v
node --test js/app.test.cjs js/chain.test.cjs js/admin.test.cjs
cd blockchain
npm test
cd ..
```

프론트 35개, 서버 31개, 계약·통합 19개로 총 85개 테스트를 검증했다.
다중 담당자 통합 테스트(test/multi-role.test.mjs)는 같은 임시 DB로 API를 설정만 바꿔 재시작하며 배정·우회·회수를 검사한다.
계약 테스트는 Hardhat의 일회성 테스트 EVM을 사용한다. 시연용 로컬 체인 실행은 필요 없다.
통합 테스트는 임시 Flask·DB와 mock IPFS를 사용하고 실제 Mustsem 거래나 회사 IPFS를 호출하지 않는다.

## 5. 사람이 할 통합 테스트

실제 개인정보가 없는 가상 PDF를 사용한다. 테스트 PDF·업로드 데이터·DB는 제출하지 않는다.
기업정보, 문서 CID와 암호화 키 등 저장 위치와 한계는 ../docs/대출신청-암호화-토큰-설계.md를 참고한다.

### A. 신청 → 자동심사 통과 → 은행 승인 → 완납

0. 관리자 지갑으로 admin.html에서 차주 주소에 차주 역할을 부여한다. 차주는 평가사·은행과 다른 주소여야 한다.
1. 차주 지갑을 선택하고 차주기업 화면에서 새 신청을 작성한다.
2. 신청금액 70,000,000원, 가상의 기업정보와 IP 정보를 입력하고 가상 PDF를 첨부한다.
3. 제출 시 서버 암호화·IPFS 업로드 후 차주 MetaMask로 신청 거래를 승인한다.
4. 신청번호·CID·거래 해시를 기록한다. Manager는 Evaluating, SBT 소유자는 신청 상세의 담당 평가사, 은행은 미배정, 채권 NFT는 미발급이어야 한다.
5. 담당 평가사 지갑·IP 가치평가 화면으로 전환한다. 해당 신청 원본 열람에는 별도 개인서명이 필요하다. 다른 지갑은 열람이 거절된다.
6. 평가액 100,000,000원으로 보고서를 준비한다. 이때 서버가 은행·여신심사역을 배정한다. MetaMask로 평가 확정을 승인한다.
7. 보고서 CID·해시 기록, SBT 소각, Eligible 전환, 배정된 은행 주소 기록을 확인한다.
8. 배정된 은행 지갑·대출 심사 화면에서 동일한 신청을 선택한다. 자동심사 통과와 최종 승인 대기를 확인한다.
9. MetaMask 최종 승인을 실행한다. Approved 상태와 은행 소유 채권 NFT를 확인한다.
10. 은행 원본 열람을 확인한다. 상환금액 20,000,000원과 고유 참조번호를 입력하고 상환 기록 거래를 승인한다.
11. 누적 20,000,000원·잔여 50,000,000원을 확인한다.
12. 다른 참조번호로 50,000,000원을 기록한다. Repaid·누적 70,000,000원·잔여 0원과 은행 NFT 유지를 확인한다.
13. 상환은 은행 확인 기록뿐이다. 실제 대출금·상환금을 송금하지 않는다.

### B. 규칙 거절

새 신청금액 70,000,000원, 평가액 90,000,000원으로 진행한다.
평가 확정 시 RuleRejected, SBT 소각, 은행 미배정, NFT 미발급 및 최종 승인 불가를 확인한다.

### C. 은행 최종 거절

새 신청금액 70,000,000원, 평가액 100,000,000원으로 Eligible까지 진행한다.
은행이 최종 거절하면 Rejected, NFT 미발급이어야 하며 같은 건을 다시 승인할 수 없다.

### D. 취소·복구

IPFS 업로드 후 신청 MetaMask를 취소하면 DB/CID는 이미 존재할 수 있다.
같은 신청의 등록을 재시도하면 기존 CID를 재사용해야 한다.
평가·승인 거래 확정 후 서버 동기화가 실패하면 체인 확인·복구를 사용한다.
확정된 거래를 새로 전송하거나 중복 발급하지 않아야 한다.
다른 지갑·다른 네트워크로 실행할 때는 권한 확인·네트워크 전환이 먼저 이루어져야 한다.

## 6. 기록 조회와 보존

```bash
curl -sS http://127.0.0.1:5001/api/chain/config
curl -sS http://127.0.0.1:5001/api/applications
```

일반 신청 목록은 공개 시연 API다. 실제 개인정보를 넣지 않는다.
원본 열람은 개인서명·일회성 nonce·현재 상태·SBT/NFT 실소유권 및 현재 역할 보유로 제한한다.
키·salt·개인키·시드는 출력하거나 공유하지 않는다.
체인 연결 중 DB 초기화는 차단한다. DB를 네트워크 간 재사용하거나 삭제하지 않는다.
RPC 조회로 거래 영수증, Submitted 등의 이벤트, getApplication(appKey), 토큰 소유권을 확인할 수 있다.
