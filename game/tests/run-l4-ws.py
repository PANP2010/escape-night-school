"""Run L4's real WS acceptance against our own preview server, exclusively on 4294."""
from pathlib import Path
import os
import socket
import subprocess
import time
import urllib.request

root = Path(__file__).resolve().parent.parent
results = root / "test-results"
results.mkdir(exist_ok=True)
port = int(os.environ.get("ESC_TEST_PORT", "4294"))

# Never reuse or stop a service owned by another test/workspace.
try:
    connection = socket.create_connection(("127.0.0.1", port), timeout=0.3)
except OSError:
    pass
else:
    connection.close()
    raise SystemExit(f"{port} is occupied; no server was started or stopped")

with (results / "l4-ws-server.log").open("w") as server_log:
    server = subprocess.Popen(
        ["env", f"PORT={port}", "NAV_CACHE=.cache/campus-nav.json",
         "node", "dist-server/index.js", "--l4-preview"],
        cwd=root, stdout=server_log, stderr=subprocess.STDOUT,
    )
    try:
        deadline = time.monotonic() + 20
        while True:
            if server.poll() is not None:
                raise RuntimeError("Own L4 server exited before its health check")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=1) as response:
                    if response.status == 200:
                        break
            except OSError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.1)
        with (results / "l4-ws.log").open("w") as log:
            result = subprocess.run(
                ["node", "tests/l4-ws.mjs"], cwd=root,
                stdout=log, stderr=subprocess.STDOUT, timeout=180,
            )
    finally:
        server.terminate()
        try:
            server.wait(timeout=8)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)

print(f"L4 WS exit: {result.returncode}; log: {results / 'l4-ws.log'}")
raise SystemExit(result.returncode)
