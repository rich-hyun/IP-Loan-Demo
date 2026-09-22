"""
LLM 기반 기술평가 자동대출 시스템 — 백엔드 API

프론트엔드(정적 HTML/CSS/JS)가 더 이상 브라우저 localStorage에만 데이터를 저장하지 않고,
이 API를 통해 서버의 SQLite 파일에 저장하도록 합니다. 방문자가 누구든 같은 데이터를 보게 됩니다.

실행 방법(로컬 테스트):
    pip install -r requirements.txt
    python3 app.py
    # http://127.0.0.1:5000/api/applications 로 확인

운영 배포는 이 폴더의 README.md를 참고하세요 (systemd + gunicorn + nginx + HTTPS).
"""

import os
import random
import sqlite3
import string
from datetime import date

from flask import Flask, g, jsonify, request
from flask_cors import CORS

DB_PATH = os.environ.get("IPLOAN_DB_PATH", os.path.join(os.path.dirname(__file__), "iploan.db"))

app = Flask(__name__)
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
    rejectReason TEXT
);
"""

FIELDS = ["id", "company", "bizNo", "ipType", "ipTitle", "amount", "status", "hash",
          "appliedDate", "appraisedValue", "ltv", "creditScore", "rate", "rejectReason"]
ALLOWED_PATCH_FIELDS = {"status", "appraisedValue", "ltv", "creditScore", "rate", "rejectReason"}


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def seed(conn):
    conn.execute("DELETE FROM applications")
    placeholders = ", ".join(f":{f}" for f in FIELDS)
    conn.executemany(
        f"INSERT INTO applications ({', '.join(FIELDS)}) VALUES ({placeholders})",
        DEFAULT_APPLICATIONS,
    )


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(SCHEMA)
    count = conn.execute("SELECT COUNT(*) FROM applications").fetchone()[0]
    if count == 0:
        seed(conn)
    conn.commit()
    conn.close()


def filter_none(row):
    """sqlite3.Row나 dict를 받아 None 값을 제거한 JSON-safe dict로 변환."""
    return {k: v for k, v in dict(row).items() if v is not None}


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
    return jsonify([filter_none(r) for r in rows])


@app.route("/api/applications", methods=["POST"])
def create_application():
    data = request.get_json(force=True, silent=True) or {}
    db = get_db()
    new_id = generate_id(db)

    try:
        amount = int(data.get("amount") or 0) or 50000000
    except (TypeError, ValueError):
        amount = 50000000

    record = {
        "id": new_id,
        "company": (data.get("company") or "미입력 기업")[:200],
        "bizNo": (data.get("bizNo") or "")[:50],
        "ipType": (data.get("ipType") or "특허권")[:50],
        "ipTitle": (data.get("ipTitle") or "미입력 IP 자산")[:200],
        "amount": amount,
        "status": "pending",
        "hash": (data.get("hash") or "")[:100],
        "appliedDate": date.today().isoformat(),
        "appraisedValue": None,
        "ltv": None,
        "creditScore": None,
        "rate": None,
        "rejectReason": None,
    }
    placeholders = ", ".join(f":{f}" for f in FIELDS)
    db.execute(f"INSERT INTO applications ({', '.join(FIELDS)}) VALUES ({placeholders})", record)
    db.commit()
    return jsonify(filter_none(record)), 201


@app.route("/api/applications/<app_id>", methods=["PATCH"])
def patch_application(app_id):
    data = request.get_json(force=True, silent=True) or {}
    db = get_db()
    existing = db.execute("SELECT * FROM applications WHERE id = ?", (app_id,)).fetchone()
    if existing is None:
        return jsonify({"error": "not found"}), 404

    updates = {k: v for k, v in data.items() if k in ALLOWED_PATCH_FIELDS}
    if updates:
        updates["id"] = app_id
        set_clause = ", ".join(f"{k} = :{k}" for k in updates if k != "id")
        db.execute(f"UPDATE applications SET {set_clause} WHERE id = :id", updates)
        db.commit()

    updated = db.execute("SELECT * FROM applications WHERE id = ?", (app_id,)).fetchone()
    return jsonify(filter_none(updated))


@app.route("/api/reset", methods=["POST"])
def reset_applications():
    db = get_db()
    seed(db)
    db.commit()
    rows = db.execute("SELECT * FROM applications ORDER BY appliedDate DESC, id DESC").fetchall()
    return jsonify([filter_none(r) for r in rows])


init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))