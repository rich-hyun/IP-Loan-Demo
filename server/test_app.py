"""v3 API on a temporary DB: wallet login, per-application access, the merged LLM report flow and migrations.
The chain, the patent report service and IPFS are mocked; blockchain/test runs the same API against a real EVM."""
import base64
import hashlib
import io
import json
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from eth_account import Account
from eth_account.messages import encode_defunct

TEST_DIR = tempfile.TemporaryDirectory()
MANAGER = "0x6D1004CB292e3ec45A4c4A0834C0eedAAbe16E38"
os.environ.update({
    "IPLOAN_DB_PATH": os.path.join(TEST_DIR.name, "import.db"),
    "IPLOAN_PATENT_DB_PATH": os.path.join(TEST_DIR.name, "no-archive.db"),
    "IPLOAN_UPLOAD_DIR": os.path.join(TEST_DIR.name, "import-uploads"),
    "IPLOAN_MANAGER_ADDRESS": MANAGER,
    "IPLOAN_ROLE_CACHE_SECONDS": "0",
})

from server import app as app_module  # noqa: E402

REGISTRY = b"%PDF-1.7\nsecret registry document"
PATENT = b"%PDF-1.4\npublished patent gazette"
REPORT = b"%PDF-1.7\nLLM valuation report"
WALLETS = {name: Account.create() for name in ("borrower", "borrower2", "evaluator", "bank", "admin", "outsider")}
ROLES = {"borrower": ["borrower"], "borrower2": ["borrower"], "evaluator": ["evaluator"], "bank": ["bank"],
         "admin": ["admin"], "outsider": []}
ADDRESS = {name: account.address for name, account in WALLETS.items()}


def job(status="queued", artifacts=None, **extra):
    return {"job_id": "job-test-123", "status": status, "business_number": "1234567890",
            "artifacts": artifacts or {}, **extra}


