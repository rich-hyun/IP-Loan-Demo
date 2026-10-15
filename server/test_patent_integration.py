"""기존 대출 API와 특허평가 API의 경로·DB·구버전 마이그레이션을 검사한다."""

import io
import os
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

_tmp = tempfile.TemporaryDirectory(prefix="iploan-integration-test-")
os.environ["IPLOAN_DB_PATH"] = str(Path(_tmp.name) / "loans.db")
os.environ["IPLOAN_PATENT_DB_PATH"] = str(Path(_tmp.name) / "patents.db")
os.environ["IPLOAN_PATENT_UPLOAD_DIR"] = str(Path(_tmp.name) / "uploads")

from server import app as native


class PatentIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.client = native.app.test_client()

    def test_existing_and_mounted_health(self):
        self.assertEqual("ok", self.client.get("/api/health").json["status"])
        report = self.client.get("/api/patent/health")
        self.assertEqual(200, report.status_code)
        self.assertIn("evaluationConfigured", report.json)
        with patch.dict(os.environ, {"IPLOAN_ENABLE_RESET": "0"}):
            self.assertEqual(403, self.client.post("/api/reset").status_code)

    def test_report_submission_and_artifact_do_not_change_loan_records(self):
        before = self.client.get("/api/applications").json
        job = {"job_id": "integration-job", "status": "completed", "artifacts": {"html": "/html"}}
        with patch.object(native.patent_app.patent_api, "token", "integration-token"), \
             patch.object(native.patent_app.patent_api, "submit", return_value=job):
            response = self.client.post("/api/patent/applications", data={
                "bizNo": "1234567890", "patent_pdf": (io.BytesIO(b"%PDF-1.4\n%%EOF"), "patent.pdf"),
            })
        self.assertEqual(201, response.status_code, response.get_data(as_text=True))
        url = response.json["evaluation"]["artifacts"]["html"]
        self.assertTrue(url.startswith("/api/patent/applications/"), url)
        with patch.object(native.patent_app.patent_api, "artifact", return_value=io.BytesIO(b"<h1>report</h1>")):
            self.assertEqual(b"<h1>report</h1>", self.client.get(url).data)
        self.assertEqual(before, self.client.get("/api/applications").json)

    def test_old_created_at_profile_schema_is_preserved(self):
        with tempfile.TemporaryDirectory(prefix="iploan-legacy-schema-") as folder:
            db_path = str(Path(folder) / "legacy.db")
            with sqlite3.connect(db_path) as conn:
                conn.execute(native.SCHEMA)
                conn.execute("""CREATE TABLE borrower_profiles (
                    id TEXT PRIMARY KEY,company TEXT NOT NULL,bizNo TEXT,ceo TEXT,contact TEXT,
                    createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL)""")
                conn.execute("INSERT INTO applications (id,company,bizNo) VALUES ('old','기존 기업','1234567890')")
            with patch.object(native, "DB_PATH", db_path):
                native.init_db()
                new = self.client.post("/api/borrower-profiles", json={"company": "새 기업"})
                self.assertEqual(201, new.status_code, new.get_data(as_text=True))
            with sqlite3.connect(db_path) as conn:
                self.assertEqual(1, conn.execute("SELECT COUNT(*) FROM applications").fetchone()[0])
                self.assertEqual(2, conn.execute("SELECT COUNT(*) FROM borrower_profiles WHERE createdAt IS NOT NULL").fetchone()[0])

    def test_worker_migrations_are_serialized(self):
        with tempfile.TemporaryDirectory(prefix="iploan-worker-migration-") as folder:
            db_path = str(Path(folder) / "workers.db")
            with patch.object(native, "DB_PATH", db_path), ThreadPoolExecutor(max_workers=2) as pool:
                list(pool.map(lambda _: native.init_db(), range(2)))
            with sqlite3.connect(db_path) as conn:
                self.assertEqual(8, conn.execute("SELECT COUNT(*) FROM applications").fetchone()[0])


if __name__ == "__main__":
    unittest.main()
