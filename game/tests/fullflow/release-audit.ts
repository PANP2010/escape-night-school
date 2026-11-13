/** Read-only readiness audit. Never builds, stages, deploys, or evaluates product modules. */
import { readFile, mkdir, writeFile, readdir, realpath, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { ts, parse, nodes, nameOf, variable, method, fn, literal, property, call, assignedLiteral, comparedLiteral, imported, methodNodes, messageShapes } from './release-source.ts';

const root = resolve(import.meta.dirname, '../..');
const read = (file: string) => readFile(resolve(root, file), 'utf8').catch(() => '');
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const json = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };
const issues: string[] = [], warnings: string[] = [];
const files = ['shared/level.ts', 'shared/protocol.ts', 'shared/levels/def.ts', 'server/index.ts', 'server/room.ts',
  'client/src/game.ts', 'client/src/main.ts', 'client/src/input.ts', 'client/src/touch.ts', 'client/src/net.ts',
  'client/src/voice.ts', 'client/src/updateNotice.ts', 'client/src/releaseState.ts', 'client/public/version.json',
  'dist/version.json', 'dist/index.html', ...Array.from({ length: 8 }, (_, i) => `shared/levels/l${i + 1}.ts`)];
const source: Record<string, string> = Object.fromEntries(await Promise.all(files.map(async f => [f, await read(f)])));
const syntax = new Map<string, ts.SourceFile>();
async function syntaxAt(file: string): Promise<ts.SourceFile> {
  if (!syntax.has(file)) {
    source[file] ??= await read(file);
    const parsed = parse(file, source[file]);
    const diagnostics = (parsed as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
    if (diagnostics?.length) issues.push(`syntax parse failed: ${file} (${diagnostics.length} diagnostics)`);
    syntax.set(file, parsed);
  }
  return syntax.get(file)!;
}
const level = await syntaxAt('shared/level.ts'), protocol = await syntaxAt('shared/protocol.ts');
const game = await syntaxAt('client/src/game.ts'), room = await syntaxAt('server/room.ts');
const entry = await syntaxAt('server/index.ts'), main = await syntaxAt('client/src/main.ts');
for (const f of files.filter(f => !/shared\/levels\/l[5-8]\.ts$/.test(f))) if (!source[f]) issues.push(`required file absent or empty: ${f}`);

// Check actual syntax and named imports: a comment or const L8 = L4 must not register eight chapters.
const init = variable(level, 'LEVELS')?.initializer;
const registry = init && ts.isArrayLiteralExpression(init) ? init.elements.map(n => ts.isIdentifier(n) ? n.text : '<non-identifier>') : [];
const expected = Array.from({ length: 8 }, (_, i) => `L${i + 1}`);
if (registry.join(',') !== expected.join(',')) issues.push(`campaign registry is [${registry.join(', ')}], expected L1…L8 exactly once`);
const definitions: Record<string, string | null> = {};
for (const [i, name] of expected.entries()) {
  const file = `shared/levels/l${i + 1}.ts`, binding = imported(level, name);
  const declaration = variable(await syntaxAt(file), name)?.initializer;
  const object = declaration && ts.isObjectLiteralExpression(declaration) ? declaration : undefined;
  const title = object?.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && nameOf(p.name) === 'name');
  definitions[name] = title && ts.isStringLiteral(title.initializer) ? title.initializer.text : null;
  if (registry.includes(name) && (binding?.module !== `./levels/l${i + 1}.ts` || binding.exported !== name || !definitions[name]))
    issues.push(`${name} must import its own nonempty level definition from ./levels/l${i + 1}.ts`);
  const mechanism = ['gym', 'exam', 'mirror', 'finale'][i - 4];
  if (registry.includes(name) && mechanism && !object?.properties.some(p => ts.isPropertyAssignment(p) && nameOf(p.name) === mechanism))
    issues.push(`${name} definition lacks its ${mechanism} campaign mechanism`);
}
for (const name of ['generateLevel', 'levelDefinition']) {
  const body = fn(level, name)?.body ?? variable(level, name)?.initializer;
  if (nodes(body).some(n => ts.isConditionalExpression(n) && [n.whenTrue, n.whenFalse].some(v => ts.isIdentifier(v) && /^L[1-8]$/.test(v.text))))
    issues.push(`${name} has a standalone chapter override; final campaign selection must use the continuous registry`);
}

