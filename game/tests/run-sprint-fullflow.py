#!/usr/bin/env python3
"""Gated, isolated acceptance. Build separately through gate heavy; never installs packages."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

root = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--chapters', choices=['4', '8'], default='8')
p.add_argument('--mode', choices=['desktop', 'mobile', 'both'], default='both')
p.add_argument('--natural-threats', action='store_true', help='Disable puzzle-isolation safe command; a separate difficulty playtest')
p.add_argument('--list', action='store_true')
p.add_argument('--run-id', help='Unique evidence directory name; an existing directory is never reused')
a = p.parse_args()
env = dict(os.environ, ESC_FULLFLOW_CHAPTERS=a.chapters, ESC_FULLFLOW_MODE=a.mode,
           ESC_FULLFLOW_NATURAL='1' if a.natural_threats else '0', ESC_FULLFLOW_LIST='1' if a.list else '0')
command = ['node', 'node_modules/@playwright/test/cli.js', 'test', '-c', 'playwright.fullflow.config.ts']
if a.mode != 'both':
    command += ['--grep', a.mode]
if a.list:
    command += ['--list']
gate = Path('/Users/local-user/escape/loop/parallel_sprint.py')
command = ['python3', str(gate), 'gate', 'browser', '--', *command]
if a.list:
    raise SystemExit(subprocess.call(command, cwd=root, env=env))

run_id = a.run_id or datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + f'-{os.getpid()}'
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', run_id):
    p.error('--run-id must be 1–80 letters, digits, dots, underscores or hyphens')
evidence_root = root / 'test-results' / 'sprint-fullflow'
run_dir = (evidence_root / 'runs' / run_id).resolve()
if not str(run_dir).startswith(str(evidence_root) + os.sep):
    p.error('evidence directory resolves outside this worktree test-results')
run_dir.mkdir(parents=True, exist_ok=False)
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
env.update(ESC_FULLFLOW_RUN_ID=run_id, ESC_FULLFLOW_RUN_DIR=str(run_dir), ESC_FULLFLOW_HEAD=head)
sources = ['tests/fullflow/harness.ts', 'tests/fullflow/chapters.ts', 'tests/fullflow/future.ts',
           'tests/fullflow/release-audit.ts', 'tests/fullflow/release-source.ts', 'tests/e2e-pending/sprint-fullflow.spec.ts',
           'tests/run-sprint-fullflow.py', 'playwright.fullflow.config.ts',
           'shared/level.ts', 'shared/protocol.ts', 'server/room.ts', 'client/src/game.ts',
           'dist/index.html', 'dist-server/index.js']

def snapshot():
    source_hashes = {}
    for name in sources:
        file = root / name
        entry = file
        while entry != root and not entry.is_symlink():
            entry = entry.parent
        if entry == root and file.is_file():
            source_hashes[name] = hashlib.sha256(file.read_bytes()).hexdigest()
    artifact_hashes = {}
    for directory in ['dist', 'dist-server']:
        artifact_root = root / directory
        if artifact_root.is_symlink():
            continue
        for parent, directories, files in os.walk(artifact_root, followlinks=False):
            directories[:] = sorted(d for d in directories if not (Path(parent) / d).is_symlink())
            for name in sorted(files):
                file = Path(parent) / name
                if not file.is_symlink() and file.is_file():
                    artifact_hashes[file.relative_to(root).as_posix()] = hashlib.sha256(file.read_bytes()).hexdigest()
    return {'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
            'dirty': subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=root, text=True),
            'sourceHashes': source_hashes, 'artifactHashes': artifact_hashes}

metadata = {'runId': run_id, 'startedAt': datetime.now(timezone.utc).isoformat(), 'head': head,
            'dirty': subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=root, text=True),
            'chapters': int(a.chapters), 'mode': a.mode, 'naturalThreats': a.natural_threats,
            'command': command}
(run_dir / 'run.json').write_text(json.dumps(metadata, indent=2) + '\n')
metadata.update(snapshot())
head = metadata['head']
env['ESC_FULLFLOW_HEAD'] = head
(run_dir / 'run.json').write_text(json.dumps(metadata, indent=2) + '\n')
print(f'FULLFLOW run {run_id} head {head} evidence {run_dir}', flush=True)

def run_logged(args, log):
    process = subprocess.Popen(args, cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, encoding='utf-8', errors='replace', start_new_session=True)
    try:
        for line in process.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            log.write(line)
            log.flush()
        return process.wait()
    except BaseException:
        cleanup = {'pid': process.pid, 'processGroup': process.pid, 'signals': [],
                   'requiresOwnedServerPidCheck': 4436}
        metadata.setdefault('childCleanup', []).append(cleanup)
        previous_handler = signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            for sig, grace in [(signal.SIGINT, 10), (signal.SIGTERM, 3), (signal.SIGKILL, 1)]:
                try:
                    os.killpg(process.pid, sig)
                except ProcessLookupError:
                    break
                cleanup['signals'].append(sig.name)
                deadline = time.monotonic() + grace
                while time.monotonic() < deadline:
                    process.poll()  # Reap our child even when other group members are still shutting down.
                    try:
                        os.killpg(process.pid, 0)
                    except ProcessLookupError:
                        break
                    time.sleep(.1)
                else:
                    continue
                break
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                cleanup['childStillRunning'] = True
        finally:
            signal.signal(signal.SIGINT, previous_handler)
            print('FULLFLOW interrupted/failed: check this run\'s own server PID on port 4436; detached descendants may remain', file=sys.stderr)
        raise
    finally:
        process.stdout.close()

result = 1
try:
    with (run_dir / 'run.log').open('x') as log:
        log.write(f'FULLFLOW run {run_id} head {head}\n')
        # Missing registry/protocol/build metadata fails before allocating the shared browser slot.
        result = run_logged(['node', 'tests/fullflow/release-audit.ts', '--require-eight'], log) if a.chapters == '8' else 0
        if result == 0:
            result = run_logged(command, log)
except KeyboardInterrupt:
    metadata['interrupted'] = True
    result = 130
except Exception as error:
    metadata['runnerError'] = f'{type(error).__name__}: {error}'
    print(f'FULLFLOW runner failed: {metadata["runnerError"]}', file=sys.stderr)
    result = 1
finally:
    metadata['commandExitCode'] = result
    try:
        final = snapshot()
        metadata['finalSnapshot'] = final
        metadata['headChanged'] = final['head'] != metadata['head']
        metadata['changedInputs'] = sorted({name for group in ['sourceHashes', 'artifactHashes']
                                            for name in metadata[group].keys() | final[group].keys()
                                            if metadata[group].get(name) != final[group].get(name)})
        if metadata['headChanged'] or metadata['changedInputs']:
            print('FULLFLOW evidence invalid: HEAD or recorded inputs changed while queued/running', file=sys.stderr)
            result = result or 2
    except Exception as error:
        metadata['snapshotError'] = f'{type(error).__name__}: {error}'
        print(f'FULLFLOW final snapshot failed: {metadata["snapshotError"]}', file=sys.stderr)
        result = result or 2
    metadata.update(endedAt=datetime.now(timezone.utc).isoformat(), exitCode=result)
    (run_dir / 'run.json').write_text(json.dumps(metadata, indent=2) + '\n')
raise SystemExit(result)
