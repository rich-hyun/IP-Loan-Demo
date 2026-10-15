"""IP-Loan demo API — 기존 SQLite 파일에 대한 비파괴적 확장 (2026-10-15).

기존 대출 신청 조회/JSON 생성/PATCH API를 유지하면서 다음을 추가합니다.
- GET /api/borrower-profiles (기업 프로필 목록)
- POST /api/applications multipart/form-data (특허등록원부 PDF 보관, SHA-256)
- 신청/프로필 연결, 기업정보 자동 저장, 기존 신청 이력 마이그레이션
- 특허 공고전문 PDF 접수, 평가 작업 저장·조회, 보고서 프록시, 평가자 확정

중요: 이 서버는 데모용입니다. 로그인/권한체계가 없어 실제 기업 및 개인 데이터를
외부 공개한 상태로 저장하거나 조회하는 데 사용하면 안 됩니다.
실제 IPFS 업로드/암호화/온체인 기록을 수행하지 않습니다.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import sqlite3
import tempfile
import uuid
from datetime import date, datetime, timezone
from pathlib import Path

from flask import Flask, Response, g, jsonify, request, send_from_directory, stream_with_context
from flask_cors import CORS
from werkzeug.exceptions import RequestEntityTooLarge

if __package__:
    from .patent_api import PatentAPIError, patent_api
else:
    from patent_api import PatentAPIError, patent_api

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("IPLOAN_PATENT_DB_PATH", str(ROOT / "patent-iploan.db"))).resolve()
UPLOAD_DIR = Path(os.environ.get("IPLOAN_PATENT_UPLOAD_DIR", str(ROOT / "patent-uploads"))).resolve()
MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_PATENT_BYTES = 50 * 1024 * 1024
WEB_ROOT = ROOT.parent

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = MAX_PATENT_BYTES + 256 * 1024
app.json.ensure_ascii = False
ORIGINS = [x.strip() for x in os.environ.get(
    "IPLOAN_ALLOWED_ORIGINS",
    "https://iploan.mustree.kr,http://127.0.0.1:5000,http://localhost:5000",
).split(",") if x.strip()]
CORS(app, resources={r"/api/*": {"origins": ORIGINS}},
     allow_headers=["Content-Type", "X-Admin-Key"])

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
    rejectReason TEXT
);
CREATE TABLE IF NOT EXISTS borrower_profiles (
    id TEXT PRIMARY KEY,
    company TEXT NOT NULL,
    bizNo TEXT,
    ceo TEXT,
    contact TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS uploaded_documents (
    id TEXT PRIMARY KEY,
    appId TEXT NOT NULL,
    originalFilename TEXT NOT NULL,
    storedFilename TEXT NOT NULL,
    fileSize INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    storageMode TEXT NOT NULL DEFAULT 'local',
    createdAt TEXT NOT NULL,
    FOREIGN KEY (appId) REFERENCES applications(id)
);
CREATE INDEX IF NOT EXISTS idx_profiles_bizNo ON borrower_profiles(bizNo);
CREATE INDEX IF NOT EXISTS idx_docs_appId ON uploaded_documents(appId);
CREATE TABLE IF NOT EXISTS evaluation_jobs (
    appId TEXT PRIMARY KEY REFERENCES applications(id),
    clientRequestId TEXT UNIQUE,
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

FIELDS = ["id", "company", "bizNo", "ipType", "ipTitle", "amount", "status", "hash",
          "appliedDate", "appraisedValue", "ltv", "creditScore", "rate", "rejectReason"]
ALLOWED_PATCH_FIELDS = {"status", "appraisedValue", "ltv", "creditScore", "rate", "rejectReason"}
ADDED_COLUMNS = {
    "borrowerProfileId": "TEXT", "ipRegNo": "TEXT", "ceo": "TEXT",
    "contact": "TEXT", "docFileHash": "TEXT", "docCid": "TEXT",
    "storageMode": "TEXT", "borrowerWallet": "TEXT",
}


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect_db():
    conn = sqlite3.connect(str(DB_PATH), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA foreign_keys=ON")
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


def seed(conn):
    """새 DB 초기화 및 승인된 데모 리셋 전용. 마이그레이션 중 호출하지 않음."""
    conn.execute("DELETE FROM applications")
    placeholders = ", ".join(f":{f}" for f in FIELDS)
    conn.executemany(
        f"INSERT INTO applications ({', '.join(FIELDS)}) VALUES ({placeholders})",
        DEFAULT_APPLICATIONS,
    )


def record_profile(conn, company, biz_no, ceo="", contact="", requested_id=""):
    """회사 식별번호를 우선하는 데모용 프로필 upsert."""
    company = (company or "").strip()[:200]
    biz_no = (biz_no or "").strip()[:50]
    ceo = (ceo or "").strip()[:100]
    contact = (contact or "").strip()[:100]
    if not company:
        raise ValueError("기업명은 필수입니다.")

    row = None
    if requested_id:
        row = conn.execute("SELECT * FROM borrower_profiles WHERE id = ?", (requested_id,)).fetchone()
        if row is None:
            raise ValueError("선택한 차주기업 프로필을 찾을 수 없습니다.")
        if row["bizNo"] and biz_no and row["bizNo"].replace("-", "") != biz_no.replace("-", ""):
            raise ValueError("선택한 프로필의 사업자등록번호와 입력값이 일치하지 않습니다.")
    if row is None and biz_no:
        row = conn.execute("SELECT * FROM borrower_profiles WHERE REPLACE(bizNo,'-','') = ? ORDER BY createdAt LIMIT 1", (biz_no.replace("-", ""),)).fetchone()
    if row is None:
        # 사업자등록번호 없이 동일 기업명이 입력되어도 프로필을 임의로 결합하지 않음
        profile_id = "BP-" + uuid.uuid4().hex[:16]
        ts = timestamp()
        conn.execute("""INSERT INTO borrower_profiles
            (id,company,bizNo,ceo,contact,createdAt,updatedAt)
            VALUES (?,?,?,?,?,?,?)""",
            (profile_id, company, biz_no, ceo, contact, ts, ts))
    else:
        profile_id = row["id"]
        # 이전 입력정보가 빈 문자열이면 기존 값을 보존한다.
        conn.execute("""UPDATE borrower_profiles
            SET company=?, bizNo=?, ceo=?, contact=?, updatedAt=? WHERE id=?""",
            (company, biz_no or row["bizNo"], ceo or row["ceo"],
             contact or row["contact"], timestamp(), profile_id))
    return conn.execute("SELECT * FROM borrower_profiles WHERE id=?", (profile_id,)).fetchone()


def init_db():
    # 기존 DB가 있으면 스키마/인덱스/연결만 확장. 기존 신청자료는 삭제하지 않음.
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    database_exists = DB_PATH.exists()
    conn = connect_db()
    try:
        # Gunicorn 다중 worker의 동시 마이그레이션 경합을 방지하기 위해
        # CREATE TABLE / ALTER TABLE / 프로필 백필을 하나의 쓰기 트랜잭션에서 실행.
        conn.execute("BEGIN IMMEDIATE")
        for statement in SCHEMA.split(";"):
            if statement.strip():
                conn.execute(statement)
        existing_cols = {r["name"] for r in conn.execute("PRAGMA table_info(applications)")}
        for col, definition in ADDED_COLUMNS.items():
            if col not in existing_cols:
                conn.execute(f"ALTER TABLE applications ADD COLUMN {col} {definition}")
        job_cols = {r["name"] for r in conn.execute("PRAGMA table_info(evaluation_jobs)")}
        if "clientRequestId" not in job_cols:
            conn.execute("ALTER TABLE evaluation_jobs ADD COLUMN clientRequestId TEXT")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_request ON evaluation_jobs(clientRequestId)")

        # 신규 DB에서만 데모용 신청 내역을 생성한다.
        if not database_exists and conn.execute("SELECT COUNT(*) FROM applications").fetchone()[0] == 0:
            seed(conn)

        # 기존 데이터가 가진 회사/사업자번호로 프로필을 만들어 연결한다.
        existing = conn.execute("""SELECT id, company, bizNo FROM applications
            WHERE borrowerProfileId IS NULL ORDER BY appliedDate ASC, id ASC""").fetchall()
        for row in existing:
            profile = record_profile(conn, row["company"], row["bizNo"])
            conn.execute("UPDATE applications SET borrowerProfileId=? WHERE id=?",
                         (profile["id"], row["id"]))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def filter_none(row):
    return {k: v for k, v in dict(row).items() if v is not None}


def public_row(row):
    """인증 없는 목록 API에서는 담당자 이름/전화번호를 기본적으로 노출하지 않는다.

    기존 공개 데모에서 시험자료에 한해서만 명시적으로 노출하려면
    IPLOAN_EXPOSE_PUBLIC_PERSONAL_DATA=1 설정을 사용한다(운영 사용 금지).
    """
    data = filter_none(row)
    if os.environ.get("IPLOAN_EXPOSE_PUBLIC_PERSONAL_DATA") != "1":
        data.pop("ceo", None)
        data.pop("contact", None)
    return data


def application_payload(conn, row):
    data = public_row(row)
    job = conn.execute("SELECT * FROM evaluation_jobs WHERE appId=?", (row["id"],)).fetchone()
    if job is not None:
        kinds = json.loads(job["artifacts"])
        data["evaluation"] = {
            "job_id": job["jobId"], "status": job["status"], "stage": job["stage"],
            "business_number": job["businessNumber"], "identity_message": job["identityMessage"],
            "error": job["error"], "detail": json.loads(job["detail"]) if job["detail"] else None,
            "read_error": job["readError"], "retry_after": job["retryAfter"],
            "submitted_at": job["submittedAt"], "updated_at": job["updatedAt"],
            "confirmed_at": job["confirmedAt"], "reviewer_note": job["reviewerNote"],
            "artifacts": {kind: f"{request.script_root or '/api'}/applications/{row['id']}/evaluation/artifacts/{kind}"
                          for kind in kinds if kind in patent_api.kinds},
        }
    return data


def save_job(conn, app_id, job):
    artifacts = job.get("artifacts") or {}
    if not isinstance(artifacts, dict):
        artifacts = {}
    artifacts = {kind: path for kind, path in artifacts.items()
                 if kind in patent_api.kinds and isinstance(path, str) and path}
    ts = timestamp()
    # 공급자 자유문에서 인증값을 제거한다.
    safe_text = lambda value: str(value or "").replace(patent_api.token, "[redacted]") if patent_api.token else str(value or "")
    conn.execute("""UPDATE evaluation_jobs SET jobId=?,status=?,stage=?,businessNumber=?,
        identityMessage=?,artifacts=?,error=?,detail=NULL,readError=NULL,retryAfter=NULL,
        updatedAt=?,lastCheckedAt=? WHERE appId=?""", (
        job["job_id"], job["status"], safe_text(job.get("stage")), job.get("business_number"),
        safe_text(job.get("identity_message")), json.dumps(artifacts),
        safe_text(job.get("error")), ts, ts, app_id,
    ))
    status = {"awaiting_identity": "doc_verify", "queued": "evaluating", "running": "evaluating",
              "completed": "report_ready", "failed": "report_failed"}[job["status"]]
    conn.execute("""UPDATE applications SET status=? WHERE id=? AND
        NOT EXISTS (SELECT 1 FROM evaluation_jobs WHERE appId=? AND confirmedAt IS NOT NULL)""",
                 (status, app_id, app_id))
    conn.commit()


def submit_evaluation(conn, app_id):
    """외부 접수 전에 저장한 신청번호에 접수 결과를 연결한다."""
    row = conn.execute("SELECT * FROM applications WHERE id=?", (app_id,)).fetchone()
    document = conn.execute("SELECT * FROM uploaded_documents WHERE appId=? ORDER BY createdAt LIMIT 1",
                            (app_id,)).fetchone()
    try:
        job = patent_api.submit(UPLOAD_DIR / document["storedFilename"], document["originalFilename"],
                                re.sub(r"\D", "", row["bizNo"]))
        save_job(conn, app_id, job)
    except PatentAPIError as exc:
        status = "submission_unknown" if exc.uncertain else "submission_rejected"
        conn.execute("""UPDATE evaluation_jobs SET status=?,error=?,detail=?,retryAfter=?,updatedAt=?
            WHERE appId=?""", (status, str(exc), json.dumps(exc.detail, ensure_ascii=False),
                               exc.retry_after, timestamp(), app_id))
        conn.execute("UPDATE applications SET status='report_failed' WHERE id=?", (app_id,))
        conn.commit()
    except OSError:
        conn.execute("UPDATE evaluation_jobs SET status='submission_rejected',error=?,updatedAt=? WHERE appId=?",
                     ("보관된 특허 PDF를 읽을 수 없습니다. 운영 담당자에게 문의해 주세요.", timestamp(), app_id))
        conn.commit()
    return application_payload(conn, conn.execute("SELECT * FROM applications WHERE id=?", (app_id,)).fetchone())


def normalize_business_number(value):
    value = str(value or "").strip()
    if not re.fullmatch(r"(?:\d{10}|\d{3}-\d{2}-\d{5})", value, flags=re.ASCII):
        raise ValueError("사업자등록번호는 숫자 10자리 또는 000-00-00000 형식으로 입력해 주세요.")
    return value.replace("-", "")


def generate_id(conn):
    for _ in range(100):
        candidate = f"LN-{date.today().year}-{secrets.randbelow(900000):06d}"
        if conn.execute("SELECT 1 FROM applications WHERE id=?", (candidate,)).fetchone() is None:
            return candidate
    raise RuntimeError("새 신청번호 생성에 실패했습니다.")


def error(message, code):
    return jsonify({"error": message}), code


def text_field(data, name, max_length=200):
    return str(data.get(name) or "").strip()[:max_length]


def stage_pdf(upload, max_bytes=MAX_FILE_BYTES):
    """제출 PDF를 임시 파일에 저장하고 파일 내용의 SHA-256을 계산한다.

    IPFS 업로드, 암호화, 권리 등록원부의 진위 판정은 하지 않는다.
    """
    if upload is None or not upload.filename:
        raise ValueError("평가할 PDF 파일을 첨부해 주세요.")
    filename = upload.filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1][:200]
    if Path(filename).suffix.lower() != ".pdf":
        raise ValueError("PDF 파일만 지원합니다.")
    UPLOAD_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    # NAS 권한·umask에 따라 권한이 달라질 수 있어 0700으로 명시
    try:
        UPLOAD_DIR.chmod(0o700)
    except OSError:
        pass
    fd, tmp_path = tempfile.mkstemp(prefix=".iploan-upload-", dir=UPLOAD_DIR)
    os.chmod(tmp_path, 0o600)
    digest = hashlib.sha256()
    size = 0
    prefix = b""
    try:
        with os.fdopen(fd, "wb") as target:
            while True:
                chunk = upload.stream.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise ValueError(f"파일 크기는 {max_bytes // (1024 * 1024)}MiB 이하여야 합니다.")
                if len(prefix) < 5:
                    prefix += chunk[:5-len(prefix)]
                digest.update(chunk)
                target.write(chunk)
        if not prefix.startswith(b"%PDF-"):
            raise ValueError("PDF 형식이 올바르지 않습니다.")
        return filename, tmp_path, size, digest.hexdigest()
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


@app.errorhandler(RequestEntityTooLarge)
def file_too_large(_exc):
    return error("요청 파일이 50MiB 제한을 초과했습니다.", 413)


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "storageMode": "local", "ipfsEnabled": False,
                    "evaluationConfigured": patent_api.configured})


@app.route("/api/borrower-profiles", methods=["GET"])
def list_profiles():
    conn = get_db()
    rows = conn.execute("""SELECT id,company,bizNo,ceo,contact,createdAt,updatedAt
        FROM borrower_profiles ORDER BY company COLLATE NOCASE, id""").fetchall()
    return jsonify([public_row(r) for r in rows])


@app.route("/api/applications", methods=["GET"])
def list_applications():
    conn = get_db()
    rows = conn.execute("SELECT * FROM applications ORDER BY appliedDate DESC, id DESC").fetchall()
    return jsonify([application_payload(conn, r) for r in rows])


@app.route("/api/applications", methods=["POST"])
def create_application():
    # 기존 JSON 형식 + 신규 FormData/PDF 방식을 모두 지원
    is_multipart = request.mimetype == "multipart/form-data"
    if is_multipart:
        data = request.form
        upload = request.files.get("patent_pdf") or request.files.get("registryDocument")
    elif request.is_json:
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return error("JSON 본문이 올바르지 않습니다.", 400)
        upload = None
    else:
        return error("application/json 또는 multipart/form-data 요청만 지원합니다.", 415)

    is_evaluation = is_multipart and "patent_pdf" in request.files
    request_id = text_field(data, "request_id", 64) if is_evaluation else ""
    if request_id and not re.fullmatch(r"[A-Za-z0-9_-]{16,64}", request_id):
        return error("신청 식별값이 올바르지 않습니다. 화면을 새로고침해 주세요.", 400)
    conn = get_db()
    if request_id:
        previous = conn.execute("""SELECT a.* FROM applications a JOIN evaluation_jobs j ON j.appId=a.id
            WHERE j.clientRequestId=?""", (request_id,)).fetchone()
        if previous is not None:
            return jsonify(application_payload(conn, previous)), 200
    company = text_field(data, "company")
    biz_no = text_field(data, "bizNo", 50)
    if is_evaluation:
        if not patent_api.configured:
            return error("보고서 서비스 연결 설정이 필요합니다. 운영 담당자에게 문의해 주세요.", 503)
        try:
            number = normalize_business_number(biz_no)
            biz_no = f"{number[:3]}-{number[3:5]}-{number[5:]}"
        except ValueError as exc:
            return error(str(exc), 400)
        if not company:
            profile = conn.execute("""SELECT company FROM borrower_profiles
                WHERE REPLACE(bizNo,'-','')=? ORDER BY createdAt LIMIT 1""", (number,)).fetchone()
            company = profile["company"] if profile else f"사업자 {biz_no}"
    if not company:
        return error("기업명을 입력해 주세요.", 400)
    amount_raw = data.get("amount") or ("0" if is_evaluation else None)
    try:
        amount = int(amount_raw)
        if amount < 0 or (amount == 0 and not is_evaluation) or amount > 9_000_000_000_000_000:
            raise ValueError
    except (TypeError, ValueError):
        return error("대출 희망 금액은 0보다 큰 정수여야 합니다.", 400)

    staged = None
    if is_multipart:
        try:
            staged = stage_pdf(upload, MAX_PATENT_BYTES if is_evaluation else MAX_FILE_BYTES)
        except ValueError as exc:
            return error(str(exc), 400)

    new_id = generate_id(conn)
    final_path = None
    persisted = False
    try:
        profile = record_profile(
            conn, company, biz_no, text_field(data, "ceo", 100),
            text_field(data, "contact", 100), text_field(data, "borrowerProfileId", 64),
        )
        doc_hash = "0x" + staged[3] if staged else None
        record = {
            "id": new_id,
            "company": company,
            "bizNo": biz_no,
            "ipType": "특허권" if is_evaluation else (text_field(data, "ipType", 50) or "특허권"),
            "ipTitle": text_field(data, "ipTitle") or (Path(staged[0]).stem if is_evaluation else "미입력 IP 자산"),
            "amount": amount,
            "status": "pending",
            "hash": doc_hash or text_field(data, "hash", 100),
            "appliedDate": date.today().isoformat(),
            "appraisedValue": None, "ltv": None, "creditScore": None,
            "rate": None, "rejectReason": None,
            "borrowerProfileId": profile["id"],
            "ipRegNo": text_field(data, "ipRegNo", 100),
            "ceo": text_field(data, "ceo", 100),
            "contact": text_field(data, "contact", 100),
            "docFileHash": doc_hash,
            "docCid": None,
            "storageMode": "local" if staged else None,
            "borrowerWallet": text_field(data, "borrowerWallet", 100),
        }
        cols = list(record)
        conn.execute(
            f"INSERT INTO applications ({', '.join(cols)}) VALUES ({', '.join(':'+c for c in cols)})",
            record,
        )
        if staged:
            original_filename, temp_path, size, hexhash = staged
            # 유추하기 어려운 파일명으로 원본을 로컬 디스크에 비공개 저장
            stored_name = uuid.uuid4().hex + ".pdf"
            final_path = UPLOAD_DIR / stored_name
            os.replace(temp_path, final_path)
            conn.execute("""INSERT INTO uploaded_documents
                (id,appId,originalFilename,storedFilename,fileSize,sha256,storageMode,createdAt)
                VALUES (?,?,?,?,?,?,?,?)""", (
                uuid.uuid4().hex, new_id, original_filename, stored_name,
                size, hexhash, "local", timestamp(),
            ))
        if is_evaluation:
            ts = timestamp()
            conn.execute("""INSERT INTO evaluation_jobs (appId,clientRequestId,status,businessNumber,submittedAt,updatedAt)
                VALUES (?,?,'submitting',?,?,?)""", (new_id, request_id or None, number, ts, ts))
            conn.execute("UPDATE applications SET status='evaluating' WHERE id=?", (new_id,))
        conn.commit()
        persisted = True
        response = submit_evaluation(conn, new_id) if is_evaluation else filter_none(record)
        # 응답의 프로필을 프론트에서 바로 사용함
        response.update({
            "borrowerProfile": filter_none(profile),
            "docFileHash": doc_hash,
            "docCid": None,
            "appKey": None,
            "storageMode": "local" if staged else None,
            "ipfsUploaded": False,
            "encrypted": False,
        })
        return jsonify(response), 201
    except ValueError as exc:
        conn.rollback()
        if persisted:
            return jsonify(application_payload(conn, conn.execute(
                "SELECT * FROM applications WHERE id=?", (new_id,)).fetchone())), 201
        if final_path is not None:
            final_path.unlink(missing_ok=True)
        elif staged:
            Path(staged[1]).unlink(missing_ok=True)
        return error(str(exc), 400)
    except sqlite3.IntegrityError:
        conn.rollback()
        if persisted:
            return jsonify(application_payload(conn, conn.execute(
                "SELECT * FROM applications WHERE id=?", (new_id,)).fetchone())), 201
        if final_path is not None:
            final_path.unlink(missing_ok=True)
        elif staged:
            Path(staged[1]).unlink(missing_ok=True)
        previous = conn.execute("""SELECT a.* FROM applications a JOIN evaluation_jobs j ON j.appId=a.id
            WHERE j.clientRequestId=?""", (request_id,)).fetchone() if request_id else None
        if previous is not None:
            return jsonify(application_payload(conn, previous)), 200
        return error("신청 저장 중 충돌이 발생했습니다. 다시 시도해 주세요.", 409)
    except Exception:
        conn.rollback()
        if persisted:
            # 외부 접수 후 오류가 나도 PDF/신청을 삭제하거나 재접수하지 않는다.
            app.logger.exception("저장된 신청의 평가 접수 결과 처리 실패: %s", new_id)
            return jsonify(application_payload(conn, conn.execute(
                "SELECT * FROM applications WHERE id=?", (new_id,)).fetchone())), 201
        if final_path is not None:
            final_path.unlink(missing_ok=True)
        elif staged:
            Path(staged[1]).unlink(missing_ok=True)
        app.logger.exception("신청서 생성 실패")
        return error("신청을 저장하지 못했습니다. 서버 로그를 확인하세요.", 500)


@app.route("/api/applications/<app_id>/evaluation", methods=["GET"])
def evaluation_status(app_id):
    conn = get_db()
    row = conn.execute("SELECT * FROM applications WHERE id=?", (app_id,)).fetchone()
    job = conn.execute("SELECT * FROM evaluation_jobs WHERE appId=?", (app_id,)).fetchone()
    if row is None or job is None:
        return error("해당 신청의 평가 작업을 찾을 수 없습니다.", 404)
    if job["status"] == "submitting":
        elapsed = (datetime.now(timezone.utc) - datetime.fromisoformat(job["updatedAt"])).total_seconds()
        if elapsed > 90:
            conn.execute("""UPDATE evaluation_jobs SET status='submission_unknown',error=?
                WHERE appId=? AND status='submitting'""",
                         ("접수 결과를 확인하지 못했습니다. 중복 접수를 방지하기 위해 운영 담당자의 확인이 필요합니다.", app_id))
            conn.commit()
    elif job["jobId"] and job["status"] in {"queued", "running", "awaiting_identity"}:
        # 여러 브라우저와 Gunicorn worker가 있어도 작업당 10초 이내 중복 조회를 막는다.
        now = datetime.now(timezone.utc)
        last = datetime.fromisoformat(job["lastCheckedAt"]) if job["lastCheckedAt"] else None
        if last is None or (now - last).total_seconds() >= 10:
            claimed = conn.execute("""UPDATE evaluation_jobs SET lastCheckedAt=? WHERE appId=?
                AND (lastCheckedAt IS NULL OR lastCheckedAt=?)""", (timestamp(), app_id, job["lastCheckedAt"]))
            conn.commit()
            if claimed.rowcount:
                try:
                    save_job(conn, app_id, patent_api.status(job["jobId"]))
                except PatentAPIError as exc:
                    conn.execute("UPDATE evaluation_jobs SET readError=? WHERE appId=?", (str(exc), app_id))
                    conn.commit()
    return jsonify(application_payload(conn, conn.execute("SELECT * FROM applications WHERE id=?", (app_id,)).fetchone()))


@app.route("/api/applications/<app_id>/evaluation", methods=["POST"])
def retry_evaluation(app_id):
    conn = get_db()
    job = conn.execute("SELECT * FROM evaluation_jobs WHERE appId=?", (app_id,)).fetchone()
    if job is None:
        return error("평가 요청을 찾을 수 없습니다.", 404)
    if job["status"] != "submission_rejected" or job["jobId"]:
        return error("이미 접수되었거나 접수 여부 확인이 필요한 작업입니다. 기존 작업의 상태를 확인해 주세요.", 409)
    if not patent_api.configured:
        return error("보고서 서비스 연결 설정이 필요합니다.", 503)
    if job["retryAfter"]:
        elapsed = (datetime.now(timezone.utc) - datetime.fromisoformat(job["updatedAt"])).total_seconds()
        if elapsed < job["retryAfter"]:
            response = jsonify({"error": "접수 가능한 시간이 되면 다시 시도해 주세요."})
            response.headers["Retry-After"] = str(max(1, int(job["retryAfter"] - elapsed)))
            return response, 429
    claimed = conn.execute("""UPDATE evaluation_jobs SET status='submitting',updatedAt=?,error=NULL,
        detail=NULL,readError=NULL,retryAfter=NULL WHERE appId=? AND status='submission_rejected' AND jobId IS NULL""",
                           (timestamp(), app_id))
    conn.commit()
    if not claimed.rowcount:
        return error("이미 접수가 진행 중입니다. 기존 신청의 상태를 확인해 주세요.", 409)
    return jsonify(submit_evaluation(conn, app_id))


@app.route("/api/applications/<app_id>/evaluation/identity", methods=["POST"])
def evaluation_identity(app_id):
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return error("JSON 요청이 필요합니다.", 400)
    try:
        business_number = normalize_business_number(data.get("business_number"))
    except ValueError as exc:
        return error(str(exc), 400)
    conn = get_db()
    job = conn.execute("SELECT * FROM evaluation_jobs WHERE appId=?", (app_id,)).fetchone()
    if job is None:
        return error("평가 요청을 찾을 수 없습니다.", 404)
    if job["status"] != "awaiting_identity" or not job["jobId"]:
        return error("사업자번호 입력을 기다리는 작업이 아닙니다. 현재 상태를 확인해 주세요.", 409)
    try:
        result = patent_api.identify(job["jobId"], business_number)
    except PatentAPIError as exc:
        return jsonify({"error": str(exc), "detail": exc.detail}), exc.status
    number = f"{business_number[:3]}-{business_number[3:5]}-{business_number[5:]}"
    application = conn.execute("SELECT * FROM applications WHERE id=?", (app_id,)).fetchone()
    company = application["company"]
    if company == f"사업자 {application['bizNo']}":
        known = conn.execute("SELECT company FROM borrower_profiles WHERE REPLACE(bizNo,'-','')=? ORDER BY createdAt LIMIT 1",
                             (business_number,)).fetchone()
        company = known["company"] if known else f"사업자 {number}"
    profile = record_profile(conn, company, number)
    conn.execute("UPDATE applications SET company=?,bizNo=?,borrowerProfileId=? WHERE id=?",
                 (company, number, profile["id"], app_id))
    save_job(conn, app_id, result)
    return jsonify(application_payload(conn, conn.execute("SELECT * FROM applications WHERE id=?", (app_id,)).fetchone()))


@app.route("/api/applications/<app_id>/evaluation/artifacts/<kind>", methods=["GET"])
def evaluation_artifact(app_id, kind):
    job = get_db().execute("SELECT * FROM evaluation_jobs WHERE appId=?", (app_id,)).fetchone()
    if job is None or kind not in patent_api.kinds:
        return error("보고서를 찾을 수 없습니다.", 404)
    if job["status"] != "completed":
        return error("보고서가 아직 준비되지 않았습니다.", 409)
    if kind not in json.loads(job["artifacts"]):
        return error("해당 형식의 결과가 제공되지 않았습니다.", 404)
    try:
        upstream = patent_api.artifact(job["jobId"], kind)
    except PatentAPIError as exc:
        return jsonify({"error": str(exc), "detail": exc.detail}), exc.status

    def chunks():
        try:
            while True:
                chunk = upstream.read(64 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:
            upstream.close()

    types = {"pdf": "application/pdf", "html": "text/html; charset=utf-8",
             "quality": "application/json", "trace": "text/markdown; charset=utf-8",
             "timing": "application/json", "log": "text/plain; charset=utf-8"}
    suffix = {"quality": "json", "timing": "json", "trace": "md", "log": "txt"}.get(kind, kind)
    disposition = "attachment" if request.args.get("download") == "1" or kind not in {"pdf", "html"} else "inline"
    response = Response(stream_with_context(chunks()), content_type=types[kind])
    response.headers["Content-Disposition"] = f'{disposition}; filename="{app_id}-{kind}.{suffix}"'
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    if kind == "html":
        # 보고서 HTML은 별도 권한 없는 문서로 표시한다.
        response.headers["Content-Security-Policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
    return response


@app.route("/api/applications/<app_id>/evaluation/confirm", methods=["POST"])
def confirm_evaluation(app_id):
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return error("JSON 요청이 필요합니다.", 400)
    value = data.get("appraisedValue")
    credit = data.get("creditScore")
    if type(value) is not int or not 0 < value <= 9_000_000_000_000_000:
        return error("확정 담보가치는 0보다 큰 정수로 입력해 주세요.", 400)
    if type(credit) is not int or not 0 <= credit <= 100:
        return error("신용평가 점수는 0~100 사이의 정수로 입력해 주세요.", 400)
    conn = get_db()
    conn.execute("BEGIN IMMEDIATE")
    job = conn.execute("SELECT * FROM evaluation_jobs WHERE appId=?", (app_id,)).fetchone()
    row = conn.execute("SELECT * FROM applications WHERE id=?", (app_id,)).fetchone()
    if job is None or row is None:
        conn.rollback()
        return error("평가 요청을 찾을 수 없습니다.", 404)
    if job["status"] != "completed" or not ({"pdf", "html"} & set(json.loads(job["artifacts"]))):
        conn.rollback()
        return error("보고서가 준비된 후 평가를 확정할 수 있습니다.", 409)
    if job["confirmedAt"]:
        conn.rollback()
        return error("이미 확정된 평가입니다.", 409)
    amount = row["amount"] or 0
    ltv = min(999, round(amount / value * 100)) if amount else None
    conn.execute("UPDATE applications SET appraisedValue=?,creditScore=?,ltv=?,status=? WHERE id=?",
                 (value, credit, ltv, "review" if amount else "evaluated", app_id))
    conn.execute("UPDATE evaluation_jobs SET confirmedAt=?,reviewerNote=? WHERE appId=?",
                 (timestamp(), text_field(data, "reviewerNote", 2000), app_id))
    conn.commit()
    return jsonify(application_payload(conn, conn.execute("SELECT * FROM applications WHERE id=?", (app_id,)).fetchone()))


@app.route("/api/applications/<app_id>", methods=["PATCH"])
def patch_application(app_id):
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return error("JSON 요청이 필요합니다.", 400)
    conn = get_db()
    existing = conn.execute("SELECT * FROM applications WHERE id=?", (app_id,)).fetchone()
    if existing is None:
        return error("not found", 404)
    updates = {k: v for k, v in data.items() if k in ALLOWED_PATCH_FIELDS}
    job = conn.execute("SELECT * FROM evaluation_jobs WHERE appId=?", (app_id,)).fetchone()
    if job is not None:
        if any(key in updates for key in {"appraisedValue", "creditScore", "ltv"}):
            return error("평가자 보고서 화면에서 가치평가를 확정해 주세요.", 409)
        if updates.get("status") in {"review", "evaluated", "approved", "rejected"} and not job["confirmedAt"]:
            return error("보고서를 검토하고 가치평가를 먼저 확정해 주세요.", 409)
        if updates.get("status") in {"review", "approved", "rejected"} and not existing["amount"]:
            return error("대출 희망 금액이 입력되지 않은 가치평가 신청입니다.", 409)
    if updates:
        updates["id"] = app_id
        set_clause = ", ".join(f"{k}=:{k}" for k in updates if k != "id")
        conn.execute(f"UPDATE applications SET {set_clause} WHERE id=:id", updates)
        conn.commit()
    updated = conn.execute("SELECT * FROM applications WHERE id=?", (app_id,)).fetchone()
    return jsonify(application_payload(conn, updated))


@app.route("/api/reset", methods=["POST"])
def reset_applications():
    # 이전 버전의 무인증 전체 삭제 API를 안전상의 이유로 기본 비활성화.
    key = os.environ.get("IPLOAN_ADMIN_KEY", "")
    if not (key and os.environ.get("IPLOAN_ENABLE_RESET") == "1"
            and secrets.compare_digest(request.headers.get("X-Admin-Key", ""), key)):
        return error("데이터 초기화가 비활성화되어 있습니다.", 403)
    conn = get_db()
    conn.execute("DELETE FROM evaluation_jobs")
    conn.execute("DELETE FROM uploaded_documents")
    seed(conn)
    conn.commit()
    # 관리자가 명시적으로 활성화한 경우에만 사용 가능. 파일은 안전상 자동 삭제하지 않음.
    return list_applications()


@app.route("/")
def web_index():
    return send_from_directory(WEB_ROOT, "patent.html")


@app.route("/css/<path:filename>")
def web_css(filename):
    return send_from_directory(WEB_ROOT / "css", filename)


@app.route("/js/<path:filename>")
def web_js(filename):
    return send_from_directory(WEB_ROOT / "js", filename)


init_db()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")))
