# Flask 서버 배포 안내

루트 `README.md`부터 읽으세요. 실제 금융서비스가 아니라 시연용입니다.

## Ubuntu 서버 실행

```bash
cd /opt/IP-Loan-Demo-main/server
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
gunicorn --workers 2 --bind 127.0.0.1:5000 'app:app'
```

기본 DB는 `server/iploan.db`, 업로드는 `server/uploads/` 입니다. 앱 재배포 전 DB와 업로드 폴더를 반드시 백업하세요. 공개 접근 가능 서버에서는 CORS 도메인 제한, HTTPS, 실제 로그인/인가, CSRF/남용 방지, 업로드 악성코드 검사, 백업암호화, 감사 로그 등을 추가해야 합니다. 현재 시연용 API 키만으로 금융정보를 보호할 수 없습니다.

`.env.example`은 **설명용**이며 자동으로 읽지 않습니다. 환경변수는 systemd EnvironmentFile 등으로 서버 전용 경로에서 설정하세요. 각 키는 `OPENAI_API_KEY`, `IPLOAN_API_KEY`, `IPLOAN_ADMIN_KEY`이며 저장소 업로드 금지입니다.

`server/iploan-api.service`는 **현재 디렉터리 및 사용자 경로에 맞게 수정**한 뒤 systemd에서 실행할 수 있습니다. Nginx는 `nginx-iploan-api.conf` 예시를 참고해 HTTPS 인증서를 구성하세요. 프론트와 API 모두 Flask에서 서비스하는 것이 가장 간단합니다.

## 핵심 API

| 메서드 | 엔드포인트 | 동작 |
|---|---|---|
| GET | `/api/health`, `/api/config` | 상태/연동 설정 |
| GET / POST | `/api/applications` | 목록/신규 신청 |
| POST | `/api/applications/:id/documents` | `multipart/form-data`, `files` 복수 첨부 |
| POST | `/api/applications/:id/documents/:docid/verify` | `{ "referenceSha256": "..." }` 입력한 참조값과 비교 |
| POST | `/api/applications/:id/evaluation` | 보고서 생성/재산정, `{ "reason": "..." }` |
| POST | `/api/applications/:id/evaluation/confirm` | 평가 확정, 보고서 해시 기록 |
| GET | `/api/applications/:id/report` | 보고서, 버전 및 SHA-256 |
| POST | `/api/applications/:id/review` | 규칙 기반 시연 심사, 선택 가상점수 `{ "creditScore": 75 }` |
| POST | `/api/applications/:id/decision` | `{ "action": "approve" }`, `reject` 또는 `hold` |
| POST | `/api/applications/:id/rwa` | 모의 RWA 발행 |
| POST | `/api/applications/:id/rwa/transfer` | 은행 시연 월렛 모의 이전 |
| POST | `/api/applications/:id/repay` | 모의 상환 `{ "amount": 1000000 }` |
| GET | `/api/ledger` | 모의/실제 체인 기록 목록 |
| POST | `/api/reset` | 데모 전용, IPLOAN_ADMIN_KEY 필수, 전체 DB/업로드 초기화 |

## RPC 해시 기록 (선택)

```bash
pip install -r requirements-chain.txt
```

`IPLOAN_CHAIN_MODE=rpc`, `IPLOAN_RPC_URL`, `IPLOAN_CHAIN_PRIVATE_KEY`, `IPLOAN_CHAIN_ID` 설정. 서버에서 가스비가 있는 전용 테스트 키로 자기 자신에게 `data=SHA-256`을 포함한 트랜잭션을 전송하며 마이닝 확인까지 대기합니다. **ERC-721 발행, 은행 월렛 이전, 대출 계약 실행을 수행하는 것은 아닙니다.** 프로덕션 키는 코드/환경변수 평문에 보관하지 마세요. 해당 기능은 별도 KMS/서명기 구성이 필요합니다.

서버 `iploan-api.service`와 `nginx-iploan-api.conf`는 예시 템플릿이므로 실제 운영 인스턴스 사용자와 호스트로 수정하여 사용하세요.
