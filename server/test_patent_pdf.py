"""Reading the application form fields from patent gazette text. No files or network."""

import unittest

from server.patent_pdf import parse_fields, read_fields

GAZETTE = """(19) 대한민국 지식재산처(KR)
(12) 등록특허공보(B1)
(11) 등록번호   10-2877748
(21) 출원번호       10-2022-0132655
(22) 출원일자       2022년10월14일
(73) 특허권자
주식회사 예시
(54) 발명의 명칭 두부 자극용 전위치료장치
(57) 요 약
두부 자극용 전위치료장치가 제공된다."""


class PatentPdfTests(unittest.TestCase):
    def test_registered_patent_gazette(self):
        self.assertEqual({"ipType": "특허권", "ipTitle": "두부 자극용 전위치료장치", "ipRegNo": "10-2022-0132655"},
                         parse_fields(GAZETTE))

    def test_utility_model_with_a_title_over_two_lines(self):
        text = "(12) 등록실용신안공보(Y1)\n(21) 출원번호 20-2023-0001234\n(54) 고안의 명칭 접이식 휴대용\n   거치대\n(57) 요 약"
        self.assertEqual({"ipType": "실용신안권", "ipTitle": "접이식 휴대용 거치대", "ipRegNo": "20-2023-0001234"}, parse_fields(text))

    def test_registry_style_labels(self):
        text = "특허등록원부\n출원번호 : 제 10-2021-0004567 호\n발명의 명칭 : 스마트 관수 제어 시스템\n등록권리자"
        self.assertEqual({"ipType": "특허권", "ipTitle": "스마트 관수 제어 시스템", "ipRegNo": "10-2021-0004567"}, parse_fields(text))

    def test_unrelated_or_broken_documents_fill_nothing(self):
        self.assertEqual({}, parse_fields("회의록\n참석자: 홍길동"))
        self.assertEqual({}, read_fields(b"%PDF-1.4 broken"))
        self.assertEqual({}, read_fields(b"not a pdf"))


if __name__ == "__main__":
    unittest.main()
