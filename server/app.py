"""
LLM 기반 기술평가 자동대출 시스템 — 백엔드 API (v3)

한 신청이 아래 흐름을 모두 거친다. 서버는 개인키 없이 체인을 읽기만 하고, 거래는 각 담당자가 MetaMask로 서명한다.
  지갑 로그인 → 차주 신청(등록원부 암호화·IPFS + 공고전문으로 LLM 보고서 생성) → 차주 온체인 등록
  → 담당 평가사가 LLM 보고서 검토·평가액 확정(보고서 암호화·IPFS, 해시 온체인) → 70% 자동심사
  → 담당 은행이 신용등급·금리·기간으로 최종 승인(대출계약 기록 + RWA 토큰 발급) → 상환 기록

실행 방법(로컬 테스트):
    pip install -r requirements.txt
    python3 app.py
    # http://127.0.0.1:5001/api/health 로 확인

운영 배포는 이 폴더의 README.md를 참고하세요 (systemd + gunicorn + nginx + HTTPS).
"""

import base64
import hashlib
import json
import os
import re
import secrets
import sqlite3
import tempfile
import time
from datetime import date, datetime, timezone
from functools import wraps
from pathlib import Path
from threading import Lock
from uuid import uuid4

import requests
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from flask import Flask, Response, g, jsonify, request
from flask_cors import CORS
from web3 import Web3
from werkzeug.utils import secure_filename

if __package__:
    from . import auth, chain
    from .patent_api import PatentAPIError, patent_api
else:
    import auth
    import chain
    from patent_api import PatentAPIError, patent_api

ROOT = Path(__file__).resolve().parent
DB_PATH = os.environ.get("IPLOAN_DB_PATH", str(ROOT / "iploan.db"))
UPLOAD_DIR = Path(os.environ.get("IPLOAN_UPLOAD_DIR", str(ROOT / "uploads"))).resolve()
# The former standalone patent-report DB; its LLM report jobs are imported once as read-only archive records.
PATENT_ARCHIVE_DB_PATH = Path(os.environ.get("IPLOAN_PATENT_DB_PATH", str(ROOT / "patent-iploan.db"))).resolve()
IPFS_UPLOAD_URL = os.environ.get("IPLOAN_IPFS_UPLOAD_URL", "https://api.mustree.kr/upload")
IPFS_GATEWAY = os.environ.get("IPLOAN_IPFS_GATEWAY", "https://rwa-gw.mustree.kr/ipfs/")
MAX_DOCUMENT_BYTES = int(os.environ.get("IPLOAN_MAX_DOCUMENT_BYTES", 20 * 1024 * 1024))
MAX_PATENT_BYTES = 50 * 1024 * 1024
MAX_REPORT_BYTES = 50 * 1024 * 1024
ROLE_CACHE_SECONDS = float(os.environ.get("IPLOAN_ROLE_CACHE_SECONDS", "30"))
CID_PATTERN = re.compile(r"^[A-Za-z0-9]{10,128}$")
SERVICE_NAME = "IP담보 자동대출 플랫폼"
ALLOWED_ORIGINS = [origin.strip() for origin in os.environ.get(
    "IPLOAN_ALLOWED_ORIGINS", "https://iploan.mustree.kr,http://127.0.0.1:8001,http://localhost:8001",
).split(",") if origin.strip()]

app = Flask(__name__)
app.json.ensure_ascii = False
app.config["MAX_CONTENT_LENGTH"] = MAX_DOCUMENT_BYTES + MAX_PATENT_BYTES + (1024 * 1024)
CORS(app, resources={r"/api/*": {"origins": ALLOWED_ORIGINS}}, allow_headers=["Content-Type", "Authorization"])

# Former demo applications (no wallet, no chain). Removed from existing databases on start-up.
LEGACY_DEMO_IDS = ("LN-2026-0088", "LN-2026-0090", "LN-2026-0091", "LN-2026-0094",
                   "LN-2026-0097", "LN-2026-0102", "LN-2026-0103", "LN-2026-0106")

SCHEMA = """
CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    company TEXT NOT NULL,
    bizNo TEXT,
    ipType TEXT,
    ipTitle TEXT,
    amount INTEGER,
    status TEXT,
    hash TEXT,
    appliedDate TEXT,
    appraisedValue INTEGER,
    ltv INTEGER,
    creditScore INTEGER,
    rate REAL,
    rejectReason TEXT,
    docCid TEXT,
    docIpfsUri TEXT,
    docFileHash TEXT,
    docKey TEXT,
    docSalt TEXT,
    docFileName TEXT,
    hashMatch INTEGER,
    ipRegNo TEXT
);
"""

MIGRATION_COLUMNS = {
    "appKey": "TEXT", "borrowerWallet": "TEXT", "evaluatorWallet": "TEXT", "bankWallet": "TEXT",
    "managerAddress": "TEXT", "chainId": "INTEGER", "chainStatus": "TEXT", "chainBlock": "INTEGER",
    "sbtTokenId": "TEXT", "debtTokenId": "TEXT", "reportCid": "TEXT", "reportHash": "TEXT", "repaidAmount": "INTEGER",
    "borrowerProfileId": "TEXT",
    "ceo": "TEXT",
    "contact": "TEXT",
    "docCid": "TEXT",
    "docIpfsUri": "TEXT",
    "docFileHash": "TEXT",
    "docKey": "TEXT",
    "docSalt": "TEXT",
    "docFileName": "TEXT",
    "hashMatch": "INTEGER",
    "ipRegNo": "TEXT",
    # v3: patent gazette for the LLM report, requested/approved loan terms and the RWA token.
    "termMonths": "INTEGER",
    "patentFileName": "TEXT",
    "patentStoredName": "TEXT",
    "patentSha256": "TEXT",
    "rwaTokenId": "TEXT",
    "creditGrade": "TEXT",
    "rateBps": "INTEGER",
    "approvedTermMonths": "INTEGER",
    "approvedAt": "INTEGER",
}

# Never returned by the API: encryption material and the private upload file name.
PRIVATE_FIELDS = {"docKey", "docSalt", "patentStoredName", "debtTokenId", "rate"}

PROFILE_SCHEMA = """
CREATE TABLE IF NOT EXISTS borrower_profiles (
    id TEXT PRIMARY KEY,
    company TEXT NOT NULL UNIQUE,
    bizNo TEXT NOT NULL DEFAULT '',
    ceo TEXT NOT NULL DEFAULT '',
    contact TEXT NOT NULL DEFAULT '',
    updatedAt TEXT NOT NULL
);
"""
PROFILE_LIMITS = {"company": 200, "bizNo": 50, "ceo": 100, "contact": 100}

