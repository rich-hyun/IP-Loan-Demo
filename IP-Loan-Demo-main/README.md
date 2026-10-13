# IP 담보 자동대출 PoC — 실행 가능한 시연 버전

> **실제 금융서비스가 아닙니다.** 입력자료의 원천검증, 외부 KIPRIS/TCB/은행 연동, 법적 담보 설정 및 실거래를 수행하지 않습니다. 금융 의사결정에 사용하지 마세요.

## 구현 기능

- Flask + SQLite: 신청, 상태, 감사이력, 문서, 평가보고서/해시/버전, 규칙 심사, 가상 토큰·계약·상환 저장
- 실제 업로드된 PDF/JPG/PNG의 서버 SHA-256 계산, 로컬 무결성 및 **직접 입력한** 참조 해시 비교 (공식 발급기관 인증 아님)
- **OPENAI_API_KEY 설정 시:** OpenAI Responses API를 통해 보고서 **서술** 생성; 실제 원천 데이터나 검증 데이터가 없으므로 사실 단정 금지
- **OPENAI_API_KEY 미설정 시:** LLM을 호출하지 않는 명시적인 규칙 기반 보고서 템플릿 생성
- 가치평가액: 신청금액과 독립적인 재현 가능한 **시연용 숫자**이며 실제 가치산정 금액이 아님
- 보고서 SHA-256 원장에 기록. `IPLOAN_CHAIN_MODE=demo`는 **SQLite 모의 기록** (TX/블록번호 미조작). `rpc`는 EVM RPC에 해시를 포함하는 실제 서명 트랜잭션을 보내지만 실제 NFT 발행/대출 계약 배포는 하지 않음
- 모의 신용점수, LTV 70% 기준 및 서버 규칙 기반 승인·거절, 가상 대출계약/잔액 관리/상환/담보해제
- `contracts/IPCollateralRegistry.sol`: 별도 Remix/Hardhat 실증 환경에서 배포 가능한 참고 NFT 담보등록 계약; Flask API와 자동 연결되지는 않음
- 평가보고서 화면에서 인쇄 또는 브라우저의 PDF로 저장

## 가장 쉬운 실행법 — Windows PowerShell

```powershell
cd .\IP-Loan-Demo-main\server
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app.py
```

브라우저에서 **http://127.0.0.1:5000/** 접속. (HTML 서버를 별도로 실행할 필요 없습니다.)

Linux/macOS:

```bash
cd IP-Loan-Demo-main/server
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python app.py
```

### 실제 LLM 서술 보고서 생성

PowerShell에서 `app.py` 실행 **전에** 같은 터미널에 환경변수 설정:

```powershell
$env:OPENAI_API_KEY = "발급받은-API-키"
$env:OPENAI_MODEL = "gpt-5.5"
.\.venv\Scripts\python.exe app.py
```

LLM API 키는 **GitHub 소스/프론트엔드/스크린샷에 넣지 마세요.** OpenAI 모델 이용권한과 결제 설정이 필요하고 API 비용이 발생할 수 있습니다. LLM 서버 호출이 실패하면 오류를 표시하며 템플릿으로 성공인 척 대체하지 않습니다.

### 사용 순서

1. 우측 상단 역할 메뉴에서 **차주기업 담당자**를 고른 뒤 신규 신청 및 서류 첨부 (서류 없이 신청은 가능하지만 심사 통과에는 최소 1개 파일이 필요).
   - 시험용 파일은 `sample_data/DEMO_IP_DOCUMENT_NOT_OFFICIAL.pdf`를 사용하세요. 공식 서류가 아닌 임의 테스트 자료입니다.
2. **IP 가치평가** 메뉴에서 신규 신청을 고르고 **가치평가보고서 생성**을 클릭.
3. 값과 근거가 *시연용/실측 미완료*임을 확인하고 **평가 확정 · 해시 기록** 클릭.
4. **대출 심사** 메뉴에서 **규칙 기반 자동심사 실행** → 승인 가능/거절 → 최종 확정.
5. **대출 신청 리스트**에서 건을 눌러 상세화면의 **모의 RWA 발행**, **은행 시연월렛 이전**, **모의 상환** 실행.
6. 상세화면의 서류 검증에서는 원본 SHA-256을 직접 입력해 비교 가능. 발급기관 직접연동 검증은 **아직 없음**.

## GitHub 업로드/배포 중요사항

- `.github/workflows/pages.yml`은 `main` 브랜치 push 시 **프론트엔드만 GitHub Pages**에 배포합니다. GitHub 저장소 설정 → Pages → Source를 **GitHub Actions**로 선택하세요.
- **GitHub Pages에서는 `server/app.py`가 실행되지 않습니다.** HTML/JS만 올리면 실제 보고서 생성·심사·DB 저장은 작동하지 않습니다.
- API는 Python 서버(예: Ubuntu VM)에 별도 배포한 다음 `js/config.js`의 `window.IPLOAN_API_BASE`에 **실제 HTTPS API URL**(`https://api.example.com/api`)을 지정해야 합니다.
- 정적 사이트 도메인은 기존 `CNAME`의 `iploan.mustree.kr`을 유지했습니다. 임의의 API 주소가 작동한다고 보장하지 않습니다.
- 서버+화면을 한 호스트로 배포할 수 있다면 `server/app.py`가 루트 `/` 에서 HTML을 제공하므로 별도의 CORS 설정이 줄어듭니다.
- **기존 `server/iploan.db` 파일은 백업 후 배포하세요.** 코드는 기존 DB에 새 열/테이블을 추가하며 정상 시작 시 기존 데이터를 지우지 않습니다. 파일·업로드 디렉터리는 버전관리에 올리지 마세요.

## 서버 운영 설정

`server/README.md` 참고. `IPLOAN_API_KEY`는 시연용 공유 키일 뿐, 역할 메뉴도 시연용 UI일 뿐 실제 사용자 인증/인가가 아닙니다. 인증·개인정보 처리·접근제어·기관 검증을 추가하기 전에는 실사용자 자료를 받는 인터넷 공개서비스로 운영하면 안 됩니다.

## 테스트

```bash
python -m unittest discover -s tests -v
node --check js/app.js
```

Flask 라우팅/업로드 통합테스트는 requirements 설치 후 아래를 실행하세요:

```bash
python -m unittest discover -s tests -p 'test_api.py' -v
```

## 사업계획서 대비 남은 실연동

실제 KIPRIS/TCB/발급기관 데이터 수집, 출원인 권리확인, 가치평가 근거 데이터/검증, 금융기관 정책·신용평가, 실제 ERC-721 계약 배포 및 키관리, 법적 담보설정, 은행 업무망 인증/감사, TPS/정확도 검증은 **별도 개발·기관 협의 필요**합니다.
