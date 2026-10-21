import hashlib
import io
import json
import unittest
from unittest.mock import patch

from PIL import Image
from server import token_media


class TokenMediaTest(unittest.TestCase):
    application = {'id': 'LN-2026-0012', 'ipTitle': '스마트센서 "특허" <평가>',
                   'company': '테스트기업', 'ceo': '홍길동', 'docKey': 'SECRET', 'contact': 'PRIVATE'}

    def test_png_and_public_json_for_both_token_types(self):
        files = {}

        def upload(body, filename, mime):
            cid = 'bafy' + hashlib.sha256(body).hexdigest()
            files[cid] = (body, mime)
            return {'cid': cid}

        result = token_media.prepare(self.application, upload)
        self.assertEqual(len(files), 4)
        for prefix in ('sbt', 'debt'):
            metadata = json.loads(files[result[prefix + 'MetadataUri'][7:]][0])
            self.assertIn('홍길동', str(metadata['attributes']))
            self.assertIn(self.application['ipTitle'], metadata['name'])
            self.assertEqual(metadata['image'], result[prefix + 'ImageUri'])
            self.assertNotIn('SECRET', json.dumps(metadata))
            self.assertNotIn('PRIVATE', json.dumps(metadata))
            image_bytes, mime = files[metadata['image'][7:]]
            self.assertEqual(mime, 'image/png')
            with Image.open(io.BytesIO(image_bytes)) as image:
                self.assertEqual(image.size, (1200, 1200))
                self.assertEqual(image.format, 'PNG')
        self.assertNotEqual(result['sbtImageUri'], result['debtImageUri'])

    def test_generation_failure_prevents_uploads(self):
        with patch.object(token_media, 'font', side_effect=token_media.TokenMediaError('font')), \
                patch('server.token_media.card', wraps=token_media.card):
            calls = []
            with self.assertRaises(token_media.TokenMediaError):
                token_media.prepare(self.application, lambda *args: calls.append(args))
            self.assertEqual(calls, [])

    def test_upload_failure_is_not_reported_as_prepared(self):
        def fail(*args):
            raise RuntimeError('IPFS failed')
        with self.assertRaisesRegex(RuntimeError, 'IPFS failed'):
            token_media.prepare(self.application, fail)


if __name__ == '__main__':
    unittest.main()
