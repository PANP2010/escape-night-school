// Build-time compression keeps CPU work and compressed buffers out of the game server.
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

const gzipAsync = promisify(gzip), brotliAsync = promisify(brotliCompress);
const TEXT = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.xml']);

/** Process one file at a time: no runtime cache, and build memory stays bounded by the largest asset. */
export async function precompress(root: string): Promise<{ file: string; bytes: number; gzip: number; br: number }[]> {
  const report: { file: string; bytes: number; gzip: number; br: number }[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) { await visit(file); continue; }
      if (!entry.isFile() || !TEXT.has(extname(file))) continue;
      const input = await readFile(file);
      const sizes = { gzip: input.length, br: input.length };
      for (const encoding of ['gzip', 'br'] as const) {
        const target = `${file}.${encoding === 'gzip' ? 'gz' : 'br'}`;
        const output = input.length < 512 ? undefined : encoding === 'gzip'
          ? await gzipAsync(input, { level: 9 })
          : await brotliAsync(input, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } });
        if (output && output.length < input.length) {
          await writeFile(target, output);
          sizes[encoding] = output.length;
        } else await rm(target, { force: true });
      }
      report.push({ file, bytes: input.length, ...sizes });
    }
  }
  await visit(root);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const start = performance.now();
  for (const row of await precompress(resolve(process.argv[2] ?? 'dist'))) {
    console.log(`precompress: ${row.file}: ${row.bytes} B → gzip ${row.gzip} B, br ${row.br} B`);
  }
  console.log(`precompress: ${Math.round(performance.now() - start)} ms; no runtime compression`);
}
