"""특허평가 API 1.0 클라이언트. 인증은 서버에서만 처리한다."""

from __future__ import annotations

import json
from http.client import HTTPException
import os
import re
import shutil
import socket
import tempfile
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


def _local_settings():
    settings = {}
    path = Path(__file__).with_name(".env")
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            key, sep, value = line.strip().partition("=")
            if sep and key.startswith("IPLOAN_PATENT_"):
                settings[key] = value.strip().strip("\"'")
    return settings


LOCAL_SETTINGS = _local_settings()


def setting(name, default=""):
    return os.environ.get(name, LOCAL_SETTINGS.get(name, default))


class PatentAPIError(Exception):
    def __init__(self, message, status=502, detail=None, retry_after=None, uncertain=False):
        super().__init__(message)
        self.status = status
        self.detail = detail
        self.retry_after = retry_after
        self.uncertain = uncertain


class NoRedirect(HTTPRedirectHandler):
    # 다른 호스트로 인증 헤더가 전달되는 리다이렉트를 허용하지 않는다.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class PatentAPI:
    statuses = {"awaiting_identity", "queued", "running", "completed", "failed"}
    kinds = {"pdf", "html", "quality", "trace", "timing", "log"}

    def __init__(self):
        self.base = setting("IPLOAN_PATENT_API_URL", "http://203.252.147.200:20024").rstrip("/")
        self.token = setting("IPLOAN_PATENT_API_TOKEN")
        self.opener = build_opener(NoRedirect())

    @property
    def configured(self):
        parsed = urlsplit(self.base)
        return bool(self.token and parsed.scheme in {"http", "https"} and parsed.netloc
                    and not parsed.username and not parsed.password)

    def _open(self, path, *, data=None, headers=None, timeout=30):
        if not self.configured:
            raise PatentAPIError("보고서 서비스 연결 설정이 필요합니다. 운영 담당자에게 문의해 주세요.", 503)
        req = Request(self.base + path, data=data, headers={
            "Authorization": self.token, **(headers or {}),
        })
        try:
            return self.opener.open(req, timeout=timeout)
        except HTTPError as exc:
            raw = exc.read(64 * 1024).decode("utf-8", errors="replace")
            try:
                detail = json.loads(raw).get("detail", raw)
            except (ValueError, AttributeError):
                detail = raw
            # 공급자 응답에 인증정보가 포함되어도 공개 응답으로 전달하지 않는다.
            detail = json.loads(json.dumps(detail, ensure_ascii=False).replace(self.token, "[redacted]"))
            messages = {
                401: "보고서 서비스 인증을 확인해 주세요. 운영 담당자에게 문의해 주세요.",
                404: "요청한 작업 또는 보고서를 찾을 수 없습니다.",
                409: "현재 작업 상태에서는 요청을 처리할 수 없습니다. 상태를 확인해 주세요.",
                413: "첨부 파일은 50MiB 이하여야 합니다.",
                415: "특허 공고전문 PDF 파일을 첨부해 주세요.",
                422: "사업자번호 또는 첨부 파일을 확인해 주세요.",
                429: "보고서 생성 요청이 많습니다. 잠시 후 다시 접수해 주세요.",
            }
            retry = exc.headers.get("Retry-After", "")
            retry = int(retry) if retry.isdigit() else (60 if exc.code == 429 else None)
            raise PatentAPIError(messages.get(exc.code, "보고서 서비스에서 오류가 발생했습니다."),
                                 exc.code if exc.code in messages else 502,
                                 detail=detail, retry_after=retry,
                                 uncertain=data is not None and not 400 <= exc.code < 500) from None
        except (URLError, TimeoutError, socket.timeout, OSError, HTTPException):
            raise PatentAPIError("보고서 서비스에 연결하지 못했습니다. 저장된 신청의 상태를 확인해 주세요.",
                                 502, uncertain=data is not None) from None

    def _job(self, response):
        try:
            with response:
                result = json.load(response)
            if (not isinstance(result, dict) or not isinstance(result.get("job_id"), str)
                    or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", result["job_id"])
                    or result.get("status") not in self.statuses):
                raise ValueError
            return result
        except (ValueError, TypeError, OSError, HTTPException):
            raise PatentAPIError("보고서 서비스의 접수·상태 응답을 확인할 수 없습니다.", uncertain=True) from None

    def submit(self, path, filename, business_number):
        boundary = "iploan-" + uuid.uuid4().hex
        # 50MiB PDF를 메모리에 복사하지 않고 임시 파일에서 전송한다.
        with tempfile.TemporaryFile() as body:
            body.write((f"--{boundary}\r\nContent-Disposition: form-data; name=\"business_number\"\r\n\r\n"
                        f"{business_number}\r\n--{boundary}\r\n"
                        "Content-Disposition: form-data; name=\"patent_pdf\"; filename=\"patent.pdf\"\r\n"
                        "Content-Type: application/pdf\r\n\r\n").encode())
            with Path(path).open("rb") as source:
                shutil.copyfileobj(source, body)
            body.write(f"\r\n--{boundary}--\r\n".encode())
            size = body.tell()
            body.seek(0)
            return self._job(self._open("/v1/evaluations", data=body, headers={
                "Content-Type": f"multipart/form-data; boundary={boundary}", "Content-Length": str(size),
            }, timeout=60))

    def status(self, job_id):
        result = self._job(self._open("/v1/evaluations/" + quote(job_id, safe="")))
        if result["job_id"] != job_id:
            raise PatentAPIError("보고서 서비스가 다른 작업번호를 반환했습니다.")
        return result

    def identify(self, job_id, business_number):
        result = self._job(self._open("/v1/evaluations/" + quote(job_id, safe="") + "/identity",
                                    data=urlencode({"business_number": business_number}).encode(),
                                    headers={"Content-Type": "application/x-www-form-urlencoded"}, timeout=60))
        if result["job_id"] != job_id:
            raise PatentAPIError("보고서 서비스가 다른 작업번호를 반환했습니다.", uncertain=True)
        return result

    def artifact(self, job_id, kind):
        if kind not in self.kinds:
            raise PatentAPIError("지원하지 않는 보고서 형식입니다.", 404)
        return self._open("/v1/evaluations/" + quote(job_id, safe="") + "/artifacts/" + kind, timeout=60)


patent_api = PatentAPI()
