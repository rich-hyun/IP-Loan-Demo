# 대출·특허평가 통합 흐름

기준 커밋은 `b4e01af`이다. 루트 서비스(`index.html`, `js/`, `server/app.py`)를 수정하며 `IP-Loan-Demo-main/`과 기존 로컬 작업 폴더는 보존한다. 운영 배포·운영 DB 수정·알림 발송·git push는 수행하지 않는다.

동시에 진행 중인 NFT/SBT 이미지 작업과 분리하기 위해 `codex/loan-evaluation-integration` 브랜치의 전용 워크트리에 통합 변경을 모았다. 원래 체크아웃은 수정하거나 정리하지 않고 보존했다. 이 브랜치는 기존 v2 계약을 재사용하며 이미지 발급용 새 계약 배포를 요구하지 않는다. 두 작업의 병합은 별도 단계다. 검증 환경의 Python 가상환경과 Node 의존성은 원래 폴더의 설치본에 대한 junction으로 재사용하지만 소스·테스트 DB·컴파일 산출물은 전용 워크트리에서 사용한다.

## 구현과 판단 근거

- 신규 신청의 진입점은 대출 신청이다. 특허 공고전문 PDF 하나를 `registryDocument` 필드로 받는다. 기존 필드 이름은 API 호환을 위해 유지한다. 현재 대출의 파일 상한인 20MiB를 적용한다.
- 기존 AES-256-GCM 암호화·IPFS 업로드·원본 해시·기업 프로필·담당자 배정·v2 SBT/NFT 계약을 재사용한다. 같은 암호문을 대출 DB에 보관하고 외부 평가 API에 보낼 때만 임시 PDF로 복호화한다. 재시도 때 브라우저 업로드나 IPFS 재업로드가 필요 없다. 원부 진위 대조는 기존 mock이며 실제 특허청 검증으로 주장하지 않는다.
- 외부 평가 접수·상태 조회·identity·보고서 다운로드는 기존 `patent_api.py` 클라이언트를 사용한다. 서버가 신청 저장 후 같은 요청에서 공급자 접수를 수행하며, 생성 작업은 공급자의 비동기 큐에서 진행된다. 접수 지연 중에는 제출 버튼에 처리 상태가 표시된다. 접수 후 상태 조회 버튼으로 15분의 읽기 세션을 만들면 10초마다 갱신한다. 페이지를 닫아도 작업번호와 파일은 DB에 남는다.
- `applications.id`를 `loan_evaluations.appId`, `loan_evaluation_attempts.appId`, `loan_artifacts.appId`, `evaluation_reports.applicationId`, `credit_cases.applicationId`의 연결 키로 사용한다. 기존 `appKey`는 이 신청번호의 해시이다. 실패한 이전 접수의 작업번호·상태·오류도 차수별로 남긴다. 평가 작업번호, 원본 해시, 공급자 보고서 해시, 자동 산출 가치, 적용 가치, 평가사 지갑과 검토 사유, 보고서의 신용등급과 재무 점검 결과, 서버 자동심사 판정을 확정 JSON에 함께 넣고 기존 IPFS 보고서 CID·해시를 체인에 기록한다.
- 실제 검토 사유·자동 산출값이 공개 IPFS에서 평문으로 노출되지 않도록 확정 JSON은 원본의 서버 보관 키와 새 IV로 AES-GCM 암호화해 업로드한다. 체인의 보고서 해시는 평문 확정 JSON의 SHA256이다. 공급자 보고서와 평가 진행 상태는 인증 없이 열람한다. 특허 원본은 지갑 서명 API로만 확인한다. 최종 적용 가치는 기존 계약 설계대로 체인에 공개된다.
- 평가사는 공급자 보고서·자동 산출 값을 확인하고 적용 가치와 검토 사유를 입력한다. 준비된 확정 내용은 변경하지 않는 것으로 가정했다. 지갑 취소·응답 유실 시 같은 내용으로 재시도하며 실제 체인 확인 전에는 여신심사에 전달하지 않는다. 일반 PATCH로 확정이나 심사 상태를 우회할 수 없다.
- 현재 v2 계약에 이미 `amount * 100 <= value * 70` 규칙이 있다. 이 **데모 계약의 70% 기준**을 서버에서도 정수 비교로 적용한다. 표시용 LTV의 반올림값으로 판정하지 않는다. 체인 진입 기준에는 새 수치를 두지 않았다(서버 자동심사 기준은 아래 별도). 계약·RPC·역할 설정이 없으면 통합 접수/확정을 차단한다. 다른 LTV 정책은 계약과 서버를 함께 변경해야 하며 환경변수만으로 계약과 다른 정책을 적용하지 않는다.
- 실제 체인 확정이 보고서·검토 기록과 일치하고 양의 적용 가치로 LTV를 통과해야 `credit_cases` 한 건이 생성된다. 미완료·실패·보고서 없음·가치 없음/0/음수·LTV 초과는 심사 건을 만들지 않는다. 초과 건은 `RuleRejected/rejected`와 사유를 표시한다.

