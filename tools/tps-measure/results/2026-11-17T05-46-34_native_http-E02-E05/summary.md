# TPS 측정 결과 (native)

측정 시각: 2026-11-17T05:46:34.633Z ~ 2026-11-17T05:53:02.052Z

| ID | API | 엔드포인트 | 측정 요청 | 목표 TPS | 실측 TPS(평균) | 판정 | 평균 응답(ms) | p95(ms) | 성공률(%) | 정상/전체 |
|---|---|---|---|---|---|---|---|---|---|---|
| E02 | LLM 가치평가 API | LLM 보고서 자동 생성 | `GET /applications/{id}/evaluation/artifacts/pdf` | 5 | 178.09 | 달성 | 59.5 | 94.8 | 100.00 | 32057/32057 |
| E05 | IP RWA화 API | IP 해시값 등록 | `POST /applications/{id}/sync` | 10 | 14.73 | 달성 | 708.9 | 1068.2 | 99.88 | 2652/2656 |

## 회차별

| ID | 회차 | 시작 | 정상/전체 | TPS | 평균(ms) | p95(ms) | 성공률(%) |
|---|---|---|---|---|---|---|---|
| E02 | 1 | 2026-11-17T05:46:34.633Z | 7848/7848 | 130.80 | 76.4 | 125.3 | 100.00 |
| E02 | 2 | 2026-11-17T05:47:39.804Z | 10032/10032 | 167.20 | 59.7 | 96.0 | 100.00 |
| E02 | 3 | 2026-11-17T05:48:45.984Z | 14177/14177 | 236.28 | 42.3 | 63.1 | 100.00 |
| E05 | 1 | 2026-11-17T05:49:51.104Z | 1124/1128 | 18.73 | 530.7 | 766.7 | 99.65 |
| E05 | 2 | 2026-11-17T05:50:56.581Z | 884/884 | 14.73 | 675.7 | 901.4 | 100.00 |
| E05 | 3 | 2026-11-17T05:52:02.052Z | 644/644 | 10.73 | 920.5 | 1536.6 | 100.00 |

## 측정 환경

```json
{
  "measuredBy": "tools/tps-measure/tps-measure.mjs",
  "network": "native",
  "chain": "HardhatNetwork/3.0.0/@nomicfoundation/edr/0.3.8 (local test chain 31337, automine)",
  "manager": "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  "api": "http://127.0.0.1:5101/api, http://127.0.0.1:5102/api (server/app.py, 2 processes x 4 threads via waitress; IPFS·LLM 평가·등록원부 API 는 시험 대역)",
  "host": {
    "os": "Windows_NT 10.0.26200 x64",
    "cpu": "11th Gen Intel(R) Core(TM) i5-1135G7 @ 2.40GHz",
    "logicalCores": 8,
    "memoryGB": 7.7,
    "node": "v22.20.0"
  },
  "virtualUsers": 10,
  "durationSeconds": 60,
  "runs": 3
}
```
