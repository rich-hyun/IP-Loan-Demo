"""Loan-owned evaluation orchestration. No keys, transactions or synthetic valuations.

All durable state lives beside applications. Provider calls reuse patent_api.py;
chain confirmation remains the evaluator's wallet transaction.
"""
import base64
import hashlib
import json
import re
import secrets
import tempfile
import time
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from eth_account import Account
from eth_account.messages import encode_defunct
from flask import Response, jsonify, request

if __package__:
    from .patent_api import patent_api, PatentAPIError
    from .patent_value import html_valuation
else:
    from patent_api import patent_api, PatentAPIError
    from patent_value import html_valuation


SCHEMA = """
CREATE TABLE IF NOT EXISTS loan_evaluations (
 appId TEXT PRIMARY KEY REFERENCES applications(id), requestId TEXT NOT NULL,
 fingerprint TEXT NOT NULL, borrower TEXT NOT NULL, document BLOB NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending', jobId TEXT, attempt INTEGER NOT NULL DEFAULT 0,
 stage TEXT, error TEXT, updatedAt REAL NOT NULL, checkedAt REAL NOT NULL DEFAULT 0,
 retryAt REAL NOT NULL DEFAULT 0, artifacts TEXT NOT NULL DEFAULT '[]',
 autoValue INTEGER, valueMessage TEXT, reviewValue INTEGER, reviewNote TEXT,
 reviewer TEXT, reviewedAt REAL, confirmedAt REAL, preparedHash TEXT,
 UNIQUE(borrower, requestId)
);
CREATE TABLE IF NOT EXISTS loan_artifacts (
 appId TEXT NOT NULL, kind TEXT NOT NULL, body BLOB NOT NULL, digest TEXT NOT NULL,
 PRIMARY KEY(appId,kind), FOREIGN KEY(appId) REFERENCES loan_evaluations(appId)
);
CREATE TABLE IF NOT EXISTS credit_cases (
 applicationId TEXT PRIMARY KEY REFERENCES applications(id),
 reportHash TEXT NOT NULL, bankWallet TEXT NOT NULL, value INTEGER NOT NULL,
 amount INTEGER NOT NULL, ltv REAL NOT NULL, policy TEXT NOT NULL, createdAt REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_nonces (
 nonce TEXT PRIMARY KEY, wallet TEXT NOT NULL, action TEXT NOT NULL,
 appId TEXT NOT NULL, digest TEXT NOT NULL, message TEXT NOT NULL, expires REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_read_sessions (
 token TEXT PRIMARY KEY, appId TEXT NOT NULL, wallet TEXT NOT NULL, expires REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS loan_evaluation_attempts (
 appId TEXT NOT NULL REFERENCES loan_evaluations(appId), attempt INTEGER NOT NULL,
 jobId TEXT, state TEXT NOT NULL, error TEXT, updatedAt REAL NOT NULL,
 PRIMARY KEY(appId,attempt)
);
"""


def migrate(conn):
    for statement in SCHEMA.split(';'):
        if statement.strip():
            conn.execute(statement)
    existing = {row[1] for row in conn.execute('PRAGMA table_info(loan_evaluations)')}
    for column in ('valueSource', 'valueReportHash', 'valueRaw'):
        if column not in existing:
            conn.execute(f'ALTER TABLE loan_evaluations ADD COLUMN {column} TEXT')


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


class WorkflowError(Exception):
    def __init__(self, message, status=409):
        super().__init__(message)
        self.status = status


def job(db, app_id):
    row = db.execute('SELECT * FROM loan_evaluations WHERE appId=?', (app_id,)).fetchone()
    return dict(row) if row else None


def summary(db, app_id):
    row = job(db, app_id)
    if not row:
        return None
    return {key: row[key] for key in (
        'state', 'jobId', 'attempt', 'stage', 'error', 'updatedAt', 'retryAt',
        'autoValue', 'valueMessage', 'reviewValue', 'reviewNote', 'reviewer',
        'reviewedAt', 'confirmedAt', 'preparedHash', 'valueSource', 'valueReportHash', 'valueRaw')}