const serverShapes = await messageShapes('shared/protocol.ts', 'ServerMsg', syntaxAt);
const clientShapes = await messageShapes('shared/protocol.ts', 'ClientMsg', syntaxAt);
const field = (shape: ts.TypeLiteralNode, key: string) => shape.members.find((m): m is ts.PropertySignature => ts.isPropertySignature(m) && nameOf(m.name) === key);
const tagged = (shapes: ts.TypeLiteralNode[], tag: string) => shapes.find(s => {
  const type = field(s, 't')?.type; return type && ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal) && type.literal.text === tag;
});
for (const [tag, required] of [['gym', ['complete', 'balls']], ['exam', ['answers', 'passed', 'revision']],
  ['l7', ['mirrors', 'key', 'openDoors']], ['finale', ['phase', 'members']], ['completed', ['elapsedMs', 'downs', 'members']]] as const) {
  const shape = tagged(serverShapes, tag);
  if (!shape || required.some(key => !field(shape, key))) issues.push(`missing declared ServerMsg ${tag} with fields ${required.join(', ')}`);
}
if (!clientShapes.some(s => { const k = field(s, 'kind'); return k && literal(k, 'mirror-key'); }) ||
    !clientShapes.some(s => { const k = field(s, 'kind'); return k && literal(k, 'mirror-push'); }) ||
    !call(fn(protocol, 'parseClientMsg')?.body, 'parseCampaignMirrorAct')) issues.push('L7 act kinds or parseClientMsg→parseCampaignMirrorAct wiring is absent');
if (!(assignedLiteral(entry, 'path', '/ws') || (literal(entry, '/ws') && call(entry, 'handleUpgrade')))) issues.push('ordinary /ws server transport is not statically confirmed');
const mirrorAct = method(room, 'actMirror')?.body;
const roomNodes = methodNodes(room, 'step');
if (!call(mirrorAct, 'takeKey') || !call(mirrorAct, 'push') || !call(method(room, 'act')?.body, 'actMirror') ||
    !roomNodes.some(n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'snapshot' &&
      ts.isPropertyAccessExpression(n.expression.expression) && n.expression.expression.name.text === 'mirrorCampaign'))
  issues.push('L7 main Room act authority or tick→mirror snapshot wiring is absent');
if (!nodes(game).some(n => ts.isIfStatement(n) && comparedLiteral(n.expression, 't', 'l7') && property(n.thenStatement, 'mirrorState')) ||
    !nodes(game).some(n => ts.isCallExpression(n) && assignedLiteral(n, 'kind', 'mirror-key')) ||
    !nodes(game).some(n => ts.isCallExpression(n) && assignedLiteral(n, 'kind', 'mirror-push')))
  issues.push('L7 Game l7 snapshot receiver or authoritative mirror actions are absent');
if (literal(entry, '/ws/l7')) warnings.push('isolated /ws/l7 exists; its preview cannot prove main campaign continuity');

const touch = await syntaxAt('client/src/touch.ts'), input = await syntaxAt('client/src/input.ts');
const onTouch = method(game, 'onWorldTouch')?.body, targetNodes = methodNodes(game, 'touchTarget');
const touchAssignment = nodes(game).some(n => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
  ts.isPropertyAccessExpression(n.left) && n.left.name.text === 'worldTouch' && call(n.right, 'onWorldTouch'));
const phases = ['start', 'tap', 'hold', 'release'].every(phase => nodes(touch).some(n => ts.isCallExpression(n) &&
  ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'worldTouch' && literal(n, phase)));
if (!touchAssignment || !phases || !nodes(input).some(n => ts.isPropertyDeclaration(n) && nameOf(n.name) === 'worldTouch') ||
    !call(method(game, 'touchTarget')?.body, 'worldTouchHit') || !call(onTouch, 'interact'))
  issues.push('direct object touch chain Input→TouchControls phases→Game hit test→interact is incomplete');
if (!targetNodes.some(n => ts.isPropertyAssignment(n) && nameOf(n.name) === 'kind' && ts.isStringLiteral(n.initializer) && n.initializer.text === 'hide'))
  issues.push('direct touch hit candidates do not include hide; mobile L4 locker tap remains unconfirmed');

interface Release { id: string; date: string; entries: string[] }
function release(value: unknown): Release | null {
  if (!value || typeof value !== 'object') return null;
  const { id, date, entries } = value as Partial<Release>;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id) || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(date);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== date || !Array.isArray(entries) || entries.length < 1 || entries.length > 6 ||
      entries.some(e => typeof e !== 'string' || !e.trim() || e.length > 240)) return null;
  return { id, date, entries: entries.map(e => e.trim()) };
}
const version = release(json(source['client/public/version.json'])), builtVersion = release(json(source['dist/version.json']));
if (!version || !builtVersion || JSON.stringify(version) !== JSON.stringify(builtVersion)) issues.push('source and built version.json must both be valid release records and match');
if (registry.length === 8 && version?.id === '0.4.0') issues.push('eight chapters still use v040 update id; old clients will not see a new release notice');
if (registry.length === 8 && !version?.entries.some(e => /(?:第\s*[八8]\s*关|[八8]\s*关)/.test(e) && /点名册|终章|校门|结局|通关/.test(e)))
  issues.push('eight-chapter release entries must explicitly describe the eighth chapter / final completion');
