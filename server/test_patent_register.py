"""등록원부 조회 결과 요약과 오류 처리. 네트워크를 쓰지 않는다."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import requests

from server import patent_register

# 2026-10-29 실제 응답(10-2642299)에서 주소를 지우고 줄인 것.
ITEMS = {
    "rgstNo": "1026422990000", "rgstDate": "20240226", "applNo": "1020220046360", "applDate": "20220414",
    "title": "할바흐 배열 마그네트 제조 방법", "cndrtExptnDate": "20420414", "lastDspst": "등록결정(일반)", "claimCount": "6",
    "pay": [{"statAnnl": 1, "lastAnnl": 3, "payDate": "20240227", "payAmount": 76500}],
    "applicant": [{"applicantName": "주식회사 마그트론", "applicantAddr": "인천광역시 ..."}],
    "inventor": [{"inventorName": "홍길동", "inventorAddr": "경기도 ..."}],
    "owner": [{"ownerName": "주식회사 마그트론", "ownerRgstCsName": None, "ownerRgstCsReason": None,
               "ownerRgstCsDate": "20240226", "ownerAddr": "인천광역시 ...", "finalOwnerYn": "Y"}],
    "right": [{"rgstCsName": "설정등록", "rgstCsDate": "20240226", "rgstCsReason": None, "rgstCsPupos": None}],
    "elsLcnsList": [{"elsLcnsPsnNm": None, "elsLcnsRgstCsNm": None, "elsLcnsStartDate": None}],
    "noelsLcnsList": [{"noelsLcnsPsnNm": None}],
    "cofpr": [{"cofprCount": None}],
}


def reply(body, status=200):
    return Mock(status_code=status, content=body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8-sig"))


class PatentRegisterTests(unittest.TestCase):
    def test_numbers(self):
        self.assertEqual("10-2877748", patent_register.gazette_number("(12) 등록특허공보(B1)\n(11) 등록번호   10-2877748\n(21) 출원번호 10-2022-0132655"))
        self.assertIsNone(patent_register.gazette_number("(21) 출원번호 10-2022-0132655"))
        for number in ("10-2642299", "102642299", "1026422990000", " 10-2642299 "):
            self.assertEqual("1026422990000", patent_register.normalize(number))
        for number in ("10-2022-0046360", "1020220046360", "20-0481234", "", None):
            self.assertIsNone(patent_register.normalize(number))

    def test_summary_drops_placeholder_rows_and_personal_details(self):
        summary = patent_register.summarize(ITEMS)
        self.assertEqual("10-2022-0046360", summary["applicationNumber"])
        self.assertEqual(("2024-02-26", "2042-04-14"), (summary["registeredAt"], summary["expiresAt"]))
        self.assertEqual(["주식회사 마그트론"], summary["currentOwners"])
        self.assertEqual([{"cause": "설정등록", "changedAt": "2024-02-26", "reason": None, "purpose": None}], summary["rights"])
        self.assertEqual([{"fromYear": 1, "toYear": 3, "paidAt": "2024-02-27", "amount": 76500}], summary["annuities"])
        self.assertEqual(([], []), (summary["exclusiveLicenses"], summary["nonExclusiveLicenses"]))
        self.assertIsNone(summary["lapsedAt"])
        text = json.dumps(summary, ensure_ascii=False)
        self.assertNotIn("인천광역시", text)
        self.assertNotIn("홍길동", text)

    def test_a_lapse_shows_although_the_last_disposition_is_still_registration(self):
        lapse = {"rgstCsName": "소멸등록", "rgstCsDate": "20260724", "rgstCsReason": "등록료불납", "rgstCsPupos": None}
        summary = patent_register.summarize({**ITEMS, "right": ITEMS["right"] + [lapse]})
        self.assertEqual(("등록결정(일반)", "2026-07-24", "등록료불납"), (summary["lastDisposition"], summary["lapsedAt"], summary["lapseReason"]))
        restored = {"rgstCsName": "회복등록", "rgstCsDate": "20260901", "rgstCsReason": None, "rgstCsPupos": None}
        self.assertIsNone(patent_register.summarize({**ITEMS, "right": ITEMS["right"] + [lapse, restored]})["lapsedAt"])

    def test_collect_matches_the_owner_with_company_suffixes(self):
        with patch.object(patent_register, "api_key", return_value="a+key"), \
             patch.object(patent_register.requests, "get", return_value=reply({"resultCode": "000", "items": ITEMS})) as get:
            record = patent_register.collect("10-2642299", "(주)마그트론")
        self.assertEqual(("collected", True), (record["status"], record["ownerMatch"]))
        self.assertEqual({"serviceKey": "a+key", "type": "json", "rgstNo": "1026422990000"}, get.call_args.kwargs["params"])
        with patch.object(patent_register, "fetch", return_value=ITEMS):
            self.assertFalse(patent_register.collect("10-2642299", "다른회사(주)")["ownerMatch"])

    def test_the_key_comes_from_the_environment_or_the_local_keys_file(self):
        with tempfile.TemporaryDirectory() as folder:
            keys = Path(folder) / "local_keys.json"
            env = {k: v for k, v in os.environ.items() if k != "PATENT_REGISTER_API_KEY"}
            with patch.object(patent_register, "KEYS_FILE", keys), patch.dict(os.environ, env, clear=True):
                self.assertEqual("", patent_register.api_key())  # no file
                keys.write_text("not json", encoding="utf-8")
                self.assertEqual("", patent_register.api_key())
                keys.write_text(json.dumps({"PATENT_REGISTER_API_KEY": " a%2Bfile%3D%3D "}), encoding="utf-8")
                self.assertEqual("a+file==", patent_register.api_key())  # an encoded copy is decoded once
                with patch.dict(os.environ, {"PATENT_REGISTER_API_KEY": "from-env"}):
                    self.assertEqual("from-env", patent_register.api_key())

    def test_failures_become_a_status_without_the_key(self):
        cases = [
            (reply({"resultCode": "001", "resultMsg": "NODATA_ERROR"}), "not_found"),
            (reply(b"<OpenAPI_ServiceResponse><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg>"), "failed"),
            (reply({}, 500), "failed"),
            (requests.ConnectionError("https://apis.data.go.kr/...?serviceKey=secret-key"), "failed"),
        ]
        for outcome, status in cases:
            with patch.object(patent_register, "api_key", return_value="secret-key"), \
                 patch.object(patent_register.requests, "get", side_effect=[outcome]):
                record = patent_register.collect("10-2642299")
            self.assertEqual(status, record["status"])
            self.assertNotIn("secret-key", json.dumps(record))
        with patch.object(patent_register, "api_key", return_value=""):
            self.assertEqual("unconfigured", patent_register.collect("10-2642299")["status"])
        self.assertEqual("no_number", patent_register.collect("10-2022-0046360")["status"])


if __name__ == "__main__":
    unittest.main()
