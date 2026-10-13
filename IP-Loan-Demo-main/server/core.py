"""IP 담보대출 *실증용* 계산/보고서 엔진. 외부기관 검증, 신용평가, 법정 감정평가가 아니다."""
from __future__ import annotations

import hashlib
import json
import os
import time
from datetime import datetime, timezone, timedelta
from decimal import Decimal, ROUND_HALF_UP

KST = timezone(timedelta(hours=9))


def now():
    return datetime.now(KST).strftime('%Y-%m-%d %H:%M:%S')


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def canonical_hash(value: dict) -> str:
    return sha256_bytes(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode())


def demo_valuation(application: dict) -> dict:
    """신청금액과 무관한 재현 가능한 *시연용* 평가액. 실거래/시장 데이터를 사용하지 않는다."""
    seed = hashlib.sha256((str(application.get('ipRegNo') or '') + '|' + str(application.get('ipTitle') or '')).encode()).digest()
    iptype = application.get('ipType', '특허권')
    bases = {'특허권': 150_000_000, '상표권': 65_000_000, '실용신안권': 85_000_000, '디자인권': 58_000_000}
    base = bases.get(iptype, 80_000_000)
    # 동일한 IP 입력이면 항상 동일한 시연액을 생성. 이 수치는 실제 자산가치 아님.
    modifier = Decimal(80 + int.from_bytes(seed[:2], 'big') % 61) / 100
    value = int((Decimal(base) * modifier / Decimal(100_000)).quantize(Decimal('1'), rounding=ROUND_HALF_UP) * 100_000)
    return {'appraisedValue': value, 'method': '시연용 IP 유형별 기준값 × 재현 가능한 보정계수', 'assumptions': [
        '공인 감정평가가 아니며 실거래·특허·매출·TCB 원천데이터를 조회하지 않았습니다.',
        '대출 신청금액과 독립적으로 만든 예시 평가액입니다.',
        '실제 가치 산정을 위해 현금흐름, 로열티율, 권리범위, 존속기간, 유사거래 자료가 필요합니다.',
    ]}


def demo_report(application: dict, reason: str = '') -> dict:
    val = demo_valuation(application)
    title = application.get('ipTitle', '미제공 IP')
    iptype = application.get('ipType', '지식재산권')
    number = application.get('ipRegNo') or '미제공'
    return {
        'mode': 'demo_template', 'generatedBy': '규칙 기반 데모 템플릿 (LLM 미사용)', 'genDate': now(),
        'appraisedValue': val['appraisedValue'], 'similarity': None, 'genTime': 'LLM 미사용',
        'summary': f'{title} / {iptype} / 출원·등록번호: {number}. 신청자가 입력한 정보만 반영하였으며 등록원부·권리상태·청구항 사실확인은 수행하지 않았습니다.',
        'similar': '실제 KIPRIS 검색이나 벡터DB 검색을 수행하지 않았습니다. 선행기술·동일권리·유사 특허 건수나 유사도는 산출할 수 없습니다.',
        'market': '시장규모·점유율·성장률·경쟁제품·기술이전 사례의 공인 자료가 연동되지 않아 시장성 분석은 보류합니다.',
        'basis': f"{val['method']}에 의한 시연액입니다. 실제 수익·시장·원가접근법을 적용한 평가가 아닙니다.",
        'risks': ['권리 유효성 미확인', '외부 시장 자료 미연동', '담보권 법적 효력 미검증', '실제 TCB 미연동'],
        'sources': ['신청자 입력 정보 (외부 검증 없음)'], 'assumptions': val['assumptions'],
        'reason': reason[:500], 'disclaimer': '시연용 비공식 보고서. 금융권 대출승인·투자·감정평가 판단에 사용 금지.',
    }


