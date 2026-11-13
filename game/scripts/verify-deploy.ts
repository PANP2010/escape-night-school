// Run by loop.sh right after a green gate restarted escape.service: does :4100 actually serve the snapshot we just staged?
// escape.service rsyncs .green/ → serve/ with a `-` prefix (a failed copy keeps the old serve/), so a silent mismatch is
// possible; this turns it into a loud one. Exit 0 = same build, 1 = different build, 2 = server or snapshot unreadable.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Hashed bundle references in an index.html (`/assets/index-XXXX.js`, `.css`), leading slash dropped, sorted. */
export function assetRefs(html: string): string[] {
  const refs = new Set<string>();
  for (const m of html.matchAll(/(?:src|href)="\/?(assets\/[^"?#]+)"/g)) refs.add(m[1]);
  return [...refs].sort();
}

/** ok only when both pages reference at least one asset and exactly the same set. */
export function compareDeploy(servedHtml: string, greenHtml: string) {
  const served = assetRefs(servedHtml), green = assetRefs(greenHtml);
  const ok = green.length > 0 && served.length === green.length && served.every((r, i) => r === green[i]);
  return { ok, served, green };
}

async function fetchIndex(url: string, tries: number): Promise<string> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return await res.text();
      if (i >= tries) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (i >= tries) throw e;
    }
    await new Promise(r => setTimeout(r, 1000)); // service may still be starting after `systemctl restart`
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const url = process.env.DEPLOY_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4100}/`;
  const index = join(resolve(process.env.GREEN_DIR ?? '.green'), 'dist/index.html');
  let green: string, served: string;
  try { green = readFileSync(index, 'utf8'); } catch (e) {
    console.error(`verify-deploy: cannot read ${index}: ${(e as Error).message}`); process.exit(2);
  }
  try { served = await fetchIndex(url, 10); } catch (e) {
    console.error(`verify-deploy: ${url} unreachable: ${(e as Error).message}`); process.exit(2);
  }
  const r = compareDeploy(served, green);
  if (r.ok) console.log(`verify-deploy: ok, ${url} serves ${r.green.join(' ')}`);
  else console.error(`verify-deploy: MISMATCH ${url} serves [${r.served.join(' ')}] but ${index} has [${r.green.join(' ')}]`);
  process.exit(r.ok ? 0 : 1);
}
