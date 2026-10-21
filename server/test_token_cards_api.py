import io
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from flask import Flask
from PIL import Image
from server import token_cards_api


class TokenCardsAPITest(unittest.TestCase):
    def setUp(self):
        token_cards_api.render.cache_clear()
        self.record = {'id': 'LN-2026-1234', 'appKey': '0x1234', 'chainId': 31337,
                       'managerAddress': 'manager', 'evaluatorWallet': 'evaluator', 'bankWallet': 'bank',
                       'company': '테스트기업', 'ceo': '테스트 대표', 'ipTitle': '실제 카드 제목',
                       'docKey': 'SECRET-KEY', 'contact': 'PRIVATE-CONTACT', 'bizNo': 'PRIVATE-BIZ'}
        self.stage = 'Approved'
        self.fail = False
        class ChainError(Exception):
            pass
        def snapshot(_):
            if self.fail:
                raise ChainError('RPC unavailable')
            return {'chainStatus': self.stage, 'sbtTokenId': '7', 'chainBlock': 55}
        app = Flask(__name__)
        native = SimpleNamespace(app=app, find_application=lambda key: self.record if key == self.record['id'] else None,
                                 error_response=lambda msg, status, code: ({'message': msg, 'error': code}, status),
                                 chain=SimpleNamespace(ChainError=ChainError, snapshot=snapshot,
                                     config=lambda: {'accessSBTAddress': 'sbt-contract', 'debtNFTAddress': 'nft-contract'}))
        token_cards_api.register(native)
        self.client = app.test_client()
        self.url = '/api/applications/' + self.record['id']

    def test_approved_nft_and_burned_sbt_use_their_own_contracts(self):
        result = self.client.get(self.url + '/tokens').get_json()
        sbt, debt = result['tokens']
        self.assertEqual((sbt['state'], sbt['owner']), ('burned', None))
        self.assertEqual((debt['state'], debt['owner'], debt['tokenId']), ('issued', 'bank', '7'))
        self.assertEqual(debt['contractAddress'], 'nft-contract')
        self.assertNotEqual(debt['contractAddress'], self.record['managerAddress'])
        self.assertFalse(result['walletImageAvailable'])
        self.assertNotIn('SECRET', str(result))

    def test_earlier_stages_never_claim_a_debt_nft_was_issued(self):
        for stage in ('None', 'Evaluating', 'Eligible', 'RuleRejected', 'Rejected'):
            with self.subTest(stage=stage):
                self.stage = stage
                sbt, debt = self.client.get(self.url + '/tokens').get_json()['tokens']
                self.assertEqual(debt['state'], 'pending')
                self.assertIsNone(debt['owner'])
                self.assertEqual(sbt['state'], 'issued' if stage == 'Evaluating' else 'pending' if stage == 'None' else 'burned')

    def test_ipfs_artwork_and_metadata_are_reported_separately_from_legacy_previews(self):
        for prefix in ('sbt', 'debt'):
            self.record[prefix+'MetadataUri'] = 'ipfs://bafyMetadata123456789'
            self.record[prefix+'ImageUri'] = 'ipfs://bafyImage123456789012'
        result = self.client.get(self.url+'/tokens').get_json()
        self.assertTrue(result['walletImageAvailable'])
        self.assertEqual(result['artworkSource'],'ipfs')
        self.assertEqual(result['tokens'][1]['metadataUri'],self.record['debtMetadataUri'])
        self.assertTrue(result['tokens'][1]['imageUrl'].endswith('bafyImage123456789012'))
        self.stage = 'None'
        result = self.client.get(self.url+'/tokens').get_json()
        self.assertFalse(result['walletImageAvailable'])

    def test_real_png_is_cached_and_renderer_never_receives_private_fields(self):
        with patch.object(token_cards_api.token_media, 'card', wraps=token_cards_api.token_media.card) as card:
            response = self.client.get(self.url + '/token-cards/debt.png')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.mimetype, 'image/png')
            with Image.open(io.BytesIO(response.data)) as image:
                self.assertEqual(image.size, (1200, 1200))
            self.assertEqual(set(card.call_args.args[0]), {'id', 'company', 'ceo', 'ipTitle'})
            repeated = self.client.get(self.url + '/token-cards/debt.png', headers={'If-None-Match': response.headers['ETag']})
            self.assertEqual(repeated.status_code, 304)
            self.assertEqual(card.call_count, 1)

    def test_https_cid_urls_are_used_directly_and_arbitrary_hosts_are_not_published(self):
        base = token_cards_api.token_media.HTTPS_GATEWAY
        for prefix in ('sbt','debt'):
            self.record[prefix+'MetadataUri'] = base+'bafyMetadata123456'
            self.record[prefix+'ImageUri'] = base+'bafyImage123456789'
        result = self.client.get(self.url+'/tokens').get_json()
        self.assertTrue(result['walletImageAvailable'])
        self.assertEqual(result['tokens'][1]['imageUrl'], self.record['debtImageUri'])
        self.record['debtImageUri'] = 'https://evil.test/track'
        result = self.client.get(self.url+'/tokens').get_json()
        self.assertFalse(result['walletImageAvailable'])
        self.assertNotIn('imageUrl', result['tokens'][1])

    def test_invalid_targets_and_rpc_failure_do_not_show_false_ownership(self):
        self.assertEqual(self.client.get('/api/applications/missing/tokens').status_code, 404)
        self.assertEqual(self.client.get(self.url + '/token-cards/secret.png').status_code, 404)
        self.fail = True
        self.assertEqual(self.client.get(self.url + '/tokens').status_code, 503)


if __name__ == '__main__':
    unittest.main()