def read_document(application, row):
    encrypted = row['document']
    plain = AESGCM(base64.b64decode(application['docKey'])).decrypt(encrypted[:12], encrypted[12:], None)
    expected = '0x' + hashlib.sha256(base64.b64decode(application['docSalt']) + plain).hexdigest()
    if expected != application['docFileHash']:
        raise WorkflowError('보관 문서의 해시가 일치하지 않습니다.')
    return plain


def authorize(native, action, app_id, payload, proof=None):
    proof = proof if isinstance(proof, dict) else {}
    db = native.get_db()
    if action == 'status' and isinstance(proof.get('session'), str):
        session = db.execute('SELECT * FROM workflow_read_sessions WHERE token=? AND appId=? AND expires>?',
                             (hashlib.sha256(proof['session'].encode()).hexdigest(), app_id, time.time())).fetchone()
        if not session:
            raise WorkflowError('상태 조회 인증이 만료되었습니다. 지갑으로 다시 확인하세요.', 403)
        wallet = session['wallet']
    else:
        nonce = proof.get('nonce')
        if not isinstance(nonce, str):
            raise WorkflowError('지갑 서명이 필요합니다.', 403)
        row = db.execute('SELECT * FROM workflow_nonces WHERE nonce=?', (nonce,)).fetchone()
        deleted = db.execute('DELETE FROM workflow_nonces WHERE nonce=?', (nonce,)).rowcount
        db.commit()  # one-use across processes, even on invalid proof
        if not row or not deleted or row['expires'] < time.time() or row['action'] != action or row['appId'] != app_id or row['digest'] != digest(payload):
            raise WorkflowError('만료·재사용·내용이 변경된 서명입니다.', 403)
        try:
            recovered = Account.recover_message(encode_defunct(text=row['message']), signature=proof.get('signature', ''))
            if recovered.lower() != row['wallet'].lower():
                raise ValueError()
        except (ValueError, TypeError):
            raise WorkflowError('지갑 서명이 일치하지 않습니다.', 403) from None
        wallet = row['wallet']
    if action == 'create':
        if wallet.lower() != payload.get('borrowerWallet', '').lower():
            raise WorkflowError('차주 지갑이 일치하지 않습니다.', 403)
        native.chain.require_role(wallet, 'BORROWER_ROLE')
        return wallet
    application = native.find_application(app_id)
    if not application or not job(db, app_id):
        raise WorkflowError('통합 신청을 찾을 수 없습니다.', 404)
    participants = {
        'borrowerWallet': 'BORROWER_ROLE', 'evaluatorWallet': 'EVALUATOR_ROLE', 'bankWallet': 'BANK_ROLE'
    }
    allowed = ['evaluatorWallet'] if action == 'review' else (
        ['borrowerWallet', 'evaluatorWallet'] if action in {'retry', 'identity', 'recover'} else list(participants))
    for field in allowed:
        if (application.get(field) or '').lower() == wallet.lower():
            native.chain.require_role(wallet, participants[field])
            # Preserve the existing SBT/NFT document access rule. Report access also
            # checks the real chain, so a forged/local status cannot confer access.
            if field != 'borrowerWallet':
                stage = native.chain.snapshot(application)['chainStatus']
                stages = {'evaluatorWallet': {'Evaluating', 'Eligible', 'RuleRejected', 'Approved', 'Rejected', 'Repaid'},
                          'bankWallet': {'Eligible', 'Approved', 'Rejected', 'Repaid'}}
                if action in {'document', 'review'}:
                    stages['evaluatorWallet'] = {'Evaluating'}
                if action == 'document':
                    stages['bankWallet'] = {'Approved', 'Repaid'}
                if stage not in stages[field]:
                    raise WorkflowError('현재 단계에서 이 담당자의 열람·검토 권한이 없습니다.', 403)
            return wallet
    raise WorkflowError('이 신청에 배정된 담당자 또는 차주만 접근할 수 있습니다.', 403)


