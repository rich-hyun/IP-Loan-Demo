# LLM 특허평가 API 연동

대출 신청에 첨부한 특허 공고전문 PDF로 외부 특허평가 API가 LLM 가치평가보고서를 만든다.
v3부터 별도 특허평가 화면(`patent.html`, `/api/patent`)은 없고, 대출 신청 한 건에 보고서 작업 한 건이 붙는다.
외부 API의 주소와 인증값은 서버만 사용한다. 브라우저는 우리 API를 통해서만 상태와 결과를 받는다.

## 설정

```dotenv
# server/.env (Git 제외, chmod 600)
IPLOAN_PATENT_API_URL=http://203.252.147.200:20024
IPLOAN_PATENT_API_TOKEN=제공받은_인증값
```

환경변수가 `.env`보다 우선한다. 인증값이 없으면 신청 API가 503으로 거절한다(원부를 올리기 전에 막는다).

## 흐름

1. 차주가 신청하면 서버가 원부를 암호화·등록한 뒤, 공고전문 PDF(최대 50 MiB)를 `IPLOAN_UPLOAD_DIR`에 보관하고
   외부 `POST /v1/evaluations`에 `patent_pdf`, `business_number`를 보낸다. `Authorization`에는 제공된 토큰 값만 쓴다.
2. 작업번호와 상태를 `evaluation_jobs`에 저장한다. 화면은 10초마다 상태를 묻고, 서버는 작업당 10초에 한 번만 외부 API를 조회한다.
3. `awaiting_identity`면 차주나 담당 평가사가 사업자번호를 보완한다. PDF는 다시 보내지 않는다.
4. 접수가 거절되면(예: 큐 상한 429) 같은 신청에서 보관된 PDF로 재접수할 수 있다. 연결이 끊겨 접수 여부를 모르면
   `submission_unknown`으로 두고 자동 재접수하지 않는다.
5. `completed`면 담당자에게 PDF/HTML과 근거자료를 중계한다(HTML은 sandbox). 응답의 `valuation`·`financials`는
   형식을 검증해 저장한다(아래). 평가사가 평가액을 확정하면 보고서를 암호화해 IPFS에 등록하고 해시를 체인에 기록한다.

## API

| 메서드·경로 | 동작 |
| --- | --- |
| `GET /api/applications/{id}/evaluation` | 작업 상태 조회·저장 |
| `POST /api/applications/{id}/evaluation` | 외부 미접수가 확실한 작업만 재접수 |
| `POST /api/applications/{id}/evaluation/identity` | JSON `business_number`로 기존 작업 재개 |
| `GET /api/applications/{id}/evaluation/artifacts/{kind}` | pdf·html·quality·trace·timing·log 열람, `?download=1` 다운로드 |
| `POST /api/applications/{id}/evaluation-report` | 평가 확정용 보고서 등록(담당 평가사) |

모두 지갑 로그인이 필요하고, 그 신청의 담당자만 쓸 수 있다.

## LLM 산정액과 재무 요약

외부 API는 완료 작업 응답에 `valuation`(LLM 산정액)과 `financials`(최근 3개 결산연도)를 함께 보낸다.
서버는 정해진 필드만 형식을 확인해 `evaluation_jobs`에 저장하고(`server/report_summary.py`), 나머지는 버린다.

- `valuation`: `ip_value_krw`(원), `value_status`(`confirmed`가 아니면 사전평가 초안), `valuation_date`, `report_number`.
  평가 화면에 산정액과 그 금액 기준 담보인정비율을 보여주고, 버튼으로 확정 평가액 칸에 넣을 수 있다.
  0원 이하이면 넣지 않는다. 평가사가 산정액과 다른 금액으로 확정하면 평가 의견(사유)이 필수다(API도 400 `note_required`).
- `financials`: 연도별 금액(원)·비율(%)·이자보상배율(배), `source`, `fiscal_date_assumed`.
  자본잠식 여부는 자본총계로 다시 계산하고, 자본잠식이면 부채비율을 비운다.
- 은행 화면의 "재무 참고 점검"은 최근 결산연도의 자본잠식·영업이익·이자보상배율(1배)·유동비율(100%)을 보여준다.
  값이 없으면 판정 불가로 표시하며 통과로 보지 않는다. 승인·거절을 자동으로 정하지 않는다.
- 운영 평가 API는 기업 상용 API(NICE·KED)를 쓰지 않으므로(`company_api: none`) 차입금·금융비용·이자보상배율은
  대부분 비어 있다. 이 변경 전에 끝난 작업과 보관 건에는 두 값이 없고, 평가사가 보고서를 보고 직접 입력한다.

## 이전 특허평가 화면의 보고서

예전 `patent-iploan.db`의 보고서 작업은 서버 시작 때 `archived` 신청으로 가져온다. 보관 건은 평가사·은행·관리자가
"이전 보고서 보관함"에서 열람만 할 수 있다. 생성 중이던 작업은 상태 조회로 계속 갱신된다.
원본 `patent-iploan.db`와 `patent-uploads/`는 수정하거나 지우지 않는다.

## 검증

```bash
server/.venv/bin/python -m unittest server.test_patent_api server.test_app server.test_report_summary -v
```

외부 보고서 생성은 mock으로 검사한다(전송 형식, 인증값 비노출, 오류·불확실 접수, 조회 간격, 사업자번호 보완, 결과 중계,
산정액·재무 검증과 점검, 산정액과 다른 확정의 사유 요구, 보고서 등록).
