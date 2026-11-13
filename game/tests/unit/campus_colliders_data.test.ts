// shared/campus/colliders.json is the server's copy of the campus colliders/holes/spawns (the generators live in
// client/ and pull in three). Regenerate with: UPDATE_COLLIDERS=1 npx vitest run tests/unit/campus_colliders_data.test.ts
import { writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import data from '../../shared/campus/colliders.json';
import { campusColliders, groundlessFootprints } from '../../client/src/campus/world/campus.ts';
import { campusDoors } from '../../client/src/campus/world/doorway.ts';
import { CAMPUS } from '../../client/src/campus/world/campus.ts';
import { campusSpawns } from '../../client/src/campus/world/navgraph.ts';

test('shared/campus/colliders.json matches the client generators', () => {
  const fresh = JSON.parse(JSON.stringify({ colliders: campusColliders(), holes: groundlessFootprints(), spawns: campusSpawns(), doors: campusDoors(CAMPUS) }));
  if (process.env.UPDATE_COLLIDERS) writeFileSync(new URL('../../shared/campus/colliders.json', import.meta.url), JSON.stringify(fresh));
  else expect(data).toEqual(fresh);
});
