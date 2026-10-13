import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from core import canonical_hash, demo_valuation, demo_report, generate_report, rule_review, sha256_bytes


APP = {'id': 'LN-DEMO-0001', 'company': '샘플기업', 'ipTitle': '특허 구조 시험',
       'ipType': '특허권', 'ipRegNo': '10-2026-000001', 'amount': 50_000_000}


class CoreTest(unittest.TestCase):
    def test_valuation_not_based_on_loan_request(self):
        one = demo_valuation(APP)
        two = demo_valuation(dict(APP, amount=2_000_000_000))
        self.assertEqual(one['appraisedValue'], two['appraisedValue'])

    def test_report_is_marked_not_llm_if_key_absent(self):
        original = os.environ.pop('OPENAI_API_KEY', None)
        try:
            report = generate_report(APP)
            self.assertEqual(report['mode'], 'demo_template')
            self.assertIn('LLM 미사용', report['generatedBy'])
            self.assertIsNone(report['similarity'])
            self.assertIn('미검증', report['disclaimer']) if '미검증' in report['disclaimer'] else self.assertIn('비공식', report['disclaimer'])
        finally:
            if original is not None:
                os.environ['OPENAI_API_KEY'] = original

    def test_repeatability_hash(self):
        self.assertEqual(sha256_bytes(b'abc'),
                         'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
        self.assertEqual(canonical_hash({'x': 1, 'y': 2}), canonical_hash({'y': 2, 'x': 1}))

    def test_review_pass_and_reject(self):
        report = demo_report(APP)
        result = rule_review(dict(APP, amount=10_000_000), report, credit_score=80)
        self.assertTrue(result['passed'])
        self.assertGreater(result['approvedAmount'], 0)
        bad_ltv = rule_review(dict(APP, amount=2_000_000_000), report, credit_score=80)
        self.assertFalse(bad_ltv['passed'])
        self.assertFalse(bad_ltv['conditions']['ltv'])
        bad_credit = rule_review(dict(APP, amount=10_000_000), report, credit_score=50)
        self.assertFalse(bad_credit['passed'])
        self.assertFalse(bad_credit['conditions']['credit'])
        bad_doc = rule_review(dict(APP, amount=10_000_000), report,
                              reference_mismatch=True, credit_score=80)
        self.assertFalse(bad_doc['passed'])
        self.assertFalse(bad_doc['conditions']['documentIntegrity'])

    def test_credit_score_range_rejected(self):
        with self.assertRaises(ValueError):
            rule_review(APP, demo_report(APP), credit_score=101)


if __name__ == '__main__':
    unittest.main()
