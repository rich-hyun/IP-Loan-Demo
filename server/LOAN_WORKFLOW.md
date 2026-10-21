# 대출·특허평가 통합 흐름

기준 커밋은 `b4e01af`이다. 루트 서비스(`index.html`, `js/`, `server/app.py`)를 수정하며 `IP-Loan-Demo-main/`과 기존 로컬 작업 폴더는 보존한다. 운영 배포·운영 DB 수정·알림 발송·git push는 수행하지 않는다.

동시에 진행 중인 NFT/SBT 이미지 작업과 분리하기 위해 `codex/loan-evaluation-integration` 브랜치의 전용 워크트리에 통합 변경을 모았다. 원래 체크아웃은 수정하거나 정리하지 않고 보존했다. 이 브랜치는 기존 v2 계약을 재사용하며 이미지 발급용 새 계약 배포를 요구하지 않는다. 두 작업의 병합은 별도 단계다. 검증 환경의 Python 가상환경과 Node 의존성은 원래 폴더의 설치본에 대한 junction으로 재사용하지만 소스·테스트 DB·컴파일 산출물은 전용 워크트리에서 사용한다.

## 구현과 판단 근거

- 신규 신청의 진입점은 대출 신청이다. 특허 공고전문 PDF 하나를 `registryDocument` 필드로 받는다. 기존 필드 이름은 API 호환을 위해 유지한다. 현재 대출의 파일 상한인 20MiB를 적용한다.
- 기존 AES-256-GCM 암호화·IPFS 업로드·원본 해시·기업 프로필·담당자 배정·v2 SBT/NFT 계약을 재사용한다. 같은 암호문을 대출 DB에 보관하고 외부 평가 API에 보낼 때만 임시 PDF로 복호화한다. 재시도 때 브라우저 업로드나 IPFS 재업로드가 필요 없다. 원부 진위 대조는 기존 mock이며 실제 특허청 검증으로 주장하지 않는다.
- 외부 평가 접수·상태 조회·identity·보고서 다운로드는 기존 `patent_api.py` 클라이언트를 사용한다. 서버가 신청 저장 후 같은 요청에서 공급자 접수를 수행하며, 생성 작업은 공급자의 비동기 큐에서 진행된다. 접수 지연 중에는 제출 버튼에 처리 상태가 표시된다. 접수 후 상태 조회 버튼으로 15분의 읽기 세션을 만들면 10초마다 갱신한다. 페이지를 닫아도 작업번호와 파일은 DB에 남는다.
- `applications.id`를 `loan_evaluations.appId`, `loan_evaluation_attempts.appId`, `loan_artifacts.appId`, `evaluation_reports.applicationId`, `credit_cases.applicationId`의 연결 키로 사용한다. 기존 `appKey`는 이 신청번호의 해시이다. 실패한 이전 접수의 작업번호·상태·오류도 차수별로 남긴다. 평가 작업번호, 원본 해시, 공급자 보고서 해시, 자동 산출 가치, 적용 가치, 평가사 지갑과 검토 사유를 확정 JSON에 함께 넣고 기존 IPFS 보고서 CID·해시를 체인에 기록한다.
- 실제 검토 사유·자동 산출값이 공개 IPFS에서 평문으로 노출되지 않도록 확정 JSON은 원본의 서버 보관 키와 새 IV로 AES-GCM 암호화해 업로드한다. 체인의 보고서 해시는 평문 확정 JSON의 SHA256이다. 보고서 원문과 검토 결과는 인증된 API로 확인한다. 최종 적용 가치는 기존 계약 설계대로 체인에 공개된다.
- 평가사는 공급자 보고서·자동 산출 값을 확인하고 적용 가치와 검토 사유를 입력한다. 준비된 확정 내용은 변경하지 않는 것으로 가정했다. 지갑 취소·응답 유실 시 같은 내용으로 재시도하며 실제 체인 확인 전에는 여신심사에 전달하지 않는다. 일반 PATCH로 확정이나 심사 상태를 우회할 수 없다.
- 현재 v2 계약에 이미 `amount * 100 <= value * 70` 규칙이 있다. 이 **데모 계약의 70% 기준**을 서버에서도 정수 비교로 적용한다. 표시용 LTV의 반올림값으로 판정하지 않는다. 새로운 정책 수치를 임의로 정하지 않았다. 계약·RPC·역할 설정이 없으면 통합 접수/확정을 차단한다. 다른 LTV 정책은 계약과 서버를 함께 변경해야 하며 환경변수만으로 계약과 다른 정책을 적용하지 않는다.
- 실제 체인 확정이 보고서·검토 기록과 일치하고 양의 적용 가치로 LTV를 통과해야 `credit_cases` 한 건이 생성된다. 미완료·실패·보고서 없음·가치 없음/0/음수·LTV 초과는 심사 건을 만들지 않는다. 초과 건은 `RuleRejected/rejected`와 사유를 표시한다.

