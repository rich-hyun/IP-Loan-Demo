# 통합 대출 흐름 검증 기록 — 2026-10-21 KST

## 작업 범위

`b4e01af`에서 시작한 `codex/loan-evaluation-integration` 전용 워크트리에서 검증했다. 동시에 진행되는 NFT/SBT 이미지 작업은 포함하지 않는다. 원래 체크아웃과 `local-multi-role/`는 보존했다. 운영 배포, 운영 대출 DB 수정, 운영 체인 거래, 알림 발송 및 push는 수행하지 않았다. 실제 공급자의 개발용 평가 접수와 가상 문서의 암호화 IPFS 업로드는 아래처럼 별도 검증했다.

## 자동 검증

| 검사 | 결과 | 범위 |
|---|---|---|
| Python unittest | 80건 통과 | 기존 API/마이그레이션/담당자 배정/특허 API 호환성 + 신규 통합 흐름·금액 어댑터 |
| 프런트 Node 회귀 테스트 | 35건 통과 | 기업 프로필, 역할 UI, 지갑 취소·복구, 거래 중복 방지, 은행 심사 표시 |
| 계약 및 실제 로컬 EVM 통합 테스트 | 20건 통과 | SBT 발급/소각, 담당자 고정, LTV, 승인/NFT/상환, 신규 서명 API의 전체 연결 |
| 암호화 확정 JSON 추가 후 통합 EVM 재검증 | 통과 | 보고서 CID가 암호문이어도 평문 확정 해시·검토 값·체인 기록이 동일하게 연결됨 |
| Solidity 컴파일·브라우저 의존성 빌드 | 통과 | 프로젝트의 `compile.mjs`, `build-web.mjs` |
| JS 구문 검사·Python py_compile·git diff --check | 통과 | 변경된 실행 코드와 패치 형식 |