JOB_SCHEMA = """
CREATE TABLE IF NOT EXISTS evaluation_jobs (
    appId TEXT PRIMARY KEY REFERENCES applications(id),
    jobId TEXT UNIQUE,
    status TEXT NOT NULL,
    stage TEXT,
    businessNumber TEXT,
    identityMessage TEXT,
    artifacts TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    detail TEXT,
    readError TEXT,
    retryAfter INTEGER,
    submittedAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    lastCheckedAt TEXT,
    confirmedAt TEXT,
    reviewerNote TEXT
);
"""
REPORT_COLUMNS = {"reportKey": "TEXT", "reportSalt": "TEXT", "kind": "TEXT", "note": "TEXT", "createdAt": "TEXT"}
ACTIVE_JOB_STATUSES = {"queued", "running", "awaiting_identity"}
STAFF_ROLES = {"evaluator", "bank", "admin"}


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def insert_profile(conn, record):
    # 이전 운영 DB에는 createdAt NOT NULL 컬럼이 있으므로 함께 보존한다.
    columns = ["id", "company", "bizNo", "ceo", "contact", "updatedAt", "ownerWallet"]
    if any(column[1] == "createdAt" for column in conn.execute("PRAGMA table_info(borrower_profiles)")):
        columns.append("createdAt")
        record = {**record, "createdAt": record["updatedAt"]}
    conn.execute(
        "INSERT INTO borrower_profiles (" + ", ".join(columns) + ") VALUES (" +
        ", ".join(":" + column for column in columns) + ")", record,
    )


def profile_values(data, existing=None):
    values = {}
    for key, limit in PROFILE_LIMITS.items():
        value = data.get(key, existing[key] if existing is not None else "")
        if not isinstance(value, str) or len(value.strip()) > limit:
            raise ValueError(f"{key} 입력값을 확인해 주세요. (최대 {limit}자)")
        values[key] = value.strip()
    if not values["company"]:
        raise ValueError("기업명을 입력해 주세요.")
    return values


def write_profile(conn, values, owner, profile_id=None):
    record = {**values, "id": profile_id or str(uuid4()), "updatedAt": timestamp(), "ownerWallet": owner}
    if profile_id:
        conn.execute(
            "UPDATE borrower_profiles SET company=:company, bizNo=:bizNo, ceo=:ceo, "
            "contact=:contact, updatedAt=:updatedAt WHERE id=:id AND ownerWallet=:ownerWallet", record,
        )
    else:
        insert_profile(conn, record)
    return public_profile(record)


def public_profile(row):
    return {key: row[key] for key in ("id", "company", "bizNo", "ceo", "contact", "updatedAt")}


class IpfsUploadError(Exception):
    """사용자에게 노출 가능한 IPFS 업로드 오류."""

    def __init__(self, message, status_code=502):
        super().__init__(message)
        self.status_code = status_code


def connect_db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def get_db():
    if "db" not in g:
        g.db = connect_db()
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def add_columns(conn, table, columns):
    existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    for column, column_type in columns.items():
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {column_type}")


def remove_legacy_demo_data(conn):
    """The seeded demo loans never had a wallet or chain record; v3 serves only real applications."""
    placeholders = ", ".join("?" for _ in LEGACY_DEMO_IDS)
    conn.execute(f"DELETE FROM applications WHERE appKey IS NULL AND status != 'archived' AND id IN ({placeholders})",
                 LEGACY_DEMO_IDS)
    # Profiles predate wallet login: give each to the wallet that last applied with it, drop the unused rest.
    conn.execute("UPDATE borrower_profiles SET ownerWallet = (SELECT borrowerWallet FROM applications "
                 "WHERE borrowerProfileId = borrower_profiles.id AND borrowerWallet IS NOT NULL "
                 "ORDER BY appliedDate DESC, rowid DESC LIMIT 1) WHERE ownerWallet IS NULL")
    conn.execute("DELETE FROM borrower_profiles WHERE ownerWallet IS NULL AND id NOT IN "
                 "(SELECT borrowerProfileId FROM applications WHERE borrowerProfileId IS NOT NULL)")


