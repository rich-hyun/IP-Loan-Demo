"""
LLM 기반 기술평가 자동대출 시스템 — 백엔드 API

프론트엔드(정적 HTML/CSS/JS)가 더 이상 브라우저 localStorage에만 데이터를 저장하지 않고,
이 API를 통해 서버의 SQLite 파일에 저장하도록 합니다. 방문자가 누구든 같은 데이터를 보게 됩니다.

실행 방법(로컬 테스트):
    pip install -r requirements.txt
    python3 app.py
    # http://127.0.0.1:5001/api/applications 로 확인

운영 배포는 이 폴더의 README.md를 참고하세요 (systemd + gunicorn + nginx + HTTPS).
"""

import base64
import hashlib
import json
import os
import random
import re
import sqlite3
import secrets
import time
import sys
from threading import Lock
from datetime import date, datetime, timezone
from uuid import uuid4

import requests
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from flask import Flask, g, jsonify, request, Response
from eth_account import Account
from eth_account.messages import encode_defunct
from web3 import Web3
if __package__:
    from . import chain, loan_workflow
else:
    import chain
    import loan_workflow
from flask_cors import CORS
from werkzeug.utils import secure_filename

DB_PATH = os.environ.get("IPLOAN_DB_PATH", os.path.join(os.path.dirname(__file__), "iploan.db"))
IPFS_UPLOAD_URL = os.environ.get("IPLOAN_IPFS_UPLOAD_URL", "https://api.mustree.kr/upload")
MAX_DOCUMENT_BYTES = int(os.environ.get("IPLOAN_MAX_DOCUMENT_BYTES", 20 * 1024 * 1024))
CID_PATTERN = re.compile(r"^[A-Za-z0-9]{10,128}$")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_DOCUMENT_BYTES + (1024 * 1024)
# TODO(운영 전환 시): 아래를 실제 프론트엔드 도메인으로 제한하세요.
# 예: CORS(app, origins=["https://your-username.github.io"])
CORS(app)

DEFAULT_APPLICATIONS = [
    dict(id="LN-2026-0088", company="에너지테크(주)", bizNo="220-87-30984", ipType="특허권",
         ipTitle="고효율 태양광 인버터", amount=150000000, status="approved", hash="0x1fa726…c0e94b",
         appliedDate="2026-09-08", appraisedValue=214000000, ltv=70, creditScore=81, rate=3.9, rejectReason=None),
    dict(id="LN-2026-0090", company="(주)헬스케어넷", bizNo="308-81-19204", ipType="특허권",
         ipTitle="원격 재활 모니터링 시스템", amount=70000000, status="rejected", hash="0x5c98a4…e7213f",
         appliedDate="2026-09-09", appraisedValue=58000000, ltv=121, creditScore=66, rate=None,
         rejectReason="산정 담보가치(58,000,000원) 대비 신청금액 비율(LTV 121%)이 자동심사 기준(70% 이하)을 "
                       "초과하여 자동 거절 처리되었습니다."),
    dict(id="LN-2026-0091", company="(주)그린파머스", bizNo="208-86-41029", ipType="특허권",
         ipTitle="스마트 관수 제어 시스템", amount=80000000, status="approved", hash="0x8c2f71…a93d0e",
         appliedDate="2026-09-10", appraisedValue=118000000, ltv=68, creditScore=78, rate=4.1, rejectReason=None),
    dict(id="LN-2026-0094", company="테크비전(주)", bizNo="134-87-22567", ipType="특허권",
         ipTitle="실시간 객체 추적 알고리즘", amount=120000000, status="review", hash="0x2af90c…771ac4",
         appliedDate="2026-09-12", appraisedValue=171000000, ltv=70, creditScore=74, rate=None, rejectReason=None),
    dict(id="LN-2026-0097", company="(주)바이오크래프트", bizNo="301-88-10945", ipType="특허권",
         ipTitle="휴대용 혈당측정 센서", amount=95000000, status="evaluating", hash="0x9d13e0…4bf27a",
         appliedDate="2026-09-14", appraisedValue=None, ltv=None, creditScore=None, rate=None, rejectReason=None),
    dict(id="LN-2026-0102", company="스마트팜솔루션(주)", bizNo="215-81-77320", ipType="상표권",
         ipTitle="그린팜 GreenFarm®", amount=40000000, status="doc_verify", hash="0x4e7ac2…f10d93",
         appliedDate="2026-09-16", appraisedValue=None, ltv=None, creditScore=None, rate=None, rejectReason=None),
    dict(id="LN-2026-0103", company="(주)로보틱스랩", bizNo="129-86-53012", ipType="실용신안권",
         ipTitle="협동로봇 안전 커버 구조", amount=65000000, status="pending", hash="0x6b40d1…8ce572",
         appliedDate="2026-09-17", appraisedValue=None, ltv=None, creditScore=None, rate=None, rejectReason=None),
    dict(id="LN-2026-0106", company="퓨처모빌리티(주)", bizNo="412-88-60371", ipType="특허권",
         ipTitle="배터리 열관리 모듈", amount=110000000, status="review", hash="0x33d0f6…9a1c58",
         appliedDate="2026-09-19", appraisedValue=143000000, ltv=77, creditScore=69, rate=None, rejectReason=None),
]

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
    **{prefix + suffix: 'TEXT' for prefix in ('sbt', 'debt') for suffix in ('MetadataUri', 'ImageUri', 'Name')},
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
    "termMonths": "INTEGER",
}

