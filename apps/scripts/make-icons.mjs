import sharp from 'sharp';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mask = (size, radius) => Buffer.from(`<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="white"/></svg>`);

export async function sourcePortrait(source) {
  const cover = join(source, 'client/public/cover');
  const css = await readFile(join(cover, 'cover.css'), 'utf8');
  const asset = css.match(/--cover-warden\s*:\s*url\(\s*["']?([^"')\s]+)["']?\s*\)/)?.[1];
  if (!asset) throw new Error('Shared cover must declare its portrait in --cover-warden.');
  return resolve(cover, asset);
}

async function portraitIcon(cover) {
  const info = await sharp(cover).metadata();
  if (!info.width || !info.height) throw new Error('Portrait dimensions are missing.');
  // Keep the warm portrait's original colors. The crop includes the complete head and glasses.
  const side = Math.floor(Math.min(info.width, info.height) * .70);
  const left = Math.floor((info.width - side) / 2);
  const top = Math.floor(info.height * .025);
  return sharp(cover).extract({ left, top, width: side, height: side }).resize(1024, 1024).png().toBuffer();
}

export async function makeWebIcons({ publicRoot, cover }) {
  const portrait = await portraitIcon(cover);
  await mkdir(publicRoot, { recursive: true });
  for (const [name, size] of [['favicon-32.png', 32], ['favicon.png', 64], ['apple-touch-icon.png', 180]]) {
    await sharp(portrait).resize(size).png().toFile(join(publicRoot, name));
  }
}

export async function makeIcons({ apps, cover, blackboard }) {
  const portrait = await portraitIcon(cover);
  const rounded = await sharp(portrait).composite([{ input: mask(1024, 206), blend: 'dest-in' }]).png().toBuffer();
  const desktop = join(apps, 'desktop/assets');
  await mkdir(desktop, { recursive: true });
  await writeFile(join(desktop, 'icon.png'), rounded);

  const parts = [];
  for (const [type, size] of [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]]) {
    const png = await sharp(rounded).resize(size).png().toBuffer();
    const chunk = Buffer.alloc(8); chunk.write(type); chunk.writeUInt32BE(png.length + 8, 4); parts.push(chunk, png);
  }
  const header = Buffer.alloc(8); header.write('icns'); header.writeUInt32BE(8 + parts.reduce((sum, part) => sum + part.length, 0), 4);
  await writeFile(join(desktop, 'icon.icns'), Buffer.concat([header, ...parts]));

  const sizes = [16, 32, 48, 256], pngs = [];
  for (const size of sizes) pngs.push(await sharp(rounded).resize(size).png().toBuffer());
  const ico = Buffer.alloc(6 + 16 * sizes.length); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(sizes.length, 4);
  let offset = ico.length;
  for (let i = 0; i < sizes.length; i++) {
    const p = 6 + 16 * i; ico[p] = ico[p + 1] = sizes[i] % 256;
    ico.writeUInt16LE(1, p + 4); ico.writeUInt16LE(32, p + 6);
    ico.writeUInt32LE(pngs[i].length, p + 8); ico.writeUInt32LE(offset, p + 12); offset += pngs[i].length;
  }
  await writeFile(join(desktop, 'icon.ico'), Buffer.concat([ico, ...pngs]));

  const res = join(apps, 'android/app/src/main/res');
  for (const [density, size] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]) {
    const dir = join(res, `mipmap-${density}`); await mkdir(dir, { recursive: true });
    await sharp(rounded).resize(size).png().toFile(join(dir, 'ic_launcher.png'));
    await sharp(portrait).resize(size).composite([{ input: mask(size, size / 2), blend: 'dest-in' }]).png().toFile(join(dir, 'ic_launcher_round.png'));
  }
  const drawable = join(res, 'drawable-nodpi'); await mkdir(drawable, { recursive: true });
  const insetPortrait = await sharp(portrait).resize(320).composite([{ input: mask(320, 72), blend: 'dest-in' }]).png().toBuffer();
  await sharp({ create: { width: 432, height: 432, channels: 4, background: '#00000000' } })
    .composite([{ input: insetPortrait, left: 56, top: 56 }]).png().toFile(join(drawable, 'ic_launcher_foreground.png'));
  // The native splash uses the same code-drawn green board, without a photographic texture.
  await sharp(Buffer.from('<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg"><rect width="512" height="512" fill="#173b2f"/><rect x="8" y="8" width="496" height="496" fill="none" stroke="#8b7650" stroke-width="12"/></svg>')).png().toFile(join(drawable, 'splash_board.png'));
  await rm(join(drawable, 'splash_face.png'), { force: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const apps = fileURLToPath(new URL('..', import.meta.url));
  const index = process.argv.indexOf('--portrait');
  const gameIndex = process.argv.indexOf('--game');
  const source = resolve(gameIndex >= 0 ? process.argv[gameIndex + 1] : join(apps, '../game'));
  const cover = index >= 0 ? resolve(process.argv[index + 1]) : await sourcePortrait(source);
  const blackboard = join(source, 'client/public/cover/blackboard-v1.webp');
  await makeIcons({ apps, cover, blackboard });
  if (process.argv.includes('--web')) await makeWebIcons({ publicRoot: join(source, 'client/public'), cover });
  console.log('Portrait app icons and blackboard splash prepared; --web also updates browser icons.');
}
