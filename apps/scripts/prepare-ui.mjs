import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIcons, sourcePortrait } from './make-icons.mjs';

export async function releaseRecord(source) {
  const release = JSON.parse(await readFile(join(source, 'client/public/version.json'), 'utf8'));
  const level = await readFile(join(source, 'shared/level.ts'), 'utf8');
  const registry = level.match(/export const LEVELS[^=]*=\s*\[([^\]]+)\]/);
  if (!registry) throw new Error('Cannot verify chapter registry.');
  return { ...release, chapters: registry[1].split(',').map(x => x.trim()).filter(Boolean).length };
}

export async function prepareNativeUi({ apps, source, metadata, portrait }) {
  const cover = join(source, 'client/public/cover');
  await rm(join(apps, 'desktop/cover'), { recursive: true, force: true });
  await mkdir(join(apps, 'desktop'), { recursive: true });
  const chalk = fileURLToPath(new URL('../shared/chalk.css', import.meta.url));
  await cp(chalk, join(apps, 'desktop/chalk.css'));
  const launcher = join(apps, 'android/app/src/main/assets/launcher');
  await rm(launcher, { recursive: true, force: true });
  await cp(join(apps, 'android/launcher'), launcher, { recursive: true });
  await cp(chalk, join(launcher, 'chalk.css'));
  await writeFile(join(launcher, 'release.json'), JSON.stringify(metadata, null, 2) + '\n');
  await writeFile(join(apps, 'desktop/release.json'), JSON.stringify(metadata, null, 2) + '\n');
  const version = /^(\d+)\.(\d+)\.(\d+)/.exec(metadata.id);
  if (!version) throw new Error('Release id must be a semantic version.');
  const code = Number(version[1]) * 1000000 + Number(version[2]) * 10000 + Number(version[3]) * 100 + 1;
  await writeFile(join(apps, 'android/release.properties'), `versionName=${metadata.id}\nversionCode=${code}\n`);
  await makeIcons({ apps, cover: portrait || await sourcePortrait(source), blackboard: join(cover, 'blackboard-v1.webp') });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const apps = fileURLToPath(new URL('..', import.meta.url));
  const index = process.argv.indexOf('--game');
  const source = resolve(index >= 0 ? process.argv[index + 1] : join(apps, '../game'));
  const metadata = await releaseRecord(source);
  const portraitIndex = process.argv.indexOf('--portrait');
  const portrait = portraitIndex >= 0 ? resolve(process.argv[portraitIndex + 1]) : undefined;
  await mkdir(join(apps, 'stage'), { recursive: true });
  await prepareNativeUi({ apps, source, metadata, portrait });
  console.log(JSON.stringify({ id: metadata.id, chapters: metadata.chapters }));
}
