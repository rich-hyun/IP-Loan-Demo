"""Wallet sign-in (challenge → session token) and the session as proof for the legacy original-document view.

Temporary SQLite only; the chain is a test double. Session proof for loan_workflow.authorize is in test_loan_workflow.
"""
from contextlib import closing
import base64
import hashlib
import os
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from datetime import timedelta
from unittest.mock import Mock, patch

from eth_account import Account
from eth_account.messages import encode_defunct
from web3 import Web3

_import_tmp = tempfile.TemporaryDirectory(prefix='auth-import-')
os.environ.setdefault('IPLOAN_DB_PATH', str(Path(_import_tmp.name) / 'loans.db'))
os.environ.setdefault('IPLOAN_PATENT_DB_PATH', str(Path(_import_tmp.name) / 'patents.db'))
os.environ.setdefault('IPLOAN_PATENT_UPLOAD_DIR', str(Path(_import_tmp.name) / 'uploads'))
from server import app as native  # noqa: E402
from server import auth, chain  # noqa: E402

REAL_ROLES = chain.roles
PDF = b'%PDF-1.4\nfictional registry for auth test\n%%EOF'


def sign(message, signer):
    return '0x' + Account.sign_message(encode_defunct(text=message), signer.key).signature.hex().removeprefix('0x')


class SessionTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='auth-')
        self.addCleanup(self.tmp.cleanup)
        self.held = {}
        for target, name, value in [
            (native, 'DB_PATH', str(Path(self.tmp.name) / 'loans.db')),
            (chain, 'roles', lambda wallet: list(self.held.get(chain.address(wallet), []))),
        ]:
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        config = patch.dict(native.app.config, {'TESTING': True})
        config.start()
        self.addCleanup(config.stop)
        native.ROLE_CACHE.clear()
        self.addCleanup(native.ROLE_CACHE.clear)
        native.init_db()
        self.client = native.app.test_client()

    def challenge(self, address):
        response = self.client.post('/api/auth/challenge', json={'address': address})
        self.assertEqual(200, response.status_code, response.get_data(as_text=True))
        return response.json

    def login(self, signer, **changes):
        challenge = self.challenge(signer.address)
        return self.client.post('/api/auth/login', json={'address': signer.address, 'nonce': challenge['nonce'],
                                                         'signature': sign(challenge['message'], signer), **changes})

    def token(self, signer):
        response = self.login(signer)
        self.assertEqual(200, response.status_code, response.get_data(as_text=True))
        return response.json['token']

    def me(self, token):
        return self.client.get('/api/auth/me', headers={'Authorization': f'Bearer {token}'})

    def logout(self, token):
        return self.client.post('/api/auth/logout', headers={'Authorization': f'Bearer {token}'})

    def count(self, table):
        with closing(sqlite3.connect(native.DB_PATH)) as db, db:
            return db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]

    def expire_sessions(self):
        with closing(sqlite3.connect(native.DB_PATH)) as db, db:
            db.execute("UPDATE sessions SET expiresAt='2000-01-01T00:00:00Z'")


