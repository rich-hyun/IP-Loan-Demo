"""Validation of the report API's valuation/financials summary and the reference financial checks. No I/O."""

import unittest

from server.report_summary import (CREDIT_GRADES, auto_review, clean_credit_rating, clean_financials, clean_valuation,
                                   financial_checks, public_financials)


def year(y, **values):
    return {"year": y, "fiscal_date": f"{y}-12-31", "source": "nice_finance", **values}


class ValuationTests(unittest.TestCase):
    def test_keeps_value_and_treats_anything_but_confirmed_as_preliminary(self):
        raw = {"ip_value_krw": 23_456_789, "value_status": "preliminary", "valuation_date": "2026-10-20",
               "report_number": " MT-2026-001 ", "discount_rate": 0.2}
        self.assertEqual({"ip_value_krw": 23_456_789, "value_status": "preliminary", "valuation_date": "2026-10-20",
                          "report_number": "MT-2026-001"}, clean_valuation(raw))
        self.assertEqual("preliminary", clean_valuation({"ip_value_krw": 1, "value_status": "final"})["value_status"])
        self.assertEqual("confirmed", clean_valuation({"ip_value_krw": 1, "value_status": "confirmed"})["value_status"])

    def test_negative_value_is_kept_but_malformed_values_are_dropped(self):
        self.assertEqual(-235_061, clean_valuation({"ip_value_krw": -235_061})["ip_value_krw"])
        for bad in (None, "1000", True, float("nan"), 10 ** 20):
            self.assertIsNone(clean_valuation({"ip_value_krw": bad}), bad)
        self.assertIsNone(clean_valuation(["ip_value_krw", 1]))
        self.assertIsNone(clean_valuation({"ip_value_krw": 5, "valuation_date": "20261020"})["valuation_date"])


class CreditRatingTests(unittest.TestCase):
    def test_report_grade_in_contract_form(self):
        self.assertEqual("BB", clean_credit_rating("bb"))
        self.assertEqual("BBB-", clean_credit_rating(" bbb- (안정적)"))
        for bad in (None, "", "등급 없음", 3, "12"):
            self.assertIsNone(clean_credit_rating(bad), bad)


class FinancialsTests(unittest.TestCase):
    def test_latest_three_years_in_order_with_typed_fields_only(self):
        raw = [year(2025, revenue_krw=198_140_000.4, current_ratio_pct=8.844, note="<script>"),
               year(2022, revenue_krw=1), year(2024, revenue_krw="5"), year(2023), {"year": True}, {"year": "2021"}, "x"]
        rows = clean_financials(raw)
        self.assertEqual([2023, 2024, 2025], [row["year"] for row in rows])
        self.assertEqual(198_140_000, rows[-1]["revenue_krw"])
        self.assertEqual(8.84, rows[-1]["current_ratio_pct"])
        self.assertIsNone(rows[1]["revenue_krw"])
        self.assertNotIn("note", rows[-1])

    def test_capital_impairment_is_recomputed_from_equity_and_blanks_the_debt_ratio(self):
        impaired, healthy, unknown = clean_financials([
            year(2023, total_equity_krw=-505_540_000, debt_ratio_pct=-190.2, capital_impaired=False),
            year(2024, total_equity_krw=1_812_000_000, debt_ratio_pct=85.81, capital_impaired=True),
            year(2025, capital_impaired=True)])
        self.assertEqual((True, None), (impaired["capital_impaired"], impaired["debt_ratio_pct"]))
        self.assertEqual((False, 85.81), (healthy["capital_impaired"], healthy["debt_ratio_pct"]))
        self.assertTrue(unknown["capital_impaired"])

    def test_assumed_fiscal_date_and_source_label(self):
        row = clean_financials([{"year": 2025, "fiscal_date": "2025-12-31", "fiscal_date_assumed": True,
                                 "source": "company_report"}, {"year": 2024, "source": "Bad Source!"}])
        self.assertTrue(row[1]["fiscal_date_assumed"])
        labels = [entry["source_label"] for entry in public_financials(row)]
        self.assertEqual(["출처 미상", "회사 제출 자료"], labels)


