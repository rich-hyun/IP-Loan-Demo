"""Strict adapter for the provider's observed HTML 'IP 가치금액' summary row.

No LLM/text guessing: accept an exact table heading, its adjacent monetary
cell, and an explicit KRW unit. Conflicting/missing rows are not a valuation.
"""
import re
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser


class ValueTable(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows = []
        self.row = None
        self.cell = None
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag == 'tr':
            self.row = []
        elif tag in {'th', 'td'} and self.row is not None:
            self.cell = [tag, []]
            self.skip = 0
        elif tag in {'span', 'script', 'style'} and self.cell is not None:
            # In the real template the cell's amount is followed by a span
            # containing the scenario name, which is provenance, not money.
            self.skip += 1

    def handle_endtag(self, tag):
        if tag in {'span', 'script', 'style'} and self.cell is not None:
            self.skip = max(0, self.skip - 1)
        elif tag in {'th', 'td'} and self.cell is not None:
            self.row.append((self.cell[0], ''.join(self.cell[1]).strip()))
            self.cell = None
        elif tag == 'tr' and self.row is not None:
            self.rows.append(self.row)
            self.row = None
            self.cell = None

    def handle_data(self, data):
        if self.cell is not None and not self.skip:
            self.cell[1].append(data)


def html_valuation(body):
    parser = ValueTable()
    try:
        parser.feed(body.decode('utf-8', errors='strict'))
    except (UnicodeError, ValueError):
        return None, None, '보고서 HTML 인코딩을 확인할 수 없습니다.'
    values = []
    units = {'원': 1, '만원': 10_000, '백만원': 1_000_000, '억원': 100_000_000}
    for row in parser.rows:
        for i, (tag, text) in enumerate(row[:-1]):
            if tag != 'th' or re.sub(r'\s+', '', text) != 'IP가치금액' or row[i+1][0] != 'td':
                continue
            raw = row[i+1][1]
            match = re.fullmatch(r'\s*([-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(백만\s*원|만\s*원|억\s*원|원)\s*', raw)
            if not match:
                return None, raw, 'IP 가치금액 표의 수치·원화 단위가 명확하지 않습니다.'
            try:
                value = Decimal(match[1].replace(',', '')) * units[re.sub(r'\s+', '', match[2])]
                if value != value.to_integral_value() or abs(value) > 9_000_000_000_000_000:
                    raise InvalidOperation()
            except InvalidOperation:
                return None, raw, 'IP 가치금액이 허용 범위의 원 단위 정수가 아닙니다.'
            values.append((int(value), raw))
    if not values:
        return None, None, '보고서에 해석 가능한 IP 가치금액 표가 없습니다.'
    if len({v[0] for v in values}) != 1:
        return None, None, '보고서 내 IP 가치금액 표의 값이 서로 다릅니다. 평가사 확인이 필요합니다.'
    value, raw = values[0]
    message = '보고서의 IP 가치금액 표에서 추출한 사전평가 값입니다. 평가사의 검토·확정이 필요합니다.'
    if value <= 0:
        message += ' 자동 산출값이 0 이하이므로 이 값으로 LTV 심사를 통과할 수 없습니다.'
    return value, raw, message