if (!call(main, 'installUpdateNotice') || !imported(main, 'installUpdateNotice')) issues.push('player-visible update notice installation is absent');
const voice = await syntaxAt('client/src/voice.ts');
if (nodes(voice).some(n => ts.isNewExpression(n) && nameOf(n.expression) === 'SpeechSynthesisUtterance') || call(voice, 'speak'))
  issues.push('voice contains a possible system TTS execution path; inspect against the WebAudio-only requirement');

const artifactHashes: Record<string, string> = {}, artifactBytes: Record<string, number> = {};
async function inventory(dir: string) {
  for (const ent of await readdir(resolve(root, dir), { withFileTypes: true }).catch(() => [])) {
    const file = `${dir}/${ent.name}`;
    if (ent.isDirectory()) await inventory(file);
    else if (ent.isFile()) {
      const bytes = await readFile(resolve(root, file));
      artifactHashes[file] = hash(bytes); artifactBytes[file] = bytes.length;
    }
  }
}
await inventory('dist'); await inventory('dist-server');
const clientAssets = [...source['dist/index.html'].matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map(m => m[1]).filter(p => /\.(?:js|css)(?:\?|$)/.test(p));
if (!clientAssets.some(p => /\.js(?:\?|$)/.test(p))) issues.push('dist/index.html has no JavaScript entry');
for (const asset of clientAssets) {
  const file = `dist/${asset.replace(/^\//, '').split('?')[0]}`;
  if (!artifactBytes[file]) issues.push(`built client asset is missing or empty: ${asset}`);
}
if (!artifactBytes['dist-server/index.js']) issues.push('built server dist-server/index.js is missing or empty');
warnings.push('build provenance is unverified: source/artifact hashes and equal version records do not prove these assets were built from this source; final integration must rebuild and save commit + build log');
warnings.push('syntax checks confirm known wiring shapes only; desktop/mobile same-room eight-chapter E2E and deployment remain separate required evidence');
const manifestPath = '/Users/local-user/escape/loop/state/parallel-sprint/manifest.json';
const manifest = await readFile(manifestPath, 'utf8').then(s => JSON.parse(s)).catch(() => null);
if (!manifest || !Array.isArray(manifest.tasks)) warnings.push('parallel sprint manifest absent or invalid');
const report = { checkedAt: new Date().toISOString(), head: git('rev-parse', 'HEAD'),
  dirty: git('status', '--porcelain', '--untracked-files=no'), registry, definitions, version, builtVersion, issues, warnings,
  sourceHashes: Object.fromEntries(Object.entries(source).filter(([f, s]) => s && !f.startsWith('dist/')).map(([f, s]) => [f, hash(s)])),
  clientAssets, artifactHashes, artifactBytes, buildProvenance: 'unverified',
  manifest: manifest && Array.isArray(manifest.tasks) ? { base: manifest.base, started: manifest.started, deadline: manifest.deadline,
    laneCount: manifest.tasks.length, lanes: manifest.tasks.map((t: { id: string; branch: string; tree: string }) => ({ id: t.id, branch: t.branch, tree: t.tree })) } : null,
  meaning: 'Read-only syntax/artifact readiness only. Zero issues does not prove matching source/build, E2E success, production state, or deployment.' };
const reportBase = resolve(root, 'test-results/sprint-fullflow');
const reportDir = resolve(root, process.env.ESC_FULLFLOW_RUN_DIR || reportBase);
const inside = (base: string, candidate: string) => candidate === base || candidate.startsWith(base + sep);
if (!inside(reportBase, reportDir)) throw new Error('ESC_FULLFLOW_RUN_DIR must stay inside this worktree game/test-results/sprint-fullflow');
// Reject symlink escapes before creating anything, including when the final run directory does not yet exist.
let existing = reportDir;
while (true) {
  const actual = await realpath(existing).catch(() => null);
  if (actual) {
    if (actual !== resolve(await realpath(root), relative(root, existing))) throw new Error('release audit output parent must not traverse a symlink below this game worktree');
    break;
  }
  if (existing === dirname(existing)) throw new Error('cannot resolve release audit output parent');
  existing = dirname(existing);
}
await mkdir(reportDir, { recursive: true });
const reportFile = resolve(reportDir, 'release-audit.json');
if ((await lstat(reportFile).catch(() => null))?.isSymbolicLink()) throw new Error('release audit output file must not be a symlink');
await writeFile(reportFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes('--require-eight') && issues.length) process.exitCode = 1;
