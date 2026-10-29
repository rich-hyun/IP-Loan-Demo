"""특허 공고전문(또는 등록원부) PDF 앞부분에서 신청서에 채울 항목을 읽는다: IP 유형, 명칭, 출원번호.

KIPO 공보의 서지 항목 번호를 기준으로 한다: (12) 공보 종류, (21) 출원번호, (54) 발명·고안의 명칭.
읽지 못한 항목은 돌려주지 않는다. 신청자가 확인·수정하는 입력 보조이며 서버에 저장하지 않는다.
"""
import logging
import re
from io import BytesIO

try:
    from pypdf import PdfReader
except ImportError:  # 자동 채우기는 입력 보조라서 pypdf가 없는 서버에서는 비워 둔다.
    PdfReader = None

logging.getLogger("pypdf").setLevel(logging.ERROR)  # a damaged upload is not a server problem

PAGES = 2
KINDS = (("실용신안", "실용신안권"), ("상표", "상표권"), ("특허", "특허권"))
NUMBER = r"\d{2}-\d{4}-\d{7}"


def read_text(pdf):
    """앞 PAGES쪽의 텍스트. pypdf가 없거나 읽지 못하면 빈 문자열."""
    if PdfReader is None:
        return ""
    try:
        reader = PdfReader(BytesIO(pdf))
        return "\n".join(page.extract_text() or "" for page in reader.pages[:PAGES])
    except Exception:
        return ""


def read_fields(pdf):
    return parse_fields(read_text(pdf))


def parse_fields(text):
    fields = {}
    kind = re.search(r"\(12\)\s*[^\n]*?공보", text) or re.search(r"(?:특허|실용신안|상표)\s*등록\s*원부", text)
    if kind:
        fields["ipType"] = next((label for word, label in KINDS if word in kind.group(0)), None)
    # A gazette title may wrap until the next numbered field; elsewhere (e.g. a registry) the title is one line.
    title = re.search(r"\(54\)\s*(?:발명|고안)의\s*명칭\s*[:：]?\s*(.+?)(?=\n\s*\(\d{2}\)|\n\s*요\s*약|$)", text, re.S) \
        or re.search(r"(?:발명|고안)의\s*명칭\s*[:：]?\s*([^\n]+)", text)
    if title:
        fields["ipTitle"] = " ".join(title.group(1).split())[:200]
    number = re.search(r"\(21\)\s*출원번호\s*(" + NUMBER + ")", text) or re.search(r"출원번호\s*[:：]?\s*(?:제\s*)?(" + NUMBER + ")", text)
    if number:
        fields["ipRegNo"] = number.group(1)
    return {key: value for key, value in fields.items() if value}
