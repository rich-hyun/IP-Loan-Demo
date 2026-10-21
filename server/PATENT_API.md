# IP 담보대출 API와 특허평가 연동

> 현재 통합 서비스에서는 신규 접수·검토를 대출 API로 통합했습니다. 이 문서는 기존 단독 특허 서버와 공급자 API의 기록입니다. 통합 서버의 `/api/patent`는 기존 이력 조회만 제공하며 쓰기는 410입니다. 신규 사용법은 [LOAN_WORKFLOW.md](LOAN_WORKFLOW.md)를 따르세요.

`patent_app.py`는 기존 신청 데이터를 유지하면서 특허평가 작업과 원본 PDF를 저장합니다. 웹브라우저는 이 서버에 요청하며, 외부 평가 API의 주소·인증 헤더는 서버가 처리합니다. HTTPS 웹에서 HTTP 평가 API를 직접 호출할 필요가 없습니다.

## 설정과 로컬 실행

프로젝트 루트에서 실행합니다. 기존 `server/venv`가 없으면 먼저 가상환경을 만들고 `server/requirements.txt`를 설치합니다. 외부 API 연결에는 Python 표준 라이브러리를 사용하므로 추가 패키지는 필요하지 않습니다.

```bash
cp server/.env.patent.example server/.env
chmod 600 server/.env
```

이미 `.env`가 있다면 기존 파일을 보존합니다. 파일에는 제공받은 값으로 아래 항목을 설정합니다. 현재 작업 환경에는 고객 연동안내 PDF의 값을 설정했습니다.

```dotenv
IPLOAN_PATENT_API_URL=http://203.252.147.200:20024
IPLOAN_PATENT_API_TOKEN=제공받은_인증값
```

환경변수가 `.env`보다 우선합니다. `.env`는 Git에서 제외되며 프론트엔드로 제공하지 않습니다.

```bash
server/venv/bin/python server/patent_app.py
```

`http://127.0.0.1:5000`에서 프론트엔드와 API를 함께 사용합니다. 다른 포트는 `PORT` 환경변수로 설정할 수 있습니다. 웹 파일은 `/`, `/css/`, `/js/`에서만 제공합니다.

| 환경변수 | 기본값 / 역할 |
| --- | --- |
| `IPLOAN_PATENT_DB_PATH` | `server/patent-iploan.db` |
| `IPLOAN_PATENT_UPLOAD_DIR` | `server/patent-uploads` |
| `IPLOAN_PATENT_API_URL` | 안내서의 평가 API 기본주소 |
| `IPLOAN_PATENT_API_TOKEN` | 서버 인증값, 설정 필수 |
| `IPLOAN_ALLOWED_ORIGINS` | 운영 웹 도메인과 localhost:5000 |

## 신청과 평가 흐름

1. 사업자등록번호와 특허 공고전문 PDF 1개를 제출합니다. PDF 상한은 50MiB이며 기업명·특허명·대출금액은 선택입니다. 기존 등록원부 업로드 API는 20MiB 제한을 유지합니다.
2. 원본 PDF와 SHA-256, 신청번호를 먼저 저장한 뒤 외부 `POST /v1/evaluations`에 `patent_pdf`, `business_number`를 전달합니다. `Authorization`에는 제공된 토큰 값만 사용합니다.
3. 작업번호와 상태를 SQLite에 저장합니다. 브라우저는 10초마다 상태를 확인하며, 서버도 작업당 10초 이내 공급자 중복 조회를 막습니다. 페이지를 닫아도 공급자 생성 작업은 계속됩니다. 다시 열면 저장된 작업을 조회합니다.
4. `awaiting_identity`에서는 기존 작업에 사업자번호만 전달합니다. PDF를 재접수하지 않습니다.
5. `completed` 응답에 실제 존재하는 PDF/HTML 및 quality·trace·timing·log만 제공합니다. 결과는 인증된 서버 프록시로 전달하며, HTML은 sandbox 정책으로 표시합니다.
6. 평가자는 보고서와 근거자료를 검토한 후 담보가치와 신용평가 점수를 입력해 확정합니다. 대출금액이 있으면 `review`, 없으면 `evaluated` 상태가 됩니다. API의 문서 내용을 임의 숫자로 변환하거나 예시 평가치를 생성하지 않습니다.

