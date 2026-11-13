import { afterEach, expect, test } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Exercise the real shell lifecycle and JSON adapter. Only OS boundaries (CLI, credential path,
// PATH prefix and lock filename) point at an isolated fixture; no cloud or real credentials are used.
const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });

const fakeCLI = `#!/usr/bin/python3
import json, os, pathlib, shlex, sys, tarfile, time
root = pathlib.Path(os.environ['GPU_FIXTURE'])
args = sys.argv[1:]
assert args[:2] == ['--json', 'instance']
operation, instance = args[2:4]
assert instance == 'uhost-1xl0i3stj2qh', 'unexpected cloud instance'
with (root / 'calls.jsonl').open('a') as log:
    log.write(json.dumps({'operation': operation, 'args': args[4:]}) + '\\n')
state_file = root / 'state'
state = state_file.read_text()
mode = os.environ.get('GPU_FAKE_MODE', '')
rc, data, error = 0, {}, None
if operation == 'start':
    state_file.write_text('Running')
    if mode == 'start-failed': rc = 42
elif operation == 'show':
    count_file = root / 'show-count'
    count = int(count_file.read_text()) + 1 if count_file.exists() else 1
    count_file.write_text(str(count))
    if mode == 'cleanup-query-failed' and count >= 2:
        rc = 1
    else:
        if mode == 'stop-pending' and (root / 'pending-stop').exists():
            pending_file = root / 'pending-shows'
            pending_count = int(pending_file.read_text()) + 1 if pending_file.exists() else 1
            pending_file.write_text(str(pending_count))
            if pending_count >= 3:
                state = 'Stopped'
                state_file.write_text(state)
        data = {'UHostSet': [{'UHostId': 'other-instance' if mode == 'wrong-instance' else instance, 'State': state}]}
        if mode == 'missing-state': del data['UHostSet'][0]['State']
elif operation == 'stop':
    if mode == 'cleanup-blocked':
        (root / 'stop-active').touch()
        time.sleep(0.5)
        state_file.write_text('Stopped')
    elif mode == 'stop-pending':
        (root / 'pending-stop').touch()
        rc, data = 1, {'failed': [{'error': {'ret_code': 226609}}]}
    elif mode == 'pending-request-did-not-start':
        if (root / 'pending-stop').exists():
            state_file.write_text('Stopped')
        else:
            (root / 'pending-stop').touch()
            rc, data = 1, {'failed': [{'error': {'ret_code': 226609}}]}
    elif mode != 'stop-not-confirmed': state_file.write_text('Stopped')
elif operation == 'cp':
    source, destination = args[4:6]
    if source.startswith(':'):
        if mode == 'pull-failed': rc = 45
        else:
            with tarfile.open(destination, 'w:gz') as archive:
                result = root / 'remote-result.txt'
                result.write_text('current run diagnostics')
                archive.add(result, 'test-results/gpu-result.txt')
    elif destination.endswith('escape-gpu-game.tar.gz'):
        if mode in ['upload-failed', 'copy-diagnostic']:
            rc = 43
            if mode == 'copy-diagnostic':
                data = {'stderr': 'scp: remoteadmin@203.0.113.27: Permission denied\\nConnection to 203.0.113.27 closed'}
        else:
            with tarfile.open(source) as archive:
                (root / 'archive.json').write_text(json.dumps(archive.getnames()))
elif operation == 'ssh':
    command = args[-1]
    if command.startswith('bash /home/ubuntu/escape-gpu-remote'):
        (root / 'remote-argv.json').write_text(json.dumps(shlex.split(command)))
        if mode == 'command-blocked':
            (root / 'remote-active').touch()
            time.sleep(1)
        rc = 37 if mode == 'command-failed' else 0
        data = {'stdout': 'remote command output\\n', 'stderr': '', 'exit_code': rc}
    elif command.startswith('mkdir') and mode == 'setup-ssh-failed': rc = 44
else:
    raise AssertionError('unexpected operation: ' + operation)
reply = {'ok': rc == 0, 'schema_version': '1', 'data': data}
if rc:
    reply['error'] = {'code': 'FAKE_FAILURE', 'message': 'sensitive connection details', 'details': data}
print(json.dumps(reply))
sys.exit(rc)
`;