def begin_create(native, plaintext):
    """Validate signed manifest and serialize creation before IPFS side effects."""
    data = dict(request.form)
    try:
        proof = json.loads(data.pop('auth', '{}'))
    except ValueError:
        raise WorkflowError('서명 형식이 올바르지 않습니다.', 403) from None
    data['fileSha256'] = hashlib.sha256(plaintext).hexdigest()
    wallet = authorize(native, 'create', '', data, proof)
    request_id = data.get('request_id', '')
    if not re.fullmatch(r'[A-Za-z0-9_-]{16,100}', request_id):
        raise WorkflowError('중복 방지 요청번호가 필요합니다.', 400)
    if not re.fullmatch(r'\d{10}', re.sub(r'\D', '', data.get('bizNo', ''))):
        raise WorkflowError('사업자번호 10자리를 입력해 주세요.', 400)
    if not native.chain.MANAGER_ADDRESS:
        raise WorkflowError('통합 신청에는 v2 계약과 역할 설정이 필요합니다.', 503)
    db = native.get_db()
    db.execute('BEGIN IMMEDIATE')
    prior = db.execute('SELECT * FROM loan_evaluations WHERE borrower=? AND requestId=?', (wallet.lower(), request_id)).fetchone()
    if prior:
        db.rollback()
        if prior['fingerprint'] != digest(data):
            raise WorkflowError('같은 요청번호로 신청 내용이나 파일을 변경할 수 없습니다.')
        return native.find_application(prior['appId']), None
    return None, (request_id, digest(data), wallet.lower())


def attach(db, record, encrypted, identity):
    db.execute('INSERT INTO loan_evaluations (appId,requestId,fingerprint,borrower,document,updatedAt) VALUES (?,?,?,?,?,?)',
               (record['id'], *identity, encrypted, time.time()))


def update(db, app_id, **values):
    values['updatedAt'] = time.time()
    db.execute('UPDATE loan_evaluations SET ' + ','.join(k + '=?' for k in values) + ' WHERE appId=?', (*values.values(), app_id))
    audit = {k: v for k, v in values.items() if k in {'jobId', 'state', 'error', 'updatedAt'}}
    db.execute('UPDATE loan_evaluation_attempts SET ' + ','.join(k + '=?' for k in audit) +
               ' WHERE appId=? AND attempt=(SELECT attempt FROM loan_evaluations WHERE appId=?)', (*audit.values(), app_id, app_id))
    db.commit()


def safe_error(exc):
    return str(exc).replace(patent_api.token, '[redacted]') if patent_api.token else str(exc)


def store_result(db, app_id, result):
    """Optional numeric adapter contract: valuation={amount: integer, currency: KRW, unit: won}.

    Existing provider contract promises reports, not structured monetary value.
    Never infer a value from text, score, example amount, or loan request.
    """
    if not isinstance(result, dict) or result.get('status') not in patent_api.statuses or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', str(result.get('job_id', ''))):
        raise PatentAPIError('평가 응답의 작업번호와 상태를 확인할 수 없습니다.', uncertain=True)
    valuation = result.get('valuation')
    value = None
    if isinstance(valuation, dict) and valuation.get('currency') == 'KRW' and valuation.get('unit') == 'won':
        candidate = valuation.get('amount')
        if type(candidate) is int and abs(candidate) <= 9_000_000_000_000_000:
            value = candidate
    artifacts = result.get('artifacts') or {}
    kinds = sorted(k for k in artifacts if k in patent_api.kinds) if isinstance(artifacts, dict) else []
    prior = job(db, app_id)
    application = dict(db.execute('SELECT * FROM applications WHERE id=?', (app_id,)).fetchone())
    if result.get('source_sha256') is not None:
        expected = hashlib.sha256(read_document(application, prior)).hexdigest()
        if result['source_sha256'] != expected:
            raise PatentAPIError('공급자 응답의 원본 SHA256이 대출 신청 파일과 다릅니다.', uncertain=True)
    if result.get('business_number'):
        if re.sub(r'\D', '', str(result['business_number'])) != re.sub(r'\D', '', application['bizNo']):
            raise PatentAPIError('공급자 응답의 사업자번호가 대출 신청과 다릅니다.', uncertain=True)
    if prior['state'] != 'submitting' and prior['jobId'] and prior['jobId'] != result['job_id']:
        raise PatentAPIError('공급자가 다른 작업번호를 반환했습니다.')
    update(db, app_id, state=result['status'], jobId=result['job_id'], stage=safe_error(result.get('stage') or '')[:1000],
           artifacts=json.dumps(kinds), autoValue=value,
           valueSource='provider-valuation-json' if value is not None else None, valueReportHash=None, valueRaw=None,
           valueMessage=(None if value is not None else
                         '공급자가 구조화된 원화 평가액을 제공하지 않았습니다. 보고서를 검토하고 적용 가치와 사유를 입력하세요.'
                         if result['status'] == 'completed' else '보고서 생성이 완료되면 자동 산출 값을 확인합니다.'),
           error=safe_error(result.get('error') or ''), checkedAt=time.time())


