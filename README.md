# IP-Loan-Demo

정적 HTML/CSS/JavaScript + Flask/SQLite + MetaMask 계약으로 구성된 시범 MVP.

신청 기록·평가 중 SBT·은행 최종 승인 시 채권 NFT를 사용한다.
평가 확정 때 SBT를 소각하고 70% 규칙을 실행한다. 상환은 실제 자금 이동 없이 기록만 남긴다.
서버 개인키·대리 발급·에스크로·정식 금융 기능은 없다.

- [확정 설계와 구현 체크리스트](docs/대출신청-암호화-토큰-설계.md)
- [WSL 실행·관리자 준비·파일별 상세 수동 통합 테스트](blockchain/README.md)
- [서버 설정과 API](server/README.md)

현재 구현 브랜치: codex/ip-loan-mvp, origin/main 084cc650 기준.
원래 checkout의 작업을 보존하기 위해 새 worktree에서 구현했다.
로컬 프론트는 8001, API는 5001. 기존 8000/5000과 구분한다.
Mustsem 실제 배포·거래·IPFS 업로드를 자동 테스트가 수행하지 않는다.

## 제출본 구성

현재 서비스는 루트의 index.html, js/, css/, server/와 blockchain/contracts/를 사용한다.
IP-Loan-Demo-main/은 이전 독립 PoC이며 현재 서비스에서는 사용하지 않는다.

GitHub 저장소를 제출본으로 사용한다. 기존 IP-Loan-Demo-main/은 변경하지 않고 보존한다.
미사용 로컬 체인 시연용 배포·지갑 준비 스크립트는 제거했다.
로컬 DB, 비밀 환경변수, 업로드 파일, node_modules 및 컴파일 산출물도 Git 추적에서 제외한다.

제출 코드에는 Solidity 소스, 웹·서버 코드, 공개 배포 기록, 라이선스 및 자동 테스트를 포함한다.
Hardhat 설정과 테스트는 검증용 일회성 EVM에 필요하며 시연용 로컬 노드 실행 명령은 제공하지 않는다.
현재 실행은 Mustsem 7601의 배포된 계약에 연결한다:

```bash
bash blockchain/scripts/start-mustsem-api.sh
# 별도 WSL 터미널
server/.venv/bin/python -m http.server 8001 --bind 127.0.0.1
```

Python 의존성 설치와 IPFS 환경변수 준비는 server/README.md를 참고한다.

## 특허 공고전문 평가보고서

메인 화면의 **대출·특허평가 통합 신청**에서 공고전문 PDF를 한 번만 제출합니다. 같은 대출 신청번호로 자동평가·보고서 생성, 담당 평가사의 검토·온체인 확정, 데모 계약의 LTV 판정과 여신심사를 연결합니다. 실패 시 보관된 파일로 재시도하며 접수 불명 상태에서는 중복 접수를 차단합니다.

새 평가 작업·암호화 원본·보고서·검토·여신심사 연결은 기존 대출 DB에 저장합니다. 별도 특허 DB와 `patent.html#evaluate`는 기존 이력 조회용으로 보존합니다. 통합 서버의 `/api/patent` 쓰기는 차단하며 신규 업무는 대출 API를 사용합니다. API 인증값은 Git에서 제외한 `server/.env`에 설정합니다. [통합 흐름 실행·설정·검증·제약](server/LOAN_WORKFLOW.md)을 참고하세요.

```bash
cd server
./venv/bin/python -m unittest -q test_server_compat test_evaluations
```