## 자동 산출 금액 어댑터

현재 실제 API 1.0.0의 상태 JSON에는 금액 필드가 없다. 실제 완료 작업의 HTML에서 `th`가 정확히 `IP 가치금액`인 표와 바로 뒤의 `td` 값을 확인했다. `patent_value.py`는 이 형식과 명시된 원/만원/백만원/억원 단위만 읽는다. 요약 시나리오 설명 span은 금액에서 제외한다. 누락, 범위, 알 수 없는 통화, 서로 다른 표 값, 원 미만 소수는 해석하지 않는다. 일반 본문·신청금액·신용점수에서 금액을 추정하지 않는다.

금액 출처 이름, 원래 표기, 공급자 HTML의 SHA256을 보존한다. 0 또는 음수도 원래 값 그대로 전달하고 부적합 안내를 표시한다. 사전평가 값은 실제 담보 확정가치가 아니며 평가사가 양의 적용 가치와 검토 근거를 별도로 확정한다. 보고서에 금액이 없으면 이를 명시하고 자동으로 임의 값을 채우지 않는다.

미래 공급자가 구조화된 `valuation: {amount: 정수, currency: "KRW", unit: "won"}`를 제공하는 경우 이를 우선 사용하는 확장 지점도 있다. 이는 현재 API가 이 필드를 제공한다는 뜻이 아니다. 보고서 형식이 바뀌면 어댑터를 확인·수정해야 한다.

## 접근 권한·중복 방지·복구

- 접수·상태·재시도·identity·복구·원본·보고서·검토 API는 nonce와 `personal_sign` 서명을 검증한다. nonce는 작업·신청번호·정렬된 JSON 내용 SHA256·지갑에 묶여 5분 후 만료되고 SQLite에서 한 번만 소비된다. 멀티프로세스에서도 재사용할 수 없다. 업로드 서명 내용에는 파일의 평문 SHA256도 포함한다.
- 서버가 배정한 차주·평가사·은행 지갑과 현재 역할을 확인한다. UI 역할 선택은 인증이 아니다. 15분 상태 조회 세션은 메모리에만 보관하며 상태 조회 외의 쓰기·보고서·파일 요청에는 사용할 수 없다. 세션 조회마다 현재 역할과 담당자를 재검증한다.
- 원본의 평가사 열람은 실제 체인의 Evaluating/SBT 단계, 은행 열람은 Approved/Repaid/NFT 단계로 제한한다. 은행은 Eligible 이후 보고서를 검토할 수 있다. 차주는 자기 신청과 파일을 확인할 수 있다.
- `(borrower, requestId)` UNIQUE와 SQLite 쓰기 트랜잭션으로 동시 제출을 직렬화한다. 같은 요청번호·같은 서명 대상 내용은 저장된 신청으로 복귀한다. 같은 요청번호에 다른 파일/내용은 409이다. 브라우저는 응답 유실 때도 같은 요청번호를 유지하며 명시적인 신청 초기화 때 새 요청번호를 만든다.
- 평가 재시도는 `pending`, 명확한 `submission_rejected`, 종결 `failed`에 한한다. 원자적 상태 변경에 성공한 요청만 공급자를 호출하고 같은 신청의 attempt를 올린다. `Retry-After`를 지킨다. 공급자는 멱등 키를 제공하지 않으므로 timeout/접수 후 저장 실패는 `submission_unknown`으로 보존하고 자동 재접수를 차단한다. 접수 중 프로세스 종료도 120초 후 이 상태로 전환한다.
- 접수 불명 상태에서 공급자 작업번호를 확보했다면 **공급자 작업번호로 접수 복구**를 사용한다. 서버가 공급자에서 읽은 원본 `source_sha256`와 사업자번호가 해당 신청의 보관 파일·사업자번호와 모두 일치해야 연결한다. 새 외부 작업을 만들지 않는다. 번호나 해시 확인이 불가능하면 공급자 확인이 필요하다.
- `credit_cases.applicationId`는 PRIMARY KEY여서 반복 동기화로 심사 건이 늘지 않는다. 기존 DB는 CREATE/ALTER로 확장하며 신청번호·기존 파일·기존 보고서를 이관하거나 삭제하지 않는다. 통합 기록이 있으면 계약 설정을 지운 경우에도 reset을 차단한다.
- 공개 데모의 기존 목록/프로필 메타데이터 API는 유지한다. 새 평가의 원본·보고서·검토 내용은 인증 API로만 제공한다. 운영용 전체 목록 인증·개인정보 및 암호화 키 관리 개선은 별도 기존 제약이다.
- `patent.html#apply`는 통합 신청으로 이동하고 `#evaluate`는 이전 특허 DB의 이력 조회용으로 남긴다. `/api/patent`의 기존 쓰기는 통합 서버에서 410으로 차단한다. 이전 단독 서버의 호환성 테스트 코드는 유지하며 실제 서비스는 `server/app.py`로 실행한다. `ALLOW_LEGACY_TEST_SUBMISSIONS`는 과거 입력의 회귀 테스트 전용 Flask 설정이고 일반 실행에서 활성화하지 않는다.
- 기존 미온체인 신청은 조회용으로 유지하고 lifecycle PATCH는 409로 차단한다. 검증되지 않은 예전 시연용 값으로 새 여신심사 전이를 만들 수 없다. 기존 온체인 신청은 기존 지갑 거래·동기화 경로를 유지한다.