def submit(native, app_id):
    db = native.get_db()
    row = job(db, app_id)
    # Only an atomic claimant submits. A crash after this point is ambiguous and
    # must never automatically create a second provider job.
    claimed = db.execute("""UPDATE loan_evaluations SET state='submitting',attempt=attempt+1,jobId=NULL,
        autoValue=NULL,valueSource=NULL,valueRaw=NULL,valueReportHash=NULL,artifacts='[]',updatedAt=?,error=NULL
        WHERE appId=? AND state IN ('pending','submission_rejected','failed')""", (time.time(), app_id)).rowcount
    if claimed:
        db.execute("""INSERT INTO loan_evaluation_attempts(appId,attempt,state,updatedAt)
            SELECT appId,attempt,'submitting',updatedAt FROM loan_evaluations WHERE appId=?""", (app_id,))
    db.commit()
    if not claimed:
        raise WorkflowError('이미 접수 중이거나 접수 여부를 확인해야 합니다.')
    try:
        application = native.find_application(app_id)
        plaintext = read_document(application, row)
        # Windows needs a closed handle before the provider client opens the file.
        with tempfile.TemporaryDirectory(prefix='iploan-evaluation-') as folder:
            path = Path(folder) / 'patent.pdf'
            path.write_bytes(plaintext)
            result = patent_api.submit(path, application['docFileName'], re.sub(r'\D', '', application['bizNo']))
        store_result(db, app_id, result)
    except PatentAPIError as exc:
        update(db, app_id, state='submission_unknown' if exc.uncertain else 'submission_rejected', error=safe_error(exc), retryAt=time.time() + (exc.retry_after or 0))
    except Exception:
        # Includes local persistence failure after remote acceptance: retain the
        # last known job id when possible, otherwise block duplicate submission.
        db.rollback()
        update(db, app_id, state='submission_unknown', error='접수 결과 저장을 확인하지 못했습니다. 공급자 작업번호 확인이 필요합니다.')


def refresh(native, app_id):
    db = native.get_db()
    row = job(db, app_id)
    if row['state'] == 'submitting' and time.time() - row['updatedAt'] > 120:
        update(db, app_id, state='submission_unknown', error='접수 응답을 확인하지 못했습니다. 중복 방지를 위해 공급자 확인이 필요합니다.')
    elif row['jobId'] and row['state'] in {'queued', 'running', 'awaiting_identity'} and time.time() - row['checkedAt'] >= 10:
        claimed = db.execute('UPDATE loan_evaluations SET checkedAt=? WHERE appId=? AND checkedAt=?', (time.time(), app_id, row['checkedAt'])).rowcount
        db.commit()
        if claimed:
            try:
                store_result(db, app_id, patent_api.status(row['jobId']))
            except PatentAPIError as exc:
                update(db, app_id, error=safe_error(exc))
    current = job(db, app_id)
    if current['state'] == 'completed' and current['autoValue'] is None and not current['valueSource'] and 'html' in json.loads(current['artifacts']):
        try:
            body, report_digest = artifact(db, app_id, 'html')
            value, raw, message = html_valuation(body)
            update(db, app_id, autoValue=value, valueRaw=raw, valueSource='provider-html-ip-value-table-v1', valueReportHash=report_digest, valueMessage=message)
        except (PatentAPIError, WorkflowError) as exc:
            update(db, app_id, valueMessage='보고서 금액을 확인하지 못했습니다. ' + safe_error(exc))
    return job(db, app_id)


