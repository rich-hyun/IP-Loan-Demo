"""실제 서버를 임시 DB에서 검사. 외부 평가 생성 요청은 전부 mock 처리한다."""

import io
import json
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError

_import_tmp = tempfile.TemporaryDirectory(prefix="iploan-import-test-")
os.environ.setdefault("IPLOAN_PATENT_DB_PATH", str(Path(_import_tmp.name) / "import.db"))
os.environ.setdefault("IPLOAN_PATENT_UPLOAD_DIR", str(Path(_import_tmp.name) / "uploads"))

import patent_app as server
from patent_api import PatentAPI, PatentAPIError

PDF = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n"


def job(status="queued", artifacts=None, **extra):
    return {"job_id": "job-test-123", "status": status, "business_number": "1234567890",
            "artifacts": artifacts or {}, **extra}


class EvaluationFlowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="iploan-flow-")
        self.addCleanup(self.tmp.cleanup)
        for name, value in [("DB_PATH", Path(self.tmp.name) / "test.db"),
                            ("UPLOAD_DIR", Path(self.tmp.name) / "uploads")]:
            patcher = patch.object(server, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        token = patch.object(server.patent_api, "token", "unit-test-token")
        token.start()
        self.addCleanup(token.stop)
        server.init_db()
        self.client = server.app.test_client()

    def submit(self, response=None, **fields):
        with patch.object(server.patent_api, "submit", return_value=response or job()) as upstream:
            res = self.client.post("/api/applications", data={
                "bizNo": "123-45-67890", "request_id": "request-test-12345678",
                "patent_pdf": (io.BytesIO(PDF), "평가할특허.pdf"), **fields,
            })
        self.assertEqual(201, res.status_code, res.get_data(as_text=True))
        return res.json, upstream

    def set_last_check(self, app_id):
        with server.app.app_context():
            db = server.get_db()
            db.execute("UPDATE evaluation_jobs SET lastCheckedAt=? WHERE appId=?",
                       ((datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat(), app_id))
            db.commit()

    def test_minimal_business_and_pdf_submit_persist_and_restart(self):
        record, upstream = self.submit()
        self.assertEqual("123-45-67890", record["bizNo"])
        self.assertEqual("평가할특허", record["ipTitle"])
        self.assertEqual(0, record["amount"])
        self.assertEqual("queued", record["evaluation"]["status"])
        self.assertEqual("evaluating", record["status"])
        self.assertTrue(record["docFileHash"].startswith("0x"))
        self.assertEqual("1234567890", upstream.call_args.args[2])
        self.assertEqual(PDF, upstream.call_args.args[0].read_bytes())
        server.init_db()
        saved = next(a for a in self.client.get("/api/applications").json if a["id"] == record["id"])
        self.assertEqual("job-test-123", saved["evaluation"]["job_id"])
        self.assertNotIn("unit-test-token", json.dumps(saved))

    def test_duplicate_local_request_does_not_resubmit(self):
        record, _ = self.submit()
        with patch.object(server.patent_api, "submit") as upstream:
            repeated = self.client.post("/api/applications", data={
                "bizNo": "1234567890", "request_id": "request-test-12345678",
                "patent_pdf": (io.BytesIO(PDF), "same.pdf"),
            })
        self.assertEqual(200, repeated.status_code)
        self.assertEqual(record["id"], repeated.json["id"])
        upstream.assert_not_called()

    def test_known_company_is_preserved_for_minimal_submission(self):
        before = next(a for a in self.client.get('/api/applications').json if a['bizNo'] == '220-87-30984')
        record, _ = self.submit(bizNo='2208730984')
        self.assertEqual('에너지테크(주)', record['company'])
        self.assertEqual(before['borrowerProfileId'], record['borrowerProfileId'])

    def test_post_acceptance_save_error_keeps_application_and_pdf(self):
        for index, failure in enumerate([ValueError('malformed accepted data'), sqlite3.IntegrityError('save failure')]):
            with patch.object(server, 'save_job', side_effect=failure), patch.object(server.patent_api, 'submit', return_value=job()):
                res = self.client.post('/api/applications', data={
                    'bizNo': '1234567890', 'request_id': f'request-save-failure-{index}',
                    'patent_pdf': (io.BytesIO(PDF), 'patent.pdf'),
                })
            self.assertEqual(201, res.status_code)
            self.assertEqual('submitting', res.json['evaluation']['status'])
        self.assertEqual(2, len(list(server.UPLOAD_DIR.glob('*.pdf'))))

    def test_validation_prevents_external_request(self):
        with patch.object(server.patent_api, "submit") as upstream:
            for number, content, filename in [("123", PDF, "patent.pdf"),
                                                ("1234567890", b"not a PDF", "patent.pdf"),
                                                ("1234567890", PDF, "patent.png")]:
                res = self.client.post("/api/applications", data={
                    "bizNo": number, "patent_pdf": (io.BytesIO(content), filename),
                })
                self.assertEqual(400, res.status_code)
            upstream.assert_not_called()

    def test_missing_server_credentials(self):
        with patch.object(server.patent_api, "token", ""):
            res = self.client.post("/api/applications", data={
                "bizNo": "1234567890", "patent_pdf": (io.BytesIO(PDF), "patent.pdf"),
            })
        self.assertEqual(503, res.status_code)

    def test_poll_rate_limit_and_completed_html_only(self):
        record, _ = self.submit()
        path = f"/api/applications/{record['id']}/evaluation"
        with patch.object(server.patent_api, "status", return_value=job("completed", {"html": "/html", "quality": "/quality"})) as upstream:
            self.client.get(path)
            upstream.assert_not_called()
            self.set_last_check(record["id"])
            completed = self.client.get(path).json
            self.assertEqual("report_ready", completed["status"])
            self.assertNotIn("pdf", completed["evaluation"]["artifacts"])
            self.client.get(path)
            self.assertEqual(1, upstream.call_count)

    def test_identity_reuses_job_and_preserved_pdf(self):
        record, _ = self.submit(job("awaiting_identity", identity_message="기업 번호 입력"))
        with patch.object(server.patent_api, "identify", return_value=job()) as identity, patch.object(server.patent_api, "submit") as submit:
            res = self.client.post(f"/api/applications/{record['id']}/evaluation/identity",
                                   json={"business_number": "123-45-67890"})
            self.assertEqual(200, res.status_code)
            identity.assert_called_once_with("job-test-123", "1234567890")
            submit.assert_not_called()
            self.assertEqual("queued", res.json["evaluation"]["status"])

    def test_transient_poll_error_does_not_fail_job(self):
        record, _ = self.submit()
        self.set_last_check(record["id"])
        with patch.object(server.patent_api, "status", side_effect=PatentAPIError("일시 연결 오류")):
            res = self.client.get(f"/api/applications/{record['id']}/evaluation")
        self.assertEqual("queued", res.json["evaluation"]["status"])
        self.assertEqual("일시 연결 오류", res.json["evaluation"]["read_error"])

    def test_identity_correction_preserves_known_company_name(self):
        record, _ = self.submit(job('awaiting_identity'))
        with patch.object(server.patent_api, 'identify', return_value=job(business_number='2208730984')):
            res = self.client.post(f"/api/applications/{record['id']}/evaluation/identity", json={'business_number': '220-87-30984'})
        self.assertEqual(200, res.status_code)
        self.assertEqual('에너지테크(주)', res.json['company'])
        profiles = self.client.get('/api/borrower-profiles').json
        self.assertEqual('에너지테크(주)', next(p for p in profiles if p['id'] == res.json['borrowerProfileId'])['company'])

    def test_uncertain_submission_blocks_resubmit(self):
        with patch.object(server.patent_api, "submit", side_effect=PatentAPIError("연결 끊김", uncertain=True)):
            response = self.client.post("/api/applications", data={
                "bizNo": "1234567890", "patent_pdf": (io.BytesIO(PDF), "patent.pdf"),
            })
        self.assertEqual(201, response.status_code)
        self.assertEqual("submission_unknown", response.json["evaluation"]["status"])
        self.assertEqual(409, self.client.post(f"/api/applications/{response.json['id']}/evaluation").status_code)
        self.assertEqual(1, len(list(server.UPLOAD_DIR.glob("*.pdf"))))

    def test_queue_full_keeps_pdf_and_honors_retry_after(self):
        with patch.object(server.patent_api, "submit", side_effect=PatentAPIError("대기열 가득 참", 429, retry_after=60)):
            res = self.client.post("/api/applications", data={
                "bizNo": "1234567890", "patent_pdf": (io.BytesIO(PDF), "patent.pdf"),
            })
        self.assertEqual("submission_rejected", res.json["evaluation"]["status"])
        retry = self.client.post(f"/api/applications/{res.json['id']}/evaluation")
        self.assertEqual(429, retry.status_code)
        self.assertIn("Retry-After", retry.headers)
        self.assertEqual(1, len(list(server.UPLOAD_DIR.glob("*.pdf"))))

    def test_known_rejection_retries_existing_request(self):
        with patch.object(server.patent_api, "submit", side_effect=PatentAPIError("입력 확인", 422)):
            rejected = self.client.post("/api/applications", data={
                "bizNo": "1234567890", "patent_pdf": (io.BytesIO(PDF), "patent.pdf"),
            }).json
        with patch.object(server.patent_api, "submit", return_value=job()) as upstream:
            retried = self.client.post(f"/api/applications/{rejected['id']}/evaluation")
        self.assertEqual(200, retried.status_code)
        self.assertEqual(rejected["id"], retried.json["id"])
        upstream.assert_called_once()
        self.assertEqual(1, len(list(server.UPLOAD_DIR.glob("*.pdf"))))

    def test_artifact_proxy_and_html_sandbox(self):
        record, _ = self.submit(job("completed", {"html": "http://untrusted.example/report", "quality": "/quality"}))
        path = f"/api/applications/{record['id']}/evaluation/artifacts"
        with patch.object(server.patent_api, "artifact", return_value=io.BytesIO(b"<h1>report</h1>")) as upstream:
            html = self.client.get(path + "/html")
            self.assertEqual(b"<h1>report</h1>", html.data)
            self.assertIn("sandbox", html.headers["Content-Security-Policy"])
            upstream.assert_called_once_with("job-test-123", "html")
        self.assertEqual(404, self.client.get(path + "/pdf").status_code)
        self.assertEqual(404, self.client.get(path + "/unknown").status_code)

    def test_cannot_confirm_or_patch_before_report(self):
        record, _ = self.submit()
        base = f"/api/applications/{record['id']}"
        res = self.client.post(base + "/evaluation/confirm", json={"appraisedValue": 100000000, "creditScore": 80})
        self.assertEqual(409, res.status_code)
        self.assertEqual(409, self.client.patch(base, json={"appraisedValue": 1, "status": "approved"}).status_code)

    def test_evaluator_confirmation_and_loan_handoff(self):
        record, _ = self.submit(job("completed", {"pdf": "/pdf"}), amount="50000000")
        base = f"/api/applications/{record['id']}"
        payload = {"appraisedValue": 100000000, "creditScore": 80, "reviewerNote": "근거자료 확인"}
        res = self.client.post(base + "/evaluation/confirm", json=payload)
        self.assertEqual(200, res.status_code)
        self.assertEqual("review", res.json["status"])
        self.assertEqual(50, res.json["ltv"])
        self.assertEqual("근거자료 확인", res.json["evaluation"]["reviewer_note"])
        self.assertTrue(res.json["evaluation"]["confirmed_at"])
        self.assertEqual(409, self.client.post(base + "/evaluation/confirm", json=payload).status_code)
        self.assertEqual(200, self.client.patch(base, json={"status": "approved"}).status_code)

    def test_evaluation_without_loan_amount(self):
        record, _ = self.submit(job("completed", {"html": "/html"}))
        res = self.client.post(f"/api/applications/{record['id']}/evaluation/confirm",
                               json={"appraisedValue": 100000000, "creditScore": 80})
        self.assertEqual("evaluated", res.json["status"])
        self.assertNotIn("ltv", res.json)
        self.assertEqual(409, self.client.patch(f"/api/applications/{record['id']}", json={'status': 'approved'}).status_code)

    def test_confirmation_input_validation(self):
        record, _ = self.submit(job("completed", {"pdf": "/pdf"}))
        path = f"/api/applications/{record['id']}/evaluation/confirm"
        for value, credit in [(0, 80), (True, 80), (10000, 101), (10000, -1), (10000, 80.5)]:
            self.assertEqual(400, self.client.post(path, json={"appraisedValue": value, "creditScore": credit}).status_code)

    def test_static_routes_do_not_expose_database_or_credentials(self):
        for path in ["/", "/js/evaluations.js", "/css/style.css"]:
            res = self.client.get(path)
            self.assertEqual(200, res.status_code)
            res.close()
        for path in ["/server/.env", "/server/iploan.db", "/js/../server/.env"]:
            self.assertEqual(404, self.client.get(path).status_code)


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
