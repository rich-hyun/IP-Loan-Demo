"""LLM 보고서 API가 완료 작업과 함께 보내는 평가금액·재무 요약(`valuation`, `financials`)의 검증, 재무 점검, 서버 자동심사.

외부 응답이므로 정해진 필드만 형식을 확인해 남긴다. 금액은 원 단위 정수, 비율은 %(이자보상배율은 배)다.
없는 값(None)은 '판정 불가'로 다루며 통과로 보지 않는다. 자동심사(`auto_review`)는 신용등급·재무 점검·LTV로
승인·거절·검토 필요를 판정한다. 계약은 LTV 70%만 판정하므로 은행 지갑의 최종 승인·거절을 대신하지 않는다.
"""
import math
import re

# 서버 자동심사 정책. 기준을 바꾸면 정책 번호도 올린다(확정 JSON에 묶인 예전 판정은 그대로 남는다).
AUTO_REVIEW_POLICY = "v2-server-auto-review-1"
CREDIT_GRADES = ("AAA", "AA+", "AA", "AA-", "A+", "A", "A-", "BBB+", "BBB", "BBB-", "BB+", "BB", "BB-",
                 "B+", "B", "B-", "CCC+", "CCC", "CCC-", "CC", "C", "D")  # 높은 등급부터
LTV_LIMIT_PCT = 70          # 계약 confirmEvaluation과 같은 한도. 넘으면 거절
APPROVE_LOWEST = "BBB-"     # AAA~BBB-: 재무 점검 모두 통과면 승인
REJECT_HIGHEST = "CCC+"     # CCC+ 이하: 거절
CONDITIONAL_LTV_PCT = 60    # 그 사이(BB+~B-): 재무 점검 모두 통과 + LTV 60% 이하면 승인, 아니면 검토
CHECK_REASONS = {  # 재무 점검 키: (미충족, 자료 없음)
    "capital": ("자본잠식", "자본총계 자료 없음"),
    "operating_income": ("영업손실", "영업이익 자료 없음"),
    "interest_coverage": ("이자보상배율 1배 미만", "이자보상배율 자료 없음"),
    "current_ratio": ("유동비율 100% 미만", "유동비율 자료 없음"),
}

MAX_KRW = 9_000_000_000_000_000
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SOURCE_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
AMOUNT_FIELDS = ("revenue_krw", "operating_income_krw", "net_income_krw", "total_assets_krw", "total_liabilities_krw",
                 "total_equity_krw", "total_borrowings_krw", "finance_costs_krw")
RATIO_FIELDS = ("debt_ratio_pct", "current_ratio_pct", "debt_dependency_pct", "interest_coverage_times")
SOURCE_LABELS = {"company_report": "회사 제출 자료", "nice_finance": "NICE BizAPI", "dart_audit": "DART 감사보고서",
                 "fsc": "금융위원회 기업재무정보", "jobkorea_finance": "잡코리아 재무표"}