function fixture(mode = '') {
  const root = mkdtempSync(join(tmpdir(), 'escape-gpu-test-'));
  fixtures.push(root);
  for (const folder of ['tools', 'game', 'bin']) mkdirSync(join(root, folder));
  const source = resolve('../tools');
  const original = readFileSync(join(source, 'gpu'), 'utf8');
  // Fail before execution if an implementation change removes one of the isolation boundaries.
  for (const boundary of [
    '/root/.local/share/compshare-venv/bin', '/root/.config/compshare/env',
    '/tmp/escape-gpu-uhost-1xl0i3stj2qh.lock',
  ]) expect(original).toContain(boundary);
  const isolated = original
    .replaceAll('/root/.local/share/compshare-venv/bin', join(root, 'bin'))
    .replaceAll('/root/.config/compshare/env', join(root, 'credentials'))
    .replaceAll('/tmp/escape-gpu-uhost-1xl0i3stj2qh.lock', join(root, 'lock'));
  writeFileSync(join(root, 'tools/gpu'), isolated, { mode: 0o755 });
  for (const file of ['gpu-api.py', 'gpu-remote', 'gpu-seed']) {
    // Speed up only the external lifecycle wait boundary, retaining real state-loop logic.
    const contents = readFileSync(join(source, file), 'utf8').replaceAll('time.sleep(5)', 'time.sleep(0.01)');
    writeFileSync(join(root, 'tools', file), contents, { mode: 0o755 });
  }
  writeFileSync(join(root, 'bin/compshare'), fakeCLI, { mode: 0o755 });
  writeFileSync(join(root, 'credentials'), 'export GPU_TEST_SECRET=never-print-this-secret\n');
  writeFileSync(join(root, 'state'), 'Stopped');
  writeFileSync(join(root, 'game/uncommitted.ts'), 'export const unsaved = true;');
  for (const name of ['node_modules', 'dist', 'dist-server', 'dist-extra', 'test-results', '.green', '.green.backup-old', '.cache']) {
    mkdirSync(join(root, 'game', name));
    writeFileSync(join(root, 'game', name, 'stale'), 'never upload');
  }
  return {
    root,
    run: (...args: string[]) => spawnSync(join(root, 'tools/gpu'), args, {
      cwd: join(root, 'game'), encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, GPU_FIXTURE: root, GPU_FAKE_MODE: mode },
    }),
    calls: () => readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { operation: string; args: string[] }),
    state: () => readFileSync(join(root, 'state'), 'utf8'),
  };
}

test('GPU run uploads the current source, preserves literal argv, retrieves artifacts and confirms shutdown', () => {
  const f = fixture();
  const args = ['printf', 'two words', 'literal $(touch unsafe) `whoami` $HOME', "a'b\"c", 'two\nlines'];
  const result = f.run('run', '--', ...args);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const remote = JSON.parse(readFileSync(join(f.root, 'remote-argv.json'), 'utf8')) as string[];
  expect(remote).toEqual(['bash', '/home/ubuntu/escape-gpu-remote', execFileSync('node', ['-v'], { encoding: 'utf8' }).trim(), ...args]);
  const archive = JSON.parse(readFileSync(join(f.root, 'archive.json'), 'utf8')) as string[];
  expect(archive).toContain('./uncommitted.ts');
  expect(archive).not.toContainEqual(expect.stringMatching(/node_modules|dist|test-results|\.green|\.cache/));
  expect(readFileSync(join(f.root, 'game/test-results/gpu-result.txt'), 'utf8')).toBe('current run diagnostics');
  expect(f.state()).toBe('Stopped');
  expect(f.calls().at(-1)?.operation).toBe('show');
  expect(result.stdout).toContain('State=Stopped');
  expect(result.stdout + result.stderr).not.toMatch(/never-print-this-secret|sensitive connection details/);
});

test.each([
  ['command-failed', 37, true],
  ['start-failed', 42, false],
  ['upload-failed', 43, false],
  ['setup-ssh-failed', 44, false],
  ['pull-failed', 1, false],
] as const)('GPU %s still stops the instance and retains the original failure', (mode, exit, hasArtifacts) => {
  const f = fixture(mode);
  const result = f.run('run', '--', 'echo', 'hello');
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(exit);
  expect(f.state()).toBe('Stopped');
  expect(f.calls()).toContainEqual(expect.objectContaining({ operation: 'stop' }));
  expect(result.stdout).toContain('State=Stopped');
  if (hasArtifacts) expect(readFileSync(join(f.root, 'game/test-results/gpu-result.txt'), 'utf8')).toBe('current run diagnostics');
});

test('GPU stop requires the observed Stopped state rather than request acceptance', () => {
  const f = fixture('stop-not-confirmed');
  writeFileSync(join(f.root, 'state'), 'Running');
  const result = f.run('stop');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('STOP NOT CONFIRMED');
  expect(result.stdout).not.toContain('State=Stopped');
  expect(f.calls().filter((call) => call.operation === 'stop')).toHaveLength(2);
});

test('GPU status rejects a response belonging to another instance', () => {
  const f = fixture('wrong-instance');
  const result = f.run('status');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('unexpected status response');
  expect(f.calls().map((call) => call.operation)).toEqual(['show']);
});