class AuthEndpointTests(SessionTestCase):
    def setUp(self):
        super().setUp()
        self.wallet, self.other = Account.create(), Account.create()
        self.held[self.wallet.address] = ['borrower']

    def test_challenge_names_service_and_chain_and_login_returns_a_hashed_session(self):
        challenge = self.challenge(self.wallet.address.lower())
        self.assertEqual({'nonce', 'message'}, set(challenge))
        self.assertTrue(challenge['message'].startswith('IP담보 자동대출에 지갑으로 로그인합니다.'))
        for line in (f'주소: {self.wallet.address}', f'체인 ID: {chain.CHAIN_ID}', f'nonce: {challenge["nonce"]}'):
            self.assertIn(line, challenge['message'])
        response = self.client.post('/api/auth/login', json={'address': self.wallet.address.lower(), 'nonce': challenge['nonce'],
                                                             'signature': sign(challenge['message'], self.wallet)})
        self.assertEqual(200, response.status_code, response.get_data(as_text=True))
        self.assertEqual({'token', 'address', 'roles', 'expiresAt'}, set(response.json))
        self.assertEqual((self.wallet.address, ['borrower']), (response.json['address'], response.json['roles']))
        self.assertRegex(response.json['expiresAt'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')
        token = response.json['token']
        self.assertEqual({'address': self.wallet.address, 'roles': ['borrower']}, self.me(token).json)
        with closing(sqlite3.connect(native.DB_PATH)) as db, db:
            rows = db.execute('SELECT tokenHash, address FROM sessions').fetchall()
        self.assertEqual([(hashlib.sha256(token.encode()).hexdigest(), self.wallet.address)], rows)
        self.assertEqual(0, self.count('auth_challenges'))

    def test_wrong_signer_reused_expired_and_malformed_requests_get_no_session(self):
        challenge = self.challenge(self.wallet.address)
        body = {'address': self.wallet.address, 'nonce': challenge['nonce']}
        wrong = self.client.post('/api/auth/login', json={**body, 'signature': sign(challenge['message'], self.other)})
        self.assertEqual((401, 'login_failed'), (wrong.status_code, wrong.json['error']))
        # A failed attempt still consumes the challenge.
        self.assertEqual(401, self.client.post('/api/auth/login', json={**body, 'signature': sign(challenge['message'], self.wallet)}).status_code)
        # A challenge is bound to the address it was issued for.
        challenge = self.challenge(self.wallet.address)
        stolen = {'address': self.other.address, 'nonce': challenge['nonce'], 'signature': sign(challenge['message'], self.other)}
        self.assertEqual(401, self.client.post('/api/auth/login', json=stolen).status_code)
        # Reuse after a successful login.
        challenge = self.challenge(self.wallet.address)
        good = {'address': self.wallet.address, 'nonce': challenge['nonce'], 'signature': sign(challenge['message'], self.wallet)}
        self.assertEqual(200, self.client.post('/api/auth/login', json=good).status_code)
        self.assertEqual(401, self.client.post('/api/auth/login', json=good).status_code)
        # Expired: signed correctly, but more than 5 minutes later.
        challenge = self.challenge(self.wallet.address)
        later = auth._now() + timedelta(minutes=6)
        with patch.object(auth, '_now', return_value=later):
            expired = self.client.post('/api/auth/login', json={'address': self.wallet.address, 'nonce': challenge['nonce'],
                                                                'signature': sign(challenge['message'], self.wallet)})
        self.assertEqual(401, expired.status_code)
        for signature in ('0x1234', None, ['0x'], '0x' + 'zz' * 65, '0x' + '00' * 65):
            challenge = self.challenge(self.wallet.address)
            response = self.client.post('/api/auth/login', json={'address': self.wallet.address, 'nonce': challenge['nonce'], 'signature': signature})
            self.assertEqual(401, response.status_code, signature)
        self.assertEqual(400, self.client.post('/api/auth/login', json={'address': self.wallet.address}).status_code)
        self.assertEqual(400, self.client.post('/api/auth/login', json=['x']).status_code)
        self.assertEqual(400, self.client.post('/api/auth/login', json={'address': 'not-a-wallet', 'nonce': 'x'}).status_code)
        for body in ({'address': 'not-a-wallet'}, {'address': '0x' + '00' * 20}, {}, ['x']):
            response = self.client.post('/api/auth/challenge', json=body)
            self.assertEqual((400, 'invalid_address'), (response.status_code, response.json['error']), body)
        self.assertEqual(1, self.count('sessions'))

    def test_me_and_logout_need_a_live_session(self):
        self.assertEqual((401, 'login_required'), (self.client.get('/api/auth/me').status_code, self.client.get('/api/auth/me').json['error']))
        self.assertEqual(401, self.me('unknown-token').status_code)
        self.assertEqual(401, self.client.get('/api/auth/me', headers={'Authorization': 'Basic abc'}).status_code)
        token, kept = self.token(self.wallet), self.token(self.wallet)
        self.assertEqual(200, self.me(token).status_code)
        logout = self.logout(token)
        self.assertEqual((200, {'status': 'ok'}), (logout.status_code, logout.json))
        self.assertEqual(401, self.me(token).status_code)
        self.assertEqual(401, self.logout(token).status_code)
        self.assertEqual(401, self.client.post('/api/auth/logout').status_code)
        self.assertEqual(200, self.me(kept).status_code)  # logout ends only that session
        later = auth._now() + timedelta(hours=12, minutes=1)
        with patch.object(auth, '_now', return_value=later):
            self.assertEqual(401, self.me(kept).status_code)

    def test_roles_are_cached_briefly_and_read_fresh_at_login(self):
        token = self.token(self.wallet)
        self.assertEqual(['borrower'], self.me(token).json['roles'])
        self.held[self.wallet.address] = ['evaluator', 'admin']
        self.assertEqual(['borrower'], self.me(token).json['roles'])
        with patch.object(native.time, 'monotonic', return_value=time.monotonic() + native.ROLE_CACHE_SECONDS + 1):
            self.assertEqual(['admin', 'evaluator'], self.me(token).json['roles'])
        self.held[self.wallet.address] = ['bank']
        login = self.login(self.wallet)
        self.assertEqual(['bank'], login.json['roles'])
        self.assertEqual(['bank'], self.me(token).json['roles'])  # login also refreshes the cache for other sessions
        self.held[self.wallet.address] = []
        self.assertEqual([], self.login(self.wallet).json['roles'])  # no role is still a valid sign-in

    def test_login_and_me_answer_503_without_a_configured_or_reachable_chain(self):
        token = self.token(self.wallet)
        native.ROLE_CACHE.clear()
        for settings in ({'MANAGER_ADDRESS': ''}, {'MANAGER_ADDRESS': '0x' + '12' * 20, 'RPC_URL': 'http://127.0.0.1:9'}):
            with patch.object(chain, 'roles', REAL_ROLES), patch.multiple(chain, **settings):
                login = self.login(self.wallet)
                self.assertEqual((503, 'chain_unavailable'), (login.status_code, login.json['error']), settings)
                me = self.me(token)
                self.assertEqual((503, 'chain_unavailable'), (me.status_code, me.json['error']), settings)
        self.assertEqual(1, self.count('sessions'))
        with patch.object(chain, 'roles', REAL_ROLES), patch.object(chain, 'MANAGER_ADDRESS', ''):
            self.assertEqual(200, self.logout(token).status_code)  # logout needs no chain read


class FakeManager:
    def __init__(self, held, broken=False):
        manager = self

        class Call:
            def __init__(self, role_id, wallet):
                self.role_id, self.wallet = role_id, wallet

            def call(self):
                if broken:
                    raise ConnectionError('rpc dropped')
                return (bytes(self.role_id), self.wallet) in manager.held

        self.held = held
        self.functions = Mock(hasRole=Call)


class RoleNameTests(SessionTestCase):
    def test_contract_roles_map_to_login_names_including_default_admin(self):
        admin, borrower, nobody = (Account.create().address for _ in range(3))
        role = lambda name: bytes(Web3.keccak(text=name))
        held = {(role('BORROWER_ROLE'), borrower), (role('EVALUATOR_ROLE'), admin), (role('BANK_ROLE'), admin),
                (b'\x00' * 32, admin), (role('ADMIN_ROLE'), nobody)}
        with patch.object(chain, '_manager', return_value=(None, FakeManager(held))):
            self.assertEqual(['evaluator', 'bank', 'admin'], REAL_ROLES(admin))
            self.assertEqual(['borrower'], REAL_ROLES(borrower.lower()))
            self.assertEqual([], REAL_ROLES(nobody))
            # Through the endpoints: sorted names.
            with patch.object(chain, 'roles', REAL_ROLES):
                signer = Account.create()
                held.update({(role('BANK_ROLE'), signer.address), (b'\x00' * 32, signer.address)})
                login = self.login(signer)
                self.assertEqual(['admin', 'bank'], login.json['roles'])
                self.assertEqual(['admin', 'bank'], self.me(login.json['token']).json['roles'])
        with patch.object(chain, '_manager', return_value=(None, FakeManager(held, broken=True))):
            with self.assertRaises(chain.ChainError):
                REAL_ROLES(admin)


class LegacyDocumentLoginTests(SessionTestCase):
    """POST /api/applications/<id>/document takes {login} in place of {nonce, signature}; access checks are unchanged."""

    def setUp(self):
        super().setUp()
        self.borrower, self.evaluator, self.bank, self.other = (Account.create() for _ in range(4))
        self.roles = {self.borrower.address: 'BORROWER_ROLE', self.evaluator.address: 'EVALUATOR_ROLE', self.bank.address: 'BANK_ROLE'}
        self.held.update({wallet: [chain.ROLE_NAMES[role]] for wallet, role in self.roles.items()})
        self.stage = 'Evaluating'
        encrypted = native.encrypt_registry_document(PDF)
        self.app_id = 'LN-2026-7001'
        with closing(sqlite3.connect(native.DB_PATH)) as db, db:
            db.execute('INSERT INTO applications (id, company, amount, status, hashMatch, appKey, docCid, docKey, docSalt, '
                       'docFileHash, borrowerWallet, evaluatorWallet, bankWallet) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                       (self.app_id, '가상 기업', 70, 'evaluating', 1, Web3.to_hex(Web3.keccak(text=self.app_id)), 'bafyLegacyDocument123',
                        base64.b64encode(encrypted['key']).decode(), base64.b64encode(encrypted['salt']).decode(),
                        encrypted['file_hash'], self.borrower.address, self.evaluator.address, self.bank.address))
        gateway = Mock()
        gateway.iter_content.side_effect = lambda size: iter([encrypted['payload']])
        self.gateway = Mock(return_value=gateway)
        for target, name, value in [(native.requests, 'get', self.gateway),
                                    (chain, 'snapshot', lambda application: {'chainStatus': self.stage}),
                                    (chain, 'has_role', lambda wallet, role: self.roles.get(wallet) == role)]:
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def read(self, **body):
        return self.client.post(f'/api/applications/{self.app_id}/document', json=body)

    def test_session_opens_the_original_for_the_assigned_participant_at_the_allowed_stage(self):
        evaluator = self.token(self.evaluator)
        for _ in range(2):  # a session is not one-use, unlike a document nonce
            response = self.read(login=evaluator)
            self.assertEqual(200, response.status_code, response.get_data(as_text=True))
            self.assertEqual(PDF, response.data)
        self.assertEqual(PDF, self.read(login=evaluator, address=self.evaluator.address.lower()).data)
        self.stage = 'Approved'
        self.assertEqual(PDF, self.read(login=self.token(self.bank)).data)
        self.assertEqual(403, self.read(login=evaluator).status_code)
        self.assertEqual(4, self.gateway.call_count)

    def test_session_is_refused_when_unknown_expired_logged_out_or_not_the_participant(self):
        evaluator, bank = self.token(self.evaluator), self.token(self.bank)
        refused = [{'login': 'unknown-token'}, {'login': ''}, {'login': self.token(self.borrower)}, {'login': self.token(self.other)},
                   {'login': bank},  # the bank only after approval
                   {'login': evaluator, 'address': self.bank.address},  # a different wallet than the session's
                   {'login': evaluator, 'address': 'not-a-wallet'}]
        for body in refused:
            response = self.read(**body)
            self.assertEqual((403, 'document_forbidden'), (response.status_code, response.json['error']), body)
        self.assertEqual('로그인이 만료되었습니다. 지갑으로 다시 로그인하세요.', self.read(login='unknown-token').json['message'])
        del self.roles[self.evaluator.address]  # role revoked after sign-in
        self.assertEqual(403, self.read(login=evaluator).status_code)
        self.roles[self.evaluator.address] = 'EVALUATOR_ROLE'
        self.assertEqual(200, self.logout(evaluator).status_code)
        self.assertEqual(403, self.read(login=evaluator).status_code)
        evaluator = self.token(self.evaluator)
        self.expire_sessions()
        self.assertEqual(403, self.read(login=evaluator).status_code)
        for body in ({}, {'login': 123}, {'login': None}, {'address': self.evaluator.address}):
            self.assertEqual(400, self.read(**body).status_code, body)
        self.assertEqual(0, self.gateway.call_count)

    def test_signature_path_is_unchanged(self):
        nonce = self.client.post(f'/api/applications/{self.app_id}/document-nonce', json={'address': self.evaluator.address}).json
        body = {**nonce, 'address': self.evaluator.address, 'signature': sign(nonce['message'], self.evaluator)}
        self.assertEqual(PDF, self.read(**body).data)
        self.assertEqual(403, self.read(**body).status_code)
        nonce = self.client.post(f'/api/applications/{self.app_id}/document-nonce', json={'address': self.other.address}).json
        self.assertEqual(403, self.read(**nonce, address=self.other.address, signature=sign(nonce['message'], self.other)).status_code)


if __name__ == '__main__':
    unittest.main()
