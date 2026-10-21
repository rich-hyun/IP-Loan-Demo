# IP-Loan-Demo

LLM 기반 기술평가 IP담보 자동대출 시범 서비스. 정적 HTML/CSS/JavaScript + Flask/SQLite + MetaMask 서명 계약으로 구성한다.
주식회사 머스트리 · NH농협은행 실증 협의용 시범 MVP이며 실제 자금 이동·법적 채권 효력은 없다.

한 신청이 한 화면에서 끝까지 이어진다.

1. 지갑 서명으로 로그인하면 체인에 등록된 역할(차주·평가사·은행·관리자)로 업무 화면이 열린다.
2. 차주가 특허등록원부와 특허 공고전문을 제출한다. 원부는 암호화해 IPFS에, 공고전문으로는 LLM 가치평가보고서를 만든다.
3. 담당 평가사가 LLM 보고서를 검토해 평가액을 확정한다. 보고서는 암호화 등록되고 해시가 체인에 기록되며, 계약이 70% 기준을 자동 심사한다.
4. 담당 은행 심사역이 신용등급·금리·기간으로 대출약정을 체결하면 은행 지갑에 RWA 토큰이 발급된다. 상환은 기록만 남긴다.

서버 개인키·대리 발급·에스크로·정식 금융 기능은 없다.

- [확정 설계·로드맵 대비 구현 현황](docs/대출신청-암호화-토큰-설계.md)
- [WSL 실행·관리자 준비·수동 통합 테스트](blockchain/README.md)
- [서버 설정·API·운영 반영 순서](server/README.md)
- [LLM 특허평가 API 연동](server/PATENT_API.md)

로컬 프론트는 8001, API는 5001을 사용한다. 자동 테스트는 Mustsem 실제 배포·거래·IPFS 업로드를 수행하지 않는다.

## 구성

| 경로 | 내용 |
|---|---|
| index.html, js/app.js, js/chain.js, css/style.css | 업무 화면(로그인·신청·가치평가·여신 심사·보관함) |
| admin.html, js/admin.js | 계약 배포·역할 주소 관리(관리자 지갑) |
| server/app.py, server/auth.py, server/chain.py, server/patent_api.py | API(로그인·신청·LLM 보고서·체인 동기화) |
| blockchain/contracts/ | IPLoanManager(v3)·평가 SBT·RWA 토큰 |
| IP-Loan-Demo-main/ | 이전 독립 PoC. 현재 서비스에서는 사용하지 않는다 |

로컬 DB, 비밀 환경변수, 업로드 파일, node_modules 및 컴파일 산출물은 Git 추적에서 제외한다.

## 실행

```bash
IPLOAN_MANAGER_ADDRESS=<v3 Manager 주소> bash blockchain/scripts/start-mustsem-api.sh
# 별도 WSL 터미널
server/.venv/bin/python -m http.server 8001 --bind 127.0.0.1
```

Python 의존성 설치, IPFS·LLM API 환경변수는 server/README.md를 참고한다.

## 테스트

```bash
server/.venv/bin/python -m unittest server.test_app server.test_patent_api server.test_participant_assignment
node --test js/app.test.cjs js/chain.test.cjs js/admin.test.cjs
cd blockchain && npm test
```