FIELDS = ["id", "company", "bizNo", "ipType", "ipTitle", "amount", "status", "hash",
          "appliedDate", "appraisedValue", "ltv", "creditScore", "rate", "rejectReason"]
ALLOWED_PATCH_FIELDS = {"status", "appraisedValue", "ltv", "creditScore", "rate", "rejectReason"}
PUBLIC_FIELDS = set(FIELDS) | {
    *[prefix + suffix for prefix in ('sbt', 'debt') for suffix in ('MetadataUri', 'ImageUri', 'Name')],
    "appKey", "borrowerWallet", "evaluatorWallet", "bankWallet", "managerAddress", "chainId", "chainStatus", "chainBlock",
    "sbtTokenId", "debtTokenId", "reportCid", "reportHash", "repaidAmount",
    "docCid", "docIpfsUri", "docFileHash", "docFileName", "hashMatch", "ipRegNo",
    "borrowerProfileId", "ceo", "contact", "termMonths"
}

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


def profile_timestamp():
    return datetime.now(timezone.utc).isoformat()


def insert_profile(conn, record):
    # 이전 운영 DB에는 createdAt NOT NULL 컬럼이 있으므로 함께 보존한다.
    columns = ["id", "company", "bizNo", "ceo", "contact", "updatedAt"]
    if any(column[1] == "createdAt" for column in conn.execute("PRAGMA table_info(borrower_profiles)")):
        columns.append("createdAt")
        record = {**record, "createdAt": record["updatedAt"]}
    conn.execute(
        "INSERT INTO borrower_profiles (" + ", ".join(columns) + ") VALUES (" +
        ", ".join(":" + column for column in columns) + ")", record,
    )


def migrate_borrower_profiles(conn):
    """연결되지 않은 기존 신청만 이관하고, 저장된 프로필은 덮어쓰지 않는다."""
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM applications WHERE borrowerProfileId IS NULL "
        "AND (hashMatch IS NULL OR hashMatch != 0) ORDER BY appliedDate, rowid"
    ).fetchall()
    legacy = {}
    for row in rows:
        values = legacy.setdefault(row["company"], {key: "" for key in PROFILE_LIMITS})
        for key in PROFILE_LIMITS:
            if row[key]:
                values[key] = row[key]
    for company, values in legacy.items():
        profile = conn.execute("SELECT id FROM borrower_profiles WHERE company = ?", (company,)).fetchone()
        profile_id = profile["id"] if profile else str(uuid4())
        if not profile:
            insert_profile(conn, {**values, "id": profile_id, "updatedAt": profile_timestamp()})
        conn.execute(
            "UPDATE applications SET borrowerProfileId = ? WHERE company = ? AND borrowerProfileId IS NULL",
            (profile_id, company),
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


def write_profile(conn, values, profile_id=None):
    record = {**values, "id": profile_id or str(uuid4()), "updatedAt": profile_timestamp()}
    if profile_id:
        conn.execute(
            "UPDATE borrower_profiles SET company=:company, bizNo=:bizNo, ceo=:ceo, "
            "contact=:contact, updatedAt=:updatedAt WHERE id=:id", record,
        )
    else:
        insert_profile(conn, record)
    return record


class IpfsUploadError(Exception):
    """사용자에게 노출 가능한 IPFS 업로드 오류."""

    def __init__(self, message, status_code=502):
        super().__init__(message)
        self.status_code = status_code


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH, timeout=30)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys=ON")
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def seed(conn):
    conn.execute("DELETE FROM applications")
    conn.execute("DELETE FROM borrower_profiles")
    placeholders = ", ".join(f":{f}" for f in FIELDS)
    conn.executemany(
        f"INSERT INTO applications ({', '.join(FIELDS)}) VALUES ({placeholders})",
        DEFAULT_APPLICATIONS,
    )
    migrate_borrower_profiles(conn)


