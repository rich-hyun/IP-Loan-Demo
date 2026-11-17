# TPS 측정 도구

KISA 「TPS 성능 측정 결과 보고서」의 API 엔드포인트 10종 TPS를 측정한다. 운영 서버·운영 DB·Mustsem 체인에는 연결하지 않는다.

## 시험 환경

| 구성 | 내용 |
| --- | --- |
| 체인 | Hardhat 로컬 노드 (chain id 31337, automine, 127.0.0.1:8545). v2 `IPLoanManager`를 매번 새로 배포한다 |
| 역할 지갑 | 차주·평가사·은행 각 1개 (운영과 같은 구성). 기본은 공개 Hardhat 시험 니모닉이며 31337에서만 허용한다. `TPS_MNEMONIC` 또는 `TPS_ADMIN_KEY`·`TPS_BORROWER_KEY`·`TPS_EVALUATOR_KEY`·`TPS_BANK_KEY`로 바꿀 수 있다 |
| API | 실제 `server/app.py`. `env/tps_server.py`가 waitress로 띄우며 운영(gunicorn `-w 2 --threads 4`)처럼 2개 프로세스 × 4 스레드로 실행하고, 클라이언트가 번갈아 요청한다 |
| 시험 대역 | 외부 서비스만 대체한다. IPFS 업로드·게이트웨이는 로컬 파일, LLM 평가 API는 완료 응답 고정(`server/integration_runner.py` 픽스처와 같은 형식), 등록원부 API는 미설정 응답 |
| 문서 | 실제 등록공고문과 같은 크기(993,736바이트)의 시험용 PDF |

## 엔드포인트 매핑

| ID | 엔드포인트 | 측정 요청 | 성공 조건 | pool |
| --- | --- | --- | --- | --- |
| E01 | IP 평가요청 | `POST /api/applications` (통합 신청 multipart, 차주 로그인 세션). 신청 생성과 LLM 평가 접수 포함 | 201 | 없음 (요청마다 새 request_id) |
| E02 | LLM 보고서 자동 생성 | `GET /api/applications/{id}/evaluation/artifacts/pdf` | 200 | 반복 사용 30건 |
| E03 | 결과 해시 기록 | 컨트랙트 `confirmEvaluation` (평가사 서명) | receipt status 1 | `evaluating` |
| E04 | 대출신청 및 담보 IP 등록 | 컨트랙트 `submitApplicationWithMetadata` (차주 서명) | receipt status 1 | `created` |
| E05 | IP 해시값 등록 | `POST /api/applications/{id}/sync` (체인의 CID·fileHash·토큰을 서버 기록과 대조·반영) | 200 | 반복 사용 30건 |
| E06 | RWA토큰 은행월렛 전송 | 컨트랙트 `finalApprove` (채권 NFT를 은행 지갑에 발행) | receipt status 1 | `eligible-E06` |
| E07 | IP 가치평가서 등록 | `POST /api/applications/{id}/evaluation-report` (평가사 세션) | 200 | `rightsChecked` |
| E08 | 신용평가 호출 | `GET /api/applications/{id}/evaluation` (신용등급·재무점검·자동심사 결과 반환) | 200 | 반복 사용 30건 |
| E09 | 대출승인여부 결정 | 컨트랙트 `finalApprove`/`finalReject`를 번갈아 호출 (은행 서명) | receipt status 1 | `eligible-E09` |
| E10 | 스마트컨트랙트 대출계약 생성 | 컨트랙트 `finalApprove` (E06과 같은 함수) | receipt status 1 | `eligible-E10` |

컨트랙트 항목은 서버가 아니라 지갑이 서명하는 트랜잭션이라 tx 전송부터 receipt 확인까지를 한 요청으로 잰다. 체인 pool(`created`·`evaluating`·`eligible-*`)은 서버가 발급하는 값과 같은 형식(CID, fileHash, 게이트웨이 메타데이터 URI)으로 컨트랙트에 직접 만든다. 서버 pool(`rightsChecked`, 반복 사용)은 실제 API로 신청 → 체인 등록 → 동기화 → 권리 확인(→ 평가서)을 거친다.

## 측정 방법

- 닫힌 루프 부하: 가상 사용자 N명이 응답을 받으면 바로 다음 요청을 보낸다.
- TPS = 측정 시간 안에 끝난 정상 요청 수 ÷ 측정 시간(초)
- 평균 응답시간 = 정상 요청 응답시간의 평균 (HTTP는 요청부터 응답 본문 수신까지, tx는 전송부터 receipt까지)
- 성공률 = 정상 요청 수 ÷ 측정 시간 안에 끝난 전체 요청 수 × 100
- 측정 시간이 끝날 때 진행 중이던 요청은 기다리기만 하고 집계하지 않는다. 회차별 값의 평균으로 판정한다.
- pool이 측정 중에 바닥나면 그 항목은 `무효(pool 소진)`로 표시한다.

## 실행

```powershell
# 1회 준비: server/venv(requirements.txt + waitress), blockchain npm ci + npm run compile, 이 폴더 npm install
node start-env.mjs              # 시험 환경 기동. 끝날 때까지 켜 둔다 (Ctrl+C로 종료)
node smoke-test.mjs             # 신청 1건 전체 흐름 확인
node prepare-pool.mjs --created 18000 --evaluating 18000 --eligible 18000 --reusable 30 --rightsChecked 300
node tps-measure.mjs            # 설정값(가상 사용자 10명, 60초, 3회)으로 10종 측정
node tps-measure.mjs --endpoints E01,E07 --duration 60 --runs 3
```

결과는 `results/<시각>_native/`에 저장한다. `summary.md`·`summary.json`이 요약, `raw/<ID>_run<n>.csv`가 요청별 기록이다.
