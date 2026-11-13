#!/usr/bin/env python3
"""Small JSON adapter: fixed instance, bounded operations, no connection/credential logging."""
import json
import re
import subprocess
import sys
import time

INSTANCE = 'uhost-1xl0i3stj2qh'


def call(operation, *args, limit=180, quiet=False):
    try:
        result = subprocess.run(
            ['compshare', '--json', 'instance', operation, INSTANCE, *args],
            capture_output=True, text=True, timeout=limit,
        )
        reply = json.loads(result.stdout)
    except (subprocess.TimeoutExpired, ValueError, OSError) as error:
        if not quiet:
            print(f'gpu: {operation} failed ({type(error).__name__})', file=sys.stderr)
        return 1, {}
    data = reply.get('data') or {}
    if not reply.get('ok'):
        error = reply.get('error') or {}
        if not quiet:
            # Error details can contain SSH connection arguments; only expose the stable code.
            print(f'gpu: {operation}: {error.get("code", "FAILED")}', file=sys.stderr)
        data = error.get('details') or data
        if not quiet and operation == 'cp':
            # Copy diagnostics are essential on fresh images (missing SFTP/scp).
            # The CLI already redacts secrets; additionally suppress connection addresses.
            diagnostic = data.get('stderr') or error.get('message') or ''
            diagnostic = re.sub(r'\b(?:\d{1,3}\.){3}\d{1,3}\b', '[host]', diagnostic)
            diagnostic = re.sub(r'\S+@\S+', '[connection]', diagnostic)
            print(diagnostic[:1500], file=sys.stderr)
    return result.returncode or (0 if reply.get('ok') else 1), data


def status():
    rc, data = call('show', '--status', limit=15)
    if rc:
        raise RuntimeError('cannot confirm instance state')
    rows = data.get('UHostSet') or []
    if len(rows) != 1 or rows[0].get('UHostId') != INSTANCE:
        raise RuntimeError('unexpected status response')
    state = rows[0].get('State')
    if not isinstance(state, str) or not state:
        raise RuntimeError('missing instance state')
    return state


def ssh(command, quiet=False, limit=1900):
    rc, data = call('ssh', '--connect-timeout', '10', '--timeout', '60', '--',
                    'sh', '-lc', command, limit=limit, quiet=quiet)
    if not quiet:
        sys.stdout.write(data.get('stdout') or '')
        sys.stderr.write(data.get('stderr') or '')
    return data.get('exit_code', rc) or rc


def main():
    action, *args = sys.argv[1:]
    if action == 'status':
        print(f'{INSTANCE} State={status()}')
        return 0
    if action == 'start':
        print(f'gpu: starting {INSTANCE}', flush=True)
        return call('start', '--wait', '--timeout', '180', limit=195)[0]
    if action == 'ready':
        deadline = time.monotonic() + 150
        while time.monotonic() < deadline:
            if status() == 'Running' and ssh('true', quiet=True, limit=15) == 0:
                print('gpu: State=Running; SSH ready', flush=True)
                return 0
            time.sleep(5)
        raise RuntimeError('SSH not ready after 150 seconds')
    if action == 'stop':
        # Query independently even after a lifecycle timeout: never claim stopped from request acceptance.
        deadline = time.monotonic() + 300
        attempt, max_attempts = 0, 2
        while attempt < max_attempts and time.monotonic() < deadline:
            attempt += 1
            try:
                stopped = status() == 'Stopped'
            except RuntimeError:
                stopped = False  # A failed query must never prevent the stop request.
            if stopped:
                print(f'{INSTANCE} State=Stopped', flush=True)
                return 0
            _, data = call('stop', '--yes', '--wait', '--timeout', '45', limit=55)
            pending = any((item.get('error') or {}).get('ret_code') == 226609
                          for item in data.get('failed', []))
            # A lifecycle lock can outlast the request. Observe first, then retry the
            # stop request if it never took effect; Running alone does not prove shutdown.
            if pending:
                max_attempts = 5
            for _ in range(6 if pending else 0):
                if time.monotonic() >= deadline:
                    break
                try:
                    if status() == 'Stopped':
                        print(f'{INSTANCE} State=Stopped', flush=True)
                        return 0
                except RuntimeError:
                    pass
                time.sleep(5)
        if status() != 'Stopped':
            raise RuntimeError('STOP NOT CONFIRMED; run tools/gpu stop immediately')
        print(f'{INSTANCE} State=Stopped', flush=True)
        return 0
    if action == 'cp' and len(args) == 2:
        return call('cp', *args, '--connect-timeout', '10', limit=90)[0]
    if action == 'cp-seed' and len(args) == 2:
        return call('cp', *args, '--connect-timeout', '10', limit=300)[0]
    if action == 'ssh' and len(args) == 1:
        return ssh(args[0])
    if action == 'ssh-short' and len(args) == 1:
        return ssh(args[0], limit=45)
    raise RuntimeError('invalid internal action')


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError, KeyError) as error:
        sys.exit(f'gpu: {error}')