## 평가 API 요약값: 금액·신용등급·재무

평가 API 1.0.0의 완료 상태 응답(`GET /v1/evaluations/{job_id}`)에는 보고서 요약값이 함께 온다. `report_summary.py`가 정해진 필드의 형식만 확인해 `loan_evaluations`에 저장한다.

- `valuation.ip_value_krw`(원 단위 정수)를 자동 산출 가치로 쓴다(`valueSource=provider-valuation-json`). 보고서 글자는 억 원 단위로 반올림되므로 숫자 필드를 우선한다. `value_status`가 `confirmed`가 아니면 사전평가 값으로 안내한다. 0 이하 값도 그대로 보여주고 부적합 안내를 붙인다. 평가사는 지금처럼 적용 가치와 검토 사유를 입력해 확정한다.
- `credit_rating`은 평가기가 보유한 같은 기업의 회사자료(TCB)에 적힌 등급이다. 대문자 등급(`BB-` 등)만 남기고 해석할 수 없으면 비운다. 여신심사 화면의 "신용등급"에 표시하고, 없으면 "판정 불가 (자료 없음)"으로 표시한다. v2 계약에는 신용등급 필드가 없으므로 체인에 기록하지 않는다. 계약 자동심사(70% 규칙)에는 쓰지 않고 서버 자동심사에 쓴다.
- `financials`는 최근 3개 결산연도만 남긴다. 자본잠식 여부는 자본총계로 다시 계산하고, 잠식이면 부채비율을 비운다. 은행 화면의 재무 점검(자본잠식·영업이익·이자보상배율 1배·유동비율 100%)은 서버 자동심사에 쓴다. 값이 없으면 통과가 아니라 판정 불가다.
- 서버 자동심사(`report_summary.auto_review`, 정책 `v2-server-auto-review-1`)는 확정 준비 때 신용등급·재무 점검·신청금액·적용 가치로 승인(`approve`)·거절(`reject`)·검토 필요(`review`)를 정한다. 기준 수치는 `report_summary.py` 상단 상수에 모았다. LTV는 계약처럼 정수로 비교한다(`amount * 100 <= value * 60`).
  - LTV 70% 초과, 또는 CCC+ 이하 등급: 거절. 70% 초과는 계약도 `RuleRejected`로 막는다.
  - 등급 없음·해석 불가, 재무 점검 하나라도 미충족·자료 없음: 검토 필요. 자료 없음을 통과로 보지 않는다.
  - AAA~BBB-, 점검 4개 통과: 승인.
  - BB+~B-, 점검 4개 통과, LTV 60% 이하: 승인. 60% 초과면 검토 필요.
- 계약은 바꾸지 않았다. 체인은 여전히 70% 규칙만 판정하고 최종 승인·거절은 은행 지갑이 한다. 은행 결정이 판정과 달라도 체인 상태가 최종이므로 동기화를 막지 않고 표시만 한다.
- 이 필드가 생기기 전에 완료된 작업은 상태 조회 때 같은 작업번호로 요약값을 한 번 더 읽는다. 실패하면 10분 뒤 다시 시도한다. 확정 준비(`preparedHash`)가 끝난 건은 확정 JSON이 자동 산출 가치를 포함하므로 금액을 바꾸지 않고 신용등급·재무만 채운다.
- 요약값이 없는 예전 작업은 HTML 보고서의 `IP 가치금액` 표를 읽는 `patent_value.py`를 대비책으로 유지한다. 정확히 `IP 가치금액`인 `th`와 바로 뒤 `td`, 명시된 원/만원/백만원/억원 단위만 읽고, 누락·충돌·원 미만 소수는 해석하지 않는다. 일반 본문·신청금액·신용점수에서 금액을 추정하지 않는다.
- 신용등급·재무 점검 결과·자동심사 판정(`autoReview`: `policy`·`decision`·`ltvPct`·`reasons[{code,label}]`)은 평가사 확정 JSON에 들어가 보고서 해시로 체인에 묶인다. 확정 JSON은 암호화해 IPFS에 올리므로 등급 원문은 체인에 남지 않는다. 같은 확정을 재시도하면 처음 준비한 값을 그대로 써서 해시가 바뀌지 않는다. 자동심사 이전에 준비한 확정은 재시도해도 `autoReview` 없이 유지한다.
- 진행 상태와 보고서처럼 요약값도 `GET /api/applications/<id>/evaluation`에서 인증 없이 열람한다. 신청 목록에는 신용등급만 포함한다.
- 같은 응답의 `evaluation.autoReview`는 준비된 확정 JSON의 판정이다. 확정 준비 전이나 자동심사 이전 확정이면 `null`이고, 표시용으로 새로 계산하지 않는다. `evaluation.autoReviewFollowed`는 체인 상태가 `Approved`·`Repaid`(승인)·`Rejected`(거절)일 때 은행 결정이 판정과 같으면 `true`, 다르면 `false`다. 그 전이거나 판정이 `review`·없음이면 `null`이다.

