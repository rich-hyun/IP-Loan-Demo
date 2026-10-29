"""특허 등록원부를 공공데이터포털 '등록원부 실시간 정보 조회' API로 가져온다.

신청 PDF(공고전문)의 (11) 등록번호로 조회해 신청건에 요약을 저장한다. 인증키는 server/local_keys.json(Git 제외)의
PATENT_REGISTER_API_KEY이며 같은 이름의 환경변수가 우선한다. 키가 든 요청 URL·예외 원문은 기록하지 않는다.
조회 실패는 신청을 막지 않고 status로 남긴다.
특허(10-) 등록번호만 다룬다. 실용신안·디자인·상표는 번호 체계와 오퍼레이션이 다르다.
"""
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote

import requests

KEYS_FILE = Path(__file__).with_name("local_keys.json")
API_URL = "https://apis.data.go.kr/1430000/PttRgstRtInfoInqSvc/getPatentRegisterHistory"
TIMEOUT = (5, 20)
GAZETTE_NUMBER = re.compile(r"\(11\)\s*등록번호\s*(10-\d{7})")


class RegisterError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def gazette_number(text):
    """공고전문 텍스트의 (11) 등록번호. 없으면 None."""
    match = GAZETTE_NUMBER.search(text or "")
    return match.group(1) if match else None


def normalize(number):
    """10-2642299, 102642299, 1026422990000 → 1026422990000. 출원번호(10-YYYY-NNNNNNN)나 다른 권리는 None."""
    match = re.fullmatch(r"10-?(\d{7})(?:0000)?", (number or "").strip())
    return f"10{match.group(1)}0000" if match else None


def api_key():
    # Read on every lookup, so a key file added to a running server takes effect without a restart.
    key = os.environ.get("PATENT_REGISTER_API_KEY", "")
    if not key:
        try:
            key = json.loads(KEYS_FILE.read_text(encoding="utf-8")).get("PATENT_REGISTER_API_KEY", "")
        except (OSError, ValueError, AttributeError):
            key = ""
    # A key copied in its URL-encoded form would be encoded twice by requests.
    return unquote(str(key).strip())


def fetch(rgst_no):
    key = api_key()
    if not key:
        raise RegisterError("unconfigured", "등록원부 API 키가 설정되지 않았습니다.")
    try:
        response = requests.get(API_URL, params={"serviceKey": key, "type": "json", "rgstNo": rgst_no}, timeout=TIMEOUT)
    except requests.RequestException:
        raise RegisterError("failed", "등록원부 API에 연결하지 못했습니다.") from None
    if response.status_code != 200:
        raise RegisterError("failed", f"등록원부 API HTTP {response.status_code}")
    try:
        # response.text guesses the charset wrong for this API; the body is UTF-8 (sometimes with a BOM).
        data = json.loads(response.content.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError):
        # Key errors come back as XML.
        raise RegisterError("failed", "등록원부 API가 JSON이 아닌 응답을 반환했습니다.") from None
    if data.get("resultCode") == "001":
        raise RegisterError("not_found", "등록원부에 해당 등록번호가 없습니다.")
    if data.get("resultCode") != "000" or not isinstance(data.get("items"), dict):
        raise RegisterError("failed", f"등록원부 조회 실패: {data.get('resultCode')} {data.get('resultMsg')}")
    return data["items"]


def day(value):
    value = str(value or "")
    return f"{value[:4]}-{value[4:6]}-{value[6:8]}" if re.fullmatch(r"\d{8}", value) else None


def rows(items, **fields):
    """API 배열을 {새 이름: 값}으로 옮기고, 모든 값이 null인 자리채움 행은 버린다."""
    out = []
    for item in items if isinstance(items, list) else []:
        row = {name: (day(item.get(key)) if name.endswith("At") else item.get(key)) for name, key in fields.items()} \
            if isinstance(item, dict) else {}
        if any(value not in (None, "") for value in row.values()):
            out.append(row)
    return out


def summarize(items):
    # Addresses and resident/inventor details stay out; the register is public, but the screen needs only rights.
    owners = rows(items.get("owner"), name="ownerName", cause="ownerRgstCsName", changedAt="ownerRgstCsDate", current="finalOwnerYn")
    licence = lambda prefix: dict(licensee=prefix + "PsnNm", cause=prefix + "RgstCsNm", region=prefix + "RgnLcns",
                                  scope=prefix + "ContLcns", startAt=prefix + "StartDate", endAt=prefix + "EndDate")
    appl_no = str(items.get("applNo") or "")
    rights = rows(items.get("right"), cause="rgstCsName", changedAt="rgstCsDate", reason="rgstCsReason", purpose="rgstCsPupos")
    # lastDspst stays "등록결정" after a lapse (e.g. 10-1561775, 등록료불납); the rights history is what tells.
    lapsed = None
    for right in rights:
        if "소멸" in (right["cause"] or ""):
            lapsed = right
        elif "회복" in (right["cause"] or ""):
            lapsed = None
    return {
        "title": items.get("title"),
        "applicationNumber": f"{appl_no[:2]}-{appl_no[2:6]}-{appl_no[6:]}" if len(appl_no) == 13 else appl_no or None,
        "appliedAt": day(items.get("applDate")),
        "registeredAt": day(items.get("rgstDate")),
        "expiresAt": day(items.get("cndrtExptnDate")),
        "lastDisposition": items.get("lastDspst"),
        "claimCount": items.get("claimCount"),
        "currentOwners": [o["name"] for o in owners if o["current"] == "Y" and o["name"]],
        "owners": owners,
        "applicants": [a["name"] for a in rows(items.get("applicant"), name="applicantName") if a["name"]],
        "rights": rights,
        "lapsedAt": lapsed and lapsed["changedAt"],
        "lapseReason": lapsed and lapsed["reason"],
        "annuities": rows(items.get("pay"), fromYear="statAnnl", toYear="lastAnnl", paidAt="payDate", amount="payAmount"),
        "exclusiveLicenses": rows(items.get("elsLcnsList"), **licence("elsLcns")),
        "nonExclusiveLicenses": rows(items.get("noelsLcnsList"), **licence("noelsLcns")),
    }


def company_key(name):
    return re.sub(r"주식회사|\(주\)|㈜|\s", "", name or "")


def collect(number, company=None):
    """등록번호로 등록원부를 조회해 저장할 기록을 만든다. 예외를 던지지 않는다."""
    record = {"registrationNumber": number, "collectedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    rgst_no = normalize(number)
    if not rgst_no:
        return {**record, "status": "no_number", "message": "특허 등록번호를 확인하지 못했습니다."}
    try:
        summary = summarize(fetch(rgst_no))
    except RegisterError as exc:
        return {**record, "status": exc.status, "message": str(exc)}
    if company and summary["currentOwners"]:
        summary["ownerMatch"] = company_key(company) in {company_key(owner) for owner in summary["currentOwners"]}
    if summary["lapsedAt"]:
        reason = f" · {summary['lapseReason']}" if summary["lapseReason"] else ""
        summary["message"] = f"소멸된 특허는 신청할 수 없습니다 ({summary['lapsedAt']} 소멸등록{reason})."
    return {**record, "status": "collected", **summary}