test('GPU stop observes pending shutdown until State becomes Stopped without repeating the request', () => {
  const f = fixture('stop-pending');
  writeFileSync(join(f.root, 'state'), 'Running');
  const result = f.run('stop');
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('State=Stopped');
  expect(f.state()).toBe('Stopped');
  expect(f.calls().filter((call) => call.operation === 'stop')).toHaveLength(1);
  expect(f.calls().filter((call) => call.operation === 'show')).toHaveLength(4);
});

test('GPU stop retries after pending shutdown never takes effect instead of polling forever', () => {
  const f = fixture('pending-request-did-not-start');
  writeFileSync(join(f.root, 'state'), 'Running');
  const result = f.run('stop');
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('State=Stopped');
  expect(f.state()).toBe('Stopped');
  const calls = f.calls();
  const stops = calls.flatMap((call, index) => call.operation === 'stop' ? [index] : []);
  expect(stops).toHaveLength(2);
  const observations = calls.slice(stops[0]! + 1, stops[1]);
  expect(observations.length).toBeGreaterThan(1);
  expect(observations.every((call) => call.operation === 'show')).toBe(true);
});

test('a missing State field cannot prevent cleanup from requesting shutdown', () => {
  const f = fixture('missing-state');
  const result = f.run('run', '--', 'echo', 'hello');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('missing instance state');
  expect(f.calls()).toContainEqual(expect.objectContaining({ operation: 'stop' }));
  expect(f.state()).toBe('Stopped');
  expect(result.stdout).not.toContain('State=Stopped');
});

test.each(['status', 'stop'])('GPU run can invoke a command literally named %s', (command) => {
  const f = fixture();
  const result = f.run('run', '--', command);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(join(f.root, 'remote-argv.json'), 'utf8')).at(-1)).toBe(command);
});

test('GPU cleanup attempts shutdown even when the status query fails', () => {
  const f = fixture('cleanup-query-failed');
  const result = f.run('run', '--', 'echo', 'hello');
  expect(result.status).toBe(1); // failed confirmation is reported honestly
  expect(f.calls()).toContainEqual(expect.objectContaining({ operation: 'stop' }));
  expect(f.state()).toBe('Stopped');
});

test('copy diagnostics retain the failure reason while suppressing connection IP and username', () => {
  const f = fixture('copy-diagnostic');
  const result = f.run('run', '--', 'echo', 'hello');
  expect(result.status).toBe(43);
  expect(result.stderr).toContain('Permission denied');
  expect(result.stderr).toContain('[connection]');
  expect(result.stderr).toContain('[host]');
  expect(result.stdout + result.stderr).not.toMatch(/203\.0\.113\.27|remoteadmin|never-print-this-secret/);
  expect(f.state()).toBe('Stopped');
});

test('SIGTERM during remote execution retrieves diagnostics and stops the instance', async () => {
  const f = fixture();
  // Exercise the trap directly in its own session: signals must never reach npm/Vitest's group.
  const child = spawn(join(f.root, 'tools/gpu'), ['__run', 'echo', 'hello'], {
    detached: true,
    cwd: join(f.root, 'game'),
    env: { ...process.env, GPU_FIXTURE: f.root, GPU_FAKE_MODE: 'command-blocked' },
  });
  let output = '';
  child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
  const finished = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  try {
    const deadline = Date.now() + 8000;
    while (!existsSync(join(f.root, 'remote-active')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(existsSync(join(f.root, 'remote-active')), output).toBe(true);
    child.kill('SIGTERM');
    expect(await finished, output).toBe(143);
    expect(f.state()).toBe('Stopped');
    expect(output).toContain('State=Stopped');
    expect(readFileSync(join(f.root, 'game/test-results/gpu-result.txt'), 'utf8')).toBe('current run diagnostics');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

test('SIGTERM during shutdown cannot interrupt cleanup before Stopped is confirmed', async () => {
  const f = fixture();
  // Avoid GNU timeout's signal forwarding and isolate this fixture from the parent process group.
  const child = spawn(join(f.root, 'tools/gpu'), ['__run', 'echo', 'hello'], {
    detached: true,
    cwd: join(f.root, 'game'),
    env: { ...process.env, GPU_FIXTURE: f.root, GPU_FAKE_MODE: 'cleanup-blocked' },
  });
  let output = '';
  child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
  const finished = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  try {
    const deadline = Date.now() + 8000;
    while (!existsSync(join(f.root, 'stop-active')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(existsSync(join(f.root, 'stop-active')), output).toBe(true);
    child.kill('SIGTERM');
    expect(await finished, output).toBe(0);
    expect(output).toContain('State=Stopped');
    expect(f.state()).toBe('Stopped');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
