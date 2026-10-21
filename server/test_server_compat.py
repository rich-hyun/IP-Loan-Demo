"""Flask 설치 환경에서 실행하는 HTTP 호환성 테스트.

실행: cd server && ./venv/bin/python -m unittest -v test_server_compat
테스트는 별도의 임시 DB와 업로드 디렉터리만 사용합니다.
"""
import io
import os
import tempfile
import unittest
from pathlib import Path

# 운영 DB에 영향을 주지 않도록 import 전에 별도 DB 환경 지정
_tmp = tempfile.TemporaryDirectory(prefix='iploan-test-')
os.environ['IPLOAN_PATENT_DB_PATH'] = str(Path(_tmp.name) / 'test.db')
os.environ['IPLOAN_PATENT_UPLOAD_DIR'] = str(Path(_tmp.name) / 'uploads')
os.environ.pop('IPLOAN_ENABLE_RESET', None)
os.environ.pop('IPLOAN_ADMIN_KEY', None)
os.environ.pop('IPLOAN_EXPOSE_PUBLIC_PERSONAL_DATA', None)

import patent_app as server  # noqa E402; 실제 실행되는 서버를 임시 DB에서 검사

PDF = b'%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n'


class TestApiCompatibility(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = server.app.test_client()

    def test_01_health(self):
        res = self.client.get('/api/health')
        self.assertEqual(200, res.status_code)
        self.assertEqual('ok', res.json['status'])

    def test_02_preserve_seed_and_backfill_profiles(self):
        apps = self.client.get('/api/applications').json
        profiles = self.client.get('/api/borrower-profiles').json
        self.assertEqual(8, len(apps))
        self.assertEqual(8, len(profiles))
        self.assertTrue(all(a['borrowerProfileId'] for a in apps))

    def test_03_legacy_json_post(self):
        res = self.client.post('/api/applications', json={
            'company': '테스트(주)', 'bizNo': '111-22-33333',
            'ipTitle': '테스트 IP', 'amount': 15000000,
        })
        self.assertEqual(201, res.status_code, res.get_data(as_text=True))
        self.assertEqual('테스트(주)', res.json['company'])
        self.assertTrue(res.json['borrowerProfile']['id'])

    def test_04_multipart_pdf_and_sha(self):
        res = self.client.post('/api/applications', data={
            'company': '시험업로드기업', 'bizNo': '999-88-77777',
            'ceo': '테스트 담당자', 'contact': '000-0000-0000',
            'amount': '20000000', 'ipTitle': '시험 특허',
            'registryDocument': (io.BytesIO(PDF), 'patent.pdf'),
        }, content_type='multipart/form-data')
        self.assertEqual(201, res.status_code, res.get_data(as_text=True))
        self.assertTrue(res.json['docFileHash'].startswith('0x'))
        self.assertIsNone(res.json['docCid'])
        self.assertEqual('local', res.json['storageMode'])
        self.assertIs(False, res.json['ipfsUploaded'])
        self.assertEqual('시험업로드기업', res.json['borrowerProfile']['company'])
        # 공용 목록에서 이름·연락처 필드는 보호되어야 함
        row = next(a for a in self.client.get('/api/applications').json if a['id'] == res.json['id'])
        self.assertNotIn('contact', row)
        self.assertNotIn('ceo', row)

    def test_05_reject_invalid_file(self):
        res = self.client.post('/api/applications', data={
            'company': '문서오류', 'amount': '100000',
            'registryDocument': (io.BytesIO(b'not-a-pdf'), 'fake.pdf'),
        }, content_type='multipart/form-data')
        self.assertEqual(400, res.status_code)

    def test_06_reset_disabled(self):
        res = self.client.post('/api/reset')
        self.assertEqual(403, res.status_code)


if __name__ == '__main__':
    try:
        unittest.main(verbosity=2)
    finally:
        _tmp.cleanup()