class V3ApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        folder = Path(self.tmp.name)
        self.roles = {ADDRESS[name]: roles for name, roles in ROLES.items()}
        self.ipfs = {}
        self.stage = {"chainStatus": "None", "chainBlock": 1}
        self.bank_role = True
        patches = [
            patch.object(app_module, "DB_PATH", str(folder / "iploan.db")),
            patch.object(app_module, "UPLOAD_DIR", folder / "uploads"),
            patch.object(app_module, "PATENT_ARCHIVE_DB_PATH", folder / "patent-iploan.db"),
            patch.object(app_module.patent_api, "token", "unit-test-token"),
            patch.object(app_module.patent_api, "submit", return_value=job()),
            patch.object(app_module.chain, "roles", side_effect=lambda wallet: self.roles.get(wallet, [])),
            patch.object(app_module.chain, "config", side_effect=self.chain_config),
            patch.object(app_module.chain, "snapshot", side_effect=lambda application: dict(self.stage)),
            patch.object(app_module.chain, "has_role", side_effect=lambda wallet, role: self.has_role(wallet, role)),
            patch.object(app_module, "upload_ipfs_payload", side_effect=self.upload),
            patch.object(app_module, "fetch_ipfs", side_effect=lambda cid, limit: self.ipfs[cid]),
        ]
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)
        app_module.init_db()
        app_module.app.config.update(TESTING=True)
        self.client = app_module.app.test_client()
        self.tokens = {}

    def chain_config(self):
        return {"enabled": True, "managerAddress": MANAGER, "chainId": 7601,
                "roleMembers": {"BORROWER_ROLE": [ADDRESS["borrower"], ADDRESS["borrower2"]],
                                "EVALUATOR_ROLE": [ADDRESS["evaluator"]], "BANK_ROLE": [ADDRESS["bank"]]}}

    def has_role(self, wallet, role):
        return {"EVALUATOR_ROLE": "evaluator", "BANK_ROLE": "bank"}[role] in self.roles.get(wallet, []) and (
            role != "BANK_ROLE" or self.bank_role)

    def upload(self, payload, filename, content_type):
        cid = "bafy" + hashlib.sha256(payload).hexdigest()[:40]
        self.ipfs[cid] = payload
        return {"cid": cid, "ipfs": "ipfs://" + cid}

    def login(self, name):
        if name not in self.tokens:
            challenge = self.client.post("/api/auth/challenge", json={"address": ADDRESS[name]}).get_json()
            signature = Account.sign_message(encode_defunct(text=challenge["message"]), WALLETS[name].key).signature.to_0x_hex()
            response = self.client.post("/api/auth/login", json={"address": ADDRESS[name], "nonce": challenge["nonce"],
                                                                 "signature": signature})
            self.assertEqual(200, response.status_code, response.get_json())
            self.tokens[name] = response.get_json()["token"]
        return {"Authorization": "Bearer " + self.tokens[name]}

    def get(self, path, who):
        return self.client.get("/api" + path, headers=self.login(who))

    def post(self, path, who, **kwargs):
        return self.client.post("/api" + path, headers=self.login(who), **kwargs)

    def form(self, **extra):
        return {"company": "테스트 주식회사", "bizNo": "123-45-67890", "ceo": "홍길동", "contact": "010-1234-5678",
                "ipType": "특허권", "ipTitle": "암호화 업로드 특허", "ipRegNo": "10-2026-0000001",
                "amount": "70", "termMonths": "24",
                "registryDocument": (io.BytesIO(REGISTRY), "특허등록원부.pdf"),
                "patentDocument": (io.BytesIO(PATENT), "공고전문.pdf"), **extra}

    def apply(self, who="borrower", **extra):
        response = self.post("/applications", who, data=self.form(**extra), content_type="multipart/form-data")
        self.assertEqual(201, response.status_code, response.get_json())
        return response.get_json()

    def complete_job(self, app_id, artifacts=("pdf", "html")):
        with sqlite3.connect(app_module.DB_PATH) as conn:
            conn.execute("UPDATE evaluation_jobs SET status='completed', jobId='job-test-123', artifacts=? WHERE appId=?",
                         (json.dumps({kind: f"/v1/{kind}" for kind in artifacts}), app_id))

    def prepare(self, app_id, value=100, who="evaluator", note="근거 확인"):
        with patch.object(app_module.patent_api, "artifact", side_effect=lambda job_id, kind: io.BytesIO(REPORT)) as artifact:
            response = self.post(f"/applications/{app_id}/evaluation-report", who, json={"appraisedValue": value, "note": note})
        return response, artifact

    def row(self, app_id):
        with sqlite3.connect(app_module.DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            return dict(conn.execute("SELECT * FROM applications WHERE id = ?", (app_id,)).fetchone())

    # ------------------------------------------------------------ 로그인

    def test_login_with_wallet_signature_and_session_lifecycle(self):
        headers = self.login("evaluator")
        me = self.client.get("/api/auth/me", headers=headers).get_json()
        self.assertEqual({"address": ADDRESS["evaluator"], "roles": ["evaluator"]}, me)
        self.assertEqual(200, self.client.post("/api/auth/logout", headers=headers).status_code)
        self.assertEqual(401, self.client.get("/api/auth/me", headers=headers).status_code)

    def test_challenge_is_single_use_signed_by_same_wallet_and_expires(self):
        challenge = self.client.post("/api/auth/challenge", json={"address": ADDRESS["bank"]}).get_json()
        self.assertIn(ADDRESS["bank"], challenge["message"])
        sign = lambda name: Account.sign_message(encode_defunct(text=challenge["message"]), WALLETS[name].key).signature.to_0x_hex()
        login = lambda signature: self.client.post("/api/auth/login", json={
            "address": ADDRESS["bank"], "nonce": challenge["nonce"], "signature": signature})
        self.assertEqual(401, login(sign("outsider")).status_code)  # wrong signer consumes the challenge
        self.assertEqual(401, login(sign("bank")).status_code)
        expired = self.client.post("/api/auth/challenge", json={"address": ADDRESS["bank"]}).get_json()
        with sqlite3.connect(app_module.DB_PATH) as conn:
            conn.execute("UPDATE auth_challenges SET expiresAt = '2000-01-01T00:00:00Z'")
        signature = Account.sign_message(encode_defunct(text=expired["message"]), WALLETS["bank"].key).signature.to_0x_hex()
        self.assertEqual(401, self.client.post("/api/auth/login", json={
            "address": ADDRESS["bank"], "nonce": expired["nonce"], "signature": signature}).status_code)
        self.assertEqual(400, self.client.post("/api/auth/challenge", json={"address": "not-a-wallet"}).status_code)
        self.assertEqual(400, self.client.post("/api/auth/login", json={"nonce": []}).status_code)

    def test_protected_endpoints_require_login_and_sessions_expire(self):
        for method, path in [("get", "/api/applications"), ("post", "/api/applications"), ("get", "/api/borrower-profiles"),
                             ("get", "/api/applications/x/evaluation"), ("post", "/api/applications/x/sync")]:
            self.assertEqual(401, getattr(self.client, method)(path).status_code, path)
        headers = self.login("borrower")
        with sqlite3.connect(app_module.DB_PATH) as conn:
            conn.execute("UPDATE sessions SET expiresAt = '2000-01-01T00:00:00Z'")
        self.assertEqual(401, self.client.get("/api/applications", headers=headers).status_code)

    def test_removed_unauthenticated_write_endpoints(self):
        self.assertIn(self.client.patch("/api/applications/x", json={"status": "approved"}).status_code, {404, 405})
        self.assertEqual(404, self.client.post("/api/reset").status_code)
        self.assertEqual(404, self.client.post("/api/applications/x/document-nonce", json={}).status_code)

    # ------------------------------------------------------------ 신청

    def test_application_encrypts_registry_stores_gazette_and_starts_llm_report(self):
        created = self.apply()
        self.assertEqual(["borrower"], created["access"])
        self.assertEqual("pending", created["status"])
        self.assertEqual(ADDRESS["evaluator"], created["evaluatorWallet"])
        self.assertEqual(24, created["termMonths"])
        self.assertEqual("queued", created["evaluation"]["status"])
        self.assertEqual(["공고전문.pdf", "특허등록원부.pdf"], sorted(created["documents"]))
        for secret in ("docKey", "docSalt", "patentStoredName"):
            self.assertNotIn(secret, created)
        self.assertNotIn("unit-test-token", json.dumps(created))
        row = self.row(created["id"])
        stored = app_module.UPLOAD_DIR / row["patentStoredName"]
        self.assertEqual(PATENT, stored.read_bytes())
        self.assertEqual(0o600, stored.stat().st_mode & 0o777)
        submit = app_module.patent_api.submit
        self.assertEqual((stored, "공고전문.pdf", "1234567890"), submit.call_args.args)
        encrypted = self.ipfs[created["docCid"]]
        self.assertNotIn(REGISTRY, encrypted)
        plaintext = AESGCM(base64.b64decode(row["docKey"])).decrypt(encrypted[:12], encrypted[12:], None)
        self.assertEqual(REGISTRY, plaintext)
        self.assertEqual(row["docFileHash"], "0x" + hashlib.sha256(base64.b64decode(row["docSalt"]) + REGISTRY).hexdigest())

    def test_only_registered_borrowers_apply_and_both_documents_are_required(self):
        self.assertEqual(403, self.post("/applications", "evaluator", data=self.form()).status_code)
        missing = self.form()
        del missing["patentDocument"]
        response = self.post("/applications", "borrower", data=missing)
        self.assertEqual((400, "patent_document_required"), (response.status_code, response.get_json()["error"]))
        response = self.post("/applications", "borrower", data=self.form(bizNo="123"))
        self.assertEqual(400, response.status_code)
        response = self.post("/applications", "borrower", data=self.form(registryDocument=(io.BytesIO(b"not a pdf"), "a.pdf")))
        self.assertEqual("invalid_pdf", response.get_json()["error"])
        self.assertEqual({}, self.ipfs)
        with patch.object(app_module.patent_api, "token", ""):
            self.assertEqual(503, self.post("/applications", "borrower", data=self.form()).status_code)
        self.assertEqual([], self.get("/applications", "borrower").get_json())
        self.assertEqual([], [p for p in app_module.UPLOAD_DIR.iterdir()] if app_module.UPLOAD_DIR.exists() else [])

    def test_registry_mismatch_and_ipfs_failure_keep_profile_and_gazette_untouched(self):
        response = self.post("/applications", "borrower", data=self.form(demoHashMismatch="true"))
        self.assertEqual(422, response.status_code)
        self.assertEqual("doc_verify", response.get_json()["status"])
        self.assertNotIn("evaluation", response.get_json())
        with patch.object(app_module, "upload_encrypted_document", side_effect=app_module.IpfsUploadError("timeout", 504)):
            self.assertEqual(504, self.post("/applications", "borrower", data=self.form()).status_code)
        self.assertEqual([], list(app_module.UPLOAD_DIR.iterdir()))
        self.assertEqual([], self.get("/borrower-profiles", "borrower").get_json())
        app_module.patent_api.submit.assert_not_called()

    def test_llm_submission_failure_keeps_application_for_retry(self):
        rejected = app_module.PatentAPIError("busy", 429, retry_after=None)
        with patch.object(app_module.patent_api, "submit", side_effect=rejected):
            created = self.apply()
        self.assertEqual("submission_rejected", created["evaluation"]["status"])
        self.assertEqual(403, self.post(f"/applications/{created['id']}/evaluation", "admin").status_code)
        retried = self.post(f"/applications/{created['id']}/evaluation", "borrower").get_json()
        self.assertEqual("queued", retried["evaluation"]["status"])
        self.assertEqual(409, self.post(f"/applications/{created['id']}/evaluation", "borrower").status_code)

    def test_profiles_belong_to_the_wallet_that_saved_them(self):
        created = self.apply()
        profiles = self.get("/borrower-profiles", "borrower").get_json()
        self.assertEqual([created["borrowerProfileId"]], [p["id"] for p in profiles])
        self.assertEqual([], self.get("/borrower-profiles", "borrower2").get_json())
        self.assertEqual(404, self.client.patch(f"/api/borrower-profiles/{created['borrowerProfileId']}",
                                                headers=self.login("borrower2"), json={"ceo": "x"}).status_code)
        stolen = self.post("/applications", "borrower2", data=self.form(borrowerProfileId=created["borrowerProfileId"]))
        self.assertEqual(404, stolen.status_code)
        self.assertEqual(409, self.post("/applications", "borrower2", data=self.form()).status_code)
        self.assertEqual(403, self.get("/borrower-profiles", "evaluator").status_code)

    # ------------------------------------------------------------ 열람 권한

    def test_each_wallet_sees_only_its_assigned_applications(self):
        created = self.apply()
        listed = lambda who: [a["id"] for a in self.get("/applications", who).get_json()]
        self.assertEqual([created["id"]], listed("borrower"))
        self.assertEqual([created["id"]], listed("evaluator"))
        self.assertEqual([created["id"]], listed("admin"))
        for who in ("borrower2", "bank", "outsider"):
            self.assertEqual([], listed(who), who)
            self.assertEqual(404, self.get(f"/applications/{created['id']}/evaluation", who).status_code)
        self.stage = {"chainStatus": "Evaluating"}
        self.complete_job(created["id"])
        self.prepare(created["id"])
        self.assertEqual([created["id"]], listed("bank"))  # assigned when a passing evaluation is prepared
        self.assertEqual(["evaluator"], self.get("/applications", "evaluator").get_json()[0]["access"])

    # ------------------------------------------------------------ LLM 보고서 작업

    def set_last_check(self, seconds_ago):
        with sqlite3.connect(app_module.DB_PATH) as conn:
            conn.execute("UPDATE evaluation_jobs SET lastCheckedAt = ?",
                         ((datetime.now(timezone.utc) - timedelta(seconds=seconds_ago)).isoformat(),))

    def test_job_status_is_polled_at_most_every_ten_seconds(self):
        created = self.apply()
        with patch.object(app_module.patent_api, "status") as status:
            self.get(f"/applications/{created['id']}/evaluation", "borrower")
        status.assert_not_called()  # the submission itself was the last check
        self.set_last_check(30)
        with patch.object(app_module.patent_api, "status", return_value=job("running", stage="analysis")) as status:
            first = self.get(f"/applications/{created['id']}/evaluation", "borrower").get_json()
            self.get(f"/applications/{created['id']}/evaluation", "evaluator")
        self.assertEqual(1, status.call_count)
        self.assertEqual("analysis", first["evaluation"]["stage"])
        self.set_last_check(30)
        with patch.object(app_module.patent_api, "status", return_value=job("completed", {"pdf": "/x", "zip": "/y"})):
            done = self.get(f"/applications/{created['id']}/evaluation", "evaluator").get_json()
        self.assertEqual(["pdf"], done["evaluation"]["artifacts"])

    def test_completed_job_stores_llm_valuation_and_financials_for_review(self):
        created = self.apply()
        self.assertNotIn("financial_checks", created["evaluation"])
        self.set_last_check(30)
        summary = {
            "valuation": {"ip_value_krw": 120_500_000, "value_status": "preliminary", "valuation_date": "2026-10-20",
                          "report_number": "MT-1", "discount_rate": 0.2},
            "financials": [{"year": 2025, "fiscal_date": "2025-12-31", "fiscal_date_assumed": True, "source": "company_report",
                            "total_equity_krw": -505_540_000, "debt_ratio_pct": -190.2, "current_ratio_pct": 8.84,
                            "total_borrowings_krw": None, "operating_income_krw": "-1"}],
        }
        with patch.object(app_module.patent_api, "status", return_value=job("completed", {"pdf": "/x"}, **summary)):
            done = self.get(f"/applications/{created['id']}/evaluation", "evaluator").get_json()["evaluation"]
        self.assertEqual({"ip_value_krw": 120_500_000, "value_status": "preliminary", "valuation_date": "2026-10-20",
                          "report_number": "MT-1"}, done["valuation"])
        row = done["financials"][0]
        self.assertEqual((True, True, None, None, "회사 제출 자료"),
                         (row["fiscal_date_assumed"], row["capital_impaired"], row["debt_ratio_pct"],
                          row["operating_income_krw"], row["source_label"]))
        results = {check["key"]: check["result"] for check in done["financial_checks"]}
        self.assertEqual({"capital": "fail", "operating_income": "unknown", "interest_coverage": "unknown",
                          "current_ratio": "fail"}, results)
        borrower_view = self.get("/applications", "borrower").get_json()[0]["evaluation"]
        self.assertEqual(done["financials"], borrower_view["financials"])

    def test_evaluator_explains_a_value_other_than_the_llm_figure(self):
        created = self.apply()
        self.stage = {"chainStatus": "Evaluating"}
        self.complete_job(created["id"])
        with sqlite3.connect(app_module.DB_PATH) as conn:
            conn.execute("UPDATE evaluation_jobs SET valuation=?", (json.dumps({"ip_value_krw": 100}),))
        self.assertEqual(201, self.prepare(created["id"], value=100, note="")[0].status_code)
        refused = self.prepare(created["id"], value=150, note=" ")[0]
        self.assertEqual((400, "note_required"), (refused.status_code, refused.get_json()["error"]))
        self.assertEqual(201, self.prepare(created["id"], value=150, note="비교 거래 반영")[0].status_code)

    def test_identity_correction_continues_the_same_job(self):
        created = self.apply()
        with sqlite3.connect(app_module.DB_PATH) as conn:
            conn.execute("UPDATE evaluation_jobs SET status='awaiting_identity', jobId='job-test-123'")
        self.assertEqual(400, self.post(f"/applications/{created['id']}/evaluation/identity", "borrower",
                                        json={"business_number": "12"}).status_code)
        with patch.object(app_module.patent_api, "identify", return_value=job("running")) as identify:
            response = self.post(f"/applications/{created['id']}/evaluation/identity", "evaluator",
                                 json={"business_number": "987-65-43210"})
        self.assertEqual(("job-test-123", "9876543210"), identify.call_args.args)
        self.assertEqual("running", response.get_json()["evaluation"]["status"])

    def test_report_artifacts_are_proxied_to_participants_only(self):
        created = self.apply()
        self.assertEqual(409, self.get(f"/applications/{created['id']}/evaluation/artifacts/pdf", "evaluator").status_code)
        self.complete_job(created["id"])
        with patch.object(app_module.patent_api, "artifact", side_effect=lambda job_id, kind: io.BytesIO(b"<p>report</p>")):
            html = self.get(f"/applications/{created['id']}/evaluation/artifacts/html", "borrower")
            denied = self.get(f"/applications/{created['id']}/evaluation/artifacts/html", "outsider")
        self.assertEqual(b"<p>report</p>", html.data)
        self.assertIn("sandbox", html.headers["Content-Security-Policy"])
        self.assertEqual(404, denied.status_code)
        self.assertEqual(404, self.get(f"/applications/{created['id']}/evaluation/artifacts/log", "evaluator").status_code)

    # ------------------------------------------------------------ 평가 확정·은행 승인

    def test_evaluator_registers_encrypted_llm_report_for_the_chain(self):
        created = self.apply()
        self.stage = {"chainStatus": "Evaluating"}
        self.assertEqual(409, self.prepare(created["id"])[0].status_code)  # LLM report not finished
        self.complete_job(created["id"])
        self.assertEqual(403, self.prepare(created["id"], who="borrower")[0].status_code)
        self.assertEqual(400, self.prepare(created["id"], value="100")[0].status_code)
        response, artifact = self.prepare(created["id"])
        self.assertEqual(201, response.status_code, response.get_json())
        report = response.get_json()
        self.assertEqual(("job-test-123", "pdf"), artifact.call_args.args)
        self.assertEqual(ADDRESS["bank"], report["bankWallet"])
        encrypted = self.ipfs[report["cid"]]
        self.assertNotIn(REPORT, encrypted)
        with sqlite3.connect(app_module.DB_PATH) as conn:
            key, salt, note = conn.execute("SELECT reportKey, reportSalt, note FROM evaluation_reports WHERE hash = ?",
                                           (report["hash"],)).fetchone()
        self.assertEqual(REPORT, AESGCM(base64.b64decode(key)).decrypt(encrypted[:12], encrypted[12:], None))
        self.assertEqual(report["hash"], "0x" + hashlib.sha256(base64.b64decode(salt) + REPORT).hexdigest())
        self.assertEqual("근거 확인", note)
        again, artifact = self.prepare(created["id"], note="수정 의견")
        self.assertEqual((200, report["cid"]), (again.status_code, again.get_json()["cid"]))
        artifact.assert_not_called()
        failing = self.prepare(created["id"], value=99)[0].get_json()
        self.assertIsNone(failing["bankWallet"])
        self.stage = {"chainStatus": "Eligible"}
        self.assertEqual(409, self.prepare(created["id"])[0].status_code)

    def test_sync_records_chain_terms_and_registered_report_is_hash_verified(self):
        created = self.apply()
        self.stage = {"chainStatus": "Evaluating"}
        self.complete_job(created["id"])
        report = self.prepare(created["id"])[0].get_json()
        self.stage = {"chainStatus": "Approved", "chainBlock": 9, "sbtTokenId": "1", "rwaTokenId": "1",
                      "reportCid": report["cid"], "reportHash": report["hash"], "appraisedValue": 100, "repaidAmount": 0,
                      "creditGrade": "CC", "rateBps": 430, "approvedTermMonths": 24, "approvedAt": 1760000000}
        synced = self.post(f"/applications/{created['id']}/sync", "bank", json={"status": "repaid"}).get_json()
        self.assertEqual(("approved", "CC", 430, 24, "1", 70), (synced["status"], synced["creditGrade"], synced["rateBps"],
                                                                 synced["approvedTermMonths"], synced["rwaTokenId"], synced["ltv"]))
        self.assertEqual({"kind": "pdf", "note": "근거 확인"}, synced["evaluationReport"])
        document = self.get(f"/applications/{created['id']}/evaluation-report/document", "borrower")
        self.assertEqual((200, REPORT), (document.status_code, document.data))
        self.assertEqual(404, self.get(f"/applications/{created['id']}/evaluation-report/document", "outsider").status_code)
        self.ipfs[report["cid"]] = self.ipfs[report["cid"]][:-1] + b"x"
        self.assertIn(self.get(f"/applications/{created['id']}/evaluation-report/document", "bank").status_code, {409, 502})
        self.stage = {**self.stage, "reportHash": "0x" + "1" * 64}
        self.assertEqual(409, self.post(f"/applications/{created['id']}/sync", "bank").status_code)

    def test_repaid_and_rejected_states_map_to_status(self):
        created = self.apply()
        self.stage = {"chainStatus": "Evaluating"}
        self.complete_job(created["id"])
        report = self.prepare(created["id"], value=99)[0].get_json()
        self.stage = {"chainStatus": "RuleRejected", "reportCid": report["cid"], "reportHash": report["hash"],
                      "appraisedValue": 99, "repaidAmount": 0, "bankWallet": None}
        synced = self.post(f"/applications/{created['id']}/sync", "evaluator").get_json()
        self.assertEqual("rejected", synced["status"])
        self.assertIn("70%", synced["rejectReason"])

    def test_registry_original_follows_chain_stage_and_current_role(self):
        created = self.apply()
        self.stage = {"chainStatus": "Evaluating"}
        self.assertEqual((200, REGISTRY), (self.get(f"/applications/{created['id']}/document", "evaluator").status_code,
                                           self.get(f"/applications/{created['id']}/document", "evaluator").data))
        self.assertEqual(403, self.get(f"/applications/{created['id']}/document", "borrower").status_code)
        self.complete_job(created["id"])
        self.prepare(created["id"])
        self.assertEqual(403, self.get(f"/applications/{created['id']}/document", "bank").status_code)
        self.stage = {"chainStatus": "Approved"}
        self.assertEqual(200, self.get(f"/applications/{created['id']}/document", "bank").status_code)
        self.bank_role = False
        self.assertEqual(403, self.get(f"/applications/{created['id']}/document", "bank").status_code)

    def test_credit_score_button_returns_demo_grade_for_assigned_bank(self):
        created = self.apply()
        self.stage = {"chainStatus": "Evaluating"}
        self.complete_job(created["id"])
        self.prepare(created["id"])
        self.assertEqual("CC", self.get(f"/applications/{created['id']}/credit-score", "bank").get_json()["grade"])
        self.assertEqual(403, self.get(f"/applications/{created['id']}/credit-score", "evaluator").status_code)

    # ------------------------------------------------------------ 이전 데이터

    def test_startup_removes_demo_loans_and_imports_llm_archive_read_only(self):
        with sqlite3.connect(app_module.DB_PATH) as conn:
            conn.execute("INSERT INTO borrower_profiles (id, company, updatedAt) VALUES ('p-demo', '(주)그린파머스', 'x')")
            conn.execute("INSERT INTO borrower_profiles (id, company, updatedAt) VALUES ('p-v2', 'v2 기업', 'x')")
            conn.execute("INSERT INTO applications (id, company, status, borrowerProfileId) VALUES "
                         "('LN-2026-0091', '(주)그린파머스', 'approved', 'p-demo')")
            conn.execute("INSERT INTO applications (id, company, status, appKey, borrowerWallet, managerAddress, borrowerProfileId) "
                         "VALUES ('LN-2026-0195', 'v2 기업', 'evaluating', '0xkey', ?, '0x0000000000000000000000000000000000000002', 'p-v2')",
                         (ADDRESS["borrower"],))
        archive = sqlite3.connect(app_module.PATENT_ARCHIVE_DB_PATH)
        archive.executescript("""
            CREATE TABLE applications (id TEXT, company TEXT, bizNo TEXT, ipType TEXT, ipTitle TEXT, amount INTEGER,
              appliedDate TEXT, appraisedValue INTEGER, ltv INTEGER, creditScore INTEGER, ipRegNo TEXT, ceo TEXT,
              contact TEXT, docFileHash TEXT);
            CREATE TABLE evaluation_jobs (appId TEXT, jobId TEXT, status TEXT, stage TEXT, businessNumber TEXT,
              identityMessage TEXT, artifacts TEXT, error TEXT, detail TEXT, readError TEXT, retryAfter INTEGER,
              submittedAt TEXT, updatedAt TEXT, lastCheckedAt TEXT, confirmedAt TEXT, reviewerNote TEXT);
            INSERT INTO applications VALUES ('LN-2026-348055', '실제 기업', '123-45-67890', '특허권', '보고서 특허', 0,
              '2026-10-20', 100, NULL, 80, '', '', '', '0xabc');
            INSERT INTO applications VALUES ('LN-2026-0088', '데모', '', '', '', 0, '', NULL, NULL, NULL, '', '', '', '');
            INSERT INTO evaluation_jobs VALUES ('LN-2026-348055', 'job-archived', 'completed', 'finished', '1234567890',
              NULL, '{"pdf": "/x"}', NULL, NULL, NULL, NULL, '2026-10-20T00:00:00+00:00', '2026-10-20T00:00:00+00:00',
              NULL, '2026-10-20T01:00:00+00:00', '검토 완료');""")
        archive.commit()
        archive.close()
        app_module.init_db()
        app_module.init_db()
        with sqlite3.connect(app_module.DB_PATH) as conn:
            ids = sorted(row[0] for row in conn.execute("SELECT id FROM applications"))
            owners = dict(conn.execute("SELECT id, ownerWallet FROM borrower_profiles").fetchall())
        self.assertEqual(["LN-2026-0195", "LN-2026-348055"], ids)
        self.assertEqual({"p-v2": ADDRESS["borrower"]}, owners)
        self.assertEqual([], self.get("/applications", "outsider").get_json())
        mine = self.get("/applications", "borrower").get_json()
        self.assertEqual([("LN-2026-0195", True)], [(a["id"], a.get("contractOutdated")) for a in mine])
        archived = self.get("/applications", "evaluator").get_json()
        self.assertEqual([("LN-2026-348055", "archived", ["archive"], "검토 완료")],
                         [(a["id"], a["status"], a["access"], a["evaluation"]["reviewer_note"]) for a in archived])
        self.assertEqual(403, self.post("/applications/LN-2026-348055/evaluation/identity", "evaluator",
                                        json={"business_number": "1234567890"}).status_code)
        with patch.object(app_module.patent_api, "artifact", side_effect=lambda job_id, kind: io.BytesIO(REPORT)) as artifact:
            self.assertEqual(REPORT, self.get("/applications/LN-2026-348055/evaluation/artifacts/pdf", "bank").data)
        self.assertEqual(("job-archived", "pdf"), artifact.call_args.args)

    # ------------------------------------------------------------ 체인 설정

    def test_chain_config_errors_and_network_names(self):
        with patch.object(app_module.chain, "config", side_effect=app_module.chain.ChainError("RPC unavailable")):
            self.assertEqual(503, self.client.get("/api/chain/config").status_code)
        for chain_id, flag, expected in [(7601, "1", ("Mustsem", "MST", True)), (7601, "0", ("Mustsem", "MST", False)),
                                         (11155111, "1", ("Sepolia", "ETH", False))]:
            with patch.object(app_module.chain, "MANAGER_ADDRESS", ""), patch.object(app_module.chain, "CHAIN_ID", chain_id), \
                 patch.dict(os.environ, {"IPLOAN_ZERO_GAS_PRICE": flag}):
                data = REAL_CHAIN_CONFIG()
            self.assertFalse(data["enabled"])
            self.assertEqual(expected, (data["networkName"], data["currency"], data["zeroGasPrice"]))


# Captured before any test patches chain.config; without a contract address it makes no RPC call.
REAL_CHAIN_CONFIG = app_module.chain.config


if __name__ == "__main__":
    unittest.main()