def _amount(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        value = int(round(value))
    return value if abs(value) <= MAX_KRW else None


def _ratio(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value) > 1e9:
        return None
    return round(float(value), 2)


def _date(value):
    return value if isinstance(value, str) and DATE_PATTERN.match(value) else None


def clean_valuation(raw):
    """LLM 산정액. 확정 표시가 없으면 사전평가 초안으로 본다."""
    if not isinstance(raw, dict):
        return None
    value = _amount(raw.get("ip_value_krw"))
    if value is None:
        return None
    number = raw.get("report_number")
    return {
        "ip_value_krw": value,
        "value_status": "confirmed" if raw.get("value_status") == "confirmed" else "preliminary",
        "valuation_date": _date(raw.get("valuation_date")),
        "report_number": number.strip()[:100] if isinstance(number, str) and number.strip() else None,
    }


def clean_credit_rating(raw):
    """The credit grade written in the attached company report (e.g. "bb"), in the form the contract accepts (BB)."""
    if not isinstance(raw, str):
        return None
    grade = re.match(r"[A-Z]{1,3}[+-]?", raw.strip().upper())
    return grade.group(0) if grade else None


def clean_financials(raw):
    """최근 3개 결산연도, 오래된 해부터. 자본잠식 여부는 자본총계로 다시 계산한다."""
    if not isinstance(raw, list):
        return []
    rows = {}
    for item in raw[:10]:
        if not isinstance(item, dict):
            continue
        year = item.get("year")
        if isinstance(year, bool) or not isinstance(year, int) or not 1900 <= year <= 2100:
            continue
        source = item.get("source")
        row = {
            "year": year,
            "fiscal_date": _date(item.get("fiscal_date")),
            "fiscal_date_assumed": item.get("fiscal_date_assumed") if isinstance(item.get("fiscal_date_assumed"), bool) else None,
            "source": source if isinstance(source, str) and SOURCE_PATTERN.match(source) else None,
            **{field: _amount(item.get(field)) for field in AMOUNT_FIELDS},
            **{field: _ratio(item.get(field)) for field in RATIO_FIELDS},
        }
        equity = row["total_equity_krw"]
        flag = item.get("capital_impaired")
        row["capital_impaired"] = equity <= 0 if equity is not None else flag if isinstance(flag, bool) else None
        if row["capital_impaired"]:
            # 자본잠식이면 부채비율은 산정할 수 없다. 음수 비율이 기준을 통과한 것처럼 보이지 않게 비운다.
            row["debt_ratio_pct"] = None
        rows[year] = row
    return [rows[year] for year in sorted(rows)][-3:]


def public_financials(rows):
    return [{**row, "source_label": SOURCE_LABELS.get(row["source"], row["source"] or "출처 미상")} for row in rows]


def _million(amount):
    if abs(amount) < 500_000:
        return f"{amount:,}원"
    return f"{round(amount / 1_000_000):,}백만원"


def financial_checks(rows):
    """가장 최근 결산연도 기준 참고 점검. result는 pass·fail·unknown(자료 없음)이다."""
    latest = rows[-1] if rows else {}

    def check(key, label, criterion, passed, observed):
        return {"key": key, "label": label, "criterion": criterion, "year": latest.get("year"),
                "result": "unknown" if passed is None else "pass" if passed else "fail",
                "observed": "자료 없음" if passed is None else observed}

    impaired, equity = latest.get("capital_impaired"), latest.get("total_equity_krw")
    equity_text = "" if equity is None else f" (자본총계 {_million(equity)})"
    operating = latest.get("operating_income_krw")
    coverage, finance_costs = latest.get("interest_coverage_times"), latest.get("finance_costs_krw")
    current = latest.get("current_ratio_pct")
    if coverage is not None:
        coverage_check = (coverage >= 1, f"{coverage:,.2f}배")
    elif finance_costs == 0:
        coverage_check = (True, "금융비용 없음")
    else:
        coverage_check = (None, "")
    return [
        check("capital", "자본잠식 없음", "자본총계 0원 초과", None if impaired is None else not impaired,
              ("자본잠식" if impaired else "자본잠식 아님") + equity_text),
        check("operating_income", "영업이익", "영업이익 0원 이상", None if operating is None else operating >= 0,
              "" if operating is None else f"영업손실 {_million(-operating)}" if operating < 0 else f"영업이익 {_million(operating)}"),
        check("interest_coverage", "이자보상배율", "영업이익이 금융비용의 1배 이상", *coverage_check),
        check("current_ratio", "유동비율", "유동자산이 유동부채의 100% 이상", None if current is None else current >= 100,
              "" if current is None else f"{current:,.2f}%"),
    ]


def _positive_int(value):
    return type(value) is int and value > 0


def auto_review(credit_rating, checks, amount, value):
    """확정 시점의 신용등급·재무 점검(`financial_checks` 결과)·신청금액·적용 가치로 내리는 자동심사.

    decision은 approve·reject·review다. 등급·점검·금액이 없으면 통과로 보지 않고 review로 남긴다.
    LTV 비교는 계약처럼 정수로 한다(`amount * 100 <= value * 70`). ltvPct는 표시용 반올림값이다.
    reasons는 거절·검토 사유(거절 먼저), 승인이면 승인 근거다.
    """
    approve_rank, reject_rank = CREDIT_GRADES.index(APPROVE_LOWEST), CREDIT_GRADES.index(REJECT_HIGHEST)
    middle = f"{CREDIT_GRADES[approve_rank + 1]}~{CREDIT_GRADES[reject_rank - 1]}"
    grade = clean_credit_rating(credit_rating)
    rank = CREDIT_GRADES.index(grade) if grade in CREDIT_GRADES else None
    rejects, reviews = [], []

    if rank is None:
        reviews.append(("grade_unknown", "신용등급 판정 불가"))
    elif rank >= reject_rank:
        rejects.append(("grade_too_low", f"신용등급 {REJECT_HIGHEST} 이하"))

    results = {}
    for check in checks if isinstance(checks, list) else ():
        if isinstance(check, dict) and check.get("key") in CHECK_REASONS:
            results.setdefault(check["key"], []).append(check.get("result"))
    for key, (failed, missing) in CHECK_REASONS.items():
        found = results.get(key, [])
        if "fail" in found:
            reviews.append((f"{key}_fail", failed))
        elif not found or any(result != "pass" for result in found):
            reviews.append((f"{key}_unknown", missing))

    ltv_pct = None
    if not (_positive_int(amount) and _positive_int(value)):
        reviews.append(("ltv_unknown", "LTV 판정 불가"))
    else:
        ltv_pct = round(amount * 100 / value, 2)
        if amount * 100 > value * LTV_LIMIT_PCT:
            rejects.insert(0, ("ltv_over_limit", f"LTV {LTV_LIMIT_PCT}% 초과"))
        elif rank is not None and approve_rank < rank < reject_rank and amount * 100 > value * CONDITIONAL_LTV_PCT:
            reviews.append(("ltv_over_conditional", f"{middle} 등급 LTV {CONDITIONAL_LTV_PCT}% 초과"))

    if rejects or reviews:
        decision, reasons = ("reject" if rejects else "review"), rejects + reviews
    elif rank <= approve_rank:
        decision, reasons = "approve", [("grade_approve", f"신용등급 {APPROVE_LOWEST} 이상"), ("checks_pass", "재무 점검 모두 통과"),
                                        ("ltv_within_limit", f"LTV {LTV_LIMIT_PCT}% 이하")]
    else:
        decision, reasons = "approve", [("grade_conditional", f"신용등급 {middle}"), ("checks_pass", "재무 점검 모두 통과"),
                                        ("ltv_within_conditional", f"LTV {CONDITIONAL_LTV_PCT}% 이하")]
    return {"policy": AUTO_REVIEW_POLICY, "decision": decision, "ltvPct": ltv_pct,
            "reasons": [{"code": code, "label": label} for code, label in reasons]}
