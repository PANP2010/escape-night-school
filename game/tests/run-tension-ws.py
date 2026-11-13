"""Run only our built server and genuine WS acceptance on fixed port 4421; always stop our own PID."""
from pathlib import Path
import socket
import subprocess
import time
import urllib.request

root = Path(__file__).resolve().parent.parent
results = root / 'test-results'
results.mkdir(exist_ok=True)
try:
    connection = socket.create_connection(('127.0.0.1', 4421), timeout=.3)
except OSError:
    pass
else:
    connection.close()
    raise SystemExit('4421 is occupied; no server was started or stopped')

with (results / 'tension-ws-server.log').open('w') as server_log:
    server = subprocess.Popen(['env', 'PORT=4421', 'HOST=127.0.0.1', 'NODE_ENV=development',
                               'node', 'dist-server/index.js'], cwd=root, stdout=server_log, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + 20
        while True:
            if server.poll() is not None:
                raise RuntimeError('Our server exited before health check')
            try:
                with urllib.request.urlopen('http://127.0.0.1:4421/healthz', timeout=1) as response:
                    if response.status == 200:
                        break
            except OSError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(.1)
        result = subprocess.run(['node', 'tests/tension-ws.mjs'], cwd=root, timeout=300)
    finally:
        server.terminate()
        try:
            server.wait(timeout=8)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)
raise SystemExit(result.returncode)