def artifact(db, app_id, kind):
    row = job(db, app_id)
    if not row or row['state'] != 'completed' or kind not in json.loads(row['artifacts']):
        raise WorkflowError('완료된 평가보고서가 필요합니다.')
    cached = db.execute('SELECT * FROM loan_artifacts WHERE appId=? AND kind=?', (app_id, kind)).fetchone()
    if cached:
        return cached['body'], cached['digest']
    with patent_api.artifact(row['jobId'], kind) as upstream:
        body = upstream.read(20 * 1024 * 1024 + 1)
    if not body or len(body) > 20 * 1024 * 1024:
        raise WorkflowError('보고서가 비어 있거나 20MiB 상한을 초과했습니다.')
    if kind == 'pdf' and not body.lstrip().startswith(b'%PDF-'):
        raise WorkflowError('공급자의 PDF 보고서 형식이 올바르지 않습니다.')
    db.execute('INSERT OR IGNORE INTO loan_artifacts VALUES (?,?,?,?)', (app_id, kind, body, hashlib.sha256(body).hexdigest()))
    db.commit()
    cached = db.execute('SELECT * FROM loan_artifacts WHERE appId=? AND kind=?', (app_id, kind)).fetchone()
    return cached['body'], cached['digest']


def prepare(native, application, data):
    db = native.get_db()
    app_id = application['id']
    payload = {k: v for k, v in data.items() if k != 'auth'}
    reviewer = authorize(native, 'review', app_id, payload, data.get('auth'))
    row = refresh(native, app_id)
    value, note = data.get('appraisedValue'), data.get('reviewerNote')
    if type(value) is not int or not 0 < value <= 9_000_000_000_000_000:
        raise WorkflowError('적용 평가가치는 양의 정수여야 합니다.', 400)
    if not isinstance(note, str) or not note.strip() or len(note) > 2000:
        raise WorkflowError('보고서 검토 및 가치 적용 사유를 1~2000자로 입력하세요.', 400)
    if row['state'] != 'completed':
        raise WorkflowError('평가가 완료되어야 확정할 수 있습니다.')
    kinds = set(json.loads(row['artifacts'])) & {'pdf', 'html'}
    if not kinds:
        raise WorkflowError('공급자의 평가보고서가 없습니다.')
    kind = 'pdf' if 'pdf' in kinds else 'html'
    _, report_digest = artifact(db, app_id, kind)
    # An immutable reviewed manifest binds the actual provider report, file,
    # automatic and applied values, reviewer and policy to the on-chain digest.
    report = {'applicationId': app_id, 'appKey': application['appKey'], 'fileHash': application['docFileHash'],
              'jobId': row['jobId'], 'attempt': row['attempt'], 'sourceReportHash': report_digest,
              'sourceReportKind': kind, 'autoValue': row['autoValue'], 'appraisedValue': value,
              'autoValueSource': row['valueSource'], 'autoValueReportHash': row['valueReportHash'],
              'reviewer': reviewer, 'reviewerNote': note.strip(), 'policy': 'v2-contract-demo-ltv-70-percent'}
    payload = canonical(report)
    report_hash = '0x' + hashlib.sha256(payload.encode()).hexdigest()
    bank = native.assign_bank(application) if native.chain.eligible(application['amount'], value) else None
    db.execute('BEGIN IMMEDIATE')
    current = job(db, app_id)
    if current['preparedHash'] and current['preparedHash'] != report_hash:
        db.rollback()
        raise WorkflowError('이미 준비한 평가 확정 내용이 있습니다. 같은 내용으로 체인 확정·동기화를 재시도하세요.')
    previous = db.execute('SELECT * FROM evaluation_reports WHERE hash=?', (report_hash,)).fetchone()
    if previous:
        cid = previous['cid']
    else:
        # Actual review notes and automatic values are no longer public demo
        # prose. Use the original document's protected key with a fresh GCM IV;
        # on-chain reportHash commits to the plaintext manifest, as fileHash
        # already commits to the original plaintext rather than ciphertext.
        iv = secrets.token_bytes(12)
        encrypted_manifest = iv + AESGCM(base64.b64decode(application['docKey'])).encrypt(iv, payload.encode(), None)
        uploaded = native.upload_ipfs_payload(encrypted_manifest, 'evaluation-report.enc', 'application/octet-stream')
        db.execute('INSERT OR IGNORE INTO evaluation_reports VALUES (?,?,?,?,?)', (report_hash, app_id, uploaded['cid'], payload, value))
        cid = uploaded['cid']
    update(db, app_id, reviewValue=value, reviewNote=note.strip(), reviewer=reviewer, reviewedAt=time.time(), preparedHash=report_hash)
    return {'cid': cid, 'hash': report_hash, 'appraisedValue': value, 'bankWallet': bank}


