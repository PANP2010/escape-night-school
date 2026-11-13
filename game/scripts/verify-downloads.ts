import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Checks the existing native artifacts without rebuilding or rewriting their release records. */
const directory = resolve(process.argv[2] ?? process.env.DOWNLOADS_DIR ?? '../releases/0.5.0');
const manifest = JSON.parse(await readFile(join(directory, 'release-manifest.json'), 'utf8'));
if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) throw new Error('缺少安装包清单');
const artifacts = [];
for (const artifact of manifest.artifacts) {
  if (typeof artifact.artifact !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(artifact.artifact) || artifact.artifact.includes('..')) throw new Error('清单文件名无效');
  const path = join(directory, artifact.artifact), info = await stat(path), digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  const sha256 = digest.digest('hex');
  if (info.size !== artifact.bytes || sha256 !== artifact.sha256) throw new Error(`完整性校验失败：${artifact.artifact}`);
  artifacts.push({ ...artifact, verified: true });
}
const report = { version: manifest.version, verifiedAtUtc: new Date().toISOString(), sourceManifest: 'release-manifest.json',
  integrationState: manifest.integrationState, allArtifactHashesVerified: true, artifactCount: artifacts.length, artifacts };
const outputIndex = process.argv.indexOf('--output');
if (outputIndex >= 0) {
  if (!process.argv[outputIndex + 1]) throw new Error('--output 需要文件路径');
  await writeFile(resolve(process.argv[outputIndex + 1]), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