class ChecksTests(unittest.TestCase):
    def results(self, rows):
        return {check["key"]: (check["result"], check["observed"]) for check in financial_checks(clean_financials(rows))}

    def test_missing_data_is_never_a_pass(self):
        self.assertEqual({"unknown"}, {result for result, _ in self.results([]).values()})
        self.assertEqual({"unknown"}, {result for result, _ in self.results([year(2025)]).values()})
        self.assertEqual("자료 없음", self.results([])["capital"][1])

    def test_latest_year_is_checked(self):
        results = self.results([
            year(2024, total_equity_krw=-1, operating_income_krw=-1, current_ratio_pct=1.0, interest_coverage_times=0.1),
            year(2025, total_equity_krw=1_812_000_000, operating_income_krw=900_000_000, current_ratio_pct=592.63,
                 interest_coverage_times=15.3)])
        self.assertEqual({"capital": ("pass", "자본잠식 아님 (자본총계 1,812백만원)"),
                          "operating_income": ("pass", "영업이익 900백만원"),
                          "interest_coverage": ("pass", "15.30배"),
                          "current_ratio": ("pass", "592.63%")}, results)

    def test_failures_and_no_finance_costs(self):
        results = self.results([year(2025, total_equity_krw=-505_540_000, operating_income_krw=-365_170_000,
                                     current_ratio_pct=8.84, finance_costs_krw=0)])
        self.assertEqual(("fail", "자본잠식 (자본총계 -506백만원)"), results["capital"])
        self.assertEqual(("fail", "영업손실 365백만원"), results["operating_income"])
        self.assertEqual(("pass", "금융비용 없음"), results["interest_coverage"])
        self.assertEqual(("fail", "8.84%"), results["current_ratio"])
        self.assertEqual("fail", self.results([year(2025, interest_coverage_times=-5.2)])["interest_coverage"][0])


def checks(**results):
    """The four checks as bound into the reviewed manifest; every check passes unless overridden."""
    keys = ("capital", "operating_income", "interest_coverage", "current_ratio")
    return [{"key": key, "year": 2025, "result": results.get(key, "pass"), "observed": ""} for key in keys]


