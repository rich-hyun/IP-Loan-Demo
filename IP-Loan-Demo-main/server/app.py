"""IP 담보 자동대출 PoC: Flask + SQLite + LLM(선택) + 모의 심사/RWA.

실제 은행 승인, 특허등록 사실 확인, 법적 담보권 설정을 수행하지 않습니다.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import uuid
from datetime import date
from functools import wraps
from pathlib import Path

from flask import Flask, g, jsonify, request, send_from_directory
from flask_cors import CORS
from werkzeug.exceptions import HTTPException

from core import canonical_hash, demo_credit_score, generate_report, now, rule_review, sha256_bytes
from demo_seed import DEFAULT_APPLICATIONS

ROOT = Path(__file__).resolve().parent
FRONT = ROOT.parent
DB_PATH = Path(os.getenv('IPLOAN_DB_PATH', str(ROOT / 'iploan.db'))).resolve()
UPLOAD_DIR = Path(os.getenv('IPLOAN_UPLOAD_DIR', str(ROOT / 'uploads'))).resolve()
DEMO_MODE = os.getenv('IPLOAN_DEMO_MODE', 'true').lower() in ('1', 'true', 'yes')
CHAIN_MODE = os.getenv('IPLOAN_CHAIN_MODE', 'demo').lower()
API_KEY = os.getenv('IPLOAN_API_KEY', '').strip()
ADMIN_KEY = os.getenv('IPLOAN_ADMIN_KEY', '').strip()
ORIGINS = [x.strip() for x in os.getenv('IPLOAN_ALLOWED_ORIGINS', 'http://localhost:8008,http://127.0.0.1:8008,http://localhost:5000,http://127.0.0.1:5000,https://iploan.mustree.kr').split(',') if x.strip()]
if not DEMO_MODE and not API_KEY:
    raise RuntimeError('운영 모드에서는 IPLOAN_API_KEY와 실제 사용자 인증 프록시가 필요합니다. 현재 프로젝트는 데모용입니다.')
if CHAIN_MODE not in ('demo', 'rpc'):
    raise RuntimeError('IPLOAN_CHAIN_MODE=demo 또는 rpc 사용')

app = Flask(__name__, static_folder=None)
app.config.update(MAX_CONTENT_LENGTH=20 * 1024 * 1024, JSON_AS_ASCII=False)
CORS(app, resources={r'/api/*': {'origins': ORIGINS}}, allow_headers=['Content-Type', 'X-API-Key'])

BASE_SCHEMA = '''
CREATE TABLE IF NOT EXISTS applications (
 id TEXT PRIMARY KEY, company TEXT NOT NULL, bizNo TEXT, ipType TEXT, ipTitle TEXT,
 amount INTEGER, status TEXT, hash TEXT, appliedDate TEXT, appraisedValue INTEGER,
 ltv INTEGER, creditScore INTEGER, rate REAL, rejectReason TEXT
);
CREATE TABLE IF NOT EXISTS reports (
 id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, version INTEGER NOT NULL,
 payload TEXT NOT NULL, sha256 TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, UNIQUE(app_id,version), FOREIGN KEY(app_id) REFERENCES applications(id)
);
CREATE TABLE IF NOT EXISTS documents (
 id TEXT PRIMARY KEY, app_id TEXT NOT NULL, filename TEXT NOT NULL, stored_name TEXT NOT NULL,
 bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, reference_sha256 TEXT, reference_match INTEGER,
 created_at TEXT NOT NULL, FOREIGN KEY(app_id) REFERENCES applications(id)
);
CREATE TABLE IF NOT EXISTS chain_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, event_type TEXT NOT NULL,
 data_hash TEXT NOT NULL, mode TEXT NOT NULL, tx_hash TEXT, block_number INTEGER,
 created_at TEXT NOT NULL, FOREIGN KEY(app_id) REFERENCES applications(id)
);
CREATE TABLE IF NOT EXISTS rwa_tokens (
 app_id TEXT PRIMARY KEY, token_id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL,
 metadata_hash TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(app_id) REFERENCES applications(id)
);
CREATE TABLE IF NOT EXISTS loans (
 app_id TEXT PRIMARY KEY, principal INTEGER NOT NULL, remaining INTEGER NOT NULL,
 rate REAL NOT NULL, state TEXT NOT NULL, contract_ref TEXT NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(app_id) REFERENCES applications(id)
);
CREATE TABLE IF NOT EXISTS audits (
 id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT, action TEXT NOT NULL,
 payload TEXT NOT NULL, created_at TEXT NOT NULL
);
'''
EXTRA_COLUMNS = {
    'ipRegNo': 'TEXT', 'termMonths': 'INTEGER', 'ceo': 'TEXT', 'contact': 'TEXT',
    'hashMatch': 'INTEGER', 'reviewResult': 'TEXT', 'workflowMode': 'TEXT DEFAULT \'demo\'',
}
ALLOWED_EXTENSIONS = {'.pdf', '.png', '.jpg', '.jpeg'}


def db():
    if 'db' not in g:
        g.db = sqlite3.connect(str(DB_PATH), timeout=30)
        g.db.row_factory = sqlite3.Row
        g.db.execute('PRAGMA foreign_keys=ON')
        g.db.execute('PRAGMA busy_timeout=30000')
    return g.db


@app.teardown_appcontext
def close_db(_exception=None):
    connection = g.pop('db', None)
    if connection:
        connection.close()


def seed(connection):
    keys = ['id', 'company', 'bizNo', 'ipType', 'ipTitle', 'amount', 'status', 'hash',
            'appliedDate', 'appraisedValue', 'ltv', 'creditScore', 'rate', 'rejectReason']
    for row in DEFAULT_APPLICATIONS:
        params = {k: row.get(k) for k in keys}
        connection.execute(f"INSERT INTO applications ({','.join(keys)}) VALUES ({','.join(':'+k for k in keys)})", params)
        audit(connection, row['id'], 'DEMO_SEED', {'note': '사전 입력된 시연용 가공 데이터'})


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(str(DB_PATH), timeout=30) as connection:
        connection.execute('PRAGMA foreign_keys=ON')
        connection.executescript(BASE_SCHEMA)
        present = {x[1] for x in connection.execute('PRAGMA table_info(applications)').fetchall()}
        for name, datatype in EXTRA_COLUMNS.items():
            if name not in present:
                connection.execute(f'ALTER TABLE applications ADD COLUMN {name} {datatype}')
        if connection.execute('SELECT COUNT(*) FROM applications').fetchone()[0] == 0 and DEMO_MODE:
            seed(connection)


def audit(connection, app_id, action, payload):
    connection.execute('INSERT INTO audits(app_id,action,payload,created_at) VALUES (?,?,?,?)',
                       (app_id, action, json.dumps(payload, ensure_ascii=False, default=str), now()))


def json_body():
    if not request.is_json:
        raise ApiError('Content-Type: application/json 이어야 합니다.', 415)
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError('JSON 객체를 전달하세요.', 400)
    return data


class ApiError(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status
        super().__init__(message)


@app.errorhandler(ApiError)
def api_error(exc):
    return jsonify({'error': exc.message}), exc.status


@app.errorhandler(HTTPException)
def http_error(exc):
    if request.path.startswith('/api/'):
        return jsonify({'error': exc.description}), exc.code
    return exc


@app.errorhandler(Exception)
def unexpected_error(exc):
    app.logger.exception('API 오류: %s', exc)
    if request.path.startswith('/api/'):
        return jsonify({'error': '서버 처리 오류가 발생했습니다. 서버 로그를 확인하세요.'}), 500
    return '서버 오류', 500


def protect(action='write'):
    def decorator(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            required = ADMIN_KEY if action == 'admin' else API_KEY
            if action == 'admin' and not ADMIN_KEY:
                raise ApiError('관리자 작업이 비활성화되어 있습니다. IPLOAN_ADMIN_KEY를 설정하세요.', 403)
            if required and request.headers.get('X-API-Key', '') != required:
                raise ApiError('인증 키가 필요합니다. 데모용 API 키를 입력하세요.', 401)
            return fn(*args, **kwargs)
        return wrapped
    return decorator


def must_app(app_id):
    row = db().execute('SELECT * FROM applications WHERE id=?', (app_id,)).fetchone()
    if row is None:
        raise ApiError('신청 건을 찾을 수 없습니다.', 404)
    return dict(row)


def latest_report(app_id):
    row = db().execute('SELECT * FROM reports WHERE app_id=? ORDER BY version DESC LIMIT 1', (app_id,)).fetchone()
    if not row:
        return None
    r = dict(row)
    r['payload'] = json.loads(r['payload'])
    return r


def enrich(row):
    a = dict(row)
    docs = db().execute('SELECT id,filename,bytes,sha256,reference_match,created_at FROM documents WHERE app_id=? ORDER BY created_at', (a['id'],)).fetchall()
    a['documents'] = [d['filename'] for d in docs]
    a['documentDetails'] = [dict(d) for d in docs]
    latest = latest_report(a['id'])
    if latest:
        a['_report'] = latest['payload']
        a['reportHash'] = latest['sha256']
        a['reportConfirmed'] = bool(latest['confirmed'])
        a['reportVersion'] = latest['version']
    reviews = a.get('reviewResult')
    if reviews:
        try:
            a['reviewResult'] = json.loads(reviews)
        except ValueError:
            a['reviewResult'] = None
    token = db().execute('SELECT * FROM rwa_tokens WHERE app_id=?', (a['id'],)).fetchone()
    if token:
        a['token'] = dict(token)
    loan = db().execute('SELECT * FROM loans WHERE app_id=?', (a['id'],)).fetchone()
    if loan:
        a['loan'] = dict(loan)
    events = db().execute('SELECT event_type,data_hash,mode,tx_hash,block_number,created_at FROM chain_events WHERE app_id=? ORDER BY id DESC', (a['id'],)).fetchall()
    a['chainEvents'] = [dict(e) for e in events]
    audits = db().execute('SELECT action,created_at FROM audits WHERE app_id=? ORDER BY id', (a['id'],)).fetchall()
    a['history'] = [{'action': it['action'], 'at': it['created_at']} for it in audits]
    a['demo'] = DEMO_MODE
    return a


def current(app_id):
    return enrich(must_app(app_id))


def update_fields(app_id, **changes):
    if not changes:
        return
    assignments = ','.join(f'{key}=?' for key in changes)
    db().execute(f'UPDATE applications SET {assignments} WHERE id=?', (*changes.values(), app_id))


def register_event(app_id, event_type, value):
    digest = value if re.fullmatch(r'[a-f0-9]{64}', value) else canonical_hash({'payload': value})
    mode, tx, block = 'simulated', None, None
    if CHAIN_MODE == 'rpc':
        # 실제 체인 기록은 가스가 있는 전용 실증 계정 + RPC 설정 필요
        try:
            from web3 import Web3
            rpc = os.environ['IPLOAN_RPC_URL']
            key = os.environ['IPLOAN_CHAIN_PRIVATE_KEY']
            w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={'timeout': 15}))
            if not w3.is_connected():
                raise RuntimeError('RPC 연결 실패')
            account = w3.eth.account.from_key(key)
            transaction = {
                'chainId': int(os.getenv('IPLOAN_CHAIN_ID', str(w3.eth.chain_id))),
                'from': account.address, 'to': account.address, 'nonce': w3.eth.get_transaction_count(account.address, 'pending'),
                'data': '0x' + digest, 'gas': 80000, 'gasPrice': w3.eth.gas_price,
            }
            signed = w3.eth.account.sign_transaction(transaction, key)
            tx = w3.eth.send_raw_transaction(signed.raw_transaction).hex()
            receipt = w3.eth.wait_for_transaction_receipt(tx, timeout=65)
            if receipt.status != 1:
                raise RuntimeError('체인 트랜잭션이 실패했습니다')
            mode, block = 'rpc_confirmed', receipt.blockNumber
        except Exception as exc:
            raise ApiError(f'온체인 기록 실패: {type(exc).__name__}. 서버 RPC/계정/가스 설정을 확인하세요.', 503) from exc
    db().execute('INSERT INTO chain_events(app_id,event_type,data_hash,mode,tx_hash,block_number,created_at) VALUES (?,?,?,?,?,?,?)',
                 (app_id, event_type, digest, mode, tx, block, now()))
    return {'hash': digest, 'mode': mode, 'txHash': tx, 'blockNumber': block}


@app.route('/api/health')
def health():
    return jsonify({'status': 'ok', 'mode': 'demo' if DEMO_MODE else 'restricted', 'chainMode': CHAIN_MODE})


@app.route('/api/config')
def config():
    return jsonify({'demoMode': DEMO_MODE, 'llmConfigured': bool(os.getenv('OPENAI_API_KEY')),
                    'llmMode': 'OpenAI Responses API' if os.getenv('OPENAI_API_KEY') else '규칙 기반 시연(LLM 호출 없음)',
                    'chainMode': CHAIN_MODE, 'financialDataVerified': False,
                    'roleSwitchIsAuthentication': False,
                    'warning': '시연용 PoC이며 실제 대출승인·특허 가치확정·담보권 설정이 아닙니다.'})


@app.route('/api/applications')
@protect('read')
def list_applications():
    rows = db().execute('SELECT * FROM applications ORDER BY appliedDate DESC, id DESC').fetchall()
    return jsonify([enrich(row) for row in rows])


@app.route('/api/applications/<app_id>')
@protect('read')
def get_application(app_id):
    return jsonify(current(app_id))


@app.route('/api/applications', methods=['POST'])
@protect()
def create_application():
    d = json_body()
    company, iptitle = str(d.get('company', '')).strip(), str(d.get('ipTitle', '')).strip()
    if not company or not iptitle or len(company) > 200 or len(iptitle) > 200:
        raise ApiError('기업명과 IP 명칭을 1~200자로 입력하세요.')
    try:
        amount = int(d.get('amount'))
        term = int(d.get('termMonths') or 12)
    except (ValueError, TypeError):
        raise ApiError('신청금액과 상환기간은 정수여야 합니다.')
    if not (1_000_000 <= amount <= 100_000_000_000) or term not in (6, 12, 24, 36, 48, 60):
        raise ApiError('금액은 100만원~1,000억원, 상환기간은 6·12·24·36·48·60개월만 가능합니다.')
    identifier = 'LN-' + date.today().strftime('%Y') + '-' + uuid.uuid4().hex[:8].upper()
    connection = db()
    connection.execute('''INSERT INTO applications
      (id,company,bizNo,ipType,ipTitle,amount,status,hash,appliedDate,ipRegNo,termMonths,ceo,contact,workflowMode)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
      (identifier, company, str(d.get('bizNo',''))[:30], str(d.get('ipType','특허권'))[:50],
       iptitle, amount, 'pending', None, date.today().isoformat(),
       str(d.get('ipRegNo',''))[:100], term, str(d.get('ceo',''))[:100], str(d.get('contact',''))[:100],
       'demo' if DEMO_MODE else 'restricted'))
    audit(connection, identifier, '대출 신청 접수', {'amount': amount, 'mode': 'demo' if DEMO_MODE else 'restricted'})
    connection.commit()
    return jsonify(current(identifier)), 201


@app.route('/api/applications/<app_id>', methods=['PATCH'])
@protect()
def patch_application(app_id):
    must_app(app_id)
    # 클라이언트가 심사상태·가치평가액·승인금액을 임의 조작하지 못하도록 허용 필드 제한
    permitted = {'ceo', 'contact'}
    data = json_body()
    invalid = set(data) - permitted
    if invalid:
        raise ApiError('상태·평가액·심사결과는 전용 업무 API로만 변경할 수 있습니다.', 403)
    changes = {k: str(v)[:100] for k, v in data.items() if k in permitted}
    update_fields(app_id, **changes)
    audit(db(), app_id, '기본정보 수정', {'fields': list(changes)})
    db().commit()
    return jsonify(current(app_id))


@app.route('/api/applications/<app_id>/documents', methods=['POST'])
@protect()
def upload_document(app_id):
    a = must_app(app_id)
    if a['status'] in ('approved', 'rejected'):
        raise ApiError('종결된 신청 건에 문서를 추가할 수 없습니다.', 409)
    files = request.files.getlist('files')
    if not files:
        raise ApiError('files 필드에 PDF/JPG/PNG 파일을 첨부하세요.')
    if len(files) > 8:
        raise ApiError('한 번에 최대 8개 파일까지 업로드할 수 있습니다.')
    uploaded = []
    for entry in files:
        display_name = Path(entry.filename or '').name[:160]
        ext = Path(display_name).suffix.lower()
        if ext not in ALLOWED_EXTENSIONS:
            raise ApiError('PDF, JPG, PNG 형식만 업로드할 수 있습니다.')
        content = entry.read(10 * 1024 * 1024 + 1)
        if len(content) > 10 * 1024 * 1024 or not content:
            raise ApiError('파일은 각각 10MB 이하여야 하며 비어 있을 수 없습니다.')
        if ext == '.pdf' and not content.startswith(b'%PDF-'):
            raise ApiError('PDF 파일 형식이 올바르지 않습니다.')
        if ext == '.png' and not content.startswith(b'\x89PNG\r\n\x1a\n'):
            raise ApiError('PNG 파일 형식이 올바르지 않습니다.')
        if ext in ('.jpg', '.jpeg') and not content.startswith(b'\xff\xd8\xff'):
            raise ApiError('JPG 파일 형식이 올바르지 않습니다.')
        docid = uuid.uuid4().hex
        path = UPLOAD_DIR / (docid + ext)
        path.write_bytes(content)
        digest = sha256_bytes(content)
        db().execute('''INSERT INTO documents(id,app_id,filename,stored_name,bytes,sha256,created_at)
                      VALUES(?,?,?,?,?,?,?)''', (docid, app_id, display_name, path.name, len(content), digest, now()))
        uploaded.append({'id': docid, 'filename': display_name, 'sha256': digest, 'bytes': len(content)})
        audit(db(), app_id, '문서 업로드/로컬 SHA-256 계산', {'documentId': docid, 'sha256': digest})
    all_hashes = [r['sha256'] for r in db().execute('SELECT sha256 FROM documents WHERE app_id=?', (app_id,)).fetchall()]
    combined = canonical_hash({'documents': sorted(all_hashes)})
    update_fields(app_id, hash='0x' + combined, status='doc_verify', hashMatch=None)
    db().commit()
    return jsonify({'documents': uploaded, 'verification': '로컬 파일 해시 계산 완료. 발급기관 원본 대조/온체인 등록은 아직 수행되지 않음',
                    'application': current(app_id)}), 201


@app.route('/api/applications/<app_id>/documents/<doc_id>/verify', methods=['POST'])
@protect()
def verify_document(app_id, doc_id):
    must_app(app_id)
    row = db().execute('SELECT * FROM documents WHERE app_id=? AND id=?', (app_id, doc_id)).fetchone()
    if not row:
        raise ApiError('문서를 찾을 수 없습니다.', 404)
    payload = json_body()
    declared = (str(payload.get('referenceSha256') or '').lower().strip())
    if declared and not re.fullmatch(r'[a-f0-9]{64}', declared):
        raise ApiError('참조 해시 형식이 올바르지 않습니다. SHA-256 64자리 필요')
    stored = UPLOAD_DIR / row['stored_name']
    real_hash = sha256_bytes(stored.read_bytes()) if stored.exists() else None
    local_ok = real_hash == row['sha256']
    reference_match = (int(real_hash == declared) if declared else None)
    db().execute('UPDATE documents SET reference_sha256=?,reference_match=? WHERE id=?',
                 (declared or None, reference_match, doc_id))
    docs = db().execute('SELECT reference_match FROM documents WHERE app_id=?', (app_id,)).fetchall()
    new_match = 0 if not local_ok or any(x[0] == 0 for x in docs) else (1 if docs and all(x[0] == 1 for x in docs) else None)
    update_fields(app_id, hashMatch=new_match)
    audit(db(), app_id, '문서 무결성 검증', {'localIntegrity': local_ok, 'matchesSuppliedReference': reference_match,
                                       'issuerVerified': False})
    db().commit()
    return jsonify({'localIntegrity': local_ok, 'matchesSuppliedReference': reference_match,
                    'issuerVerified': False, 'note': '사용자가 제공한 참조값 대조일 뿐 발급기관 인증이 아닙니다.', 'application': current(app_id)})


@app.route('/api/applications/<app_id>/evaluation', methods=['POST'])
@protect()
def evaluate(app_id):
    a = must_app(app_id)
    if a['status'] in ('approved', 'rejected'):
        raise ApiError('종결된 신청은 평가할 수 없습니다.', 409)
    payload = json_body()
    reason = str(payload.get('reason', ''))[:500]
    if a['status'] == 'review' and latest_report(app_id) and latest_report(app_id)['confirmed']:
        raise ApiError('평가 확정 이후에는 평가 변경할 수 없습니다.', 409)
    try:
        report = generate_report(a, reason)
    except Exception as exc:
        app.logger.exception('LLM API 실패')
        raise ApiError(f'LLM 생성 실패({type(exc).__name__}). API 키, 모델 접근 권한, 네트워크를 확인하세요. 템플릿으로 대체하지 않았습니다.', 503) from exc
    digest = canonical_hash(report)
    previous = latest_report(app_id)
    version = (previous['version'] + 1) if previous else 1
    db().execute('INSERT INTO reports(app_id,version,payload,sha256,created_at) VALUES(?,?,?,?,?)',
                 (app_id, version, json.dumps(report, ensure_ascii=False), digest, now()))
    update_fields(app_id, status='evaluating', appraisedValue=report['appraisedValue'])
    audit(db(), app_id, '가치평가 보고서 생성', {'mode': report['mode'], 'version': version, 'hash': digest})
    db().commit()
    return jsonify(current(app_id))


@app.route('/api/applications/<app_id>/evaluation/confirm', methods=['POST'])
@protect()
def confirm_evaluation(app_id):
    a = must_app(app_id)
    report = latest_report(app_id)
    if a['status'] != 'evaluating' or not report:
        raise ApiError('평가보고서를 먼저 생성하세요.', 409)
    if report['confirmed']:
        raise ApiError('이미 확정된 보고서입니다.', 409)
    event = register_event(app_id, 'valuation_report_sha256', report['sha256'])
    db().execute('UPDATE reports SET confirmed=1 WHERE id=?', (report['id'],))
    update_fields(app_id, status='review', appraisedValue=report['payload']['appraisedValue'],
                  ltv=round((a['amount'] / report['payload']['appraisedValue']) * 100),
                  creditScore=None, reviewResult=None)
    audit(db(), app_id, '가치평가 확정', {'reportSha256': report['sha256'], 'chainMode': event['mode']})
    db().commit()
    return jsonify({'chain': event, 'application': current(app_id)})


@app.route('/api/applications/<app_id>/review', methods=['POST'])
@protect()
def run_review(app_id):
    a = must_app(app_id)
    report = latest_report(app_id)
    if a['status'] != 'review' or not report or not report['confirmed']:
        raise ApiError('보고서가 확정된 심사중 건만 자동심사할 수 있습니다.', 409)
    payload = json_body()
    credit = payload.get('creditScore')
    try:
        credit = int(credit) if credit is not None and credit != '' else None
    except (TypeError, ValueError):
        raise ApiError('신용점수는 0~100 사이 정수여야 합니다.')
    docs = db().execute('SELECT stored_name,sha256,reference_match FROM documents WHERE app_id=?', (app_id,)).fetchall()
    local_ok = bool(docs) and all((UPLOAD_DIR / x['stored_name']).exists() and sha256_bytes((UPLOAD_DIR / x['stored_name']).read_bytes()) == x['sha256'] for x in docs)
    reference_mismatch = any(x['reference_match'] == 0 for x in docs)
    try:
        result = rule_review(a, report['payload'], local_integrity=local_ok,
                             reference_mismatch=reference_mismatch, credit_score=credit)
    except ValueError as exc:
        raise ApiError(str(exc)) from exc
    result['issuerVerified'] = False
    result['documentCount'] = len(docs)
    result['documentPolicy'] = '시연용: 최소 1개 서류 + 서버 로컬 해시 일치 필요; 기관 검증은 수행하지 않음'
    result['sourceStatus'] = '실제 발급기관·TCB 미연동 (모든 심사는 데모)'
    update_fields(app_id, ltv=result['ltv'], creditScore=result['creditScore'],
                  rate=result['rate'], reviewResult=json.dumps(result, ensure_ascii=False),
                  rejectReason='; '.join(result['reasons']) if result['reasons'] else None)
    audit(db(), app_id, '자동심사 규칙 실행(시연)', {'passed': result['passed'], 'conditions': result['conditions']})
    db().commit()
    return jsonify({'review': result, 'application': current(app_id)})


@app.route('/api/applications/<app_id>/decision', methods=['POST'])
@protect()
def final_decision(app_id):
    a = must_app(app_id)
    if a['status'] != 'review' or not a.get('reviewResult'):
        raise ApiError('먼저 심사 단계에서 자동심사를 실행하세요.', 409)
    result = json.loads(a['reviewResult'])
    operation = str(json_body().get('action', ''))
    if operation not in ('approve', 'reject', 'hold'):
        raise ApiError('action은 approve/reject/hold 중 하나여야 합니다.')
    if operation == 'hold':
        audit(db(), app_id, '대출 심사 보류', {})
        db().commit()
        return jsonify(current(app_id))
    if operation == 'approve' and not result['passed']:
        raise ApiError('심사기준 미충족 건은 승인할 수 없습니다.', 409)
    status = 'approved' if operation == 'approve' else 'rejected'
    loan = None
    if operation == 'approve':
        principal = int(result['approvedAmount'])
        ref = 'DEMO-LOAN-' + uuid.uuid4().hex[:12].upper()
        loan = {'principal': principal, 'rate': result['rate'], 'contractReference': ref, 'onChain': False}
        db().execute('INSERT INTO loans(app_id,principal,remaining,rate,state,contract_ref,created_at) VALUES(?,?,?,?,?,?,?)',
                     (app_id, principal, principal, result['rate'], 'active', ref, now()))
        register_event(app_id, 'loan_contract_demo_digest', canonical_hash(loan))
    update_fields(app_id, status=status)
    audit(db(), app_id, '최종 승인 확정 (모의)' if status == 'approved' else '거절 확정 통지 (모의)',
          {'action': operation, 'simulated': True})
    db().commit()
    return jsonify(current(app_id))


@app.route('/api/applications/<app_id>/rwa', methods=['POST'])
@protect()
def mint_rwa(app_id):
    a = must_app(app_id)
    if not latest_report(app_id) or not latest_report(app_id)['confirmed']:
        raise ApiError('평가보고서 확정 후 RWA 모의 발행이 가능합니다.', 409)
    existing = db().execute('SELECT 1 FROM rwa_tokens WHERE app_id=?', (app_id,)).fetchone()
    if existing:
        raise ApiError('이미 발행된 모의 RWA 토큰입니다.', 409)
    token_id = 'DEMO-RWA-' + uuid.uuid4().hex[:12].upper()
    metadata_hash = canonical_hash({'app': app_id, 'reportHash': latest_report(app_id)['sha256'],
                                    'ipRegNo': a.get('ipRegNo'), 'tokenId': token_id})
    db().execute('INSERT INTO rwa_tokens(app_id,token_id,owner,metadata_hash,state,created_at) VALUES(?,?,?,?,?,?)',
                 (app_id, token_id, 'borrower_demo_wallet', metadata_hash, 'minted', now()))
    register_event(app_id, 'rwa_metadata_digest', metadata_hash)
    audit(db(), app_id, 'RWA 모의 토큰 발행', {'tokenId': token_id, 'notAnNFT': True})
    db().commit()
    return jsonify(current(app_id)), 201


@app.route('/api/applications/<app_id>/rwa/transfer', methods=['POST'])
@protect()
def transfer_rwa(app_id):
    must_app(app_id)
    token = db().execute('SELECT * FROM rwa_tokens WHERE app_id=?', (app_id,)).fetchone()
    if not token or token['state'] != 'minted':
        raise ApiError('차주가 보유한 모의 토큰을 먼저 발행해야 합니다.', 409)
    db().execute('UPDATE rwa_tokens SET owner=?,state=? WHERE app_id=?',
                 ('bank_demo_wallet', 'pledged', app_id))
    register_event(app_id, 'rwa_transfer_demo', token['metadata_hash'])
    audit(db(), app_id, 'RWA 은행 시연월렛 이전/담보잠금', {'simulated': True})
    db().commit()
    return jsonify(current(app_id))


@app.route('/api/applications/<app_id>/repay', methods=['POST'])
@protect()
def repay(app_id):
    must_app(app_id)
    loan = db().execute('SELECT * FROM loans WHERE app_id=?', (app_id,)).fetchone()
    if not loan or loan['state'] != 'active':
        raise ApiError('상환 가능한 모의 대출이 없습니다.', 409)
    try:
        amount = int(json_body().get('amount'))
    except (ValueError, TypeError):
        raise ApiError('상환금액은 정수여야 합니다.')
    if not (0 < amount <= loan['remaining']):
        raise ApiError('상환금액은 잔액 범위 이내여야 합니다.')
    remain = loan['remaining'] - amount
    db().execute('UPDATE loans SET remaining=?,state=? WHERE app_id=?',
                 (remain, 'repaid' if remain == 0 else 'active', app_id))
    if remain == 0:
        db().execute("UPDATE rwa_tokens SET owner='borrower_demo_wallet',state='released' WHERE app_id=? AND state='pledged'", (app_id,))
    audit(db(), app_id, '모의 대출 상환/담보해제' if remain == 0 else '모의 대출 부분상환',
          {'amount': amount, 'remaining': remain, 'realPayment': False})
    db().commit()
    return jsonify(current(app_id))


@app.route('/api/applications/<app_id>/report')
@protect('read')
def get_report(app_id):
    must_app(app_id)
    r = latest_report(app_id)
    if not r:
        raise ApiError('생성된 보고서가 없습니다.', 404)
    return jsonify({'report': r['payload'], 'sha256': r['sha256'], 'version': r['version'],
                    'confirmed': bool(r['confirmed']), 'application': current(app_id)})


@app.route('/api/ledger')
@protect('read')
def get_ledger():
    events = db().execute('SELECT * FROM chain_events ORDER BY id DESC LIMIT 100').fetchall()
    return jsonify({'chainMode': CHAIN_MODE, 'events': [dict(item) for item in events],
                    'warning': 'simulated 이벤트는 실제 체인에 기록되지 않습니다.'})


@app.route('/api/reset', methods=['POST'])
@protect('admin')
def reset_applications():
    if not DEMO_MODE:
        raise ApiError('운영 환경에서는 초기화가 비활성화됩니다.', 403)
    db().execute('DELETE FROM loans')
    db().execute('DELETE FROM rwa_tokens')
    db().execute('DELETE FROM chain_events')
    db().execute('DELETE FROM documents')
    db().execute('DELETE FROM reports')
    db().execute('DELETE FROM audits')
    db().execute('DELETE FROM applications')
    seed(db())
    db().commit()
    # 초기화는 업로드 파일도 제거 (운영환경에서는 사용 금지)
    for file in UPLOAD_DIR.iterdir():
        if file.is_file():
            file.unlink()
    return jsonify([enrich(r) for r in db().execute('SELECT * FROM applications').fetchall()])


@app.route('/')
def home():
    return send_from_directory(str(FRONT), 'index.html')


@app.route('/<path:filename>')
def public_assets(filename):
    if not (filename.startswith('css/') or filename.startswith('js/') or filename.startswith('sample_data/') or filename in ('CNAME', 'favicon.ico')):
        raise ApiError('찾을 수 없습니다', 404)
    return send_from_directory(str(FRONT), filename)


init_db()

if __name__ == '__main__':
    app.run(host=os.getenv('HOST', '127.0.0.1'), port=int(os.getenv('PORT', '5000')), debug=False)
