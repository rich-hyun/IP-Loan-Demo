"""TEST ONLY: temporary DB and in-memory IPFS; local RPC supplied by test runner."""
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import Mock
from werkzeug.serving import make_server

# IPLOAN_TEST_DATA_DIR lets a test restart the API with new settings on the same temporary data.
test_dir = None if os.environ.get("IPLOAN_TEST_DATA_DIR") else tempfile.TemporaryDirectory()
data_dir = Path(os.environ.get("IPLOAN_TEST_DATA_DIR") or test_dir.name)
os.environ["IPLOAN_DB_PATH"] = str(data_dir / "integration.db")
os.environ["IPLOAN_PATENT_DB_PATH"] = str(data_dir / "patents.db")
os.environ["IPLOAN_PATENT_UPLOAD_DIR"] = str(data_dir / "patent-uploads")
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

app_module.upload_ipfs_payload = mock_upload
app_module.requests.get = mock_gateway
httpd = make_server("127.0.0.1", 0, app_module.app)
print(json.dumps({"url": f"http://127.0.0.1:{httpd.server_port}/api"}), flush=True)
try:
    httpd.serve_forever()
finally:
    httpd.server_close()
    if test_dir:
        test_dir.cleanup()