## 실행과 설정

`server/.env`는 Git 제외 파일이다. 공급자 URL·토큰만 해당 파일에서 자동으로 읽는다. 체인과 DB 설정은 기존대로 환경변수에 지정한다. 실제 지갑 개인키는 서버에 넣지 않는다. 로컬 설정을 마련할 때 기존 `.env`를 덮어쓰지 않는다.

```powershell
server/venv/Scripts/python.exe -m pip install -r server/requirements.txt
cd blockchain
node scripts/compile.mjs
node scripts/build-web.mjs
cd ..
# 별도 로컬 개발 DB와 개발 계약/RPC를 지정한다.
$env:IPLOAN_DB_PATH = "$PWD/server/iploan-workflow-dev.db"
$env:IPLOAN_PATENT_DB_PATH = "$PWD/server/patent-workflow-dev.db"
$env:IPLOAN_RPC_URL = "개발 RPC"
$env:IPLOAN_CHAIN_ID = "개발 체인 ID"
$env:IPLOAN_MANAGER_ADDRESS = "개발 v2 계약 주소"
server/venv/Scripts/python.exe server/app.py
# 별도 터미널: 정적 UI
server/venv/Scripts/python.exe -m http.server 8001 --bind 127.0.0.1
```

일반 브라우저는 MetaMask와 각 담당자의 등록된 지갑을 사용한다. 외부 보고서 서비스가 없으면 신청·파일을 보존하고 접수 실패와 재시도 경로를 표시한다. DB에 암호화 키가 함께 있으므로 DB 사본도 비밀 데이터로 취급한다.

### 격리된 브라우저 QA

```powershell
cd blockchain
node scripts/workflow-qa.mjs
# 실제 평가 API를 호출할 때만 명시적으로:
node scripts/workflow-qa.mjs --real-provider
```

출력한 loopback URL을 연다. 이 도구는 일회성 EVM에 개발 계약을 배포하고 임시 DB와 IPFS 테스트 대역을 사용한다. 상단 QA 지갑 선택은 MetaMask 대신 로컬 테스트 계정으로 서명한다. 기본 보고서 API도 테스트 대역이며 `--real-provider`만 실제 API다. 운영 네트워크에 연결하지 않고 외부에 바인딩하지 않는다. 이 도구는 실제 MetaMask 확장 사용 또는 실제 IPFS 업로드 성공의 증거가 아니다.

## 검증 명령

```powershell
$env:PYTHONPATH="$PWD/server"
server/venv/Scripts/python.exe -m unittest server.test_app server.test_patent_integration server.test_participant_assignment server.test_loan_workflow server.test_patent_value server.test_server_compat server.test_evaluations -q
Remove-Item Env:PYTHONPATH
node --check js/workflow.js
node --check js/app.js
node --test js/app.test.cjs js/chain.test.cjs js/admin.test.cjs
cd blockchain
node scripts/compile.mjs
node scripts/build-web.mjs
node --test test/*.test.mjs
```

서버 테스트는 임시 DB만 사용한다. 신규 테스트는 정상·LTV 초과·미완료·실패·재시도·접수 불명·동시 중복·서명 재사용/변조·권한 회수·정책 설정 누락을 검사한다. HTML 어댑터는 단위 변환·0/음수·누락·모호한 값·불일치를 검사한다. 실제 EVM 통합 테스트의 공급자 및 IPFS는 테스트 대역이다. 정적 HTML/JS 프로젝트로 별도 TypeScript 타입 검사기는 없으며 JS 구문 검사, 회귀 테스트, 계약 컴파일, Python 테스트로 검증한다.

검증 결과와 실제 공급자 연동 범위는 작업 결과 보고에 따로 기재한다. 테스트 대역 통과를 실제 공급자·실제 IPFS·운영 체인 전체 연동 완료로 보고하지 않는다.