def init_db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(SCHEMA)
        conn.execute(PROFILE_SCHEMA)
        conn.execute("CREATE TABLE IF NOT EXISTS evaluation_reports (hash TEXT PRIMARY KEY, applicationId TEXT, cid TEXT, payload TEXT, value INTEGER)")
        loan_workflow.migrate(conn)
        existing_columns = {row[1] for row in conn.execute("PRAGMA table_info(applications)")}
        for column, column_type in MIGRATION_COLUMNS.items():
            if column not in existing_columns:
                conn.execute(f"ALTER TABLE applications ADD COLUMN {column} {column_type}")
        duplicates = conn.execute("SELECT 1 FROM borrower_profiles GROUP BY company HAVING COUNT(*)>1 LIMIT 1").fetchone()
        if duplicates is None:
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_company ON borrower_profiles(company)")
        count = conn.execute("SELECT COUNT(*) FROM applications").fetchone()[0]
        if count == 0:
            seed(conn)
        else:
            migrate_borrower_profiles(conn)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def application_to_public(row):
    """서버 전용 AES 키와 salt를 제외한 신청 데이터만 반환."""
    public = {k: v for k, v in dict(row).items() if k in PUBLIC_FIELDS and v is not None}
    if public.get("docFileName"):
        public["documents"] = [public["docFileName"]]
    evaluation = loan_workflow.summary(get_db(), public["id"])
    if evaluation:
        # Public list retains existing demo metadata; reports and review contents
        # require wallet authentication through the dedicated evaluation API.
        public["workflow"] = True
        public["evaluation"] = {key: evaluation[key] for key in ("state", "stage", "error", "updatedAt", "retryAt", "confirmedAt")}
        case = get_db().execute("SELECT applicationId FROM credit_cases WHERE applicationId=?", (public["id"],)).fetchone()
        public["creditCaseId"] = case["applicationId"] if case else None
    return public


def verify_registry(reg_no, biz_no, demo_mismatch=False):
    """특허청 연동 전까지 사용하는 원부 대조 mock."""
    if demo_mismatch:
        return {"match": False, "mismatches": ["권리자"]}
    return {"match": True, "mismatches": []}


def encrypt_registry_document(plaintext):
    """설계 규격에 맞춰 IV(12) | 암호문 | 태그(16)를 만든다."""
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


def error_response(message, status_code, code):
    return jsonify({"error": code, "message": message}), status_code


def generate_id(conn):
    while True:
        candidate = "LN-2026-" + str(random.randint(110, 9998)).zfill(4)
        exists = conn.execute("SELECT 1 FROM applications WHERE id = ?", (candidate,)).fetchone()
        if not exists:
            return candidate


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/api/applications", methods=["GET"])
def list_applications():
    db = get_db()
    rows = db.execute("SELECT * FROM applications ORDER BY appliedDate DESC, id DESC").fetchall()
    return jsonify([application_to_public(r) for r in rows])


@app.route("/api/borrower-profiles", methods=["GET"])
def list_borrower_profiles():
    rows = get_db().execute("SELECT * FROM borrower_profiles ORDER BY company").fetchall()
    return jsonify([dict(row) for row in rows])


