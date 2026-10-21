"""Patent report API client: transport, authorization and error handling. No network calls."""

import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock
from urllib.error import HTTPError, URLError

from server.patent_api import PatentAPI, PatentAPIError

PDF = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n"


def job(status="queued", artifacts=None, **extra):
    return {"job_id": "job-test-123", "status": status, "business_number": "1234567890",
            "artifacts": artifacts or {}, **extra}


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.api = PatentAPI()
        self.api.base = "http://patent.test"
        self.api.token = "transport-token"

    def test_streaming_multipart_and_raw_authorization(self):
        seen = {}
        def open_request(req, timeout):
            seen["headers"] = dict(req.header_items())
            seen["body"] = req.data.read()
            seen["url"] = req.full_url
            return io.BytesIO(json.dumps(job()).encode())
        self.api.opener = Mock(open=open_request)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "patent.pdf"
            path.write_bytes(PDF)
            result = self.api.submit(path, "특허.pdf", "1234567890")
        self.assertEqual("queued", result["status"])
        self.assertEqual("transport-token", seen["headers"]["Authorization"])
        self.assertEqual(len(seen["body"]), int(seen["headers"]["Content-length"]))
        self.assertIn(b'name="patent_pdf"', seen["body"])
        self.assertIn(b'name="business_number"', seen["body"])
        self.assertIn(PDF, seen["body"])

    def test_http_error_details_and_token_redaction(self):
        exception = HTTPError("http://patent.test", 422, "validation", {},
                              io.BytesIO(b'{"detail":[{"msg":"transport-token invalid"}]}'))
        self.api.opener.open = Mock(side_effect=exception)
        with self.assertRaises(PatentAPIError) as raised:
            self.api.status("job-test-123")
        self.assertEqual(422, raised.exception.status)
        self.assertNotIn("transport-token", json.dumps(raised.exception.detail))

    def test_post_connection_failure_is_uncertain(self):
        self.api.opener.open = Mock(side_effect=URLError("timeout"))
        with self.assertRaises(PatentAPIError) as raised:
            self.api.identify("job-test-123", "1234567890")
        self.assertTrue(raised.exception.uncertain)


if __name__ == "__main__":
    unittest.main(verbosity=2)
