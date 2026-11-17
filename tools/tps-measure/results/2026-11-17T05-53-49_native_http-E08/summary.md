# TPS 측정 결과 (native)

측정 시각: 2026-11-17T05:53:49.598Z ~ 2026-11-17T05:56:59.974Z

| ID | API | 엔드포인트 | 측정 요청 | 목표 TPS | 실측 TPS(평균) | 판정 | 평균 응답(ms) | p95(ms) | 성공률(%) | 정상/전체 |
|---|---|---|---|---|---|---|---|---|---|---|
| E08 | 자동대출심사 API | 신용평가 호출 | `GET /applications/{id}/evaluation` | 10 | 49.12 | 달성 | 205.3 | 431.1 | 100.00 | 8842/8842 |

## 회차별

| ID | 회차 | 시작 | 정상/전체 | TPS | 평균(ms) | p95(ms) | 성공률(%) |
|---|---|---|---|---|---|---|---|
| E08 | 1 | 2026-11-17T05:53:49.598Z | 2510/2510 | 41.83 | 238.1 | 471.4 | 100.00 |
| E08 | 2 | 2026-11-17T05:54:54.803Z | 3160/3160 | 52.67 | 189.2 | 416.8 | 100.00 |
| E08 | 3 | 2026-11-17T05:55:59.974Z | 3172/3172 | 52.87 | 188.6 | 405.0 | 100.00 |

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
