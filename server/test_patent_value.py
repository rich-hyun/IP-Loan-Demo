"""Monetary parsing boundaries for the observed provider report template."""
import unittest
from server.patent_value import html_valuation


def report(amount):
    return f'<table><tr><th class="th-blue">IP 가치금액</th><td class="td-strong">{amount}<span class="summary-basis">기준 시나리오</span></td><th>할인율</th><td>16.16%</td></tr></table>'.encode()


class PatentValueTests(unittest.TestCase):
    def test_explicit_units_decimals_and_comma_are_normalized_to_won(self):
        for text, expected in [('1.25억 원', 125_000_000), ('1,234 만원', 12_340_000), ('3.14백만원', 3_140_000), ('100원', 100)]:
            self.assertEqual(expected, html_valuation(report(text))[0])

    def test_zero_and_negative_are_reported_without_turning_positive(self):
        self.assertEqual(0, html_valuation(report('-0.00억 원'))[0])
        self.assertEqual(-125_000_000, html_valuation(report('-1.25억원'))[0])
        self.assertIn('0 이하', html_valuation(report('0원'))[2])

    def test_missing_unknown_range_currency_multiple_values_and_fractional_won_fail_closed(self):
        for text in ['1.2', '100 USD', '1~2억원', '약 2억원', '1.1원', '1,2원', '9000000000000001원', '<script>1억원</script>', '가치금액 없음']:
            self.assertIsNone(html_valuation(report(text))[0], text)
        self.assertIsNone(html_valuation(report('1억원') + report('2억원'))[0])
        self.assertIsNone(html_valuation(b'<p>IP value 100000000</p>')[0])

    def test_agreeing_duplicate_summary_rows_are_accepted(self):
        self.assertEqual(100_000_000, html_valuation(report('1억원') + report('100백만원'))[0])


if __name__ == '__main__':
    unittest.main()