큐 상한(429)은 `Retry-After` 이후 보관된 PDF로 같은 신청에서 수동 재접수할 수 있습니다. 접수 중 연결이 끊겨 작업번호를 받지 못했다면 `submission_unknown`으로 보존하며 자동 재접수를 허용하지 않습니다. 프론트엔드의 `request_id`는 로컬 신청 중복 방지용이며 공급자 API의 중복 방지 키가 아닙니다.

## 추가 API

아래 표의 `/api`는 단독 실행 경로입니다. 통합 운영에서는 `/api/patent`로 바꾸어 호출합니다.

| 메서드·경로 | 동작 |
| --- | --- |
| `GET /api/health` | 서버 및 평가 연동 설정 여부 |
| `POST /api/applications` | 기존 JSON/등록원부 업로드 + `patent_pdf` 특허평가 접수 |
| `GET /api/applications` | 저장된 신청 및 `evaluation` 상태 |
| `GET /api/applications/{id}/evaluation` | 공급자 상태 조회·저장 |
| `POST /api/applications/{id}/evaluation` | 외부 미접수가 확실한 신청만 재접수 |
| `POST /api/applications/{id}/evaluation/identity` | JSON `business_number`로 기존 작업 재개 |
| `GET /api/applications/{id}/evaluation/artifacts/{kind}` | 보고서/근거자료 열람, `?download=1` 다운로드 |
| `POST /api/applications/{id}/evaluation/confirm` | JSON `appraisedValue`, `creditScore`, 선택 `reviewerNote` 확정 |

기존 신청 GET/POST/PATCH, 차주기업 프로필 API를 유지합니다. API 보고서가 연결된 신청의 가치는 전용 확정 API로만 변경할 수 있습니다. DB 초기화는 `IPLOAN_ENABLE_RESET=1`과 `IPLOAN_ADMIN_KEY`, 일치하는 `X-Admin-Key`가 있을 때만 허용합니다.

## 기존 운영 서버 반영

현재 서비스 경로는 `/mnt/nas4/kjh/IP-Loan-Demo/server`, 바인딩은 `127.0.0.1:58080`, API 도메인은 `iploan-api.mustree.kr`입니다. `iploan-api.service`는 `.env`, 동시 요청용 스레드, 120초 timeout을 설정합니다. `nginx-iploan-api.conf`는 50MiB PDF를 허용하도록 요청 상한과 프록시 timeout을 설정합니다.

운영 반영 시 기존 DB와 uploads를 보존하고 아래 설정을 적용합니다. 설치된 Nginx 파일 경로는 현재 서버의 구성에 맞춥니다.

```bash
sudo cp server/iploan-api.service /etc/systemd/system/iploan-api.service
sudo systemctl daemon-reload
sudo systemctl restart iploan-api
sudo cp server/nginx-iploan-api.conf /etc/nginx/sites-available/iploan-api
sudo nginx -t
sudo systemctl reload nginx
```

프론트엔드도 `patent.html`, `css/patent.css`, `js/patent-app.js`, **`js/evaluations.js`**를 함께 반영해야 합니다. localhost에서는 `/api`, 운영에서는 `https://iploan-api.mustree.kr/api/patent`를 사용하며 `window.IPLOAN_API_BASE`로 다른 API 주소를 지정할 수 있습니다.

현재 데모에는 로그인과 신청자·평가자별 접근 권한이 없습니다. 외부 API의 인증값 보호와 이 플랫폼의 사용자 인증은 별도입니다. 실제 기업자료를 사용하는 운영 환경에는 사용자 인증이 필요합니다.

## 검증

```bash
cd server
./venv/bin/python -m unittest -v test_server_compat test_evaluations
```

임시 SQLite와 업로드 폴더에서 기존 호환성, PDF 접수, 작업 복구, 중복 방지, 상태 조회 간격, 기업번호 재입력, 실패·429, 결과 프록시, 확정 전 차단 및 평가 확정을 검사합니다. 외부 보고서 생성은 mock 처리합니다.

통합 운영 서버에서는 기존 API를 유지하며 `/api/patent`에 특허평가 앱을 연결합니다. 기존 대출 DB와 특허평가 DB는 각각 보존합니다.
