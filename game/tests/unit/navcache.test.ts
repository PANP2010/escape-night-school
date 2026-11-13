import { expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { campusNavCached } from '../../client/src/campus/world/navcache.ts';

test('campusNavCached: second load matches the first and is fast', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'nav-')), 'nav.json');
  const a = campusNavCached(f);
  const t = Date.now(), b = campusNavCached(f);
  expect(Date.now() - t).toBeLessThan(3000);
  expect(b.graph.nodes).toEqual(a.graph.nodes);
  expect(b.graph.adj).toEqual(a.graph.adj);
  expect(b.failures).toEqual(a.failures);
}, 120000);