def validate_sync(db, application, state):
    row = job(db, application['id'])
    if not row:
        return
    stage = state['chainStatus']
    if stage in {'None', 'Evaluating'}:
        return
    if (row['state'] != 'completed' or not row['reviewedAt'] or not row['reviewer'] or
            row['reviewer'].lower() != application['evaluatorWallet'].lower() or
            row['reviewValue'] is None or row['reviewValue'] <= 0 or
            state['appraisedValue'] != row['reviewValue'] or state['reportHash'] != row['preparedHash']):
        raise WorkflowError('평가 완료·보고서 검토·평가사 확정 데이터가 일치하지 않습니다.')
    # Unrounded integer comparison mirrors the deployed v2 contract exactly.
    eligible = application['amount'] * 100 <= row['reviewValue'] * 70
    if stage in {'Eligible', 'Approved', 'Rejected', 'Repaid'} and not eligible:
        raise WorkflowError('LTV가 데모 계약 기준 70%를 초과하여 여신심사로 전달할 수 없습니다.')
    if stage == 'RuleRejected' and eligible:
        raise WorkflowError('LTV 판정과 체인 결과가 다릅니다.')


def after_sync(db, application, state):
    row = job(db, application['id'])
    if not row:
        return
    if state['chainStatus'] == 'Evaluating':
        mapped = {'completed': 'report_ready', 'failed': 'report_failed', 'submission_unknown': 'report_failed',
                  'submission_rejected': 'report_failed', 'awaiting_identity': 'doc_verify'}
        db.execute('UPDATE applications SET status=? WHERE id=?', (mapped.get(row['state'], 'evaluating'), application['id']))
    elif state['chainStatus'] not in {'None'}:
        db.execute('UPDATE loan_evaluations SET confirmedAt=COALESCE(confirmedAt,?) WHERE appId=?', (time.time(), application['id']))
        if state['chainStatus'] in {'Eligible', 'Approved', 'Rejected', 'Repaid'}:
            db.execute('INSERT OR IGNORE INTO credit_cases VALUES (?,?,?,?,?,?,?,?)',
                       (application['id'], state['reportHash'], application['bankWallet'], state['appraisedValue'],
                        application['amount'], application['amount'] / state['appraisedValue'] * 100,
                        'v2-contract-demo-ltv-70-percent', time.time()))


