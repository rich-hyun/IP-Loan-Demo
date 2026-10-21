"""Signed loan workflow against temporary SQLite; provider and chain are test doubles.

Actual EVM coverage lives in blockchain/test/workflow.test.mjs.
"""
from contextlib import closing
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from eth_account import Account
from eth_account.messages import encode_defunct

_import_tmp = tempfile.TemporaryDirectory(prefix='workflow-import-')
os.environ.setdefault('IPLOAN_DB_PATH', str(Path(_import_tmp.name) / 'loans.db'))
os.environ.setdefault('IPLOAN_PATENT_DB_PATH', str(Path(_import_tmp.name) / 'patents.db'))
os.environ.setdefault('IPLOAN_PATENT_UPLOAD_DIR', str(Path(_import_tmp.name) / 'uploads'))
from server import app as native
from server import loan_workflow as workflow
from server.patent_api import PatentAPIError

PDF = b'%PDF-1.4\nfictional patent for workflow test\n%%EOF'


class LoanWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='loan-workflow-')
        self.addCleanup(self.tmp.cleanup)
        self.borrower, self.evaluator, self.bank, self.other = [Account.create() for _ in range(4)]
        self.roles = {self.borrower.address: 'BORROWER_ROLE', self.evaluator.address: 'EVALUATOR_ROLE', self.bank.address: 'BANK_ROLE'}
        self.cfg = {'enabled': True, 'managerAddress': '0x' + '12' * 20, 'chainId': 31337, 'contractVersion': 2}
        self.chain_states = {}
        self.submissions = []
        self.result = self.provider_job('queued')
        for target, name, value in [
            (native, 'DB_PATH', str(Path(self.tmp.name) / 'loans.db')),
            (native.chain, 'MANAGER_ADDRESS', self.cfg['managerAddress']),
            (native.chain, 'config', lambda: self.cfg),
            (native.chain, 'select_evaluator', lambda *args: self.evaluator.address),
            (native.chain, 'select_bank', lambda *args: self.bank.address),
            (native.chain, 'require_role', self.require_role),
            (native.chain, 'has_role', lambda wallet, role: self.roles.get(wallet) == role),
            (native.chain, 'snapshot', self.snapshot),
            (native, 'upload_ipfs_payload', lambda body, *args: {'cid': 'bafy' + hashlib.sha256(body).hexdigest(), 'ipfs': 'ipfs://test'}),
            (workflow.patent_api, 'submit', self.provider_submit),
            (workflow.patent_api, 'status', lambda _: self.result),
            (workflow.patent_api, 'artifact', lambda *args: io.BytesIO(b'%PDF-1.4\nreal provider test double report')),
        ]:
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.config_patch = patch.dict(native.app.config, {'TESTING': True, 'ALLOW_LEGACY_TEST_SUBMISSIONS': False})
        self.config_patch.start()
        self.addCleanup(self.config_patch.stop)
        native.init_db()
        self.client = native.app.test_client()

    def require_role(self, wallet, role):
        if self.roles.get(wallet) != role:
            raise native.chain.ChainError('권한 없는 지갑')

    def snapshot(self, application):
        return self.chain_states.get(application['id'], {'chainStatus': 'Evaluating', 'chainBlock': 1, 'appraisedValue': 0})

    def provider_job(self, state, value=100, artifacts=None):
        return {'job_id': 'provider-job-1', 'status': state, 'valuation': {'amount': value, 'currency': 'KRW', 'unit': 'won'},
                'artifacts': artifacts if artifacts is not None else ({'pdf': '/pdf'} if state == 'completed' else {})}

    def provider_submit(self, path, filename, number):
        self.assertEqual(PDF, path.read_bytes())
        self.submissions.append((filename, number))
        if isinstance(self.result, Exception):
            raise self.result
        return self.result

    def proof(self, action, app_id, body, signer=None, client=None):
        signer = signer or self.borrower
        client = client or self.client
        response = client.post('/api/workflow/challenge', json={'address': signer.address, 'action': action,
                    'applicationId': app_id, 'digest': workflow.digest(body)})
        self.assertEqual(200, response.status_code, response.get_data(as_text=True))
        signature = Account.sign_message(encode_defunct(text=response.json['message']), signer.key).signature.hex()
        return {'nonce': response.json['nonce'], 'signature': '0x' + signature.removeprefix('0x')}

    def fields(self, **changes):
        return {'company': '가상 통합 기업', 'bizNo': '123-45-67890', 'amount': '70', 'ipTitle': '가상 특허',
                'borrowerWallet': self.borrower.address, 'workflow': 'integrated', 'request_id': 'workflow-request-12345', **changes}



    def create(self, fields=None, client=None, proof=None):
        client = client or self.client
        fields = fields or self.fields()
        manifest = {**fields, 'fileSha256': hashlib.sha256(PDF).hexdigest()}
        proof = proof or self.proof('create', '', manifest, client=client)
        return client.post('/api/applications', data={**fields, 'auth': json.dumps(proof), 'registryDocument': (io.BytesIO(PDF), 'patent.pdf')})

    def call(self, app_id, action='status', signer=None, **extra):
        body = {'action': action, **extra}
        return self.client.post(f'/api/applications/{app_id}/evaluation', json={**body, 'auth': self.proof(action, app_id, body, signer)})

    def completed(self, amount=70):
        self.result = self.provider_job('completed')
        created = self.create(self.fields(amount=str(amount)))
        self.assertEqual(201, created.status_code, created.get_data(as_text=True))
        app_id = created.json['id']
        self.sync(app_id)
        return app_id

    def prepare(self, app_id, value=100, signer=None, **extra):
        body = {'appraisedValue': value, 'reviewerNote': '보고서 검토 후 적용 가치 확정', **extra}
        return self.client.post(f'/api/applications/{app_id}/evaluation-report', json={**body, 'auth': self.proof('review', app_id, body, signer or self.evaluator)})

    def sync(self, app_id, report=None, stage='Evaluating'):
        if report:
            self.chain_states[app_id] = {'chainStatus': stage, 'chainBlock': 2, 'reportHash': report['hash'], 'reportCid': report['cid'],
                                        'appraisedValue': report['appraisedValue'], 'repaidAmount': 0}
        return self.client.post(f'/api/applications/{app_id}/sync', json={})

    def count(self, table):
        with closing(sqlite3.connect(native.DB_PATH)) as db, db:
            return db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]

    def test_image_metadata_prepared_once_and_bound_to_replayed_submission(self):
        self.cfg.update(tokenMediaVersion=2, tokenMediaGateway='https://rwa-gw.mustree.kr/ipfs/')
        original = native.upload_ipfs_payload
        with patch.object(native, 'upload_ipfs_payload', side_effect=original) as upload:
            created = self.create()
            self.assertEqual(created.status_code, 201, created.get_data(as_text=True))
            self.assertEqual(upload.call_count, 5)
            for prefix in ('sbt', 'debt'):
                self.assertTrue(created.json[prefix+'MetadataUri'].startswith('https://rwa-gw.mustree.kr/ipfs/bafy'))
                self.assertTrue(created.json[prefix+'ImageUri'].startswith('https://rwa-gw.mustree.kr/ipfs/bafy'))
            replay = self.create()
            self.assertEqual(replay.status_code, 200)
            self.assertEqual(replay.json['id'], created.json['id'])
            self.assertEqual(replay.json['debtMetadataUri'], created.json['debtMetadataUri'])
            self.assertEqual(upload.call_count, 5)

    def test_image_upload_failure_never_creates_application_or_provider_job(self):
        self.cfg.update(tokenMediaVersion=2, tokenMediaGateway='https://rwa-gw.mustree.kr/ipfs/')
        before = self.count('applications')
        calls = []
        def upload(body, filename, mime):
            calls.append(filename)
            if len(calls) == 3:
                raise native.IpfsUploadError('image upload failed')
            return {'cid': 'bafy' + hashlib.sha256(body).hexdigest(), 'ipfs': 'ipfs://test'}
        with patch.object(native, 'upload_ipfs_payload', side_effect=upload):
            response = self.create()
        self.assertEqual(response.status_code, 502)
        self.assertEqual(self.count('applications'), before)
        self.assertEqual(self.submissions, [])

    def test_https_media_contract_uses_gateway_paths_and_rejects_gateway_mismatch(self):
        from server import token_media
        self.cfg.update(tokenMediaVersion=2, tokenMediaGateway='https://wrong.example/ipfs/')
        before = self.count('applications')
        self.assertEqual(self.create().status_code, 503)
        self.assertEqual(self.count('applications'), before)
        self.assertEqual(self.submissions, [])
        self.cfg['tokenMediaGateway'] = token_media.HTTPS_GATEWAY
        created = self.create()
        self.assertEqual(created.status_code, 201, created.get_data(as_text=True))
        self.assertTrue(created.json['debtMetadataUri'].startswith(token_media.HTTPS_GATEWAY))
        self.assertTrue(created.json['debtImageUri'].startswith(token_media.HTTPS_GATEWAY))
        replay = self.create()
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json['debtMetadataUri'], created.json['debtMetadataUri'])

    def test_one_upload_report_review_confirm_ltv_credit_case_and_restart(self):
        app_id = self.completed()
        status = self.call(app_id, signer=self.evaluator)
        self.assertEqual(100, status.json['evaluation']['autoValue'])
        self.assertEqual(['pdf'], status.json['evaluation']['artifacts'])
        self.assertTrue(status.json['ltvPolicy']['demo'])
        proof = self.proof('document', app_id, {}, self.evaluator)
        self.assertEqual(PDF, self.client.post(f'/api/applications/{app_id}/evaluation/document', json={'auth': proof}).data)
        self.assertEqual(403, self.client.post(f'/api/applications/{app_id}/evaluation/document', json={'auth': proof}).status_code)
        report = self.prepare(app_id)
        self.assertEqual(200, report.status_code, report.get_data(as_text=True))
        self.assertEqual(0, self.count('credit_cases'))
        repeat = self.prepare(app_id)
        self.assertEqual(report.json['hash'], repeat.json['hash'])
        self.assertEqual(409, self.prepare(app_id, 101).status_code)
        sync = self.sync(app_id, report.json, 'Eligible')
        self.assertEqual(200, sync.status_code, sync.get_data(as_text=True))
        self.assertEqual(app_id, sync.json['creditCaseId'])
        self.assertEqual('review', sync.json['status'])
        self.assertEqual(1, self.count('credit_cases'))
        self.sync(app_id, report.json, 'Eligible')
        native.init_db()
        self.assertEqual(1, self.count('credit_cases'))
        self.assertEqual(1, self.count('loan_artifacts'))
        self.assertEqual(1, len(self.submissions))
        self.assertEqual(200, self.call(app_id, signer=self.evaluator).status_code)
        self.assertEqual(200, self.call(app_id, signer=self.bank).status_code)
        for signer in (self.evaluator, self.bank):
            auth = self.proof('document', app_id, {}, signer)
            self.assertEqual(403, self.client.post(f'/api/applications/{app_id}/evaluation/document', json={'auth': auth}).status_code)

    def test_review_manifest_is_encrypted_before_public_ipfs_and_replay_reuses_it(self):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        import base64
        app_id = self.completed()
        with patch.object(native, 'upload_ipfs_payload', return_value={'cid': 'bafyEncryptedManifest1234567890'}) as upload:
            prepared = self.prepare(app_id)
            repeated = self.prepare(app_id)
        self.assertEqual(200, prepared.status_code, prepared.json)
        self.assertEqual(prepared.json['cid'], repeated.json['cid'])
        upload.assert_called_once()
        encrypted = upload.call_args.args[0]
        self.assertNotIn('보고서 검토'.encode(), encrypted)
        with closing(sqlite3.connect(native.DB_PATH)) as db, db:
            key = base64.b64decode(db.execute('SELECT docKey FROM applications WHERE id=?', (app_id,)).fetchone()[0])
        restored = AESGCM(key).decrypt(encrypted[:12], encrypted[12:], None)
        self.assertEqual(prepared.json['hash'], '0x' + hashlib.sha256(restored).hexdigest())
        self.assertEqual(app_id, json.loads(restored)['applicationId'])

    def test_ltv_excess_exact_boundary_and_forged_eligible_cannot_enter_review(self):
        app_id = self.completed(71)
        report = self.prepare(app_id)
        self.assertIsNone(report.json['bankWallet'])
        self.assertEqual(409, self.sync(app_id, report.json, 'Eligible').status_code)
        result = self.sync(app_id, report.json, 'RuleRejected')
        self.assertEqual(200, result.status_code)
        self.assertEqual('rejected', result.json['status'])
        self.assertIn('70%', result.json['rejectReason'])
        self.assertEqual(0, self.count('credit_cases'))

    def test_incomplete_failed_missing_report_zero_negative_and_bypass_rejected(self):
        for index, state in enumerate(['queued', 'running', 'failed']):
            self.result = self.provider_job(state)
            created = self.create(self.fields(request_id=f'workflow-request-{index:016}'))
            app_id = created.json['id']
            self.assertEqual(409, self.prepare(app_id).status_code)
            self.assertEqual(409, self.client.patch(f'/api/applications/{app_id}', json={'status': 'review', 'appraisedValue': 999}).status_code)
        app_id = self.completed()
        for value in [None, 0, -1, True, '100', 1.5]:
            self.assertEqual(400, self.prepare(app_id, value).status_code)
        self.assertEqual(0, self.count('credit_cases'))
        with native.app.app_context():
            workflow.update(native.get_db(), app_id, artifacts='[]')
        self.assertEqual(409, self.prepare(app_id).status_code)

    def test_provider_failure_retry_uses_same_application_and_bytes(self):
        self.result = PatentAPIError('서비스 일시 실패', 429, retry_after=1)
        created = self.create()
        app_id = created.json['id']
        self.assertEqual('submission_rejected', created.json['evaluation']['state'])
        self.assertEqual(429, self.call(app_id, 'retry').status_code)
        with native.app.app_context():
            workflow.update(native.get_db(), app_id, retryAt=0)
        self.result = self.provider_job('failed')
        self.assertEqual(200, self.call(app_id, 'retry').status_code)
        self.result = self.provider_job('completed')
        retried = self.call(app_id, 'retry')
        self.assertEqual(app_id, retried.json['id'])
        self.assertEqual('completed', retried.json['evaluation']['state'])
        self.assertEqual(3, retried.json['evaluation']['attempt'])
        self.assertEqual(['submission_rejected', 'failed', 'completed'], [r['state'] for r in retried.json['evaluation']['attempts']])
        self.assertEqual(409, self.call(app_id, 'retry').status_code)
        self.assertEqual(1, self.count('loan_evaluations'))
        self.assertEqual(0, self.count('credit_cases'))

    def test_ambiguous_submission_and_stale_process_do_not_duplicate_provider_job(self):
        self.result = PatentAPIError('timeout after acceptance', uncertain=True)
        app_id = self.create().json['id']
        self.assertEqual(409, self.call(app_id, 'retry').status_code)
        self.assertEqual(200, self.create().status_code)
        self.assertEqual(1, len(self.submissions))
        with native.app.app_context():
            native.get_db().execute("UPDATE loan_evaluations SET state='submitting',updatedAt=? WHERE appId=?", (time.time()-121, app_id))
            native.get_db().commit()
        self.assertEqual('submission_unknown', self.call(app_id).json['evaluation']['state'])
        self.assertEqual(1, len(self.submissions))

    def test_duplicate_changed_payload_concurrent_create_and_nonce_replay(self):
        fields = self.fields()
        def submit_one(_):
            client = native.app.test_client()
            return self.create(fields, client=client)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(submit_one, range(2)))
        self.assertEqual([200, 201], sorted(result.status_code for result in results))
        self.assertEqual(results[0].json['id'], results[1].json['id'])
        self.assertEqual(1, len(self.submissions))
        self.assertEqual(409, self.create(self.fields(amount='71')).status_code)
        manifest = {**fields, 'fileSha256': hashlib.sha256(PDF).hexdigest()}
        proof = self.proof('create', '', manifest)
        self.assertEqual(200, self.create(fields, proof=proof).status_code)
        self.assertEqual(403, self.create(fields, proof=proof).status_code)

    def test_unsigned_unauthorized_revoked_and_changed_review_body(self):
        app_id = self.completed()
        self.assertEqual(403, self.client.post(f'/api/applications/{app_id}/evaluation', json={}).status_code)
        self.assertEqual(403, self.call(app_id, signer=self.other).status_code)
        self.assertEqual(403, self.prepare(app_id, signer=self.borrower).status_code)
        self.assertEqual(403, self.prepare(app_id, signer=self.other).status_code)
        body = {'appraisedValue': 100, 'reviewerNote': 'checked'}
        proof = self.proof('review', app_id, body, self.evaluator)
        response = self.client.post(f'/api/applications/{app_id}/evaluation-report', json={**body, 'appraisedValue': 200, 'auth': proof})
        self.assertEqual(403, response.status_code)
        del self.roles[self.evaluator.address]
        self.assertEqual(403, self.call(app_id, signer=self.evaluator).status_code)
        self.assertEqual(0, self.count('credit_cases'))

    def test_status_session_cannot_modify_read_other_application_or_outlive_role(self):
        app_id = self.completed()
        result = self.call(app_id, signer=self.evaluator)
        token = result.json['readSession']
        self.assertEqual(200, self.client.post(f'/api/applications/{app_id}/evaluation', json={'action': 'status', 'auth': {'session': token}}).status_code)
        self.assertEqual(403, self.client.post(f'/api/applications/{app_id}/evaluation', json={'action': 'retry', 'auth': {'session': token}}).status_code)
        self.assertEqual(403, self.client.post('/api/applications/another/evaluation', json={'action': 'status', 'auth': {'session': token}}).status_code)
        del self.roles[self.evaluator.address]
        self.assertEqual(403, self.client.post(f'/api/applications/{app_id}/evaluation', json={'action': 'status', 'auth': {'session': token}}).status_code)

    def test_public_status_refreshes_provider_and_report_opens_without_wallet(self):
        self.result = self.provider_job('queued')
        app_id = self.create().json['id']
        self.result = self.provider_job('completed')
        with closing(sqlite3.connect(native.DB_PATH)) as db, db:
            db.execute('UPDATE loan_evaluations SET checkedAt=0 WHERE appId=?', (app_id,))
        status = self.client.get(f'/api/applications/{app_id}/evaluation')
        self.assertEqual(200, status.status_code, status.get_data(as_text=True))
        self.assertEqual('completed', status.json['evaluation']['state'])
        self.assertEqual(['pdf'], status.json['evaluation']['artifacts'])
        self.assertNotIn('readSession', status.json)
        report = self.client.get(f'/api/applications/{app_id}/evaluation/artifacts/pdf')
        self.assertEqual(200, report.status_code)
        self.assertTrue(report.data.startswith(b'%PDF-'))
        self.assertTrue(report.headers['Content-Disposition'].startswith('inline'))
        download = self.client.get(f'/api/applications/{app_id}/evaluation/artifacts/pdf?download=1')
        self.assertTrue(download.headers['Content-Disposition'].startswith('attachment'))
        self.assertEqual(403, self.client.post(f'/api/applications/{app_id}/evaluation/document', json={}).status_code)
        self.assertEqual(404, self.client.get('/api/applications/missing/evaluation').status_code)
        self.assertEqual(1, len(self.submissions))

    def test_missing_contract_config_never_passes_and_legacy_writes_closed(self):
        with patch.object(native.chain, 'MANAGER_ADDRESS', ''):
            response = self.create()
        self.assertEqual(503, response.status_code)
        self.assertEqual(0, len(self.submissions))
        self.assertEqual(410, self.client.post('/api/patent/applications', data={}).status_code)
        self.assertEqual(410, self.client.post('/api/patent/applications/old/evaluation/confirm', json={}).status_code)
        self.assertEqual(200, self.client.get('/api/patent/applications').status_code)
        self.assertEqual(409, self.client.patch('/api/applications/LN-2026-0106', json={'status': 'review', 'appraisedValue': 0}).status_code)

    def test_missing_auto_value_is_explicit_and_never_fabricated(self):
        self.result = {'job_id': 'reports-only', 'status': 'completed', 'artifacts': {'pdf': '/pdf'}}
        app_id = self.create().json['id']
        result = self.call(app_id, signer=self.evaluator)
        self.assertIsNone(result.json['evaluation']['autoValue'])
        self.assertIn('구조화된', result.json['evaluation']['valueMessage'])
        self.assertEqual(0, self.count('credit_cases'))

    def test_actual_template_html_value_is_cached_bound_and_provided_to_reviewer(self):
        self.result = {'job_id': 'html-money', 'status': 'completed', 'artifacts': {'html': '/html'}}
        html = '<table><tr><th>IP 가치금액</th><td>1.25억 원<span>기준 시나리오</span></td></tr></table>'.encode()
        with patch.object(workflow.patent_api, 'artifact', side_effect=lambda *_: io.BytesIO(html)):
            created = self.create(self.fields(termMonths='24'))
            app_id = created.json['id']
            status = self.call(app_id, signer=self.evaluator)
            self.assertEqual(125_000_000, status.json['evaluation']['autoValue'])
            self.assertEqual('24', str(status.json['termMonths']))
            report = self.prepare(app_id, value=125_000_000)
        self.assertEqual(200, report.status_code, report.get_data(as_text=True))
        with closing(sqlite3.connect(native.DB_PATH)) as db, db:
            payload = json.loads(db.execute('SELECT payload FROM evaluation_reports WHERE hash=?', (report.json['hash'],)).fetchone()[0])
        self.assertEqual(hashlib.sha256(html).hexdigest(), payload['autoValueReportHash'])
        self.assertEqual(125_000_000, payload['autoValue'])
        self.assertEqual(1, self.count('loan_artifacts'))

    def test_unknown_submission_can_recover_only_matching_provider_source_without_resubmission(self):
        self.result = PatentAPIError('accepted timeout', uncertain=True)
        app_id = self.create().json['id']
        self.result = {**self.provider_job('completed'), 'source_sha256': 'wrong', 'business_number': '1234567890'}
        self.assertEqual(409, self.call(app_id, 'recover', job_id='provider-job-1').status_code)
        self.result['source_sha256'] = hashlib.sha256(PDF).hexdigest()
        recovered = self.call(app_id, 'recover', job_id='provider-job-1')
        self.assertEqual(200, recovered.status_code, recovered.get_data(as_text=True))
        self.assertEqual('completed', recovered.json['evaluation']['state'])
        self.assertEqual(1, len(self.submissions))
        self.assertEqual(1, self.count('loan_evaluations'))

    def test_rounded_display_does_not_allow_ltv_above_limit(self):
        app_id = self.completed(704)
        report = self.prepare(app_id, value=1000)
        self.assertEqual(409, self.sync(app_id, report.json, 'Eligible').status_code)
        rejected = self.sync(app_id, report.json, 'RuleRejected')
        self.assertEqual(70, rejected.json['ltv'])
        self.assertEqual(0, self.count('credit_cases'))

    def test_valid_wallet_signature_cannot_create_without_owning_borrower_wallet(self):
        fields = self.fields()
        manifest = {**fields, 'fileSha256': hashlib.sha256(PDF).hexdigest()}
        outsider_proof = self.proof('create', '', manifest, self.other)
        self.assertEqual(403, self.create(fields, proof=outsider_proof).status_code)
        self.assertEqual(0, len(self.submissions))

    def test_provider_wrong_source_hash_is_not_accepted_as_completed(self):
        self.result = {**self.provider_job('completed'), 'source_sha256': '0'*64}
        response = self.create()
        self.assertEqual('submission_unknown', response.json['evaluation']['state'])
        self.assertEqual(409, self.prepare(response.json['id']).status_code)
        self.assertEqual(0, self.count('credit_cases'))

    def test_identity_continues_existing_job_without_reupload_or_changing_applicant(self):
        self.result = self.provider_job('awaiting_identity')
        app_id = self.create().json['id']
        with patch.object(workflow.patent_api, 'identify', return_value=self.provider_job('completed')) as identify:
            self.assertEqual(400, self.call(app_id, 'identity', business_number='9999999999').status_code)
            self.assertEqual(200, self.call(app_id, 'identity', business_number='1234567890').status_code)
        identify.assert_called_once_with('provider-job-1', '1234567890')
        self.assertEqual(1, len(self.submissions))


if __name__ == '__main__':
    unittest.main()
