# TPS 측정 결과 (native)

측정 시각: 2026-11-17T05:40:16.225Z ~ 2026-11-17T05:43:43.626Z

| ID | API | 엔드포인트 | 측정 요청 | 목표 TPS | 실측 TPS(평균) | 판정 | 평균 응답(ms) | p95(ms) | 성공률(%) | 정상/전체 |
|---|---|---|---|---|---|---|---|---|---|---|
| E01 | LLM 가치평가 API | IP 평가요청 | `POST /applications` | 10 | 0.86 | 미달 | 9891.0 | 19298.6 | 98.15 | 154/157 |

## 회차별

| ID | 회차 | 시작 | 정상/전체 | TPS | 평균(ms) | p95(ms) | 성공률(%) |
|---|---|---|---|---|---|---|---|
| E01 | 1 | 2026-11-17T05:40:16.225Z | 50/52 | 0.83 | 9807.5 | 16362.3 | 96.15 |
| E01 | 2 | 2026-11-17T05:41:27.229Z | 46/46 | 0.77 | 10073.3 | 20995.4 | 100.00 |
| E01 | 3 | 2026-11-17T05:42:43.626Z | 58/59 | 0.97 | 9792.2 | 20538.1 | 98.31 |

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
