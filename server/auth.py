"""Wallet sign-in: one-time challenge messages, signature checks and opaque session tokens.

A session only proves which wallet signed in. Roles are always read from the chain (chain.roles),
so revoking a role takes effect without clearing sessions. Challenges and sessions live in SQLite
because gunicorn runs several workers that do not share memory.
"""
import hashlib
import re
import secrets
from datetime import datetime, timedelta, timezone

from eth_account import Account
from eth_account.messages import encode_defunct

CHALLENGE_TTL = timedelta(minutes=5)
SESSION_TTL = timedelta(hours=12)
MAX_OPEN_CHALLENGES = 1000
SIGNATURE_PATTERN = re.compile(r"0x[0-9a-fA-F]{130}")

SCHEMA = [
    "CREATE TABLE IF NOT EXISTS auth_challenges (nonce TEXT PRIMARY KEY, address TEXT NOT NULL, "
    "message TEXT NOT NULL, expiresAt TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS sessions (tokenHash TEXT PRIMARY KEY, address TEXT NOT NULL, "
    "createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL)",
]


class AuthError(Exception):
    def __init__(self, message, status_code=401):
        super().__init__(message)
        self.status_code = status_code


def _now():
    return datetime.now(timezone.utc)


def _stamp(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def create_challenge(conn, wallet, chain_id, service):
    now = _now()
    conn.execute("DELETE FROM auth_challenges WHERE expiresAt < ?", (_stamp(now),))
    if conn.execute("SELECT COUNT(*) FROM auth_challenges").fetchone()[0] >= MAX_OPEN_CHALLENGES:
        conn.commit()
        raise AuthError("로그인 요청이 많습니다. 잠시 후 다시 시도하세요.", 429)
    nonce = secrets.token_urlsafe(24)
    message = (f"{service}에 지갑으로 로그인합니다.\n"
               "거래가 아니며 수수료가 발생하지 않습니다.\n\n"
               f"주소: {wallet}\n체인 ID: {chain_id}\nnonce: {nonce}\n"
               f"발급 시각: {_stamp(now)}\n만료 시각: {_stamp(now + CHALLENGE_TTL)}")
    conn.execute("INSERT INTO auth_challenges VALUES (?, ?, ?, ?)", (nonce, wallet, message, _stamp(now + CHALLENGE_TTL)))
    conn.commit()
    return {"nonce": nonce, "message": message}


def verify_challenge(conn, wallet, nonce, signature):
    """Consumes the challenge (one use only) and checks that `wallet` signed exactly that message."""
    row = conn.execute("SELECT * FROM auth_challenges WHERE nonce = ?", (nonce,)).fetchone()
    consumed = conn.execute("DELETE FROM auth_challenges WHERE nonce = ?", (nonce,)).rowcount
    conn.commit()
    if row is None or not consumed or row["address"] != wallet or row["expiresAt"] < _stamp(_now()):
        raise AuthError("만료되었거나 이미 사용한 로그인 요청입니다. 다시 로그인하세요.")
    if not isinstance(signature, str) or not SIGNATURE_PATTERN.fullmatch(signature):
        raise AuthError("올바른 지갑 서명을 제출하세요.")
    signer = Account.recover_message(encode_defunct(text=row["message"]), signature=signature)
    if signer.lower() != wallet.lower():
        raise AuthError("지갑 서명을 확인하지 못했습니다.")


def create_session(conn, wallet):
    now = _now()
    token = secrets.token_urlsafe(32)
    expires = _stamp(now + SESSION_TTL)
    conn.execute("DELETE FROM sessions WHERE expiresAt < ?", (_stamp(now),))
    conn.execute("INSERT INTO sessions VALUES (?, ?, ?, ?)", (token_hash(token), wallet, _stamp(now), expires))
    conn.commit()
    return token, expires


def session_wallet(conn, token):
    row = conn.execute("SELECT address, expiresAt FROM sessions WHERE tokenHash = ?", (token_hash(token),)).fetchone()
    if row is None or row["expiresAt"] < _stamp(_now()):
        return None
    return row["address"]


def end_session(conn, token):
    conn.execute("DELETE FROM sessions WHERE tokenHash = ?", (token_hash(token),))
    conn.commit()
