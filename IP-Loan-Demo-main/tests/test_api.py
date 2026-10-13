"""requirements 설치 후 자동 실행되는 API 실제 Flask 테스트.

Flask 미설치 환경에서는 이 모듈을 건너뜁니다.
"""
import hashlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

BASE = Path(__file__).resolve().parents[1] / 'server'
sys.path.insert(0, str(BASE))
try:
    import flask
except ImportError:
    flask = None


@unittest.skipIf(flask is None, 'Flask 미설치: pip install -r server/requirements.txt 후 실행')
class ApiIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        os.environ['IPLOAN_DB_PATH'] = str(Path(cls.tmp.name) / 'test.db')
        os.environ['IPLOAN_UPLOAD_DIR'] = str(Path(cls.tmp.name) / 'uploads')
        os.environ['IPLOAN_DEMO_MODE'] = 'true'
        os.environ['IPLOAN_CHAIN_MODE'] = 'demo'
        os.environ.pop('OPENAI_API_KEY', None)
        os.environ.pop('IPLOAN_API_KEY', None)
        os.environ['IPLOAN_ADMIN_KEY'] = 'test-admin-only'
        import app as webapp
        cls.webapp = webapp

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def setUp(self):
        self.client = self.webapp.app.test_client()

    def create_case(self, amount=10_000_000):
        response = self.client.post('/api/applications', json={
            'company': '테스트기업', 'ipTitle': '테스트 특허', 'ipType': '특허권',
            'ipRegNo': '10-2026-1', 'amount': amount, 'termMonths': 12,
        })
        self.assertEqual(response.status_code, 201, response.json)
        return response.json['id']

    def test_health_and_static(self):
        self.assertEqual(self.client.get('/api/health').status_code, 200)
        self.assertEqual(self.client.get('/').status_code, 200)
        self.assertEqual(self.client.get('/js/app.js').status_code, 200)
        self.assertEqual(self.client.get('/server/app.py').status_code, 404)

    def test_evaluation_review_rwa_repay(self):
        id = self.create_case()
        upload = self.client.post(f'/api/applications/{id}/documents', data={'files': (io.BytesIO(b'%PDF-1.4\nDEMO\n%%EOF'), 'demo.pdf')}, content_type='multipart/form-data')
        self.assertEqual(upload.status_code, 201, upload.json)
        r = self.client.post(f'/api/applications/{id}/evaluation', json={})
        self.assertEqual(r.status_code, 200, r.json)
        self.assertEqual(r.json['_report']['mode'], 'demo_template')
        r = self.client.post(f'/api/applications/{id}/evaluation/confirm', json={})
        self.assertEqual(r.status_code, 200, r.json)
        self.assertEqual(r.json['chain']['mode'], 'simulated')
        r = self.client.post(f'/api/applications/{id}/review', json={'creditScore': 80})
        self.assertEqual(r.status_code, 200, r.json)
        self.assertTrue(r.json['review']['passed'])
        r = self.client.post(f'/api/applications/{id}/decision', json={'action': 'approve'})
        self.assertEqual(r.status_code, 200, r.json)
        self.assertIn('loan', r.json)
        r = self.client.post(f'/api/applications/{id}/rwa', json={})
        self.assertEqual(r.status_code, 201, r.json)
        r = self.client.post(f'/api/applications/{id}/rwa/transfer', json={})
        self.assertEqual(r.json['token']['state'], 'pledged')
        total = r.json['loan']['remaining']
        r = self.client.post(f'/api/applications/{id}/repay', json={'amount': total})
        self.assertEqual(r.status_code, 200, r.json)
        self.assertEqual(r.json['loan']['state'], 'repaid')
        self.assertEqual(r.json['token']['state'], 'released')

    def test_file_upload_sha_and_reference_mismatch(self):
        id = self.create_case()
        content = b'%PDF-1.4\nhello\n%%EOF'
        resp = self.client.post(f'/api/applications/{id}/documents', data={
            'files': (io.BytesIO(content), 'test.pdf')
        }, content_type='multipart/form-data')
        self.assertEqual(resp.status_code, 201, resp.json)
        document = resp.json['documents'][0]
        self.assertEqual(document['sha256'], hashlib.sha256(content).hexdigest())
        resp = self.client.post(f'/api/applications/{id}/documents/{document["id"]}/verify',
                                json={'referenceSha256': '0' * 64})
        self.assertEqual(resp.status_code, 200, resp.json)
        self.assertFalse(resp.json['matchesSuppliedReference'])
        self.assertFalse(resp.json['issuerVerified'])
        self.client.post(f'/api/applications/{id}/evaluation', json={})
        self.client.post(f'/api/applications/{id}/evaluation/confirm', json={})
        resp = self.client.post(f'/api/applications/{id}/review', json={'creditScore': 80})
        self.assertFalse(resp.json['review']['passed'])
        self.assertEqual(self.client.post(f'/api/applications/{id}/decision',json={'action':'approve'}).status_code, 409)

    def test_direct_status_patch_disallowed(self):
        id = self.create_case()
        self.assertEqual(self.client.patch(f'/api/applications/{id}',json={'status':'approved'}).status_code, 403)

    def test_reset_needs_admin_key(self):
        self.assertEqual(self.client.post('/api/reset',json={}).status_code, 401)
        self.assertEqual(self.client.post('/api/reset',json={}, headers={'X-API-Key':'test-admin-only'}).status_code, 200)


if __name__ == '__main__':
    unittest.main()
