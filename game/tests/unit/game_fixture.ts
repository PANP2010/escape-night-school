import { vi } from 'vitest';
import { ObjectiveTiming } from '../../client/src/objectiveTiming.ts';
import { TeamActivity } from '../../client/src/teamActivity.ts';

/** Inactive owned collaborators for tests that intentionally bypass Game's WebGL constructor. */
export const inactiveGameCollaborators = () => ({
  worldReady: true,
  items: [], bag: {},
  objectiveTiming: new ObjectiveTiming(), objectivePauses: new Set<'intro' | 'capture'>(),
  teamActivity: new TeamActivity(),
  interactionHighlight: { setGroup: vi.fn(), update: vi.fn(), dispose: vi.fn() },
  refreshLevelHighlights: vi.fn(),
  intro: { id: 0, active: false, reset: vi.fn(), receive: vi.fn(), dispose: vi.fn() },
  tut: { start: vi.fn(), stop: vi.fn() },
  story: { isOpen: false, enter: vi.fn(), setAvailable: vi.fn(), setVisible: vi.fn(), destroy: vi.fn(),
    readCandidate: vi.fn(() => false) },
  reviveHold: { sync: vi.fn(), stop: vi.fn(), dispose: vi.fn() },
  monitorMurmurs: { reset: vi.fn(), pause: vi.fn(), dispose: vi.fn() },
  bossView: { receive: vi.fn(), dispose: vi.fn() },
  settings: { dispose: vi.fn() }, atmosphere: { dispose: vi.fn() },
  mirrorDoorBoxes: new Map(), campusVisibility: new Map(),
  doorPreview: new Map(),
  campus: { world: {}, setLandmarks: vi.fn() }, pos: { x: 0, z: 0 },
});