def register(native):
    app = native.app

    @app.errorhandler(WorkflowError)
    def workflow_error(exc):
        native.get_db().rollback()
        return native.error_response(str(exc), exc.status, 'workflow_blocked')

    @app.errorhandler(native.chain.ChainError)
    def chain_error(exc):
        native.get_db().rollback()
        return native.error_response(str(exc), 403, 'workflow_role_unavailable')

    @app.route('/api/workflow/challenge', methods=['POST'])
    def challenge():
        data = request.get_json(silent=True) or {}
        if not isinstance(data, dict):
            raise WorkflowError('JSON 요청이 필요합니다.', 400)
        try:
            wallet = native.chain.address(data.get('address'))
        except native.chain.ChainError as exc:
            raise WorkflowError(str(exc), 400) from None
        action, app_id, content_hash = data.get('action'), data.get('applicationId', ''), data.get('digest', '')
        if action not in {'create', 'status', 'retry', 'identity', 'recover', 'artifact', 'review', 'document'} or not isinstance(app_id, str) or len(app_id) > 100 or not re.fullmatch('[0-9a-f]{64}', str(content_hash)):
            raise WorkflowError('서명 요청 내용을 확인하세요.', 400)
        db = native.get_db()
        db.execute('DELETE FROM workflow_nonces WHERE expires<?', (time.time(),))
        if db.execute('SELECT COUNT(*) FROM workflow_nonces').fetchone()[0] >= 1000:
            db.commit()
            raise WorkflowError('서명 요청이 많습니다. 잠시 후 다시 시도하세요.', 429)
        nonce = secrets.token_urlsafe(24)
        message = f'IP Loan 통합 업무\n작업: {action}\n신청: {app_id}\n주소: {wallet}\n내용 SHA256: {content_hash}\nnonce: {nonce}'
        db.execute('INSERT INTO workflow_nonces VALUES (?,?,?,?,?,?,?)', (nonce, wallet, action, app_id, content_hash, message, time.time()+300))
        db.commit()
        return jsonify({'nonce': nonce, 'message': message})

    def evaluation_result(app_id):
        db = native.get_db()
        current = job(db, app_id)
        application = native.find_application(app_id)
        if application.get('chainStatus') == 'Evaluating':
            after_sync(db, application, {'chainStatus': 'Evaluating'})
            db.commit()
        result = native.application_to_public(native.find_application(app_id))
        result['evaluation'] = {**summary(db, app_id), 'artifacts': json.loads(current['artifacts'])}
        result['evaluation']['attempts'] = [dict(r) for r in db.execute(
            'SELECT attempt,jobId,state,error,updatedAt FROM loan_evaluation_attempts WHERE appId=? ORDER BY attempt', (app_id,))]
        result['ltvPolicy'] = {'limitPercent': 70, 'source': 'v2-contract', 'demo': True}
        return result

    @app.route('/api/applications/<app_id>/evaluation', methods=['GET'])
    def evaluation_status(app_id):
        # Progress and reports are open to viewers; the patent original still needs a wallet signature.
        if not job(native.get_db(), app_id):
            raise WorkflowError('통합 신청을 찾을 수 없습니다.', 404)
        refresh(native, app_id)
        return jsonify(evaluation_result(app_id))

    @app.route('/api/applications/<app_id>/evaluation', methods=['POST'])
    def evaluation(app_id):
        data = request.get_json(silent=True) or {}
        if not isinstance(data, dict):
            raise WorkflowError('JSON 요청이 필요합니다.', 400)
        action = data.get('action', 'status')
        if action not in {'status', 'retry', 'identity', 'recover'}:
            raise WorkflowError('지원하지 않는 평가 작업입니다.', 400)
        payload = {k: v for k, v in data.items() if k != 'auth'}
        wallet = authorize(native, action, app_id, payload, data.get('auth'))
        db = native.get_db()
        row = refresh(native, app_id)
        if action == 'retry':
            if row['state'] not in {'pending', 'submission_rejected', 'failed'} or row['reviewedAt']:
                raise WorkflowError('접수 중·완료·접수 불명 작업은 재접수할 수 없습니다. 기존 작업번호를 확인하세요.')
            if time.time() < row['retryAt']:
                raise WorkflowError('공급자가 지정한 대기 시간 이후에 재시도하세요.', 429)
            submit(native, app_id)
        elif action == 'identity':
            number = data.get('business_number', '')
            if row['state'] != 'awaiting_identity' or not re.fullmatch(r'\d{10}', str(number)):
                raise WorkflowError('사업자번호 입력 대기 상태와 10자리 번호를 확인하세요.', 400)
            if number != re.sub(r'\D', '', native.find_application(app_id)['bizNo']):
                raise WorkflowError('대출 신청에 저장된 동일한 사업자번호로 확인해야 합니다.', 400)
            store_result(db, app_id, patent_api.identify(row['jobId'], number))
        elif action == 'recover':
            job_id = data.get('job_id', '')
            if row['state'] != 'submission_unknown' or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', str(job_id)):
                raise WorkflowError('접수 여부 확인이 필요한 작업과 공급자 작업번호를 확인하세요.')
            recovered = patent_api.status(job_id)
            application = native.find_application(app_id)
            expected = hashlib.sha256(read_document(application, row)).hexdigest()
            if (recovered.get('source_sha256') != expected or
                    re.sub(r'\D', '', str(recovered.get('business_number') or '')) != re.sub(r'\D', '', application['bizNo'])):
                raise WorkflowError('공급자 작업의 원본 SHA256·사업자번호가 신청과 일치하지 않습니다.')
            claimed = db.execute("UPDATE loan_evaluations SET state='submitting' WHERE appId=? AND state='submission_unknown'", (app_id,)).rowcount
            db.commit()
            if not claimed:
                raise WorkflowError('다른 요청에서 작업번호를 복구했습니다. 상태를 다시 조회하세요.')
            try:
                store_result(db, app_id, recovered)
            except Exception:
                db.rollback()
                update(db, app_id, state='submission_unknown', error='복구 결과 저장 실패. 같은 공급자 작업번호로 다시 확인하세요.')
                raise
        result = evaluation_result(app_id)
        if action == 'status' and not (data.get('auth') or {}).get('session'):
            token = secrets.token_urlsafe(32)
            db.execute('DELETE FROM workflow_read_sessions WHERE expires<?', (time.time(),))
            db.execute('INSERT INTO workflow_read_sessions VALUES (?,?,?,?)',
                       (hashlib.sha256(token.encode()).hexdigest(), app_id, wallet, time.time()+900))
            db.commit()
            result['readSession'] = token
        return jsonify(result)

    @app.route('/api/applications/<app_id>/evaluation/artifacts/<kind>', methods=['GET', 'POST'])
    def evaluation_artifact(app_id, kind):
        # GET shows the report without a wallet (inline unless ?download=1); POST keeps the signed download.
        if request.method == 'POST':
            data = request.get_json(silent=True) or {}
            if not isinstance(data, dict):
                raise WorkflowError('JSON 요청이 필요합니다.', 400)
            authorize(native, 'artifact', app_id, {'kind': kind}, data.get('auth'))
        body, _ = artifact(native.get_db(), app_id, kind)
        types = {'pdf': 'application/pdf', 'html': 'text/html; charset=utf-8', 'quality': 'application/json',
                 'timing': 'application/json', 'trace': 'text/plain; charset=utf-8', 'log': 'text/plain; charset=utf-8'}
        disposition = 'inline' if request.method == 'GET' and request.args.get('download') != '1' else 'attachment'
        response = Response(body, content_type=types[kind], headers={'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': f'{disposition}; filename="{app_id}-{kind}.{kind}"'})
        if kind == 'html':
            response.headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
        return response

    @app.route('/api/applications/<app_id>/evaluation/document', methods=['POST'])
    def evaluation_document(app_id):
        data = request.get_json(silent=True) or {}
        if not isinstance(data, dict):
            raise WorkflowError('JSON 요청이 필요합니다.', 400)
        authorize(native, 'document', app_id, {}, data.get('auth'))
        application = native.find_application(app_id)
        body = read_document(application, job(native.get_db(), app_id))
        return Response(body, mimetype='application/pdf', headers={'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="patent.pdf"'})

    @app.errorhandler(PatentAPIError)
    def provider_error(exc):
        native.get_db().rollback()
        return native.error_response(safe_error(exc), exc.status, 'evaluation_provider_error')