## 특허 등록원부 자동 수집

신청을 접수하면 서버가 공고전문 PDF의 `(11) 등록번호`(없으면 입력한 `ipRegNo`가 `10-NNNNNNN` 형식일 때)로 공공데이터포털 [등록원부 실시간 정보 조회](https://www.data.go.kr/data/15124946/openapi.do) `getPatentRegisterHistory`를 호출해 `applications.patentRegister`(JSON)에 요약을 저장한다(`server/patent_register.py`). 신청 응답과 목록에 `patentRegister`로 나온다.

- 인증키는 `server/local_keys.json`(Git 제외)의 `PATENT_REGISTER_API_KEY`이고, 같은 이름의 환경변수가 우선한다. KIPRIS 키와 별개다. 운영 API는 NAS 폴더를 직접 실행하므로 운영 폴더에 파일을 두면 되고 Git으로 배포하지 않는다(공개 저장소·Pages). 조회마다 읽으므로 파일을 바꿔도 재시작이 필요 없다. 키가 든 URL이나 예외 원문은 저장·기록하지 않는다.

  ```json
  {"PATENT_REGISTER_API_KEY": "공공데이터포털 인증키"}
  ```
- `status`: `collected`, `not_found`(원부에 없음), `failed`(연결·응답 오류), `unconfigured`(키 없음), `no_number`(특허 등록번호를 못 찾음). 조회 실패는 신청을 막지 않는다.
- 요약: 명칭·출원번호·등록일·존속만료일·최종처분, 현재 권리자(`currentOwners`)와 신청 기업명의 일치 여부(`ownerMatch`, `주식회사`·`(주)`·공백 무시), 권리 이력(`rights`), 연차료 납부(`annuities`), 전용·통상실시권. 주소·발명자는 저장하지 않는다.
- `lastDispst`는 소멸 뒤에도 `등록결정`으로 남는다. 권리 이력의 `소멸등록`(이후 `회복등록`이 없을 때)을 `lapsedAt`·`lapseReason`으로 따로 둔다. 다음 연차료 납부기한은 계산하지 않는다.
- **소멸된 특허는 신청이 시작되지 않는다.** PDF를 고르면 `POST /api/documents/fields`가 같은 조회를 해 `patentRegister`를 함께 돌려주고, 화면은 조회 동안 전체 음영과 "등록원부 확인 중입니다"를 띄운다. `lapsedAt`이 있으면 메시지를 보이고 제출을 막는다. 서버도 신청 접수 때 다시 조회해 IPFS 업로드·DB 저장 전에 422 `patent_lapsed`로 거절한다. 조회 실패·키 없음은 막지 않는다.
- 특허(10-)만 조회한다. 실용신안·디자인·상표는 번호 체계와 오퍼레이션이 다르다.
- **평가사 권리 확인.** 평가사 보고서 화면에 등록원부와 신청 내용(권리자·명칭·번호)을 항목별로 나란히 보이고, 권리 상태·실시권·연차료·권리 이력을 함께 보인다. 일치 표시는 참고용이고 판단은 평가사가 한다. `POST /api/applications/<id>/patent-register` `{action: "confirm" | "refresh"}`(배정 평가사, Evaluating 단계, 서명 또는 로그인 세션)로 확인을 기록하거나 다시 조회한다. 다시 조회하면 기존 확인이 지워진다. 소멸 특허는 확인할 수 없다.
- 평가 확정(`evaluation-report`)은 권리 확인이 있어야 한다. 확인 시각·지갑과 그때의 등록번호·조회 시각·현재 권리자를 `rightsCheck`로 평가 매니페스트에 넣어 온체인 `reportHash`에 묶는다. 이 기능 전에 준비된 확정은 재시도 때 그대로 둔다.

## 접근 권한·중복 방지·복구

- `GET /api/applications/<id>/evaluation`(진행 상태)과 `GET .../evaluation/artifacts/<kind>`(보고서, `?download=1`은 내려받기)는 인증 없이 열람한다. 상태 조회 때 서버가 공급자 진행 상황을 10초 간격 제한으로 확인해 저장한다.
- 접수·재시도·identity·복구·원본·검토 API와 기존 POST 상태·보고서 API는 nonce와 `personal_sign` 서명을 검증한다. nonce는 작업·신청번호·정렬된 JSON 내용 SHA256·지갑에 묶여 5분 후 만료되고 SQLite에서 한 번만 소비된다. 멀티프로세스에서도 재사용할 수 없다. 업로드 서명 내용에는 파일의 평문 SHA256도 포함한다.
- 서버가 배정한 차주·평가사·은행 지갑과 현재 역할을 확인한다. UI 역할 선택은 인증이 아니다. 15분 상태 조회 세션은 메모리에만 보관하며 상태 조회 외의 쓰기·보고서·파일 요청에는 사용할 수 없다. 세션 조회마다 현재 역할과 담당자를 재검증한다.
- 원본의 평가사 열람은 실제 체인의 Evaluating/SBT 단계, 은행 열람은 Approved/Repaid/NFT 단계로 제한한다. 은행은 Eligible 이후 보고서를 검토할 수 있다. 차주는 자기 신청과 파일을 확인할 수 있다.
- `(borrower, requestId)` UNIQUE와 SQLite 쓰기 트랜잭션으로 동시 제출을 직렬화한다. 같은 요청번호·같은 서명 대상 내용은 저장된 신청으로 복귀한다. 같은 요청번호에 다른 파일/내용은 409이다. 브라우저는 응답 유실 때도 같은 요청번호를 유지하며 명시적인 신청 초기화 때 새 요청번호를 만든다.
- 평가 재시도는 `pending`, 명확한 `submission_rejected`, 종결 `failed`에 한한다. 원자적 상태 변경에 성공한 요청만 공급자를 호출하고 같은 신청의 attempt를 올린다. `Retry-After`를 지킨다. 공급자는 멱등 키를 제공하지 않으므로 timeout/접수 후 저장 실패는 `submission_unknown`으로 보존하고 자동 재접수를 차단한다. 접수 중 프로세스 종료도 120초 후 이 상태로 전환한다.
- 접수 불명 상태에서 공급자 작업번호를 확보했다면 **공급자 작업번호로 접수 복구**를 사용한다. 서버가 공급자에서 읽은 원본 `source_sha256`와 사업자번호가 해당 신청의 보관 파일·사업자번호와 모두 일치해야 연결한다. 새 외부 작업을 만들지 않는다. 번호나 해시 확인이 불가능하면 공급자 확인이 필요하다.
- `credit_cases.applicationId`는 PRIMARY KEY여서 반복 동기화로 심사 건이 늘지 않는다. 기존 DB는 CREATE/ALTER로 확장하며 신청번호·기존 파일·기존 보고서를 이관하거나 삭제하지 않는다. 통합 기록이 있으면 계약 설정을 지운 경우에도 reset을 차단한다.
- 공개 데모의 기존 목록/프로필 메타데이터 API는 유지한다. 새 평가의 원본과 검토 확정은 인증 API로만 제공한다. 공급자 보고서는 신청번호만 알면 열람할 수 있으므로 운영 공개 전에 접근 범위를 다시 정해야 한다. 운영용 전체 목록 인증·개인정보 및 암호화 키 관리 개선은 별도 기존 제약이다.
- `patent.html#apply`는 통합 신청으로 이동하고 `#evaluate`는 이전 특허 DB의 이력 조회용으로 남긴다. `/api/patent`의 기존 쓰기는 통합 서버에서 410으로 차단한다. 이전 단독 서버의 호환성 테스트 코드는 유지하며 실제 서비스는 `server/app.py`로 실행한다. `ALLOW_LEGACY_TEST_SUBMISSIONS`는 과거 입력의 회귀 테스트 전용 Flask 설정이고 일반 실행에서 활성화하지 않는다.
- 기존 미온체인 신청은 조회용으로 유지하고 lifecycle PATCH는 409로 차단한다. 검증되지 않은 예전 시연용 값으로 새 여신심사 전이를 만들 수 없다. 기존 온체인 신청은 기존 지갑 거래·동기화 경로를 유지한다.

## 지갑 로그인

v3와 같은 방식이다(`server/auth.py`). 계약은 바꾸지 않았다.

- `POST /api/auth/challenge` `{address}` → `{nonce, message}`. 메시지에 서비스 이름(`IP담보 자동대출`)·주소·체인 ID·nonce·발급/만료 시각이 들어간다. 거래가 아니며 수수료가 없다.
- `POST /api/auth/login` `{address, nonce, signature}` → `{token, address, roles, expiresAt}`. challenge는 5분 뒤 만료되고 실패해도 한 번만 소비된다. 세션은 12시간이다. SQLite `auth_challenges`·`sessions`에 두고 토큰은 SHA256만 저장하므로 gunicorn 워커 간에 공유된다.
- `GET /api/auth/me`(Bearer) → `{address, roles}`. `POST /api/auth/logout`(Bearer)은 그 세션만 끝내며 체인을 읽지 않는다.
- 역할은 설정된 v2 Manager의 `hasRole`로 읽는다(`chain.roles`). `DEFAULT_ADMIN_ROLE`→`admin`, `BORROWER_ROLE`→`borrower`, `EVALUATOR_ROLE`→`evaluator`, `BANK_ROLE`→`bank`. `me`는 워커별 30초 캐시(`IPLOAN_ROLE_CACHE_SECONDS`)를 쓰고 로그인은 새로 읽는다. 역할이 없어도 로그인은 된다. 계약 주소·RPC가 없거나 연결되지 않으면 login·me는 503 `chain_unavailable`이다.
- 세션은 지갑만 증명한다. 건별 서명 `{nonce, signature}` 자리에 `{"login": "<token>"}`을 보내면 `loan_workflow.authorize`가 세션의 지갑을 쓴다. 그 뒤의 담당자 대조·체인 `require_role`(캐시 없음)·단계 규칙·`create`의 `borrowerWallet` 확인은 서명 경로와 같다. `create`는 multipart `auth` 필드의 JSON 문자열, 나머지는 JSON 본문의 `auth` 키다. 만료·모르는 토큰은 403이다.
- 기존 원본 열람 `POST /api/applications/<id>/document`도 `{nonce, signature}` 대신 `{"login": "<token>"}`을 받는다. `address`를 함께 보내면 세션 지갑과 같아야 한다. 이후 단계·담당자·역할 확인은 같다.
- 세션은 만료·로그아웃 전까지 재사용된다. 세션으로 보낸 요청은 내용에 대한 서명이 없다. 공개 열람 API는 지금처럼 인증 없이 연다. 계약 거래는 여전히 각 지갑이 MetaMask로 서명한다.

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

실제 MetaMask·IPFS·평가 API를 함께 사용할 로컬 실행은 저장소 루트의 `start-local.ps1`과 `LOCAL_RUN.md`를 사용한다. 기본 주소는 8003이고 이 모드는 지갑·IPFS·평가 클라이언트를 교체하지 않는다. 아래 QA 도구는 자동화 테스트 전용이다.

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
server/venv/Scripts/python.exe -m unittest server.test_app server.test_auth server.test_patent_integration server.test_participant_assignment server.test_loan_workflow server.test_patent_value server.test_report_summary server.test_server_compat server.test_evaluations -q
Remove-Item Env:PYTHONPATH
node --check js/workflow.js
node --check js/app.js
node --test js/app.test.cjs js/chain.test.cjs js/admin.test.cjs
cd blockchain
node scripts/compile.mjs
node scripts/build-web.mjs
node --test test/*.test.mjs
```

서버 테스트는 임시 DB만 사용한다. 신규 테스트는 정상·LTV 초과·미완료·실패·재시도·접수 불명·동시 중복·서명 재사용/변조·권한 회수·정책 설정 누락, 자동심사 기준표·확정 JSON 바인딩·재시도 해시 유지를 검사한다. HTML 어댑터는 단위 변환·0/음수·누락·모호한 값·불일치를 검사한다. 실제 EVM 통합 테스트의 공급자 및 IPFS는 테스트 대역이다. 정적 HTML/JS 프로젝트로 별도 TypeScript 타입 검사기는 없으며 JS 구문 검사, 회귀 테스트, 계약 컴파일, Python 테스트로 검증한다.

테스트 대역 통과는 실제 공급자·실제 IPFS·운영 체인 전체 연동의 검증이 아니다.