def import_patent_archive(conn):
    """Copy the LLM report jobs of the former patent-report screen as read-only archive records (idempotent)."""
    if not PATENT_ARCHIVE_DB_PATH.exists():
        return
    source = sqlite3.connect(f"file:{PATENT_ARCHIVE_DB_PATH}?mode=ro", uri=True, timeout=30)
    source.row_factory = sqlite3.Row
    try:
        rows = source.execute("""SELECT a.id, a.company, a.bizNo, a.ipType, a.ipTitle, a.amount, a.appliedDate,
            a.appraisedValue, a.ltv, a.creditScore, a.ipRegNo, a.ceo, a.contact, a.docFileHash,
            j.jobId, j.status AS jobStatus, j.stage, j.businessNumber, j.identityMessage, j.artifacts, j.error,
            j.detail, j.readError, j.retryAfter, j.submittedAt, j.updatedAt, j.lastCheckedAt, j.confirmedAt,
            j.reviewerNote
            FROM applications a JOIN evaluation_jobs j ON j.appId = a.id""").fetchall()
    except sqlite3.DatabaseError:
        return
    finally:
        source.close()
    for row in rows:
        conn.execute("""INSERT OR IGNORE INTO applications (id, company, bizNo, ipType, ipTitle, amount, status, hash,
            appliedDate, appraisedValue, ltv, creditScore, ipRegNo, ceo, contact, patentSha256)
            VALUES (?, ?, ?, ?, ?, ?, 'archived', '', ?, ?, ?, ?, ?, ?, ?, ?)""", (
            row["id"], row["company"], row["bizNo"], row["ipType"], row["ipTitle"], row["amount"], row["appliedDate"],
            row["appraisedValue"], row["ltv"], row["creditScore"], row["ipRegNo"], row["ceo"], row["contact"],
            row["docFileHash"]))
        conn.execute("""INSERT OR IGNORE INTO evaluation_jobs (appId, jobId, status, stage, businessNumber, identityMessage,
            artifacts, error, detail, readError, retryAfter, submittedAt, updatedAt, lastCheckedAt, confirmedAt, reviewerNote)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", (
            row["id"], row["jobId"], row["jobStatus"], row["stage"], row["businessNumber"], row["identityMessage"],
            row["artifacts"] or "{}", row["error"], row["detail"], row["readError"], row["retryAfter"],
            row["submittedAt"], row["updatedAt"], row["lastCheckedAt"], row["confirmedAt"], row["reviewerNote"]))


def init_db():
    conn = connect_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(SCHEMA)
        conn.execute(PROFILE_SCHEMA)
        conn.execute(JOB_SCHEMA)
        conn.execute("CREATE TABLE IF NOT EXISTS evaluation_reports (hash TEXT PRIMARY KEY, applicationId TEXT, cid TEXT, payload TEXT, value INTEGER)")
        for statement in auth.SCHEMA:
            conn.execute(statement)
        add_columns(conn, "applications", MIGRATION_COLUMNS)
        add_columns(conn, "borrower_profiles", {"ownerWallet": "TEXT"})
        add_columns(conn, "evaluation_reports", REPORT_COLUMNS)
        duplicates = conn.execute("SELECT 1 FROM borrower_profiles GROUP BY company HAVING COUNT(*)>1 LIMIT 1").fetchone()
        if duplicates is None:
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_company ON borrower_profiles(company)")
        remove_legacy_demo_data(conn)
        import_patent_archive(conn)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def verify_registry(reg_no, biz_no, demo_mismatch=False):
    """특허청 연동 전까지 사용하는 원부 대조 mock."""
    if demo_mismatch:
        return {"match": False, "mismatches": ["권리자"]}
    return {"match": True, "mismatches": []}


def encrypt_document(plaintext):
    """설계 규격에 맞춰 IV(12) | 암호문 | 태그(16)를 만든다. 해시는 salt를 섞어 원문 추측 대조를 막는다."""
    key = AESGCM.generate_key(bit_length=256)
    salt = os.urandom(32)
    iv = os.urandom(12)
    file_hash = "0x" + hashlib.sha256(salt + plaintext).hexdigest()
    ciphertext_and_tag = AESGCM(key).encrypt(iv, plaintext, None)
    return {
        "payload": iv + ciphertext_and_tag,
        "key": key,
        "salt": salt,
        "file_hash": file_hash,
    }


def decrypt_document(payload, key_b64, salt_b64, expected_hash):
    plaintext = AESGCM(base64.b64decode(key_b64)).decrypt(payload[:12], payload[12:], None)
    if "0x" + hashlib.sha256(base64.b64decode(salt_b64) + plaintext).hexdigest() != expected_hash.lower():
        raise ValueError("원본 해시가 일치하지 않습니다.")
    return plaintext


def upload_ipfs_payload(payload, filename, content_type):
    """mustsem RWA 페이지와 같은 multipart file 형식으로 암호문을 업로드."""
    try:
        response = requests.post(
            IPFS_UPLOAD_URL,
            files={"file": (filename, payload, content_type)},
            timeout=(10, 600),
        )
    except requests.Timeout as exc:
        raise IpfsUploadError("IPFS 업로드 시간이 초과되었습니다. 잠시 후 다시 시도하세요.", 504) from exc
    except requests.RequestException as exc:
        raise IpfsUploadError("IPFS 업로드 서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요.") from exc

    if response.status_code == 413:
        raise IpfsUploadError("파일이 너무 큽니다. 더 작은 PDF로 다시 시도하세요.", 413)
    if not response.ok:
        raise IpfsUploadError("IPFS 업로드에 실패했습니다. 잠시 후 다시 시도하세요.")

    try:
        data = response.json()
    except ValueError as exc:
        raise IpfsUploadError("IPFS 업로드 결과를 확인하지 못했습니다.") from exc

    cid = str(data.get("cid") or "").strip()
    if not CID_PATTERN.fullmatch(cid):
        raise IpfsUploadError("IPFS 업로드 결과의 CID가 올바르지 않습니다.")
    ipfs_uri = f"ipfs://{cid}"
    return {"cid": cid, "ipfs": ipfs_uri}


def upload_encrypted_document(payload, original_filename):
    safe_name = secure_filename(original_filename) or "patent-registry.pdf"
    return upload_ipfs_payload(payload, f"{safe_name}.enc", "application/octet-stream")


def fetch_ipfs(cid, max_bytes):
    response = requests.get(IPFS_GATEWAY.rstrip("/") + "/" + cid, timeout=(10, 60), stream=True)
    response.raise_for_status()
    chunks, size = [], 0
    for chunk in response.iter_content(65536):
        size += len(chunk)
        if size > max_bytes + 28:
            raise ValueError("암호문 크기가 허용 범위를 초과했습니다.")
        chunks.append(chunk)
    response.close()
    return b"".join(chunks)


def error_response(message, status_code, code):
    return jsonify({"error": code, "message": message}), status_code


def generate_id(conn):
    for _ in range(100):
        candidate = f"LN-{date.today().year}-{secrets.randbelow(900000) + 100000}"
        if conn.execute("SELECT 1 FROM applications WHERE id = ?", (candidate,)).fetchone() is None:
            return candidate
    raise RuntimeError("새 신청번호 생성에 실패했습니다.")


def normalize_business_number(value):
    value = str(value or "").strip()
    if not re.fullmatch(r"(?:\d{10}|\d{3}-\d{2}-\d{5})", value, flags=re.ASCII):
        raise ValueError("사업자등록번호는 숫자 10자리 또는 000-00-00000 형식으로 입력해 주세요.")
    return value.replace("-", "")


def stage_pdf(upload, max_bytes):
    """제출 PDF를 업로드 폴더의 임시 파일로 저장하고 내용의 SHA-256을 계산한다."""
    if upload is None or not upload.filename:
        raise ValueError("특허 공고전문 PDF를 첨부해 주세요.")
    filename = upload.filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1][:200]
    if Path(filename).suffix.lower() != ".pdf":
        raise ValueError("특허 공고전문은 PDF 파일만 업로드할 수 있습니다.")
    UPLOAD_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".iploan-upload-", dir=UPLOAD_DIR)
    os.chmod(tmp_path, 0o600)
    digest, size, prefix = hashlib.sha256(), 0, b""
    try:
        with os.fdopen(fd, "wb") as target:
            while chunk := upload.stream.read(1024 * 1024):
                size += len(chunk)
                if size > max_bytes:
                    raise ValueError(f"특허 공고전문 파일 크기는 {max_bytes // (1024 * 1024)}MiB 이하여야 합니다.")
                if len(prefix) < 5:
                    prefix += chunk[:5 - len(prefix)]
                digest.update(chunk)
                target.write(chunk)
        if not prefix.startswith(b"%PDF-"):
            raise ValueError("특허 공고전문이 올바른 PDF 파일인지 확인해 주세요.")
        return {"name": filename, "path": tmp_path, "sha256": digest.hexdigest()}
    except Exception:
        Path(tmp_path).unlink(missing_ok=True)
        raise


# ---------------------------------------------------------------- 로그인·권한

ROLE_CACHE = {}
ROLE_CACHE_LOCK = Lock()


def wallet_roles(wallet):
    """On-chain roles with a short cache; every chain transaction is still checked by the contract itself."""
    now = time.monotonic()
    with ROLE_CACHE_LOCK:
        cached = ROLE_CACHE.get(wallet)
        if cached and cached[1] > now:
            return cached[0]
    roles = set(chain.roles(wallet))
    with ROLE_CACHE_LOCK:
        if len(ROLE_CACHE) > 1000:
            ROLE_CACHE.clear()
        ROLE_CACHE[wallet] = (roles, now + ROLE_CACHE_SECONDS)
    return roles


def bearer_token():
    header = request.headers.get("Authorization", "")
    return header[7:].strip() if header.startswith("Bearer ") else ""


def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        token = bearer_token()
        wallet = auth.session_wallet(get_db(), token) if token else None
        if not wallet:
            return error_response("지갑으로 로그인해 주세요.", 401, "login_required")
        try:
            g.user = {"address": wallet, "roles": wallet_roles(wallet)}
        except chain.ChainError as exc:
            return error_response(str(exc), 503, "chain_unavailable")
        return view(*args, **kwargs)
    return wrapper


def access(application):
    """Capacities of the signed-in wallet for one application: its assigned participants, admin, or staff for archives."""
    roles, wallet = g.user["roles"], g.user["address"].lower()
    if application.get("status") == "archived":
        return {"archive"} if roles & STAFF_ROLES else set()
    capacities = {"admin"} if "admin" in roles else set()
    for role, field in (("borrower", "borrowerWallet"), ("evaluator", "evaluatorWallet"), ("bank", "bankWallet")):
        if role in roles and (application.get(field) or "").lower() == wallet:
            capacities.add(role)
    return capacities


def load_application(app_id, *needed):
    """Returns (application, capacities) or an error response when the wallet may not use it as `needed`."""
    row = get_db().execute("SELECT * FROM applications WHERE id = ?", (app_id,)).fetchone()
    application = dict(row) if row else None
    capacities = access(application) if application else set()
    if not capacities:
        return None, error_response("신청을 찾을 수 없습니다.", 404, "not_found")
    if needed and not capacities & set(needed):
        return None, error_response("이 신청에서 허용되지 않은 작업입니다. 담당 지갑으로 로그인하세요.", 403, "forbidden")
    return (application, capacities), None


@app.route("/api/auth/challenge", methods=["POST"])
def auth_challenge():
    data = request.get_json(silent=True)
    try:
        wallet = chain.address((data or {}).get("address") if isinstance(data, dict) else None)
        challenge = auth.create_challenge(get_db(), wallet, chain.CHAIN_ID, SERVICE_NAME)
    except chain.ChainError as exc:
        return error_response(str(exc), 400, "invalid_address")
    except auth.AuthError as exc:
        return error_response(str(exc), exc.status_code, "too_many_requests")
    return jsonify(challenge)


@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not isinstance(data.get("nonce"), str):
        return error_response("요청 형식을 확인하세요.", 400, "invalid_request")
    db = get_db()
    try:
        wallet = chain.address(data.get("address"))
    except chain.ChainError as exc:
        return error_response(str(exc), 400, "invalid_address")
    try:
        auth.verify_challenge(db, wallet, data["nonce"], data.get("signature"))
        roles = sorted(chain.roles(wallet))
    except auth.AuthError as exc:
        return error_response(str(exc), exc.status_code, "login_failed")
    except chain.ChainError as exc:
        return error_response(str(exc), 503, "chain_unavailable")
    with ROLE_CACHE_LOCK:
        ROLE_CACHE.pop(wallet, None)
    token, expires = auth.create_session(db, wallet)
    return jsonify({"token": token, "address": wallet, "roles": roles, "expiresAt": expires})


@app.route("/api/auth/me", methods=["GET"])
@login_required
def auth_me():
    return jsonify({"address": g.user["address"], "roles": sorted(g.user["roles"])})


@app.route("/api/auth/logout", methods=["POST"])
@login_required
def auth_logout():
    auth.end_session(get_db(), bearer_token())
    return jsonify({"status": "ok"})


# ---------------------------------------------------------------- 신청·기업 프로필

def public_application(application, capacities):
    public = {k: v for k, v in application.items() if k not in PRIVATE_FIELDS and v is not None}
    if public.get("docFileName"):
        public["documents"] = [name for name in (application.get("docFileName"), application.get("patentFileName")) if name]
    public["access"] = sorted(capacities)
    if application.get("managerAddress") and application["managerAddress"].lower() != chain.MANAGER_ADDRESS.lower():
        # Registered on an earlier contract; the server reads only the configured v3 Manager, so it stays read-only.
        public["contractOutdated"] = True
    db = get_db()
    job = db.execute("SELECT * FROM evaluation_jobs WHERE appId = ?", (application["id"],)).fetchone()
    if job is not None:
        public["evaluation"] = {
            "job_id": job["jobId"], "status": job["status"], "stage": job["stage"],
            "business_number": job["businessNumber"], "identity_message": job["identityMessage"],
            "error": job["error"], "detail": json.loads(job["detail"]) if job["detail"] else None,
            "read_error": job["readError"], "retry_after": job["retryAfter"],
            "submitted_at": job["submittedAt"], "updated_at": job["updatedAt"],
            "confirmed_at": job["confirmedAt"], "reviewer_note": job["reviewerNote"],
            "artifacts": sorted(kind for kind in json.loads(job["artifacts"] or "{}") if kind in patent_api.kinds),
        }
    if application.get("reportHash"):
        report = db.execute("SELECT note, kind FROM evaluation_reports WHERE applicationId = ? AND hash = ?",
                            (application["id"], application["reportHash"])).fetchone()
        if report:
            public["evaluationReport"] = {"kind": report["kind"], "note": report["note"]}
    return public


def application_response(app_id, capacities=None):
    row = get_db().execute("SELECT * FROM applications WHERE id = ?", (app_id,)).fetchone()
    application = dict(row)
    return public_application(application, access(application) if capacities is None else capacities)


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "evaluationConfigured": patent_api.configured})


@app.route("/api/applications", methods=["GET"])
@login_required
def list_applications():
    rows = get_db().execute("SELECT * FROM applications ORDER BY appliedDate DESC, id DESC").fetchall()
    visible = []
    for row in rows:
        application = dict(row)
        capacities = access(application)
        if capacities:
            visible.append(public_application(application, capacities))
    return jsonify(visible)


def borrower_required():
    if "borrower" not in g.user["roles"]:
        return error_response("차주기업 역할이 등록된 지갑으로 로그인하세요.", 403, "forbidden")
    return None


@app.route("/api/borrower-profiles", methods=["GET"])
@login_required
def list_borrower_profiles():
    if denied := borrower_required():
        return denied
    rows = get_db().execute("SELECT * FROM borrower_profiles WHERE ownerWallet = ? ORDER BY company",
                            (g.user["address"],)).fetchall()
    return jsonify([public_profile(row) for row in rows])


@app.route("/api/borrower-profiles", methods=["POST"])
@app.route("/api/borrower-profiles/<profile_id>", methods=["PATCH"])
@login_required
def save_borrower_profile(profile_id=None):
    if denied := borrower_required():
        return denied
    db = get_db()
    existing = None
    if profile_id:
        existing = db.execute("SELECT * FROM borrower_profiles WHERE id = ? AND ownerWallet = ?",
                              (profile_id, g.user["address"])).fetchone()
        if existing is None:
            return error_response("차주기업 프로필을 찾을 수 없습니다.", 404, "profile_not_found")
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return error_response("기업정보를 JSON 객체로 보내 주세요.", 400, "invalid_profile")
    try:
        values = profile_values(data, existing)
    except ValueError as exc:
        return error_response(str(exc), 400, "invalid_profile")
    try:
        profile = write_profile(db, values, g.user["address"], profile_id)
        db.commit()
    except sqlite3.IntegrityError:
        db.rollback()
        return error_response("이미 등록된 기업명입니다. 해당 기업 프로필을 선택해 주세요.", 409, "duplicate_company")
    return jsonify(profile), 200 if profile_id else 201


@app.route("/api/applications", methods=["POST"])
@login_required
def create_application():
    if denied := borrower_required():
        return denied
    if not request.content_type or "multipart/form-data" not in request.content_type:
        return error_response("특허등록원부와 특허 공고전문 PDF를 첨부해 주세요.", 415, "multipart_required")
    if not patent_api.configured:
        return error_response("LLM 보고서 서비스 연결 설정이 필요합니다. 운영 담당자에게 문의해 주세요.", 503, "evaluation_unavailable")

    data = request.form
    borrower = g.user["address"]
    try:
        cfg = chain.config()
        if not cfg.get("enabled"):
            raise chain.ChainError("온체인 계약 주소가 설정되지 않았습니다.")
        evaluator = chain.select_evaluator(cfg, borrower)
    except chain.ChainError as exc:
        return error_response(str(exc), 400, "chain_not_ready")

    document = request.files.get("registryDocument")
    if document is None or not document.filename:
        return error_response("특허등록원부 PDF를 첨부해 주세요.", 400, "document_required")
    if not document.filename.lower().endswith(".pdf"):
        return error_response("특허등록원부는 PDF 파일만 업로드할 수 있습니다.", 400, "pdf_required")
    plaintext = document.read(MAX_DOCUMENT_BYTES + 1)
    if len(plaintext) > MAX_DOCUMENT_BYTES:
        return error_response("파일이 너무 큽니다. 더 작은 PDF로 다시 시도하세요.", 413, "file_too_large")
    if not plaintext.lstrip().startswith(b"%PDF-"):
        return error_response("올바른 PDF 파일인지 확인해 주세요.", 400, "invalid_pdf")

    db = get_db()
    profile_id = data.get("borrowerProfileId") or None
    if profile_id:
        profile = db.execute("SELECT * FROM borrower_profiles WHERE id = ? AND ownerWallet = ?",
                             (profile_id, borrower)).fetchone()
        if profile is None:
            return error_response("차주기업 프로필을 다시 선택해 주세요.", 404, "profile_not_found")
    else:
        profile = db.execute("SELECT * FROM borrower_profiles WHERE company = ? AND ownerWallet = ?",
                             ((data.get("company") or "").strip(), borrower)).fetchone()
        profile_id = profile["id"] if profile else None
    try:
        values = profile_values(data, profile)
        number = normalize_business_number(values["bizNo"])
        values["bizNo"] = f"{number[:3]}-{number[3:5]}-{number[5:]}"
    except ValueError as exc:
        return error_response(str(exc), 400, "invalid_profile")
    duplicate = db.execute("SELECT id FROM borrower_profiles WHERE company = ?", (values["company"],)).fetchone()
    if duplicate and duplicate["id"] != profile_id:
        return error_response("이미 등록된 기업명입니다. 해당 기업 프로필을 선택해 주세요.", 409, "duplicate_company")

    try:
        amount = int(data.get("amount") or 0)
        if amount <= 0 or amount > 9_000_000_000_000_000:
            raise ValueError()
        term = int(data.get("termMonths") or 12)
        if not 1 <= term <= 600:
            raise ValueError()
    except (TypeError, ValueError):
        return error_response("신청금액과 상환 희망 기간을 허용 범위의 양의 정수로 입력하세요.", 400, "invalid_amount")

    try:
        patent = stage_pdf(request.files.get("patentDocument"), MAX_PATENT_BYTES)
    except ValueError as exc:
        return error_response(str(exc), 400, "patent_document_required")

    new_id = generate_id(db)
    base_record = {
        "id": new_id,
        **values,
        "borrowerProfileId": profile_id,
        "borrowerWallet": borrower, "evaluatorWallet": evaluator, "bankWallet": None,
        "managerAddress": cfg["managerAddress"], "chainId": cfg["chainId"], "chainStatus": "None", "repaidAmount": 0,
        "appKey": Web3.to_hex(Web3.keccak(text=new_id)),
        "ipType": (data.get("ipType") or "특허권")[:50],
        "ipTitle": (data.get("ipTitle") or "미입력 IP 자산")[:200],
        "ipRegNo": (data.get("ipRegNo") or "")[:100],
        "amount": amount,
        "termMonths": term,
        "status": "pending",
        "hash": "",
        "appliedDate": date.today().isoformat(),
        "docFileName": document.filename[:255],
        "patentFileName": patent["name"],
        "patentSha256": "0x" + patent["sha256"],
    }

    def insert(record):
        columns = list(record)
        db.execute(f"INSERT INTO applications ({', '.join(columns)}) VALUES ({', '.join(':' + c for c in columns)})", record)

    registry_result = verify_registry(
        data.get("ipRegNo", ""), values["bizNo"], str(data.get("demoHashMismatch", "")).lower() in {"1", "true", "on"})
    if not registry_result["match"]:
        Path(patent["path"]).unlink(missing_ok=True)
        insert({**base_record, "status": "doc_verify", "hashMatch": 0})
        db.commit()
        response = application_response(new_id)
        response["error"] = "registry_mismatch"
        response["message"] = "발급기관 정보와 일치하지 않는 항목이 있습니다: " + ", ".join(registry_result["mismatches"])
        response["mismatches"] = registry_result["mismatches"]
        return jsonify(response), 422

    encrypted = encrypt_document(plaintext)
    try:
        uploaded = upload_encrypted_document(encrypted["payload"], document.filename)
    except IpfsUploadError as exc:
        Path(patent["path"]).unlink(missing_ok=True)
        return error_response(str(exc), exc.status_code, "ipfs_upload_failed")

    # 신청·프로필·LLM 작업 저장은 한 트랜잭션. 업로드 실패/원부 불일치 시 갱신하지 않는다.
    stored_name = uuid4().hex + ".pdf"
    try:
        updated_profile = write_profile(db, values, borrower, profile_id)
        insert({
            **base_record,
            "borrowerProfileId": updated_profile["id"],
            "hash": encrypted["file_hash"],
            "docCid": uploaded["cid"],
            "docIpfsUri": uploaded["ipfs"],
            "docFileHash": encrypted["file_hash"],
            "docKey": base64.b64encode(encrypted["key"]).decode("ascii"),
            "docSalt": base64.b64encode(encrypted["salt"]).decode("ascii"),
            "hashMatch": 1,
            "patentStoredName": stored_name,
        })
        now = timestamp()
        db.execute("INSERT INTO evaluation_jobs (appId, status, businessNumber, submittedAt, updatedAt) "
                   "VALUES (?, 'submitting', ?, ?, ?)", (new_id, number, now, now))
        os.replace(patent["path"], UPLOAD_DIR / stored_name)
        db.commit()
    except sqlite3.IntegrityError:
        db.rollback()
        Path(patent["path"]).unlink(missing_ok=True)
        return error_response("기업정보가 변경되었습니다. 프로필을 다시 선택해 주세요.", 409, "duplicate_company")
    submit_evaluation(db, new_id)
    response = application_response(new_id)
    response["borrowerProfile"] = updated_profile
    return jsonify(response), 201


# ---------------------------------------------------------------- LLM 가치평가 보고서 작업

def save_job(db, app_id, job):
    artifacts = job.get("artifacts") or {}
    if not isinstance(artifacts, dict):
        artifacts = {}
    artifacts = {kind: path for kind, path in artifacts.items()
                 if kind in patent_api.kinds and isinstance(path, str) and path}
    now = timestamp()
    # 공급자 자유문에서 인증값을 제거한다.
    safe_text = lambda value: str(value or "").replace(patent_api.token, "[redacted]") if patent_api.token else str(value or "")
    db.execute("""UPDATE evaluation_jobs SET jobId=?, status=?, stage=?, businessNumber=?, identityMessage=?, artifacts=?,
        error=?, detail=NULL, readError=NULL, retryAfter=NULL, updatedAt=?, lastCheckedAt=? WHERE appId=?""", (
        job["job_id"], job["status"], safe_text(job.get("stage")), job.get("business_number"),
        safe_text(job.get("identity_message")), json.dumps(artifacts), safe_text(job.get("error")), now, now, app_id,
    ))
    db.commit()


def submit_evaluation(db, app_id):
    """외부 접수 전에 저장한 신청번호에 접수 결과를 연결한다. 실패는 작업 상태로 남기고 신청은 유지한다."""
    row = db.execute("SELECT * FROM applications WHERE id = ?", (app_id,)).fetchone()
    try:
        save_job(db, app_id, patent_api.submit(UPLOAD_DIR / row["patentStoredName"], row["patentFileName"],
                                               re.sub(r"\D", "", row["bizNo"])))
    except PatentAPIError as exc:
        status = "submission_unknown" if exc.uncertain else "submission_rejected"
        db.execute("UPDATE evaluation_jobs SET status=?, error=?, detail=?, retryAfter=?, updatedAt=? WHERE appId=?",
                   (status, str(exc), json.dumps(exc.detail, ensure_ascii=False), exc.retry_after, timestamp(), app_id))
        db.commit()
    except OSError:
        db.execute("UPDATE evaluation_jobs SET status='submission_rejected', error=?, updatedAt=? WHERE appId=?",
                   ("보관된 특허 PDF를 읽을 수 없습니다. 운영 담당자에게 문의해 주세요.", timestamp(), app_id))
        db.commit()


def refresh_job(db, app_id):
    job = db.execute("SELECT * FROM evaluation_jobs WHERE appId = ?", (app_id,)).fetchone()
    if job is None:
        return
    if job["status"] == "submitting":
        elapsed = (datetime.now(timezone.utc) - datetime.fromisoformat(job["updatedAt"])).total_seconds()
        if elapsed > 90:
            db.execute("UPDATE evaluation_jobs SET status='submission_unknown', error=? WHERE appId=? AND status='submitting'",
                       ("접수 결과를 확인하지 못했습니다. 중복 접수를 방지하기 위해 운영 담당자의 확인이 필요합니다.", app_id))
            db.commit()
    elif job["jobId"] and job["status"] in ACTIVE_JOB_STATUSES:
        # 여러 브라우저와 Gunicorn worker가 있어도 작업당 10초 이내 중복 조회를 막는다.
        last = datetime.fromisoformat(job["lastCheckedAt"]) if job["lastCheckedAt"] else None
        if last is None or (datetime.now(timezone.utc) - last).total_seconds() >= 10:
            claimed = db.execute("UPDATE evaluation_jobs SET lastCheckedAt=? WHERE appId=? AND lastCheckedAt IS ?",
                                 (timestamp(), app_id, job["lastCheckedAt"]))
            db.commit()
            if claimed.rowcount:
                try:
                    save_job(db, app_id, patent_api.status(job["jobId"]))
                except PatentAPIError as exc:
                    db.execute("UPDATE evaluation_jobs SET readError=? WHERE appId=?", (str(exc), app_id))
                    db.commit()


@app.route("/api/applications/<app_id>/evaluation", methods=["GET"])
@login_required
def evaluation_status(app_id):
    found, denied = load_application(app_id)
    if denied:
        return denied
    refresh_job(get_db(), app_id)
    return jsonify(application_response(app_id, found[1]))


@app.route("/api/applications/<app_id>/evaluation", methods=["POST"])
@login_required
def retry_evaluation(app_id):
    found, denied = load_application(app_id, "borrower", "evaluator")
    if denied:
        return denied
    db = get_db()
    job = db.execute("SELECT * FROM evaluation_jobs WHERE appId = ?", (app_id,)).fetchone()
    if job is None:
        return error_response("평가 요청을 찾을 수 없습니다.", 404, "not_found")
    if job["status"] != "submission_rejected" or job["jobId"]:
        return error_response("이미 접수되었거나 접수 여부 확인이 필요한 작업입니다. 기존 작업의 상태를 확인해 주세요.", 409, "wrong_stage")
    if job["retryAfter"]:
        elapsed = (datetime.now(timezone.utc) - datetime.fromisoformat(job["updatedAt"])).total_seconds()
        if elapsed < job["retryAfter"]:
            response = jsonify({"error": "retry_later", "message": "접수 가능한 시간이 되면 다시 시도해 주세요."})
            response.headers["Retry-After"] = str(max(1, int(job["retryAfter"] - elapsed)))
            return response, 429
    claimed = db.execute("""UPDATE evaluation_jobs SET status='submitting', updatedAt=?, error=NULL, detail=NULL,
        readError=NULL, retryAfter=NULL WHERE appId=? AND status='submission_rejected' AND jobId IS NULL""", (timestamp(), app_id))
    db.commit()
    if not claimed.rowcount:
        return error_response("이미 접수가 진행 중입니다. 기존 신청의 상태를 확인해 주세요.", 409, "wrong_stage")
    submit_evaluation(db, app_id)
    return jsonify(application_response(app_id, found[1]))


@app.route("/api/applications/<app_id>/evaluation/identity", methods=["POST"])
@login_required
def evaluation_identity(app_id):
    found, denied = load_application(app_id, "borrower", "evaluator")
    if denied:
        return denied
    data = request.get_json(silent=True)
    try:
        number = normalize_business_number((data or {}).get("business_number") if isinstance(data, dict) else None)
    except ValueError as exc:
        return error_response(str(exc), 400, "invalid_business_number")
    db = get_db()
    job = db.execute("SELECT * FROM evaluation_jobs WHERE appId = ?", (app_id,)).fetchone()
    if job is None or job["status"] != "awaiting_identity" or not job["jobId"]:
        return error_response("사업자번호 입력을 기다리는 작업이 아닙니다. 현재 상태를 확인해 주세요.", 409, "wrong_stage")
    try:
        save_job(db, app_id, patent_api.identify(job["jobId"], number))
    except PatentAPIError as exc:
        return jsonify({"error": "evaluation_service", "message": str(exc), "detail": exc.detail}), exc.status
    return jsonify(application_response(app_id, found[1]))


ARTIFACT_TYPES = {"pdf": "application/pdf", "html": "text/html; charset=utf-8",
                  "quality": "application/json", "trace": "text/markdown; charset=utf-8",
                  "timing": "application/json", "log": "text/plain; charset=utf-8"}


def report_headers(response, filename, kind, download=False):
    disposition = "attachment" if download or kind not in {"pdf", "html"} else "inline"
    response.headers["Content-Disposition"] = f'{disposition}; filename="{filename}"'
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    if kind == "html":
        # 보고서 HTML은 별도 권한 없는 문서로 표시한다.
        response.headers["Content-Security-Policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
    return response


@app.route("/api/applications/<app_id>/evaluation/artifacts/<kind>", methods=["GET"])
@login_required
def evaluation_artifact(app_id, kind):
    found, denied = load_application(app_id)
    if denied:
        return denied
    job = get_db().execute("SELECT * FROM evaluation_jobs WHERE appId = ?", (app_id,)).fetchone()
    if job is None or kind not in patent_api.kinds:
        return error_response("보고서를 찾을 수 없습니다.", 404, "not_found")
    if job["status"] != "completed":
        return error_response("보고서가 아직 준비되지 않았습니다.", 409, "not_ready")
    if kind not in json.loads(job["artifacts"] or "{}"):
        return error_response("해당 형식의 결과가 제공되지 않았습니다.", 404, "not_found")
    try:
        upstream = patent_api.artifact(job["jobId"], kind)
    except PatentAPIError as exc:
        return jsonify({"error": "evaluation_service", "message": str(exc), "detail": exc.detail}), exc.status

    def chunks():
        try:
            while chunk := upstream.read(64 * 1024):
                yield chunk
        finally:
            upstream.close()

    suffix = {"quality": "json", "timing": "json", "trace": "md", "log": "txt"}.get(kind, kind)
    return report_headers(Response(chunks(), content_type=ARTIFACT_TYPES[kind]), f"{app_id}-{kind}.{suffix}",
                          kind, request.args.get("download") == "1")


# ---------------------------------------------------------------- 체인 연결

@app.route("/api/chain/config")
def chain_config():
    try:
        return jsonify(chain.config())
    except chain.ChainError as exc:
        return error_response(str(exc), 503, "chain_unavailable")


CHAIN_TO_STATUS = {"Evaluating": "evaluating", "Eligible": "review", "RuleRejected": "rejected",
                   "Approved": "approved", "Rejected": "rejected", "Repaid": "repaid"}


@app.route("/api/applications/<app_id>/sync", methods=["POST"])
@login_required
def sync_application(app_id):
    found, denied = load_application(app_id, "borrower", "evaluator", "bank", "admin")
    if denied:
        return denied
    application, capacities = found
    if not application.get("appKey") or application.get("hashMatch") != 1:
        return error_response("등록 가능한 원부 업로드 신청이 아닙니다.", 409, "not_ready")
    try:
        state = chain.snapshot(application)
        stage = state["chainStatus"]
        if stage == "None":
            if application.get("chainStatus") not in {None, "None"}:
                raise chain.ChainError("이전에 확인한 체인 기록이 없습니다. RPC·로컬 체인 재시작 여부를 확인하세요.")
            return jsonify(public_application(application, capacities))
        if stage != "Evaluating":
            report = get_db().execute("SELECT * FROM evaluation_reports WHERE applicationId = ? AND hash = ? AND cid = ?",
                                      (app_id, state["reportHash"], state["reportCid"])).fetchone()
            if not report or report["value"] != state["appraisedValue"]:
                raise chain.ChainError("체인의 평가보고서가 이 신청에서 준비한 보고서와 다릅니다.")
        # Never accept caller-provided status, tokenId, repayment or a receipt as proof.
        state["status"] = CHAIN_TO_STATUS[stage]
        if state["appraisedValue"]:
            state["ltv"] = round(application["amount"] / state["appraisedValue"] * 100)
        if stage == "RuleRejected":
            state["rejectReason"] = "컨트랙트 자동심사: 신청금액이 평가액의 70%를 초과했습니다."
        elif stage == "Rejected":
            state["rejectReason"] = "은행 지갑이 최종 거절했습니다."
        else:
            state["rejectReason"] = None
        db = get_db()
        db.execute("UPDATE applications SET " + ", ".join(f"{k}=:{k}" for k in state) + " WHERE id=:id", {**state, "id": app_id})
        db.commit()
        return jsonify(application_response(app_id))
    except chain.ChainError as exc:
        return error_response(str(exc), 409, "chain_verification_failed")


def assign_bank(application):
    """Bank/reviewer is chosen once, when a passing evaluation is prepared (chain still Evaluating).
    It is re-chosen only if the stored bank lost BANK_ROLE before the evaluator confirmed on chain."""
    current = application.get("bankWallet")
    if current and chain.has_role(current, "BANK_ROLE"):
        return current
    selected = chain.select_bank(chain.config(), application["evaluatorWallet"], application["borrowerWallet"])
    db = get_db()
    db.execute("UPDATE applications SET bankWallet = ? WHERE id = ? AND bankWallet IS ?", (selected, application["id"], current))
    db.commit()
    return db.execute("SELECT bankWallet FROM applications WHERE id = ?", (application["id"],)).fetchone()["bankWallet"]


def read_artifact(job_id, kind):
    upstream = patent_api.artifact(job_id, kind)
    chunks, size = [], 0
    try:
        while chunk := upstream.read(64 * 1024):
            size += len(chunk)
            if size > MAX_REPORT_BYTES:
                raise ValueError("LLM 보고서 크기가 허용 범위를 초과했습니다.")
            chunks.append(chunk)
    finally:
        upstream.close()
    return b"".join(chunks)


@app.route("/api/applications/<app_id>/evaluation-report", methods=["POST"])
@login_required
def prepare_evaluation_report(app_id):
    """Registers the completed LLM report for the evaluator's confirmation: encrypted to IPFS, salted hash for the chain."""
    found, denied = load_application(app_id, "evaluator")
    if denied:
        return denied
    application = found[0]
    if not application.get("appKey") or application.get("hashMatch") != 1:
        return error_response("온체인 평가 신청이 아닙니다.", 409, "not_ready")
    data = request.get_json(silent=True)
    value = data.get("appraisedValue") if isinstance(data, dict) else None
    if type(value) is not int or not 0 < value <= 9_000_000_000_000_000:
        return error_response("평가액을 양의 정수로 입력해 주세요.", 400, "invalid_value")
    note = str(data.get("note") or "").strip()[:2000]
    db = get_db()
    try:
        if chain.snapshot(application)["chainStatus"] != "Evaluating":
            return error_response("평가 중인 신청만 보고서를 확정할 수 있습니다.", 409, "wrong_stage")
        job = db.execute("SELECT * FROM evaluation_jobs WHERE appId = ?", (app_id,)).fetchone()
        kinds = json.loads(job["artifacts"] or "{}") if job else {}
        kind = "pdf" if "pdf" in kinds else "html" if "html" in kinds else None
        if job is None or job["status"] != "completed" or kind is None:
            return error_response("LLM 가치평가 보고서가 완성된 뒤 확정할 수 있습니다.", 409, "report_not_ready")
        bank = assign_bank(application) if chain.eligible(application["amount"], value) else None
        previous = db.execute("SELECT * FROM evaluation_reports WHERE applicationId = ? AND value = ? AND reportKey IS NOT NULL "
                              "ORDER BY createdAt DESC LIMIT 1", (app_id, value)).fetchone()
        if previous:
            db.execute("UPDATE evaluation_reports SET note = ? WHERE hash = ?", (note, previous["hash"]))
            db.commit()
            return jsonify({"cid": previous["cid"], "hash": previous["hash"], "appraisedValue": value, "bankWallet": bank})
        encrypted = encrypt_document(read_artifact(job["jobId"], kind))
        uploaded = upload_ipfs_payload(encrypted["payload"], f"{app_id}-evaluation-report.{kind}.enc", "application/octet-stream")
        db.execute("INSERT INTO evaluation_reports (hash, applicationId, cid, value, reportKey, reportSalt, kind, note, createdAt) "
                   "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", (
                       encrypted["file_hash"], app_id, uploaded["cid"], value,
                       base64.b64encode(encrypted["key"]).decode("ascii"), base64.b64encode(encrypted["salt"]).decode("ascii"),
                       kind, note, timestamp()))
        db.commit()
        return jsonify({"cid": uploaded["cid"], "hash": encrypted["file_hash"], "appraisedValue": value, "bankWallet": bank}), 201
    except chain.ChainError as exc:
        return error_response(str(exc), 409, "chain_unavailable")
    except PatentAPIError as exc:
        return error_response(str(exc), exc.status, "evaluation_service")
    except ValueError as exc:
        return error_response(str(exc), 413, "report_too_large")
    except IpfsUploadError as exc:
        return error_response(str(exc), exc.status_code, "ipfs_upload_failed")


@app.route("/api/applications/<app_id>/evaluation-report/document", methods=["GET"])
@login_required
def read_evaluation_report(app_id):
    """The registered report, decrypted from IPFS only after its salted hash matches the chain record."""
    found, denied = load_application(app_id, "borrower", "evaluator", "bank", "admin")
    if denied:
        return denied
    application = found[0]
    try:
        state = chain.snapshot(application) if application.get("appKey") else {"chainStatus": "None"}
        if state["chainStatus"] in {"None", "Evaluating"}:
            return error_response("평가가 확정되어 체인에 기록된 보고서가 없습니다.", 409, "not_ready")
        report = get_db().execute("SELECT * FROM evaluation_reports WHERE applicationId = ? AND hash = ? AND cid = ?",
                                  (app_id, state["reportHash"], state["reportCid"])).fetchone()
        if not report or not report["reportKey"]:
            return error_response("등록된 평가보고서를 찾을 수 없습니다.", 404, "not_found")
        plaintext = decrypt_document(fetch_ipfs(report["cid"], MAX_REPORT_BYTES), report["reportKey"],
                                     report["reportSalt"], state["reportHash"])
    except (ValueError, chain.ChainError) as exc:
        return error_response(str(exc), 409, "report_verification_failed")
    except Exception:
        return error_response("평가보고서를 다운로드·복호화하지 못했습니다.", 502, "report_unavailable")
    kind = report["kind"] or "pdf"
    return report_headers(Response(plaintext, content_type=ARTIFACT_TYPES[kind]), f"{app_id}-registered-report.{kind}",
                          kind, request.args.get("download") == "1")


@app.route("/api/applications/<app_id>/document", methods=["GET"])
@login_required
def read_document(app_id):
    found, denied = load_application(app_id, "evaluator", "bank")
    if denied:
        return denied
    application, capacities = found
    wallet = g.user["address"]
    try:
        state = chain.snapshot(application)
        allowed = (state["chainStatus"] == "Evaluating" and "evaluator" in capacities) or (
            state["chainStatus"] in {"Approved", "Repaid"} and "bank" in capacities)
        if not allowed:
            raise ValueError("현재 이 지갑에는 원본 열람권이 없습니다.")
        # A revoked participant keeps its SBT/token but must not keep document access, so check the role now.
        role = "EVALUATOR_ROLE" if state["chainStatus"] == "Evaluating" else "BANK_ROLE"
        if not chain.has_role(wallet, role):
            raise ValueError("역할이 회수된 지갑은 원본을 열람할 수 없습니다.")
        plaintext = decrypt_document(fetch_ipfs(application["docCid"], MAX_DOCUMENT_BYTES), application["docKey"],
                                     application["docSalt"], application["docFileHash"])
        return Response(plaintext, mimetype="application/pdf", headers={"Cache-Control": "no-store", "Content-Disposition": "inline; filename=registry.pdf"})
    except (ValueError, chain.ChainError) as exc:
        return error_response(str(exc), 403, "document_forbidden")
    except Exception:
        return error_response("원본을 다운로드·복호화하지 못했습니다.", 502, "document_unavailable")


@app.route("/api/applications/<app_id>/credit-score", methods=["GET"])
@login_required
def credit_score(app_id):
    found, denied = load_application(app_id, "bank")
    if denied:
        return denied
    # Stand-in for a credit bureau lookup until one is connected; the reviewer confirms or edits it before approval.
    return jsonify({"grade": "CC", "source": "모의 신용평가 (외부 연동 전)", "asOf": date.today().isoformat()})


@app.errorhandler(413)
def request_too_large(_error):
    return error_response("파일이 너무 큽니다. 더 작은 PDF로 다시 시도하세요.", 413, "file_too_large")


init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5001)))