@app.route("/api/borrower-profiles", methods=["POST"])
@app.route("/api/borrower-profiles/<profile_id>", methods=["PATCH"])
def save_borrower_profile(profile_id=None):
    db = get_db()
    existing = None
    if profile_id:
        existing = db.execute("SELECT * FROM borrower_profiles WHERE id = ?", (profile_id,)).fetchone()
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
        profile = write_profile(db, values, profile_id)
        db.commit()
    except sqlite3.IntegrityError:
        db.rollback()
        return error_response("이미 등록된 기업명입니다. 해당 기업 프로필을 선택해 주세요.", 409, "duplicate_company")
    return jsonify(profile), 200 if profile_id else 201


@app.route("/api/applications", methods=["POST"])
def create_application():
    if not request.content_type or "multipart/form-data" not in request.content_type:
        return error_response("특허등록원부 PDF를 첨부해 주세요.", 415, "multipart_required")

    data = request.form
    chain_fields = {}
    if chain.MANAGER_ADDRESS:
        try:
            cfg = chain.config()
            borrower = chain.address(data.get("borrowerWallet"))
            chain.require_role(borrower, "BORROWER_ROLE")
            evaluator = chain.select_evaluator(cfg, borrower)
            chain_fields = {"borrowerWallet": borrower, "evaluatorWallet": evaluator, "bankWallet": None,
                            "managerAddress": cfg["managerAddress"], "chainId": cfg["chainId"], "chainStatus": "None", "repaidAmount": 0}
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

    workflow_identity = None
    if data.get("workflow") == "integrated" or not app.config.get("ALLOW_LEGACY_TEST_SUBMISSIONS", False):
        prior, workflow_identity = loan_workflow.begin_create(sys.modules[__name__], plaintext)
        if prior:
            replay = application_to_public(prior)
            profile = get_db().execute("SELECT * FROM borrower_profiles WHERE id=?", (prior["borrowerProfileId"],)).fetchone()
            if profile:
                replay["borrowerProfile"] = dict(profile)
            return jsonify(replay), 200

    db = get_db()
    profile_id = data.get("borrowerProfileId") or None
    if profile_id:
        profile = db.execute("SELECT * FROM borrower_profiles WHERE id = ?", (profile_id,)).fetchone()
        if profile is None:
            return error_response("차주기업 프로필을 다시 선택해 주세요.", 404, "profile_not_found")
    else:
        # 기존 API 클라이언트도 기업별 프로필에 연결한다.
        profile = db.execute(
            "SELECT * FROM borrower_profiles WHERE company = ?", ((data.get("company") or "").strip(),)
        ).fetchone()
        profile_id = profile["id"] if profile else None
    try:
        values = profile_values(data, profile)
    except ValueError as exc:
        return error_response(str(exc), 400, "invalid_profile")
    duplicate = db.execute(
        "SELECT id FROM borrower_profiles WHERE company = ?", (values["company"],)
    ).fetchone()
    if duplicate and duplicate["id"] != profile_id:
        return error_response("이미 등록된 기업명입니다. 해당 기업 프로필을 선택해 주세요.", 409, "duplicate_company")
    new_id = generate_id(db)

    try:
        amount = int(data.get("amount") or 0)
        if amount <= 0 or amount > 9_000_000_000_000_000:
            raise ValueError()
    except (TypeError, ValueError):
        return error_response("신청금액을 허용 범위의 양의 정수로 입력하세요.", 400, "invalid_amount")
    term = data.get("termMonths")
    if term and term not in {"12", "24", "36"}:
        return error_response("화면에서 제공하는 상환 희망 기간을 선택하세요.", 400, "invalid_term")

    registry_result = verify_registry(
        data.get("ipRegNo", ""),
        values["bizNo"],
        str(data.get("demoHashMismatch", "")).lower() in {"1", "true", "on"},
    )

    base_record = {
        "id": new_id,
        **chain_fields,
        **values,
        "borrowerProfileId": profile_id,
        "ipType": (data.get("ipType") or "특허권")[:50],
        "ipTitle": (data.get("ipTitle") or "미입력 IP 자산")[:200],
        "amount": amount,
        "termMonths": int(term) if term else None,
        "status": "doc_verify",
        "hash": "",
        "appliedDate": date.today().isoformat(),
        "appraisedValue": None,
        "ltv": None,
        "creditScore": None,
        "rate": None,
        "rejectReason": None,
    }

    if chain_fields:
        base_record["appKey"] = Web3.to_hex(Web3.keccak(text=new_id))

    if not registry_result["match"]:
        mismatch_record = {
            **base_record,
            "hashMatch": 0,
            "docFileName": document.filename[:255],
            "ipRegNo": (data.get("ipRegNo") or "")[:100],
        }
        columns = list(mismatch_record)
        db.execute(
            f"INSERT INTO applications ({', '.join(columns)}) VALUES ({', '.join(':' + c for c in columns)})",
            mismatch_record,
        )
        db.commit()
        response = application_to_public(mismatch_record)
        response["error"] = "registry_mismatch"
        response["message"] = "발급기관 정보와 일치하지 않는 항목이 있습니다: " + ", ".join(
            registry_result["mismatches"]
        )
        response["mismatches"] = registry_result["mismatches"]
        return jsonify(response), 422

    encrypted = encrypt_registry_document(plaintext)
    media = {}
    try:
        uploaded = upload_encrypted_document(encrypted["payload"], document.filename)
        if chain_fields and cfg.get('tokenMediaVersion', 0) >= 1:
            if __package__:
                from . import token_media
            else:
                import token_media
            try:
                if cfg.get('tokenMediaVersion', 0) >= 2 and cfg.get('tokenMediaGateway') != token_media.HTTPS_GATEWAY:
                    raise token_media.TokenMediaError('Contract gateway mismatch')
                media = token_media.prepare(base_record, upload_ipfs_payload, https=cfg.get('tokenMediaVersion', 0) >= 2)
            except token_media.TokenMediaError:
                return error_response('토큰 카드 생성 설정을 확인해 주세요.', 503, 'token_media_failed')
    except IpfsUploadError as exc:
        return error_response(str(exc), exc.status_code, "ipfs_upload_failed")

    # 신청 저장과 프로필 갱신은 같은 트랜잭션. 업로드 실패/원부 불일치 시 갱신하지 않는다.
    try:
        updated_profile = write_profile(db, values, profile_id)
    except sqlite3.IntegrityError:
        db.rollback()
        return error_response("기업정보가 변경되었습니다. 프로필을 다시 선택해 주세요.", 409, "duplicate_company")

    record = {
        **base_record,
        **media,
        "borrowerProfileId": updated_profile["id"],
        "hash": encrypted["file_hash"],
        "docCid": uploaded["cid"],
        "docIpfsUri": uploaded["ipfs"],
        "docFileHash": encrypted["file_hash"],
        "docKey": base64.b64encode(encrypted["key"]).decode("ascii"),
        "docSalt": base64.b64encode(encrypted["salt"]).decode("ascii"),
        "docFileName": document.filename[:255],
        "hashMatch": 1,
        "ipRegNo": (data.get("ipRegNo") or "")[:100],
    }
    columns = list(record)
    db.execute(
        f"INSERT INTO applications ({', '.join(columns)}) VALUES ({', '.join(':' + c for c in columns)})",
        record,
    )
    if workflow_identity:
        loan_workflow.attach(db, record, encrypted["payload"], workflow_identity)
    db.commit()
    if workflow_identity:
        loan_workflow.submit(sys.modules[__name__], record["id"])
    response = application_to_public(record)
    response["borrowerProfile"] = updated_profile
    return jsonify(response), 201