def generate_report(application: dict, reason: str = '') -> dict:
    """API 키 있으면 실제 LLM 서술 생성, 없으면 명시적 템플릿 시연. 오류 시 실제 생성했다고 속이지 않음."""
    base = demo_report(application, reason)
    api_key = os.getenv('OPENAI_API_KEY', '').strip()
    if not api_key:
        return base
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise RuntimeError('OPENAI_API_KEY가 있지만 openai 패키지가 없습니다. pip install -r requirements.txt') from exc
    model = os.getenv('OPENAI_MODEL', 'gpt-5.5')
    prompt = {
        'company': application.get('company'), 'ipType': application.get('ipType'),
        'ipTitle': application.get('ipTitle'), 'ipRegNo': application.get('ipRegNo'),
        'demoValuation': base['appraisedValue'], 'referenceEvidence': '기업 입력 필드 외 외부 증거 없음',
        'reevaluationReason': reason[:500],
    }
    rules = (
        '당신은 IP 금융 실증용 보고서 작성 보조입니다. 입력은 검증되지 않았습니다. '
        '특허 등록상태, 유사특허 건수, 출처, 시장규모, 업계 데이터, 신용정보를 지어내지 마세요. '
        '외부자료 미확인이라는 한계를 명확히 밝히세요. '
        '반드시 유효한 JSON 객체 하나만 출력하세요. 키: summary,similar,market,basis,risks. '
        'summary/similar/market/basis는 한국어 문자열, risks는 한국어 문자열 배열입니다. '
        '숫자형 가치 추정은 직접 하지 말고 입력 demoValuation은 검증되지 않은 시연용임을 분명히 밝히세요. '
        'IP 유형 및 명칭에 따른 검토항목과 필요한 근거자료 중심으로 구체적으로 작성하세요.'
    )
    start = time.perf_counter()
    client = OpenAI(api_key=api_key, timeout=45.0, max_retries=1)
    resp = client.responses.create(model=model, instructions=rules,
                                   input=json.dumps(prompt, ensure_ascii=False))
    body = (resp.output_text or '').strip()
    if body.startswith('```'):
        body = body.strip('`').replace('json\n', '', 1).strip()
    result = json.loads(body)
    if any(not isinstance(result.get(key), str) or not result[key].strip() for key in ('summary', 'similar', 'market', 'basis')):
        raise ValueError('LLM 필수 보고서 항목이 누락되었습니다')
    if not isinstance(result.get('risks'), list):
        raise ValueError('LLM 리스크 항목 형식 오류')
    base.update({key: result[key][:10000] for key in ('summary', 'similar', 'market', 'basis')})
    base['risks'] = [str(x)[:350] for x in result['risks'][:10]]
    base.update({'mode': 'llm_live', 'generatedBy': f'OpenAI Responses API ({model})',
                 'genTime': f'{time.perf_counter()-start:.1f}초', 'genDate': now(),
                 'disclaimer': 'LLM 서술 생성 완료. 외부 특허·시장·TCB 사실검증 및 공식 감정평가는 수행하지 않았고 평가액은 시연용입니다.'})
    return base


def demo_credit_score(application: dict) -> int:
    """외부 TCB 결과가 아니라 재현 가능한 신용점수 시연."""
    h = hashlib.sha256(('DEMO-CREDIT|' + str(application['id'])).encode()).digest()
    return 55 + (h[0] % 36)


def rule_review(application: dict, report: dict, local_integrity: bool = True,
                reference_mismatch: bool = False, credit_score: int | None = None) -> dict:
    value = int(report.get('appraisedValue') or 0)
    amount = int(application.get('amount') or 0)
    if amount <= 0 or value <= 0:
        raise ValueError('신청금액 또는 평가액이 없습니다.')
    if credit_score is None:
        credit_score = demo_credit_score(application)
    if not (0 <= credit_score <= 100):
        raise ValueError('신용점수는 0~100 사이입니다.')
    # 정수 연산만 사용한 70% 담보한도 (10만원 단위 내림)
    limit = (value * 70 // 100 // 100_000) * 100_000
    ltv = int((Decimal(amount * 100) / Decimal(value)).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
    conditions = {
        'ltv': amount <= limit, 'credit': credit_score >= 60,
        'documentIntegrity': local_integrity and not reference_mismatch,
    }
    passed = all(conditions.values())
    reasons = []
    if not conditions['ltv']:
        reasons.append(f'신청금액이 담보가치의 70% 한도({limit:,}원)를 초과합니다.')
    if not conditions['credit']:
        reasons.append('시연용 신용점수가 최소 기준 60점에 미달합니다.')
    if not conditions['documentIntegrity']:
        reasons.append('업로드 문서의 무결성 검증에 실패했습니다.')
    rate = round(3.5 + max(0, 85-credit_score)*0.04 + max(0, ltv-50)*0.02, 2)
    return {
        'decision': 'eligible' if passed else 'ineligible', 'passed': passed, 'conditions': conditions,
        'creditScore': credit_score, 'creditScoreSource': 'DEMO_SYNTHETIC', 'ltv': ltv,
        'limitAmount': limit, 'approvedAmount': min(amount, limit) if passed else 0,
        'rate': rate if passed else None, 'reasons': reasons, 'evaluatedAt': now(),
        'mode': 'simulated_rule_engine',
        'disclaimer': '시연용 규칙 판정입니다. 실제 신용조회·은행 여신승인·스마트컨트랙트 실행이 아닙니다.',
    }