class AutoReviewTests(unittest.TestCase):
    def verdict(self, grade, found=None, amount=50, value=100):
        result = auto_review(grade, checks() if found is None else found, amount, value)
        return result["decision"], [reason["code"] for reason in result["reasons"]]

    def test_grade_order_high_to_low(self):
        self.assertEqual(("AAA", "AA+", "AA", "AA-", "A+", "A", "A-", "BBB+", "BBB", "BBB-", "BB+", "BB", "BB-",
                          "B+", "B", "B-", "CCC+", "CCC", "CCC-", "CC", "C", "D"), CREDIT_GRADES)

    def test_investment_grade_with_all_checks_passing_is_approved_up_to_ltv_70(self):
        self.assertEqual({"policy": "v2-server-auto-review-1", "decision": "approve", "ltvPct": 70.0, "reasons": [
            {"code": "grade_approve", "label": "신용등급 BBB- 이상"}, {"code": "checks_pass", "label": "재무 점검 모두 통과"},
            {"code": "ltv_within_limit", "label": "LTV 70% 이하"}]}, auto_review("BBB-", checks(), 70, 100))
        for grade in ("AAA", "AA-", "A", "BBB+", " bbb (안정적)"):
            self.assertEqual("approve", self.verdict(grade, amount=70, value=100)[0], grade)

    def test_ltv_over_70_is_rejected_by_integer_comparison(self):
        self.assertEqual(("reject", ["ltv_over_limit"]), self.verdict("AAA", amount=71, value=100))
        # 70.000001% shows as 70.0 but is over the contract limit.
        result = auto_review("AAA", checks(), 70_000_001, 100_000_000)
        self.assertEqual(("reject", 70.0), (result["decision"], result["ltvPct"]))

    def test_ccc_plus_or_lower_is_rejected(self):
        for grade in ("CCC+", "CCC", "CCC-", "CC", "C", "D"):
            self.assertEqual(("reject", ["grade_too_low"]), self.verdict(grade, amount=10), grade)
        self.assertEqual(("reject", ["ltv_over_limit", "grade_too_low", "current_ratio_fail"]),
                         self.verdict("CCC", checks(current_ratio="fail"), amount=80))

    def test_missing_or_unrecognised_grade_needs_review(self):
        for grade in (None, "", "등급 없음", "NR", "AAA+", 3):
            self.assertEqual(("review", ["grade_unknown"]), self.verdict(grade, amount=10), grade)

    def test_any_failed_or_unknown_check_needs_review_and_missing_data_never_passes(self):
        self.assertEqual(("review", ["current_ratio_fail"]), self.verdict("AAA", checks(current_ratio="fail")))
        self.assertEqual(("review", ["capital_unknown", "interest_coverage_fail"]),
                         self.verdict("AA", checks(capital="unknown", interest_coverage="fail")))
        all_unknown = ["capital_unknown", "operating_income_unknown", "interest_coverage_unknown", "current_ratio_unknown"]
        for found in (None, [], "pass", [{"key": "capital", "result": "pass"}] * 4):
            self.assertEqual("review", auto_review("AAA", found, 50, 100)["decision"], found)
        self.assertEqual(all_unknown, self.verdict("AAA", [])[1])
        self.assertEqual(["operating_income_unknown"], self.verdict("AAA", checks(operating_income="PASS"))[1])
        self.assertEqual(["current_ratio_unknown"], self.verdict("AAA", checks()[:3])[1])
        self.assertEqual(all_unknown, self.verdict("AAA", financial_checks(clean_financials([])))[1])

    def test_bb_to_b_minus_needs_all_checks_and_ltv_60(self):
        for grade in ("BB+", "BB", "BB-", "B+", "B", "B-"):
            self.assertEqual(("approve", ["grade_conditional", "checks_pass", "ltv_within_conditional"]),
                             self.verdict(grade, amount=60, value=100), grade)
            self.assertEqual(("review", ["ltv_over_conditional"]), self.verdict(grade, amount=60_000_001, value=100_000_000), grade)
            self.assertEqual(("reject", ["ltv_over_limit"]), self.verdict(grade, amount=71, value=100), grade)
            self.assertEqual(("review", ["capital_fail"]), self.verdict(grade, checks(capital="fail"), amount=10), grade)
        self.assertEqual(["신용등급 BB+~B-", "재무 점검 모두 통과", "LTV 60% 이하"],
                         [reason["label"] for reason in auto_review("B", checks(), 60, 100)["reasons"]])
        self.assertEqual("BB+~B- 등급 LTV 60% 초과", auto_review("BB", checks(), 65, 100)["reasons"][0]["label"])

    def test_missing_amount_or_value_needs_review(self):
        for amount, value in ((0, 100), (50, 0), (50, None), (True, 100), (50.0, 100), (50, -1)):
            result = auto_review("AAA", checks(), amount, value)
            self.assertEqual(("review", None, ["ltv_unknown"]),
                             (result["decision"], result["ltvPct"], [r["code"] for r in result["reasons"]]), (amount, value))

    def test_pilot_reports(self):
        current_ratio_fail = checks(current_ratio="fail")
        cases = [("SHI&E", "BB-", checks(), "approve", "review"), ("부영금속", "B+", checks(), "approve", "review"),
                 ("북성공업", "BBB", checks(), "approve", "approve"), ("성보지업", "B+", checks(), "approve", "review"),
                 ("세종정기", "BB-", current_ratio_fail, "review", "review")]
        for name, grade, found, at_60, at_65 in cases:
            self.assertEqual(at_60, auto_review(grade, found, 60, 100)["decision"], name)
            self.assertEqual(at_65, auto_review(grade, found, 65, 100)["decision"], name)


if __name__ == "__main__":
    unittest.main()