@app.route("/api/applications/<app_id>", methods=["PATCH"])
def patch_application(app_id):
    data = request.get_json(force=True, silent=True) or {}
    db = get_db()
    existing = db.execute("SELECT * FROM applications WHERE id = ?", (app_id,)).fetchone()
    if existing is None:
        return jsonify({"error": "not found"}), 404

    if existing["appKey"]:
        return error_response("지갑으로 트랜잭션을 실행한 뒤 체인 동기화를 사용하세요.", 409, "chain_is_authority")
    if not app.config.get("ALLOW_LEGACY_TEST_SUBMISSIONS", False):
        return error_response("기존 미온체인 신청은 이력 조회용입니다. 신규 통합 신청과 평가사 확정 절차를 사용하세요.", 409, "legacy_history_only")

    updates = {k: v for k, v in data.items() if k in ALLOWED_PATCH_FIELDS}
    if updates:
        updates["id"] = app_id
        set_clause = ", ".join(f"{k} = :{k}" for k in updates if k != "id")
        db.execute(f"UPDATE applications SET {set_clause} WHERE id = :id", updates)
        db.commit()

    updated = db.execute("SELECT * FROM applications WHERE id = ?", (app_id,)).fetchone()
    return jsonify(application_to_public(updated))


@app.route("/api/chain/config")
def chain_config():
    try:
        return jsonify(chain.config())
    except chain.ChainError as exc:
        return error_response(str(exc), 503, "chain_unavailable")