TypeScript 프로젝트가 아니므로 별도의 타입 검사기는 없다. 명령 전체는 [실행 가이드](LOAN_WORKFLOW.md#검증-명령)에 있다.

신규 서버 검증에는 다음이 포함된다.

- 단일 PDF → 공급자 작업 → 실제 보고서 바이트 캐시 → 자동/적용 가치·검토 사유 → 평가사 체인 확정 → 같은 신청번호의 여신심사 건 생성. 반복 동기화와 서버 재초기화 후에도 한 건이다.
- LTV 70% 경계 통과, 초과 차단, 70.4%가 화면에 70%로 반올림되더라도 정수 비교로 거절.
- queued/running/failed, 보고서 없음, 적용 가치 누락·0·음수·비정수, 정책/계약 미설정 차단.
- 공급자 429 대기 시간, 실패 재시도 시 같은 신청·같은 원본 사용, 차수별 실패 작업 이력 보존.
- 동시 신청 2건에 대해 201/200과 동일한 신청번호 반환, 다른 내용의 동일 요청번호는 409, 공급자 중복 접수 없음.
- timeout/프로세스 중단의 접수 불명은 재접수 차단. 공급자의 원본 SHA256과 사업자번호가 일치할 때만 기존 작업번호로 복구.
- 무서명·다른 담당자·역할 회수·서명 재사용·서명 후 내용 변조·다른 신청의 읽기 세션·읽기 세션으로 쓰기 시도 차단.
- 원본 열람은 평가사 SBT 단계와 은행 승인/NFT 단계로 제한. 은행은 여신심사 단계부터 보고서·검토 결과를 확인 가능.
- 검토 JSON은 IPFS 업로드 전에 AES-GCM 암호화되고 복호화한 내용의 SHA256이 체인 보고서 해시와 일치한다. 같은 확정의 재시도는 같은 CID를 사용한다.
- HTML의 명시적 IP 가치금액 항목과 원화 단위만 추출. 숫자 누락·충돌·범위·알 수 없는 통화·원 미만 소수는 사용하지 않고, 0과 음수는 그대로 전달한다.

## 실제 외부 서비스 검증

`sailab02`에서 기존 프로젝트의 평가 API 설정이 존재함을 확인했다. 운영 파일을 수정하지 않고 필요한 URL/토큰만 로컬의 Git 제외 `.env`에 준비했다. 토큰은 코드·문서·로그에 포함하지 않는다.

1. 실제 OpenAPI와 health 응답을 읽었다. 접수·상태·identity·보고서 다운로드 경로가 기존 `patent_api.py`와 맞는다. 현재 상태 JSON에는 수치 평가가치가 없고, 실제 HTML에는 `IP 가치금액` 표가 있다.
2. 저장소의 `DEMO_IP_DOCUMENT_NOT_OFFICIAL.pdf`를 통합 신청에서 실제 서비스에 제출했다. 작업 `a283523d9e3c47bbb3ee9dfcde18c7fe`는 접수 후 실패(프로세스 종료 코드 2)했다. 화면에 실패와 재시도 경로가 표시되고 여신심사 건은 생성되지 않았다.
3. 기존 성공 이력에 사용된 16쪽 등록특허 공고전문의 읽기 전용 사본을 사용해 새 통합 신청 `LN-2026-8172`를 만들었다. 공급자 작업은 `f5c4374d8394462dae1899b0832c2651`, 실제 처리 시각은 2026-10-21 08:48:46~08:53:04 KST이다. 한 번 제출한 파일로 `running → completed`가 표시됐다.
4. 실제 생성 PDF(78쪽, 1,592,064 bytes)를 평가사 인증 경로로 내려받았고 텍스트 및 렌더링을 확인했다. 실제 HTML의 `-0.00억 원`은 **0원**으로 추출됐다. 숫자를 채워 넣거나 양수로 바꾸지 않았다.
5. 0원의 적용 가치로 확정을 시도하면 차단된다. 실제 보고서와 원본 해시를 연결한 상태에서, **로컬 QA 절차 확인용 적용값 100원**이라는 검토 사유를 명시하고 일회성 로컬 EVM에서 확정했다. 이 값은 실제 담보가치가 아니다. 신청금액 70원에 대해 같은 신청번호의 여신심사 건 생성과 LTV 70% 전달을 확인했다.
6. 별도의 가상 PDF canary를 기존 실제 IPFS API로 AES-GCM 암호화 업로드했다. 실제 게이트웨이에서 내려받아 복호화한 결과가 원본과 일치했다. canary 결과는 `output/workflow/ipfs-canary-result.json`에 있다. 공개 업로드에는 암호문만 사용했다.

보고서 API와 IPFS의 실제 호출은 위 범위에서 확인했다. 실제 보고서가 연결된 브라우저 전체 흐름의 IPFS는 테스트 대역이었다. 실제 IPFS는 별도 canary로 검증했다. 체인은 모든 검증에서 일회성 로컬 EVM이었다. 테스트 대역을 실제 운영 연동으로 간주하지 않는다.

## 최종 전용 워크트리 브라우저 확인

전용 워크트리에서 `workflow-qa.mjs`를 실행해 최종 소스의 핵심 동선을 확인했다.

- `LN-2026-6012`: PDF 1개 제출, 24개월 입력 → 자동 평가 작업/보고서 조회 → 평가사 적용값·사유 확정 → 은행 심사 도착.
- 신청번호와 여신심사 번호가 동일하고, 은행 화면에 24개월·70원·적용 가치 100원·LTV 70%가 보존된다.
- 은행 서명으로 공급자 작업번호·자동 산출값·보고서·평가사 검토 내용과 접수 이력을 확인했다. 승인 전 원본 열람 버튼은 표시하지 않는다.
- `patent.html#apply`가 `index.html#apply`로 이동하고 통합 신청 화면에 도착한다.
- 브라우저 오류 로그 없음. `output/workflow/browser-isolated-credit-case.png`에 화면 증거가 있다.

이 QA 환경의 보고서·IPFS는 테스트 대역이고 지갑은 로컬 테스트 계정용 EIP-1193 어댑터다. 실제 MetaMask 확장 및 Mustsem 배포·거래는 이번 검증에 포함하지 않았다.

## 남는 제약과 인수 사항

- 운영 배포와 다른 채팅의 이미지 발급 변경 병합은 별도 작업이다. 이번 브랜치는 b4e01af의 v2 계약으로 동작한다.
- 실제 API는 사전평가 보고서를 만들며 결과가 0 이하이거나 근거가 부족할 수 있다. 자동 산출값과 평가사의 적용 가치를 구분한다. 보고서 표 형식이 바뀌면 어댑터를 재검증해야 한다.
- 공급자는 멱등 키/작업 검색 API를 제공하지 않는다. 응답 유실 때 작업번호를 확보하지 못하면 자동 재접수하지 않고 공급자 확인이 필요하다. 원본 파일은 보존된다.
- 기존 원부 진위 대조와 TCB 점수 연동은 mock/미연동 상태를 유지한다. 실제 자금 이동 기능은 없다. 새로 실제 연동했다고 보고하지 않는다.
- 공개 데모의 일반 목록·프로필 메타데이터 API와 SQLite 내 키 보관은 기존 제약이다. 운영 인증·키 관리 강화는 별도 범위다.
# 실제 MetaMask·IPFS 실행 환경 추가 검증 (2026-10-21)

- 저장소 루트 `start-local.ps1`의 기본 실행을 `local-real.mjs`로 변경했다. 8003 UI, 8545 로컬 EVM RPC, 실제 `server.app`을 연결하며 `globalThis.ethereum` 주입이나 IPFS/평가 API monkeypatch가 없다. 관리자 페이지도 같은 API 기준을 사용한다. 기존 8002 QA 데이터는 보존했다.
- 로컬 체인의 v2 계약 코드, 역할 세 주소 및 `/api/chain/config`, 서버 health를 확인했다. 개발 체인과 역할 설정은 운영 체인에 배포하지 않았다.
- 등록특허 입력 PDF 993,736바이트를 실제 앱의 AES-GCM 함수로 암호화한 뒤 실제 업로드 서버로 전송했다. 실제 게이트웨이에서 993,764바이트를 회수하여 복호화·원본 SHA256 일치를 확인했다. CID `QmU1u8px9mMnQ2gBfWiikrSWyUR8984X3j7APqhEjWXPPk`, 증거는 Git 제외 `output/local-real/real-ipfs-verification.json`이다. 이 검증은 대출 신청을 만들지 않은 파일 경로 검증이다.
- MetaMask가 없는 Chrome 프로필과 설치된 `머스트리Gemini2` 프로필을 구분했다. 사용자가 실제 MetaMask 연결·메시지 서명·로컬 거래 승인을 진행했다. 연결된 `0xcdfBfb91DE6a35f243c10c8a291B632A7F20156e`에 로컬 차주 역할과 테스트 ETH를 설정했다. 운영 체인의 권한과 잔액은 변경하지 않았다.
- 실제 신청 `LN-2026-4233`은 주식회사 미브레스 / 사업자번호 `550-81-02614` / 등록특허 `10-2877748` / 신청금액 70,000,000원 / 12개월이다. 대표자·연락처는 명시적 로컬 테스트 입력이며 실제 기업의 대표자·연락처로 주장하지 않는다. 실제 알림을 발송하지 않았다.
- 신청의 실제 IPFS CID는 `QmaBy2uN8FarzD8hVWN9we7jPVsQ8QZJjivVefL7xcfXr6`이다. 게이트웨이에서 회수해 DB에 보관된 키로 복호화하고 원본 PDF 및 salt 포함 체인 해시와 일치함을 확인했다. MetaMask가 전송한 거래 `0xf972ecb5d944e3edee02e22ac79c5d7527079b8173e05a7f57a4e4d0a30267e9`의 receipt status=1, 발신 지갑·대상 계약 일치, 평가 SBT 1을 확인했다. 증거는 `output/local-real/real-application-proof.json`과 `browser-real-submitted.png`이다.
- 같은 신청의 실제 외부 평가 작업은 `ddc61f8fc5064175a47d3ce3c4e0fa60`이다. 최초 접수 1회이며 공급자 응답의 사업자번호·원본 SHA256이 일치했다. 실제 MetaMask 상태 조회 서명 후 10초 자동 갱신으로 약 5분 뒤 `completed/finished`와 보고서 버튼이 화면에 표시됐다. 자동 산출값은 실제 HTML 표의 `-0.00억 원`을 추출한 0원이다. 평가사 확정 전 여신심사 건은 0건이다. 화면 증거는 `output/local-real/browser-real-report-ready.png`이다. PDF 열람용 MetaMask 서명이 승인되어 인증 API 200과 브라우저 다운로드를 확인했다. 다운로드 파일은 C:/Users/mustree/Downloads/LN-2026-4233-pdf.pdf (1,591,828바이트, 78쪽)이며 PDF 파싱과 해당 특허번호 포함을 확인했다. SHA256은 5d78c1130fe4723fd5c4fee3ed0fd15f99da398eecd545c2b5392396134cdd99이다. 평가사 검토·확정은 아직 수행하지 않았다. **이 실제 신청의 평가사 검토 이후 흐름은 미검증이며 전체 흐름 완료로 표시하지 않는다.**
- 변경 후 Python 80건, 프런트엔드 35건 통과. 새 런처의 PowerShell 구문 검사와 Node 구문 검사, 실제 서버 기동을 확인했다.

## 실제 MetaMask 평가 확정·은행 최종 승인 확인 (2026-10-21)

사용자가 평가사와 은행의 MetaMask 거래를 직접 승인한 뒤 `LN-2026-4233`의 DB 및 실제 로컬 RPC를 다시 조회했다. `chainStatus=Approved`, 적용 가치 100,000,000원, 신청금액 70,000,000원, LTV 70%, `credit_cases` 1건, 채권 NFT Token ID 1 및 배정 은행 `0x90F79bf6EB2c4f870365E785982E1f101E93b906`의 소유권이 일치했다. 자동 산출값은 0원으로 보존되었다. 적용 1억원은 사용자가 승인한 로컬 기능 검증용 데모 값이며 실제 특허 가치평가 결론이 아니다.

사용자가 직접 확정한 검토 사유는 `test`로 저장되어 있다. 준비 화면에서 작성했던 긴 데모 설명으로 덮어쓰지 않았다. 이후 실제 업무에서는 충분한 검토 근거를 입력해야 한다. 이 확인은 로컬 개발 체인과 실제 IPFS·평가 API·MetaMask 범위이며 운영 배포나 실제 대출 집행을 의미하지 않는다.

## 토큰 이미지 생성기 병합과 NFT UI 검증 (2026-10-21)

- `feat/token-card-design`의 `e55b582`를 merge로 통합했다. 다른 작업 폴더의 미커밋 변경은 가져오거나 수정하지 않았다. 해당 커밋에는 문서에 적힌 계약 확장·웹 연결이 없어서, 현재 동작에 맞게 TOKEN_MEDIA.md와 환경변수 예시를 정정했다.
- 기존 최종승인 건과 계약을 그대로 사용하는 카드 UI를 신청 상세·평가 검토·은행 심사에 연결했다. 실제 RPC 조회로 상태·소유권·토큰 계약 주소·Token ID를 대조한다. PNG에는 신청번호·기업명·대표자명·IP 제목만 전달한다. 카드 미리보기 생성은 새 NFT 발급이나 기존 tokenURI 변경이 아니다.
- 8004 UI/API를 기존 8003 세션 DB와 RPC 8545에 연결했다. 브라우저 은행 심사 화면에서 소각된 SBT와 발급된 NFT를 구분하고, 1200×1200 PNG 두 장이 정상 로드됨을 확인했다. 은행 NFT 계약은 `0xB7A5bd0345EF1Cc5E66bf61BdeC17D2461fBd968`, Token ID 1, 소유자는 기존 배정 은행이다. 화면 증거: `output/local-real/browser-token-gallery.png`.
- Python 87건, 프런트엔드 38건, 계약·통합 20건 통과. 계약 컴파일 및 웹 의존성 빌드, 새 JS 구문 검사 통과. 기존 계약 코드는 변경하지 않았다. 별도 TypeScript 검사 대상은 없다.
- 기존 토큰 메타데이터에는 image 필드가 없으므로 MetaMask에서 새 표지가 보인다고 보고하지 않는다. 지갑 이미지까지 바꾸려면 별도의 계약·발급 메타데이터 작업이 필요하다. 운영 배포·push·새 승인 거래는 수행하지 않았다.

## 997f3ae 기준 최소 HTTPS 이미지 연결 재구성

- `codex/minimal-https-token-media`는 997f3ae에서 새로 시작했다. 이후 시도의 원본은 `codex/loan-evaluation-integration`의 4054b27에 보존했다. 다른 에이전트의 원래 체크아웃은 수정하지 않았다.
- 실행 코드 변경은 7파일(계약, 지갑 등록 호출, 카드 표시, 서버 신청의 미디어 업로드, 계약 미디어 capability 조회·바인딩 확인, 카드 API, 생성기의 HTTPS URL 구성)뿐이다. 추가 지갑 선택 UI, 읽기 세션 변경, 자동 갱신 변경, 신규 체인 옵션·샘플 첨부 도우미 변경을 가져오지 않았다.
- `js/workflow.js`, `js/app.js`, `index.html`, `server/loan_workflow.py`, `server/patent_app.py`, 로컬 런처·Hardhat 설정·실제 실행 스크립트는 997f3ae와 diff가 없다. 계약의 confirmEvaluation·finalApprove·finalReject·recordRepayment 함수도 문자 단위로 동일하다. 기준 커밋에 있던 인증 서명 절차를 추가·제거하지 않았다.
- 기존 LN-2026-4233은 실제 RPC 31337에서 Approved(status 4), 여신심사 1건, NFT 1의 은행 소유권을 유지한다. 기존 31338 LN-2026-3599도 Eligible(status 2), 여신심사 1건이다. DB·체인·실행 프로세스를 초기화하거나 교체하지 않았다. 보존 증거는 Git 제외 `output/minimal-https-preservation.json`이다.
- Python 94건은 모듈별 독립 프로세스로, JS 41건, 계약·통합 21건을 실행해 모두 통과했다. 기존 Python 호환성 테스트의 import 순서 의존성을 고치는 별도 변경도 가져오지 않았다. 계약 컴파일을 수행했고 별도 TypeScript 검사 대상은 없다.
- 실제 IPFS로 PNG·JSON 4개를 업로드하고 고정 HTTPS 게이트웨이에서 JSON·PNG 모두 200, application/json·image/png, 1200×1200 및 업로드 원본 바이트 일치를 확인했다. JSON image도 HTTPS이며 ipfs:// 지갑 해석을 요구하지 않는다. 증거: `output/minimal-https-preflight/proof.json`. 이 확인은 미디어 전송만 검증하며 새 대출·평가 작업·지갑 거래를 생성하지 않았다.
- 최소 재구성에서 새로운 수동 승인 흐름은 시작하지 않았다. **이 코드로 MetaMask 내부 이미지 표시를 직접 확인한 것은 아니므로 지갑 표시 검증 완료로 보고하지 않는다.** 기존 계약의 URI는 변경할 수 없어 실제 신규 발급에는 이미지 지원 계약이 필요하다. 새 운영 배포·외부 알림·git push는 하지 않았다.

### MetaMask 이미지 표시 후속 검증 완료 (사용자 확인, 2026-10-21)

- 9fc233c 계약을 기존 로컬 31339 RPC의 별도 Manager `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9`에 배포했다. 이미지 표시만 검증하는 별도 NFT이며 실제 대출 신청이나 외부 평가 작업은 만들지 않았다. 공개 로컬 개발 계정이 계약 거래를 실행했다. 테스트 manifest와 70/100 계약 단위는 이미지 검증용이며 실제 가치평가 결과가 아니다.
- 채권 NFT 계약 `0x6D544390Eb535d61e196c87d6B9c80dCD8628Acd`, Token ID 1, 소유 은행 `0x90F79bf6EB2c4f870365E785982E1f101E93b906`을 실제 RPC에서 확인했다. tokenURI는 `https://rwa-gw.mustree.kr/ipfs/Qmb78DwJpr7bkzNiEgNc1MxbxPEemkTgxRsn7HX3ojHh5M`, JSON image는 `https://rwa-gw.mustree.kr/ipfs/QmQFrZNXVMwYe3NokLxxVxE6ndrEjafvWELqPn3Ut1NEwB`이며 실제 HTTPS 조회와 기존 원본 PNG 해시 일치를 확인했다.
- 저장소 코드 변경 없이 Git 제외 `output/metamask-image-check/`의 임시 확인 페이지(8007)에서 공식 wallet_watchAsset ERC721 요청을 보냈다. 사용자는 은행 연결·NFT 추가를 승인했다. 브라우저에서 wallet_watchAsset=true를 확인했고, 사용자는 대화에서 **“승인했고 MetaMask에 이미지가 보임”**으로 실제 지갑 표시를 확인했다. IPFS 설정 변경을 요구하지 않았고 메시지 서명·지갑 거래 승인도 요청하지 않았다.
- 지갑 내부 화면을 에이전트가 직접 캡처한 것은 아니다. 표시 완료의 근거는 사용자 확인이며, API 성공·HTTP 200만으로 지갑 표시 성공을 추정하지 않았다. 증거: `output/metamask-image-check/mint-proof.json`, `browser-import-result.png`(API 결과 화면이며 지갑 내부 캡처는 아님).
- 기존 31337 LN-2026-4233 Approved 및 31338 LN-2026-3599 Eligible·각 여신심사 1건을 다시 확인했다. 업무·인증·로컬 실행 코드는 여전히 997f3ae와 동일하다. 이 검증은 최소 이미지 전달 경로에 한정하며 실제 대출 업무를 새로 완주했다는 의미는 아니다.

### 통합 브랜치 반영 및 Mustsem 인수 환경 (2026-10-21)

- 9b360b0에서 codex/loan-evaluation-integration의 추적 파일을 검증된 최소 구성 80a8f23과 일치시켰다. 이전 실험은 codex/archive-loan-evaluation-4054b27에 보존했다. 이후 변경은 새 배포 manifest, 별도 Mustsem 로컬 실행기, 설정 예제와 안내 문서이며 업무·인증 코드는 바꾸지 않았다.
- 사용자가 MetaMask로 Mustsem에 Manager 0x65C40E399b145A9f9021652192C3e781dadbD2FA를 배포했다. 배포 거래 0xe5f0c9d3b8965e226137ad046969340ded639ddf690e5ab443d59ff5764e97c5, block 13257348, receipt 성공을 실제 RPC에서 확인했다. 생성 바이트코드·생성자 인자 및 immutable 슬롯을 반영한 Manager/SBT/NFT 런타임 코드가 컴파일 산출물과 일치한다. 계약 mediaVersion=2, 고정 HTTPS gateway, 토큰의 Manager 연결도 확인했다. 공개 증거는 blockchain/deployments/mustsem-https.json이다.
- 실제 배포자·관리자·은행은 B3Ec…4951, 평가사는 28b5…0cdE이다. 사용자 역할 추가 승인 후 차주 5C92…b207의 BORROWER_ROLE을 실제 체인 및 로컬 /api/chain/config에서 확인했다. 역할 검증 block 13257588. 차주·평가사·은행은 서로 다르다. 추가 배포·역할 승인은 필요 없다.
- start-mustsem-local.ps1은 실제 Mustsem RPC 및 기존 실제 IPFS·평가 API를 사용하는 8008 UI를 실행한다. 새 Manager별 영속 DB를 쓰며 기존 계약·DB와 로컬 체인 프로세스를 교체하지 않는다. 실제 HTTP 설정에서 enabled=true, chainId=7601, mediaVersion=2와 세 역할을 확인했다. 비밀 설정 경로는 HTTP 404이며 서버 키를 프런트에 노출하지 않는다.
- 실행기 JS 구문 검사, PowerShell 파싱 및 실제 서버 기동·설정 응답을 확인했다. 최소 기능의 기존 Python 94 / JS 41 / 계약·통합 21건 통과 기록은 위와 같다. 이번 설정 추가로 업무 코드 테스트를 변경하지 않았다.
- 새 Mustsem 계약에서의 대출 접수부터 최종승인·MetaMask NFT 표시까지는 사용자 인수 테스트가 남아 있다. 앞선 MetaMask 표시 성공은 별도 로컬 이미지 검증이며 새 Mustsem 대출의 완료 근거로 사용하지 않는다. Git push·운영 서버 배포·실제 외부 알림 발송은 수행하지 않았다.
