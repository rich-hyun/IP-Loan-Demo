"""TPS TEST ONLY. Runs the real Flask API (server/app.py) against a local test chain with test doubles
for the external services only:

- IPFS upload/gateway  -> files in <data>/mock-ipfs (CID = "bafy" + sha256)
- LLM evaluation API   -> fixed completed response (same shape as server/integration_runner.py fixture)
- patent register API  -> fixed "unconfigured" record (no data.go.kr call)

Routes, auth, SQLite, encryption, token card rendering and chain reads are the production code paths.
Served by waitress with IPLOAN_TPS_THREADS threads (production: gunicorn -w 2 --threads 4).
Never point this at the production DB, chain or IPFS.
"""
import hashlib
import io
import json
import os
import sys
from pathlib import Path
from unittest.mock import Mock

data_dir = Path(os.environ["IPLOAN_TPS_DATA_DIR"]).resolve()
data_dir.mkdir(parents=True, exist_ok=True)
os.environ["IPLOAN_DB_PATH"] = str(data_dir / "tps.db")
os.environ["IPLOAN_PATENT_DB_PATH"] = str(data_dir / "patents.db")
os.environ["IPLOAN_PATENT_UPLOAD_DIR"] = str(data_dir / "patent-uploads")
os.environ.pop("PATENT_REGISTER_API_KEY", None)
os.environ.pop("IPLOAN_PATENT_API_TOKEN", None)
if int(os.environ.get("IPLOAN_CHAIN_ID", "0")) != 31337 or not os.environ.get("IPLOAN_RPC_URL", "").startswith("http://127.0.0.1"):
    sys.exit("tps_server.py only runs against a loopback test chain (chain id 31337).")

repo = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(repo))
from server import app as app_module  # noqa: E402
from server import patent_register  # noqa: E402
from server.loan_workflow import patent_api  # noqa: E402

ipfs_dir = data_dir / "mock-ipfs"
ipfs_dir.mkdir(exist_ok=True)


def mock_upload(payload, filename, content_type):
    cid = "bafy" + hashlib.sha256(payload).hexdigest()
    (ipfs_dir / cid).write_bytes(payload)
    return {"cid": cid, "ipfs": "ipfs://" + cid}


real_get = app_module.requests.get


def mock_gateway(url, **kwargs):
    if "/ipfs/" not in url:
        return real_get(url, **kwargs)
    payload = (ipfs_dir / url.rsplit("/", 1)[-1]).read_bytes()
    response = Mock()
    response.raise_for_status.return_value = None
    response.iter_content.side_effect = lambda size: (payload[i:i + size] for i in range(0, len(payload), size))
    return response


app_module.upload_ipfs_payload = mock_upload
app_module.requests.get = mock_gateway


def register_stub(number, company=None):
    return {"registrationNumber": number, "collectedAt": "2026-11-17T00:00:00+00:00",
            "status": "unconfigured", "message": "TPS 시험: 등록원부 API 대체 응답"}


patent_register.collect = register_stub
app_module.patent_register.collect = register_stub


def fixture_submit(path, filename, number):
    key = hashlib.sha256(path.read_bytes()).hexdigest()
    year = {'year': 2025, 'fiscal_date': '2025-12-31', 'source': 'nice_finance', 'revenue_krw': 8710036000,
            'operating_income_krw': 584083000, 'net_income_krw': 455107000, 'total_assets_krw': 9095449000,
            'total_liabilities_krw': 6896117000, 'total_equity_krw': 2199332000, 'finance_costs_krw': 79266000,
            'debt_ratio_pct': 313.56, 'current_ratio_pct': 166.61, 'interest_coverage_times': 7.37}
    return {'job_id': 'tps-' + key[:16] + '-' + os.urandom(4).hex(), 'status': 'completed',
            'valuation': {'ip_value_krw': 200000000, 'value_status': 'preliminary'},
            'credit_rating': 'bb-', 'financials': [year], 'artifacts': {'pdf': '/pdf'}, 'error': ''}


REPORT_PDF = b'%PDF-1.4\n% TPS TEST DOUBLE evaluation report\n' + os.urandom(200_000) + b'\n%%EOF'
patent_api.submit = fixture_submit
patent_api.artifact = lambda *_: io.BytesIO(REPORT_PDF)

if __name__ == "__main__":
    from waitress import serve
    port = int(os.environ.get("IPLOAN_TPS_PORT", "5101"))
    threads = int(os.environ.get("IPLOAN_TPS_THREADS", "8"))
    print(json.dumps({"url": f"http://127.0.0.1:{port}/api", "threads": threads}), flush=True)
    serve(app_module.app, host="127.0.0.1", port=port, threads=threads, connection_limit=200, channel_timeout=120,
          ident=None, _quiet=True)
