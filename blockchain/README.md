# IP Loan v3 — Mustsem 실행·검증 가이드

시연 네트워크는 Mustsem 7601(MST)이다. 로컬 프론트/API는 실제 Mustsem 계약에 연결한다.
원부 대조와 신용평가 조회는 mock이며 실제 자금 이동·법적 채권 효력은 구현하지 않는다.

## 1. 계약과 지갑

Solidity 0.8.24, EVM Paris, optimizer 200, viaIR 설정을 사용한다.
서버는 v3 계약(`contractVersion() == 3`)에만 연결한다. v3는 최종 승인 때 대출약정을 기록하고
담당 은행 지갑에 RWA 토큰(IPLoanRWAToken, IPRWA)을 발급한다. 신용등급·금리·기간은 비공개 정보라
서버가 무작위 salt와 함께 보관하고, 체인에는 그 해시(`termsHash`)만 기록한다.
토큰 카드 그림은 v2와 같이 서버가 IBM Plex 글꼴로 PNG를 그려 메타데이터 JSON과 함께 IPFS에 올린다.
계약은 고정 HTTPS 게이트웨이(`https://rwa-gw.mustree.kr/ipfs/<CID>`) 주소만 받아 SBT 카드는 신청 때, RWA 토큰 카드는
최종 승인 때 고정한다. 카드에는 신청번호·IP 유형·금액·평가액만 넣고 기업명·대표자명·특허 명칭·약정 조건은 넣지 않는다.

v3 배포는 관리자 지갑으로 로컬에서 한다. 계약 주소 없이 API를 띄워야 배포 버튼이 동작한다(2장 설치·컴파일 후).

```bash
# 터미널 A: 계약 주소 없이 API 실행(배포 전용)
IPLOAN_CHAIN_ID=7601 IPLOAN_DB_PATH="$PWD/server/iploan-deploy.db" server/.venv/bin/python server/app.py
# 터미널 B: 정적 서버 → http://127.0.0.1:8001/admin.html
server/.venv/bin/python -m http.server 8001 --bind 127.0.0.1
```

v3 지갑 배정(2026-10-21 결정): 관리자·은행 `0xE63a192911048B74c1149DBb058DEbdC30cC785B`,
평가사 `0xa3B81443517443D7612040Dc8E02609c5b9Ad174`, 차주 `0xed25983C90c773828a00b0FAF5e92cf5eE2cedb6`.
admin.html의 첫 평가사·은행 기본값이 이 주소이고, 배포한 지갑(`0xE63a…`)이 관리자가 된다. 차주는 배포 후 추가한다.
세 지갑 모두 배포 전 수수료용 MST가 조금 있어야 한다.

admin.html에서 관리자 지갑으로 "새 v3 계약 배포"를 승인한다. 결과의 Manager·SBT·RWA 토큰 주소와 거래 해시를
deployments/에 새 파일로 기록한다. 이후 API를 v3 주소로 다시 시작하고 차주·평가사·은행 주소에 역할을 다시 부여한다.

2026-10-21 배포분(Manager 0x7428932Dd3542657139ff9d560250b0ef5b6E50E)은 약정 조건을 평문으로 기록하는 빌드라 폐기했다
(deployments/mustsem-v3-retired-20261021.json). 2026-10-22 재배포한 계약은 deployments/mustsem-v3.json(Manager 0xC9E94e50F3EAa3a4E4Fa0829B8EcE1fd993e68e6)에 기록했다.
이전 v2 계약(deployments/mustsem.json, Manager 0x6D1004CB292e3ec45A4c4A0834C0eedAAbe16E38)은 기록으로 남긴다.
v2에 등록된 신청은 v3 서버에서 열람만 할 수 있다. deployments/sepolia.json은 그 이전 단일 담당자 계약의 기록이다.

