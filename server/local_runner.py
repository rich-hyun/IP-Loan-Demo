"""Loopback development server using the real application, IPFS and evaluation clients."""
import json
from pathlib import Path
import sys
from werkzeug.serving import make_server

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.app import app

# No monkeypatches, provider fixtures, unlocked-wallet injection or legacy submissions.
httpd = make_server('127.0.0.1', 0, app, threaded=True)
print(json.dumps({'url': f'http://127.0.0.1:{httpd.server_port}/api'}), flush=True)
try:
    httpd.serve_forever()
finally:
    httpd.server_close()