def find_application(app_id):
    row = get_db().execute("SELECT * FROM applications WHERE id = ?", (app_id,)).fetchone()
    return dict(row) if row else None


@app.route("/api/applications/<app_id>/sync", methods=["POST"])
def sync_application(app_id):
    application = find_application(app_id)
    if not application:
        return error_response("신청을 찾을 수 없습니다.", 404, "not_found")
    if not application.get("appKey") or application.get("hashMatch") != 1:
        return error_response("등록 가능한 원부 업로드 신청이 아닙니다.", 409, "not_ready")
    try:
        state = chain.snapshot(application)
        stage = state["chainStatus"]
        if stage == "None":
            if application.get("chainStatus") not in {None, "None"}:
                raise chain.ChainError("이전에 확인한 체인 기록이 없습니다. RPC·로컬 체인 재시작 여부를 확인하세요.")
            return jsonify(application_to_public(application))
        if stage != "Evaluating":
            report = get_db().execute("SELECT * FROM evaluation_reports WHERE applicationId = ? AND hash = ? AND cid = ?",
                                      (app_id, state["reportHash"], state["reportCid"])).fetchone()
            if not report or report["value"] != state["appraisedValue"]:
                raise chain.ChainError("체인의 평가보고서가 이 신청에서 준비한 보고서와 다릅니다.")
        loan_workflow.validate_sync(get_db(), application, state)
        # Never accept caller-provided status, tokenId, repayment or a receipt as proof.
        state["status"] = {"Evaluating": "evaluating", "Eligible": "review", "RuleRejected": "rejected",
                           "Approved": "approved", "Rejected": "rejected", "Repaid": "approved"}[stage]
        if state["appraisedValue"]:
            state["ltv"] = round(application["amount"] / state["appraisedValue"] * 100)
        if stage == "RuleRejected":
            state["rejectReason"] = "컨트랙트 자동심사: 신청금액이 평가액의 70%를 초과했습니다."
        elif stage == "Rejected":
            state["rejectReason"] = "은행 지갑이 최종 거절했습니다."
        else:
            state["rejectReason"] = None
        db = get_db()
        db.execute("BEGIN IMMEDIATE")
        latest = db.execute("SELECT * FROM applications WHERE id=?", (app_id,)).fetchone()
        if latest["chainBlock"] is not None and state.get("chainBlock", 0) < latest["chainBlock"]:
            db.rollback()
            return jsonify(application_to_public(latest))
        updates = {**state, "id": app_id}
        db.execute("UPDATE applications SET " + ", ".join(f"{k}=:{k}" for k in state) + " WHERE id=:id", updates)
        loan_workflow.after_sync(db, application, state)
        db.commit()
        return jsonify(application_to_public(find_application(app_id)))
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


