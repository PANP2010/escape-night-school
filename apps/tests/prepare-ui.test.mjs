import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { releaseRecord, prepareNativeUi } from '../scripts/prepare-ui.mjs';
import { makeWebIcons } from '../scripts/make-icons.mjs';

test('native preparation keeps source release metadata and creates valid portrait icon containers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'escape-native-ui-'));
  try {
    const source = join(root, 'game'), apps = join(root, 'apps');
    await mkdir(join(source, 'client/public/cover'), { recursive: true });
    await mkdir(join(source, 'shared'), { recursive: true });
    await mkdir(join(apps, 'android/launcher'), { recursive: true });
    await writeFile(join(source, 'client/public/version.json'), JSON.stringify({ id: '1.2.3', entries: [] }));
    await writeFile(join(source, 'shared/level.ts'), 'export const LEVELS: Level[] = [\n FIRST, SECOND, THIRD,\n];');
    await sharp({ create: { width: 1100, height: 1100, channels: 3, background: '#c6a184' } })
      .webp({ lossless: true }).toFile(join(source, 'client/public/cover/face-current.webp'));
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#15251c' } })
      .webp({ lossless: true }).toFile(join(source, 'client/public/cover/blackboard-v1.webp'));
    await writeFile(join(source, 'client/public/cover/cover.css'), '.school-cover { --cover-warden: url("face-current.webp"); color: white; }');
    await writeFile(join(apps, 'android/launcher/index.html'), '<h1>逃离夜校</h1>');
    const metadata = await releaseRecord(source);
    assert.equal(metadata.id, '1.2.3');
    assert.equal(metadata.chapters, 3);
    await prepareNativeUi({ apps, source, metadata });
    await makeWebIcons({ publicRoot: join(source, 'client/public'), cover: join(source, 'client/public/cover/face-current.webp') });
    assert.deepEqual(JSON.parse(await readFile(join(apps, 'desktop/release.json'), 'utf8')), metadata);
    assert.deepEqual(JSON.parse(await readFile(join(apps, 'android/app/src/main/assets/launcher/release.json'), 'utf8')), metadata);
    assert.match(await readFile(join(apps, 'android/release.properties'), 'utf8'), /versionName=1\.2\.3\nversionCode=1020301\n/);
    const chalk = await readFile(join(apps, 'android/app/src/main/assets/launcher/chalk.css'), 'utf8');
    assert.match(chalk, /feTurbulence/);
    assert.doesNotMatch(chalk, /blackboard-v1|\.webp|\.png/);
    assert.equal(await readFile(join(apps, 'desktop/chalk.css'), 'utf8'), chalk);
    await assert.rejects(access(join(apps, 'desktop/cover')));
    await assert.rejects(access(join(apps, 'android/app/src/main/assets/launcher/cover')));
    const ico = await readFile(join(apps, 'desktop/assets/icon.ico'));
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 4);
    for (let i = 0; i < 4; i++) {
      const entry = 6 + i * 16, offset = ico.readUInt32LE(entry + 12), length = ico.readUInt32LE(entry + 8);
      assert.ok(offset + length <= ico.length);
      assert.deepEqual(ico.subarray(offset, offset + 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
    const icns = await readFile(join(apps, 'desktop/assets/icon.icns'));
    assert.equal(icns.toString('ascii', 0, 4), 'icns');
    assert.equal(icns.readUInt32BE(4), icns.length);
    for (const [file, width] of [['desktop/assets/icon.png', 1024], ['android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', 192], ['android/app/src/main/res/drawable-nodpi/ic_launcher_foreground.png', 432]]) {
      const image = sharp(join(apps, file)); const info = await image.metadata();
      assert.equal(info.width, width); assert.equal(info.height, width); assert.equal(info.hasAlpha, true);
    }
    const pixel = await sharp(join(apps, 'desktop/assets/icon.png')).extract({ left: 512, top: 512, width: 1, height: 1 }).raw().toBuffer();
    assert.deepEqual([...pixel], [198, 161, 132, 255]);
    for (const [file, width] of [['favicon-32.png', 32], ['favicon.png', 64], ['apple-touch-icon.png', 180]]) {
      const image = sharp(join(source, 'client/public', file)), info = await image.metadata();
      assert.equal(info.width, width); assert.equal(info.height, width);
      const pixel = await image.extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
      assert.deepEqual([...pixel], [198, 161, 132]);
    }
    const splash = sharp(join(apps, 'android/app/src/main/res/drawable-nodpi/splash_board.png'));
    const splashInfo = await splash.metadata();
    assert.equal(splashInfo.width, 512); assert.equal(splashInfo.height, 512);
    assert.deepEqual([...(await splash.extract({ left: 256, top: 256, width: 1, height: 1 }).removeAlpha().raw().toBuffer())], [23, 59, 47]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
