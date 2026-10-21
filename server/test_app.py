from contextlib import closing
import base64
import hashlib
import io
import os
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


TEST_DIR = tempfile.TemporaryDirectory()
os.environ["IPLOAN_DB_PATH"] = os.path.join(TEST_DIR.name, "iploan-test.db")
# Importing app also loads patent_app; keep its DB/uploads out of server/ as well.
os.environ["IPLOAN_PATENT_DB_PATH"] = os.path.join(TEST_DIR.name, "patent-test.db")
os.environ["IPLOAN_PATENT_UPLOAD_DIR"] = os.path.join(TEST_DIR.name, "patent-uploads")

from server import app as app_module  # noqa: E402


class ApplicationUploadTest(unittest.TestCase):
    def setUp(self):
        app_module.NONCES.clear()
        app_module.app.config.update(TESTING=True, ALLOW_LEGACY_TEST_SUBMISSIONS=True)
        self.addCleanup(lambda: app_module.app.config.pop("ALLOW_LEGACY_TEST_SUBMISSIONS", None))
        connection = sqlite3.connect(app_module.DB_PATH)
        app_module.seed(connection)
        connection.commit()
        connection.close()
        self.client = app_module.app.test_client()

    @staticmethod
    def application_form(pdf_bytes=b"%PDF-1.7\nregistry document"):
        return {
            "company": "테스트 주식회사",
            "bizNo": "123-45-67890",
            "ceo": "홍길동",
            "contact": "010-1234-5678",
            "ipType": "특허권",
            "ipTitle": "암호화 업로드 특허",
            "ipRegNo": "10-2026-0000001",
            "amount": "80000000",
            "registryDocument": (io.BytesIO(pdf_bytes), "특허등록원부.pdf"),
        }

    def test_encrypts_pdf_before_ipfs_upload_and_hides_secrets(self):
        plaintext = b"%PDF-1.7\nsecret registry document"
        captured = {}

        def fake_upload(payload, filename):
            captured["payload"] = payload
            captured["filename"] = filename
            return {"cid": "bafybeigdyrzt1234567890", "ipfs": "ipfs://bafybeigdyrzt1234567890"}

        with patch.object(app_module, "upload_encrypted_document", side_effect=fake_upload):
            response = self.client.post(
                "/api/applications",
                data=self.application_form(plaintext),
                content_type="multipart/form-data",
            )

        self.assertEqual(response.status_code, 201)
        body = response.get_json()
        self.assertEqual(body["docCid"], "bafybeigdyrzt1234567890")
        self.assertEqual(body["hashMatch"], 1)
        self.assertNotIn("docKey", body)
        self.assertNotIn("docSalt", body)
        self.assertNotEqual(captured["payload"], plaintext)
        self.assertEqual(len(captured["payload"]), len(plaintext) + 28)

        connection = sqlite3.connect(app_module.DB_PATH)
        row = connection.execute(
            "SELECT docKey, docSalt, docFileHash FROM applications WHERE id = ?", (body["id"],)
        ).fetchone()
        connection.close()
        key = base64.b64decode(row[0])
        salt = base64.b64decode(row[1])
        encrypted = captured["payload"]
        decrypted = AESGCM(key).decrypt(encrypted[:12], encrypted[12:], None)
        self.assertEqual(decrypted, plaintext)
        self.assertEqual(row[2], "0x" + hashlib.sha256(salt + plaintext).hexdigest())

        listed = next(item for item in self.client.get("/api/applications").get_json() if item["id"] == body["id"])
        self.assertNotIn("docKey", listed)
        self.assertNotIn("docSalt", listed)

    def test_registry_mismatch_is_saved_without_ipfs_upload(self):
        form = self.application_form()
        form["demoHashMismatch"] = "true"
        with patch.object(app_module, "upload_encrypted_document") as upload:
            response = self.client.post(
                "/api/applications", data=form, content_type="multipart/form-data"
            )

        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.get_json()["hashMatch"], 0)
        upload.assert_not_called()

    def test_rejects_non_pdf_content(self):
        response = self.client.post(
            "/api/applications",
            data=self.application_form(b"not a pdf"),
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"], "invalid_pdf")

    def test_ipfs_client_uses_company_rwa_multipart_contract(self):
        upstream = Mock(status_code=200, ok=True)
        upstream.json.return_value = {
            "cid": "bafybeigdyrzt1234567890",
            "ipfs": "ipfs://bafybeigdyrzt1234567890",
            "gateway": "https://rwa-gw.mustree.kr/ipfs/bafybeigdyrzt1234567890",
        }
        with patch.object(app_module.requests, "post", return_value=upstream) as post:
            result = app_module.upload_encrypted_document(b"encrypted", "원부.pdf")

        self.assertEqual(result["cid"], "bafybeigdyrzt1234567890")
        args = post.call_args.kwargs
        self.assertEqual(args["files"]["file"][2], "application/octet-stream")
        self.assertEqual(args["files"]["file"][1], b"encrypted")
        self.assertEqual(args["timeout"], (10, 600))

    def profiles(self):
        return self.client.get("/api/borrower-profiles").get_json()

    def test_existing_companies_migrated_once_and_linked_by_id(self):
        self.assertEqual(len(self.profiles()), 8)
        green = next(p for p in self.profiles() if p["company"] == "(주)그린파머스")
        self.assertEqual(green["bizNo"], "208-86-41029")
        self.assertEqual(green["ceo"], "")
        updated = self.client.patch(
            f'/api/borrower-profiles/{green["id"]}', json={"bizNo": "999-99-99999", "ceo": "김대표"}
        )
        self.assertEqual(updated.status_code, 200)
        app_module.init_db()  # 재시작 시 신청 이력으로 프로필을 덮어쓰지 않는다.
        profile = next(p for p in self.profiles() if p["id"] == green["id"])
        self.assertEqual(profile["bizNo"], "999-99-99999")
        application = next(a for a in self.client.get("/api/applications").get_json() if a["id"] == "LN-2026-0091")
        self.assertEqual(application["borrowerProfileId"], green["id"])
        self.assertEqual(application["bizNo"], "208-86-41029")

    def test_profile_can_be_created_without_pdf_and_updated_independently(self):
        response = self.client.post("/api/borrower-profiles", json={
            "company": "신규 기업", "bizNo": "123", "ceo": "김대표", "contact": "010-1111-2222"
        })
        self.assertEqual(response.status_code, 201)
        profile = response.get_json()
        renamed = self.client.patch(f'/api/borrower-profiles/{profile["id"]}', json={"company": "변경 기업"})
        self.assertEqual(renamed.status_code, 200)
        self.assertEqual(renamed.get_json()["id"], profile["id"])
        self.assertEqual(renamed.get_json()["contact"], "010-1111-2222")
        self.assertEqual(len(self.client.get("/api/applications").get_json()), 8)

    def test_success_updates_only_selected_profile_and_preserves_application_snapshot(self):
        green = next(p for p in self.profiles() if p["company"] == "(주)그린파머스")
        others = [p for p in self.profiles() if p["id"] != green["id"]]
        uploaded = {"cid": "bafybeigdyrzt1234567890", "ipfs": "ipfs://bafybeigdyrzt1234567890"}
        with patch.object(app_module, "upload_encrypted_document", return_value=uploaded):
            form = self.application_form()
            form.update(borrowerProfileId=green["id"], company="그린파머스 변경")
            first = self.client.post("/api/applications", data=form).get_json()
            form = self.application_form()
            form.update(borrowerProfileId=green["id"], company="그린파머스 변경", ceo="다음 대표", contact="02-1234-5678")
            second_response = self.client.post("/api/applications", data=form)
        self.assertEqual(second_response.status_code, 201)
        self.assertEqual(first["borrowerProfileId"], green["id"])
        self.assertEqual(first["ceo"], "홍길동")
        self.assertEqual(second_response.get_json()["borrowerProfile"]["ceo"], "다음 대표")
        app_module.init_db()
        latest = next(p for p in self.profiles() if p["id"] == green["id"])
        self.assertEqual(latest["ceo"], "다음 대표")
        self.assertEqual(latest["contact"], "02-1234-5678")
        self.assertEqual([p for p in self.profiles() if p["id"] != green["id"]], others)
        old = next(a for a in self.client.get("/api/applications").get_json() if a["id"] == first["id"])
        self.assertEqual(old["ceo"], "홍길동")
        self.assertEqual(old["contact"], "010-1234-5678")

    def test_failures_do_not_update_profile(self):
        green = next(p for p in self.profiles() if p["company"] == "(주)그린파머스")
        for mismatch, status in [(True, 422), (False, 504)]:
            with self.subTest(status=status):
                form = self.application_form()
                form.update(borrowerProfileId=green["id"], company=green["company"])
                if mismatch:
                    form["demoHashMismatch"] = "true"
                with patch.object(app_module, "upload_encrypted_document", side_effect=app_module.IpfsUploadError("timeout", 504)):
                    response = self.client.post("/api/applications", data=form)
                self.assertEqual(response.status_code, status)
                self.assertEqual(next(p for p in self.profiles() if p["id"] == green["id"]), green)
        self.assertEqual(len(self.client.get("/api/applications").get_json()), 9)  # 불일치 신청만 저장

    def test_duplicate_and_invalid_profiles_rejected(self):
        self.assertEqual(self.client.post("/api/borrower-profiles", json={"company": "(주)그린파머스"}).status_code, 409)
        for data in [{"company": " "}, {"company": "x" * 201}, {"company": "x", "ceo": []}, []]:
            self.assertEqual(self.client.post("/api/borrower-profiles", json=data).status_code, 400)
        self.assertEqual(self.client.patch("/api/borrower-profiles/missing", json={"company": "x"}).status_code, 404)
        form = self.application_form()
        form["borrowerProfileId"] = "missing"
        with patch.object(app_module, "upload_encrypted_document") as upload:
            self.assertEqual(self.client.post("/api/applications", data=form).status_code, 404)
            upload.assert_not_called()

    def test_failed_new_application_does_not_create_profile_on_restart(self):
        form = self.application_form()
        form["demoHashMismatch"] = "true"
        self.assertEqual(self.client.post("/api/applications", data=form).status_code, 422)
        app_module.init_db()
        self.assertEqual(len(self.profiles()), 8)

    def test_reset_resets_both_profiles_and_applications(self):
        self.client.post("/api/borrower-profiles", json={"company": "신규 기업"})
        with patch.dict(os.environ, {"IPLOAN_ENABLE_RESET": "1", "IPLOAN_ADMIN_KEY": "test-reset-key"}):
            self.assertEqual(self.client.post("/api/reset").status_code, 403)
            self.assertEqual(
                self.client.post("/api/reset", headers={"X-Admin-Key": "test-reset-key"}).status_code,
                200,
            )
        self.assertEqual(len(self.profiles()), 8)
        self.assertFalse(any(p["company"] == "신규 기업" for p in self.profiles()))

    def test_legacy_schema_migrates_without_losing_upload_data(self):
        legacy_path = os.path.join(TEST_DIR.name, "legacy.db")
        connection = sqlite3.connect(legacy_path)
        connection.execute(app_module.SCHEMA)
        connection.execute(
            "INSERT INTO applications (id, company, bizNo, appliedDate, docCid, docKey) VALUES (?, ?, ?, ?, ?, ?)",
            ("legacy-id", "기존 기업", "123", "2026-10-13", "existing-cid", "existing-key"),
        )
        connection.commit()
        connection.close()
        with patch.object(app_module, "DB_PATH", legacy_path):
            app_module.init_db()
            profile = self.profiles()[0]
            application = self.client.get("/api/applications").get_json()[0]
            self.assertEqual(application["docCid"], "existing-cid")
            self.assertEqual(application["borrowerProfileId"], profile["id"])
            connection = sqlite3.connect(legacy_path)
            self.assertEqual(connection.execute("SELECT docKey FROM applications").fetchone()[0], "existing-key")
            connection.close()


    def test_chain_rpc_failure_is_reported_without_enabling_wallet_flow(self):
        with patch.object(app_module.chain, "config", side_effect=app_module.chain.ChainError("RPC unavailable")):
            response = self.client.get("/api/chain/config")
        self.assertEqual(response.status_code, 503)

    def test_sepolia_network_config_has_eth_name_and_explorer(self):
        with patch.object(app_module.chain, "MANAGER_ADDRESS", ""), patch.object(app_module.chain, "CHAIN_ID", 11155111):
            data = self.client.get("/api/chain/config").get_json()
        self.assertFalse(data["enabled"])
        self.assertEqual(data["networkName"], "Sepolia")
        self.assertEqual(data["currency"], "ETH")
        self.assertEqual(data["explorerUrl"], "https://sepolia.etherscan.io")

    def test_mustsem_zero_price_mode_explicitly_enabled(self):
        with patch.object(app_module.chain, "MANAGER_ADDRESS", ""), patch.object(app_module.chain, "CHAIN_ID", 7601), \
             patch.dict(os.environ, {"IPLOAN_ZERO_GAS_PRICE": "1"}):
            data = self.client.get("/api/chain/config").get_json()
        self.assertEqual(data["networkName"], "Mustsem")
        self.assertEqual(data["currency"], "MST")
        self.assertTrue(data["zeroGasPrice"])

    def test_zero_price_disabled_without_flag_and_on_other_chains(self):
        for chain_id, flag in [(7601, "0"), (11155111, "1"), (31337, "1")]:
            with patch.object(app_module.chain, "MANAGER_ADDRESS", ""), patch.object(app_module.chain, "CHAIN_ID", chain_id), \
                 patch.dict(os.environ, {"IPLOAN_ZERO_GAS_PRICE": flag}):
                self.assertFalse(self.client.get("/api/chain/config").get_json()["zeroGasPrice"])

    def test_unregistered_borrower_rejected_before_upload(self):
        form = self.application_form()
        form["borrowerWallet"] = "0x1111111111111111111111111111111111111111"
        with patch.object(app_module.chain, "MANAGER_ADDRESS", "0x2222222222222222222222222222222222222222"), \
             patch.object(app_module.chain, "config", return_value={}), \
             patch.object(app_module.chain, "require_role", side_effect=app_module.chain.ChainError("role required")), \
             patch.object(app_module, "upload_encrypted_document") as upload:
            response = self.client.post("/api/applications", data=form)
        self.assertEqual(response.status_code, 400)
        upload.assert_not_called()

    def test_document_rejects_malformed_nonce_and_address(self):
        app_id = self.client.get("/api/applications").get_json()[0]["id"]
        self.assertEqual(self.client.post(f"/api/applications/{app_id}/document", json={"nonce": []}).status_code, 400)
        self.assertEqual(self.client.post(f"/api/applications/{app_id}/document-nonce", json={"address": "not-a-wallet"}).status_code, 400)

    def test_expired_document_nonce_is_one_use(self):
        app_id = self.client.get("/api/applications").get_json()[0]["id"]
        wallet = "0x1111111111111111111111111111111111111111"
        with patch.object(app_module.time, "time", return_value=1000):
            challenge = self.client.post(f"/api/applications/{app_id}/document-nonce", json={"address": wallet}).get_json()
        with patch.object(app_module.time, "time", return_value=1301):
            response = self.client.post(f"/api/applications/{app_id}/document", json={**challenge, "address": wallet})
        self.assertEqual(response.status_code, 403)
        self.assertNotIn(challenge["nonce"], app_module.NONCES)

    def test_malformed_signature_is_forbidden_not_gateway_error(self):
        app_id = self.client.get("/api/applications").get_json()[0]["id"]
        wallet = "0x1111111111111111111111111111111111111111"
        challenge = self.client.post(f"/api/applications/{app_id}/document-nonce", json={"address": wallet}).get_json()
        response = self.client.post(f"/api/applications/{app_id}/document", json={**challenge, "address": wallet, "signature": []})
        self.assertEqual(response.status_code, 403)

    def test_reset_forbidden_when_chain_configured_preserves_records(self):
        before = self.client.get("/api/applications").get_json()
        with patch.object(app_module.chain, "MANAGER_ADDRESS", "0x2222222222222222222222222222222222222222"):
            self.assertEqual(self.client.post("/api/reset").status_code, 409)
        self.assertEqual(self.client.get("/api/applications").get_json(), before)


if __name__ == "__main__":
    unittest.main()