@app.route("/api/applications/<app_id>/evaluation-report", methods=["POST"])
def prepare_evaluation_report(app_id):
    application = find_application(app_id)
    if not application:
        return error_response("신청을 찾을 수 없습니다.", 404, "not_found")
    if not application.get("appKey") or application.get("hashMatch") != 1:
        return error_response("온체인 평가 신청이 아닙니다.", 409, "not_ready")
    try:
        if chain.snapshot(application)["chainStatus"] != "Evaluating":
            return error_response("평가 중인 신청만 보고서를 준비할 수 있습니다.", 409, "wrong_stage")
        data = request.get_json(silent=True) or {}
        if loan_workflow.job(get_db(), app_id):
            if not isinstance(data, dict):
                raise ValueError()
            return jsonify(loan_workflow.prepare(sys.modules[__name__], application, data)), 200
        if not isinstance(data, dict) or isinstance(data.get("appraisedValue"), bool):
            raise ValueError()
        value = int(data.get("appraisedValue", 0))
        if str(value) != str(data.get("appraisedValue")):
            raise ValueError()
        if value <= 0 or value > 9_000_000_000_000_000:
            raise ValueError()
        report = {"appKey": application["appKey"], "fileHash": application["docFileHash"], "appraisedValue": value,
                  "summary": str(data.get("summary", "시연용 IP 가치평가 보고서"))[:4000]}
        payload = json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        digest = "0x" + hashlib.sha256(payload.encode()).hexdigest()
        bank = assign_bank(application) if chain.eligible(application["amount"], value) else None
        previous = get_db().execute("SELECT * FROM evaluation_reports WHERE hash = ?", (digest,)).fetchone()
        if previous:
            return jsonify({"cid": previous["cid"], "hash": digest, "appraisedValue": value, "bankWallet": bank})
        uploaded = upload_ipfs_payload(payload.encode(), "evaluation-report.json", "application/json")
        get_db().execute("INSERT INTO evaluation_reports VALUES (?, ?, ?, ?, ?)", (digest, app_id, uploaded["cid"], payload, value))
        get_db().commit()
        return jsonify({"cid": uploaded["cid"], "hash": digest, "appraisedValue": value, "bankWallet": bank}), 201
    except (ValueError, TypeError):
        return error_response("평가액을 양의 정수로 입력해 주세요.", 400, "invalid_value")
    except chain.ChainError as exc:
        return error_response(str(exc), 409, "chain_unavailable")
    except IpfsUploadError as exc:
        return error_response(str(exc), exc.status_code, "ipfs_upload_failed")


NONCES = {}
NONCE_LOCK = Lock()

@app.route("/api/applications/<app_id>/document-nonce", methods=["POST"])
def document_nonce(app_id):
    if not find_application(app_id):
        return error_response("신청을 찾을 수 없습니다.", 404, "not_found")
    try:
        data = request.get_json(silent=True) or {}
        if not isinstance(data, dict):
            raise chain.ChainError("요청 형식을 확인하세요.")
        wallet = chain.address(data.get("address"))
    except chain.ChainError as exc:
        return error_response(str(exc), 400, "invalid_address")
    nonce = secrets.token_urlsafe(24)
    message = f"IP Loan 시연 원본 열람\n신청번호: {app_id}\n주소: {wallet}\nnonce: {nonce}"
    with NONCE_LOCK:
        for key in [k for k, v in NONCES.items() if v[3] < time.time()]:
            del NONCES[key]
        if len(NONCES) >= 1000:
            return error_response("요청이 많습니다. 잠시 후 다시 시도하세요.", 429, "too_many_requests")
        NONCES[nonce] = (app_id, wallet, message, time.time() + 300)
    return jsonify({"nonce": nonce, "message": message})


