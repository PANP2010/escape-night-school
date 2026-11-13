import { describe, expect, it } from 'vitest';
import { parseClientMsg } from '../../shared/protocol.ts';
import { parseCampaignMirrorAct } from '../../shared/l7-campaign.ts';
import { MIRROR_DOORS } from '../../shared/levels/l7.ts';

const parse = (message: unknown) => parseClientMsg(JSON.stringify(message));

describe('L7 campaign protocol', () => {
  it('accepts only the shared key and the two real wall interactions through ordinary act', () => {
    expect(parse({ t: 'act', kind: 'mirror-key', id: 0 })).toEqual({ t: 'act', kind: 'mirror-key', id: 0 });
    for (const { id } of MIRROR_DOORS) expect(parse({ t: 'act', kind: 'mirror-push', id })).toEqual({ t: 'act', kind: 'mirror-push', id });
    for (const id of [-1, 0, 3, 1.5, '1', null]) expect(parse({ t: 'act', kind: 'mirror-push', id })).toBeNull();
    for (const id of [-1, 1, 0.5, '0', null]) expect(parse({ t: 'act', kind: 'mirror-key', id })).toBeNull();
    expect(parse({ t: 'take-key' })).toBeNull();
    expect(parse({ t: 'push', id: 1 })).toBeNull();
  });

  it('does not promote preview transport, forged identities or snapshot state into campaign authority', () => {
    for (const message of [
      { t: 'mirror-key', id: 0 }, { t: 'push', id: 1 }, { t: 'take-key' },
      { t: 'l7', tick: 20, key: { taken: true }, revealedDoors: [1, 2], openDoors: [1, 2], mirrors: [] },
    ]) expect(parse(message)).toBeNull();
    expect(parseCampaignMirrorAct({ t: 'push', kind: 'mirror-push', id: 1 })).toBeNull();
    expect(parse({ t: 'act', kind: 'mirror-key', id: 0, player: 123, room: 'FAKE', taken: true }))
      .toEqual({ t: 'act', kind: 'mirror-key', id: 0 });
  });

  it('allows directed entry to every registered chapter and rejects invalid indices', () => {
    for (const level of [0, 1, 2, 3, 4, 5, 6, 7]) expect(parse({ t: 'debug', op: 'level', level })).toEqual({ t: 'debug', op: 'level', level });
    for (const level of [-1, 8, 6.1, '6', null, Infinity]) expect(parse({ t: 'debug', op: 'level', level })).toBeNull();
  });

  it('preserves ordinary actions, movement epochs and debug teleport shapes', () => {
    expect(parse({ t: 'act', kind: 'revive', id: 2 })).toEqual({ t: 'act', kind: 'revive', id: 2 });
    expect(parse({ t: 'debug', op: 'tp', x: -80.4, z: 143.4, floor: 1 })).toMatchObject({ op: 'tp', floor: 1 });
    expect(parse({ t: 'input', seq: 1, p: [1, 0, 2], yaw: 0.2, pitch: -0.1, f: 4, c: 2 })).toMatchObject({ t: 'input', c: 2 });
  });
});
