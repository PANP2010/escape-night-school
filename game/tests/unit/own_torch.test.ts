import { describe, expect, it } from 'vitest';
import { FLASH_ANGLE, FLASH_LIGHT, FLASH_PENUMBRA, FLASH_POS } from '../../client/src/teamlight.ts';
import { TORCH_DECAY } from '../../client/src/campus/render/interior_light.ts';

// The player's own 手电 (game.ts flashlight, decay 2). Brightness itself is measured by shot-torch-own.mjs (审查 #205);
// these guard the config against sliding back to the 4 cd one nobody could see by, and the interior shader gate.
describe('own torch', () => {
  it('stays at least as strong and wide as the #209 tuning', () => {
    expect(FLASH_LIGHT).toBeGreaterThanOrEqual(10);
    expect(FLASH_ANGLE).toBeGreaterThanOrEqual(0.7);
    expect(FLASH_PENUMBRA).toBeGreaterThanOrEqual(0.6); // soft rim, not a hard disc
    expect(FLASH_ANGLE).toBeLessThan(Math.PI / 2);
  });
  it('still passes the interior lighting gate (eye-near source or torch decay)', () => {
    expect(Math.hypot(...FLASH_POS)).toBeLessThan(1);
    expect(2).toBeGreaterThanOrEqual(TORCH_DECAY); // game.ts constructs it with decay 2
  });
  it('sits behind the eye so arm\'s-length walls do not blow out', () => {
    expect(FLASH_POS[2]).toBeGreaterThan(0);
  });
});
