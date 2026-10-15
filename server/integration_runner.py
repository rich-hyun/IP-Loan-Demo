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

test_dir = tempfile.TemporaryDirectory()
os.environ["IPLOAN_DB_PATH"] = str(Path(test_dir.name) / "integration.db")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import app as app_module

files = {}
def mock_upload(payload, filename, content_type):
    cid = "bafy" + hashlib.sha256(payload).hexdigest()
    files[cid] = payload
    return {"cid": cid, "ipfs": "ipfs://" + cid}

def mock_gateway(url, **kwargs):
    payload = files[url.rsplit("/", 1)[-1]]
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
    test_dir.cleanup()
