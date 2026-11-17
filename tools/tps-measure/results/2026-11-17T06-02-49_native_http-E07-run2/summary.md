# TPS 측정 결과 (native)

측정 시각: 2026-11-17T06:02:49.046Z ~ 2026-11-17T06:03:49.046Z

| ID | API | 엔드포인트 | 측정 요청 | 목표 TPS | 실측 TPS(평균) | 판정 | 평균 응답(ms) | p95(ms) | 성공률(%) | 정상/전체 |
|---|---|---|---|---|---|---|---|---|---|---|
| E07 | IP RWA화 API | IP 가치평가서 등록 | `POST /applications/{id}/evaluation-report` | 5 | 3.00 | 미달 | 3263.9 | 4930.9 | 100.00 | 180/180 |

## 회차별

| ID | 회차 | 시작 | 정상/전체 | TPS | 평균(ms) | p95(ms) | 성공률(%) |
|---|---|---|---|---|---|---|---|
| E07 | 1 | 2026-11-17T06:02:49.046Z | 180/180 | 3.00 | 3263.9 | 4930.9 | 100.00 |

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
  "runs": 1
}
```
