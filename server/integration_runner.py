"""TEST ONLY: temporary DB, in-memory IPFS and a mock LLM report service; local RPC supplied by test runner."""
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import uuid
from unittest.mock import Mock
from werkzeug.serving import make_server

# IPLOAN_TEST_DATA_DIR lets a test restart the API with new settings on the same temporary data.
test_dir = None if os.environ.get("IPLOAN_TEST_DATA_DIR") else tempfile.TemporaryDirectory()
data_dir = Path(os.environ.get("IPLOAN_TEST_DATA_DIR") or test_dir.name)
os.environ["IPLOAN_DB_PATH"] = str(data_dir / "integration.db")
os.environ["IPLOAN_PATENT_DB_PATH"] = str(data_dir / "no-archive.db")
os.environ["IPLOAN_UPLOAD_DIR"] = str(data_dir / "uploads")
os.environ["IPLOAN_ROLE_CACHE_SECONDS"] = "0"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import app as app_module

ipfs_dir = data_dir / "mock-ipfs"
ipfs_dir.mkdir(exist_ok=True)
def mock_upload(payload, filename, content_type):
    cid = "bafy" + hashlib.sha256(payload).hexdigest()
    (ipfs_dir / cid).write_bytes(payload)
    return {"cid": cid, "ipfs": "ipfs://" + cid}

def mock_gateway(url, **kwargs):
    payload = (ipfs_dir / url.rsplit("/", 1)[-1]).read_bytes()
    response = Mock()
    response.raise_for_status.return_value = None
    response.iter_content.side_effect = lambda size: (payload[i:i+size] for i in range(0, len(payload), size))
    return response

# The report is ready as soon as it is submitted; its bytes identify the job so tests can verify decryption.
# It carries the LLM figure and fiscal summary that the report API sends with a completed job.
def mock_submit(path, filename, business_number):
    return {"job_id": "job-" + uuid.uuid4().hex, "status": "completed",
            "business_number": business_number, "artifacts": {"pdf": "/report.pdf"},
            "valuation": {"ip_value_krw": 100, "value_status": "preliminary", "valuation_date": "2026-10-20"},
            "financials": [{"year": 2025, "fiscal_date": "2025-12-31", "fiscal_date_assumed": True, "source": "company_report",
                            "total_equity_krw": 1_812_000_000, "operating_income_krw": None, "current_ratio_pct": 592.63}]}

app_module.upload_ipfs_payload = mock_upload
app_module.requests.get = mock_gateway
app_module.patent_api.token = "integration-test-token"
app_module.patent_api.submit = mock_submit
app_module.patent_api.artifact = lambda job_id, kind: io.BytesIO(b"%PDF-1.7\nLLM report " + job_id.encode())
httpd = make_server("127.0.0.1", 0, app_module.app)
print(json.dumps({"url": f"http://127.0.0.1:{httpd.server_port}/api"}), flush=True)
try:
    httpd.serve_forever()
finally:
    httpd.server_close()
    if test_dir:
        test_dir.cleanup()