@app.route("/api/applications/<app_id>/document", methods=["POST"])
def read_document(app_id):
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict) or not isinstance(data.get("nonce"), str):
        return error_response("요청 형식을 확인하세요.", 400, "invalid_request")
    with NONCE_LOCK:
        challenge = NONCES.pop(data.get("nonce"), None)
    try:
        wallet = chain.address(data.get("address"))
        if not challenge or challenge[0] != app_id or challenge[1] != wallet or challenge[3] < time.time():
            raise ValueError("만료되었거나 재사용한 열람 요청입니다.")
        signature = data.get("signature")
        if not isinstance(signature, str) or not re.fullmatch(r"0x[0-9a-fA-F]{130}", signature):
            raise ValueError("올바른 지갑 서명을 제출하세요.")
        signer = Account.recover_message(encode_defunct(text=challenge[2]), signature=signature)
        if signer.lower() != wallet.lower():
            raise ValueError("지갑 서명을 확인하지 못했습니다.")
        application = find_application(app_id)
        if not application or not application.get("appKey"):
            raise ValueError("열람 가능한 신청이 아닙니다.")
        state = chain.snapshot(application)
        if not state:
            raise ValueError("아직 체인에 등록되지 않은 신청입니다.")
        allowed = (state["chainStatus"] == "Evaluating" and wallet.lower() == application["evaluatorWallet"].lower()) or (
            state["chainStatus"] in {"Approved", "Repaid"} and wallet.lower() == application["bankWallet"].lower())
        if not allowed:
            raise ValueError("현재 이 지갑에는 원본 열람권이 없습니다.")
        # A revoked participant keeps its SBT/NFT but must not keep document access.
        role = "EVALUATOR_ROLE" if state["chainStatus"] == "Evaluating" else "BANK_ROLE"
        if not chain.has_role(wallet, role):
            raise ValueError("역할이 회수된 지갑은 원본을 열람할 수 없습니다.")
        gateway = os.environ.get("IPLOAN_IPFS_GATEWAY", "https://rwa-gw.mustree.kr/ipfs/")
        response = requests.get(gateway.rstrip("/") + "/" + application["docCid"], timeout=(10, 60), stream=True)
        response.raise_for_status()
        chunks, size = [], 0
        for chunk in response.iter_content(65536):
            size += len(chunk)
            if size > MAX_DOCUMENT_BYTES + 28:
                raise ValueError("암호문 크기가 허용 범위를 초과했습니다.")
            chunks.append(chunk)
        response.close()
        encrypted = b"".join(chunks)
        plaintext = AESGCM(base64.b64decode(application["docKey"])).decrypt(encrypted[:12], encrypted[12:], None)
        expected = "0x" + hashlib.sha256(base64.b64decode(application["docSalt"]) + plaintext).hexdigest()
        if expected != application["docFileHash"]:
            raise ValueError("원본 해시가 일치하지 않습니다.")
        return Response(plaintext, mimetype="application/pdf", headers={"Cache-Control": "no-store", "Content-Disposition": "inline; filename=registry.pdf"})
    except (ValueError, chain.ChainError) as exc:
        return error_response(str(exc), 403, "document_forbidden")
    except Exception:
        return error_response("원본을 다운로드·복호화하지 못했습니다.", 502, "document_unavailable")


@app.route("/api/reset", methods=["POST"])
def reset_applications():
    if chain.MANAGER_ADDRESS or get_db().execute("SELECT 1 FROM loan_evaluations LIMIT 1").fetchone():
        return error_response("온체인 계약 연결 중에는 DB 초기화를 막습니다. 체인 기록은 초기화되지 않습니다.", 409, "chain_reset_forbidden")
    key = os.environ.get("IPLOAN_ADMIN_KEY", "")
    if not (key and os.environ.get("IPLOAN_ENABLE_RESET") == "1"
            and secrets.compare_digest(request.headers.get("X-Admin-Key", ""), key)):
        return error_response("데이터 초기화가 비활성화되어 있습니다.", 403, "reset_disabled")
    db = get_db()
    seed(db)
    db.commit()
    rows = db.execute("SELECT * FROM applications ORDER BY appliedDate DESC, id DESC").fetchall()
    return jsonify([application_to_public(r) for r in rows])


@app.errorhandler(413)
def request_too_large(_error):
    return error_response("파일이 너무 큽니다. 더 작은 PDF로 다시 시도하세요.", 413, "file_too_large")


loan_workflow.register(sys.modules[__name__])
if __package__:
    from . import token_cards_api
else:
    import token_cards_api
token_cards_api.register(sys.modules[__name__])
init_db()


# 기존 지갑·IPFS API를 유지하며 특허 공고전문 평가 앱을 별도 경로에 연결한다.
from werkzeug.middleware.dispatcher import DispatcherMiddleware
if __package__:
    from . import patent_app
else:
    import patent_app


def patent_wsgi(environ, start_response):
    # Existing DB and GET history remain available. New business mutations must
    # use the single loan-owned workflow; the old unauthenticated confirm API
    # cannot create an alternate route to credit review.
    if environ.get("REQUEST_METHOD") not in {"GET", "HEAD", "OPTIONS"} and not app.config.get("ALLOW_LEGACY_TEST_SUBMISSIONS", False):
        response = Response(json.dumps({"message": "기존 특허평가는 이력 조회만 지원합니다. 대출·평가 통합 신청을 사용하세요."}, ensure_ascii=False), status=410, mimetype="application/json")
        return response(environ, start_response)
    forwarded = dict(environ)
    forwarded["PATH_INFO"] = "/api" + environ.get("PATH_INFO", "")
    return patent_app.app(forwarded, start_response)


app.wsgi_app = DispatcherMiddleware(app.wsgi_app, {"/api/patent": patent_wsgi})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5001)))