차주·평가사·은행 주소는 관리자가 admin.html에서 MetaMask로 여러 개 추가·회수한다.
서버가 등록된 주소 중에서 신청 접수 시 평가사를, 평가가 70% 기준을 통과하면 은행·여신심사역을 배정한다.
`IPLOAN_ASSIGNMENT_EVALUATOR`/`IPLOAN_ASSIGNMENT_BANK`를 지정하면 그 주소만, 비우면 임의 선택한다.
차주 본인은 담당자가 될 수 없고 평가사는 같은 신청의 은행이 될 수 없다(서버·계약 모두 검사).
RPC: https://block.mustree.kr. 정상 네트워크 수수료를 사용한다. 각 거래 지갑에 MST가 필요하다.

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

컴파일은 API와 관리자 페이지에서 사용하는 artifacts/*.json을 생성한다. 설치 후 반드시 컴파일한다.
서버는 지갑 개인키를 저장하거나 대신 거래를 서명하지 않는다.

## 3. 실행

저장소 루트의 WSL 터미널 A:

```bash
IPLOAN_MANAGER_ADDRESS=<v3 Manager 주소> bash blockchain/scripts/start-mustsem-api.sh
```

터미널 B:

```bash
server/.venv/bin/python -m http.server 8001 --bind 127.0.0.1
```

API는 5001, 프론트는 http://127.0.0.1:8001/index.html 이다. 이미 실행 중인 포트에 중복 실행하지 않는다.
v3 로컬 DB는 server/iploan-mustsem-v3.db다. 신청은 등록한 계약에 묶이므로 다른 계약의 DB를 재사용하지 않는다.
LLM 보고서를 만들려면 server/.env에 `IPLOAN_PATENT_API_URL`, `IPLOAN_PATENT_API_TOKEN`이 있어야 한다.

MetaMask 확장이 있는 Chrome/Edge에서 Mustsem RPC·chainId 7601·MST를 확인한다.
화면 오른쪽 위 "MetaMask 로그인"으로 로그인한다. 로그인 메시지 서명은 거래가 아니며 수수료가 없다.
처음 한 번 로그인 버튼 아래 "다른 계정 연결"로 차주·평가사·은행 계정을 모두 이 사이트에 연결한다.
그 뒤 MetaMask에서 계정을 바꾸면 처음 쓰는 지갑은 로그인 서명만 요청하고, 로그인했던 지갑은 서명 없이 바로 전환된다(12시간 유지).
시연 전에 세 계정으로 한 번씩 로그인해 두면 시연 중에는 거래 승인 창만 뜬다.

## 4. 자동 검증

```bash
server/.venv/bin/python -m unittest server.test_app server.test_patent_api server.test_participant_assignment server.test_report_summary -v
node --test js/app.test.cjs js/chain.test.cjs js/admin.test.cjs
cd blockchain
npm test
cd ..
```

서버 39개, 프론트 41개, 계약·통합 20개로 총 100개 테스트를 검증했다.
통합 테스트(test/integration.test.mjs, test/multi-role.test.mjs)는 실제 로컬 EVM과 임시 Flask·DB, mock IPFS·LLM으로
지갑 로그인, 신청, 보고서 등록·평가 확정, 약정·RWA 토큰, 상환과 배정·우회·회수를 검사한다.
계약 테스트는 Hardhat의 일회성 테스트 EVM을 사용한다. 실제 Mustsem 거래나 회사 IPFS를 호출하지 않는다.

## 5. 사람이 할 통합 테스트

실제 개인정보가 없는 가상 PDF를 사용한다. 테스트 PDF·업로드 데이터·DB는 제출하지 않는다.

### A. 신청 → 평가 확정 → 대출약정 → 완납

0. 관리자 지갑으로 admin.html에서 차주 주소에 차주 역할을 부여한다. 차주는 평가사·은행과 다른 주소여야 한다.
1. 차주 지갑으로 로그인해 대출 신청 화면에서 기업정보, 신청금액 70,000,000원, 상환 희망 기간을 입력한다.
2. 가상 특허등록원부 PDF와 가상 특허 공고전문 PDF를 첨부하고 "신청하고 지갑으로 서명"을 누른다.
3. 원부 암호화·IPFS 등록 후 MetaMask로 신청 거래를 승인한다. 신청번호·CID·거래 해시를 기록한다.
   Manager는 Evaluating, SBT 소유자는 담당 평가사, 은행은 미배정이어야 한다. LLM 보고서는 "생성 중"으로 표시된다.
4. 담당 평가사 지갑으로 로그인한다. IP 가치평가 화면에서 보고서가 도착하면 미리보기와 다운로드를 확인한다.
   보고서 API가 산정액을 보냈다면 "LLM 산정액"(사전평가 초안)과 그 금액 기준 담보인정비율이 보인다.
   평가 SBT로 등록원부 원본을 열람할 수 있다. 다른 지갑에는 신청이 보이지 않는다.
5. 평가액 100,000,000원과 평가 의견을 입력하고 "가치평가 확정"을 누른다. LLM 산정액과 다른 금액이면 평가 의견이 필수다.
   보고서가 암호화 등록된 뒤 MetaMask로 평가 확정을 승인한다.
6. 보고서 CID·해시 기록, SBT 소각, Eligible 전환, 배정된 은행 주소 기록을 확인한다.
7. 배정된 은행 지갑으로 로그인한다. "LLM 보고서 재무 참고 점검"에서 최근 결산 재무와 점검 결과(자료가 없으면 판정 불가)를 확인한다.
   신용등급을 입력한다(보고서에 회사자료 등급이 있으면 미리 채워진다).
   금리와 약정 기간을 입력하고 "최종 승인·약정 체결"을 승인한다. Approved, 약정 조건, 은행 소유 RWA 토큰을 확인한다.
8. "등록된 평가보고서 열람"이 체인 해시와 일치하는 보고서를 내려주는지 확인한다. 등록원부 원본 열람도 확인한다.
9. 상환금액 20,000,000원과 고유 참조번호로 상환 기록 거래를 승인한다. 누적 20,000,000원·잔여 50,000,000원을 확인한다.
10. 다른 참조번호로 50,000,000원을 기록한다. Repaid·누적 70,000,000원·잔여 0원과 은행 RWA 토큰 유지를 확인한다.
11. 차주 지갑으로 다시 로그인해 신청 진행 상황에서 약정 조건과 상환 내역을 확인한다.

### B. 규칙 거절

새 신청금액 70,000,000원, 평가액 90,000,000원으로 진행한다.
평가 확정 시 RuleRejected, SBT 소각, 은행 미배정, RWA 토큰 미발급 및 최종 승인 불가를 확인한다.

### C. 은행 최종 거절

새 신청금액 70,000,000원, 평가액 100,000,000원으로 Eligible까지 진행한다.
은행이 최종 거절하면 Rejected, RWA 토큰 미발급이어야 하며 같은 건을 다시 승인할 수 없다.

### D. 취소·복구

IPFS 등록 후 신청 MetaMask를 취소하면 신청·CID는 이미 저장되어 있다. 신청 진행 상황에서 온체인 등록을 다시 시도하면 기존 CID를 재사용한다.
평가·승인 거래 확정 후 서버 동기화가 실패하면 "체인 확인·복구"를 사용한다. 확정된 거래를 새로 전송하거나 중복 발급하지 않아야 한다.
LLM 보고서 접수가 거절되면 "보관된 PDF로 다시 접수"로 같은 신청에서 재접수한다.

## 6. 기록 조회와 보존

```bash
curl -sS http://127.0.0.1:5001/api/chain/config
```

신청 목록과 보고서는 로그인한 담당자만 볼 수 있다. 키·salt·개인키·시드는 출력하거나 공유하지 않는다.
DB를 네트워크·계약 간 재사용하거나 삭제하지 않는다.
RPC 조회로 거래 영수증, Submitted·FinalApproved 등의 이벤트, getApplication(appKey), 토큰 소유권을 확인할 수 있다.
