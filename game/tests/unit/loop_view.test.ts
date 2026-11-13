import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Game } from '../../client/src/game.ts';
import { buildLoopView } from '../../client/src/loopView.ts';
import { EYE_H } from '../../shared/constants.ts';
import { L3 } from '../../shared/levels/l3.ts';

describe('L3 opening clue framing', () => {
  it('shows the complete blackboard before movement from every spawn on desktop and landscape phone', () => {
    const context = { fillRect() {}, strokeRect() {}, fillText() {} };
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => context }) });
    const view = buildLoopView(L3);
    try {
      const clue = L3.loop!.clue;
      const board = view.root.children.find((o) => o.position.x === clue.x && o.position.z === clue.z) as THREE.Mesh<THREE.PlaneGeometry>;
      expect(board).toBeDefined();
      view.root.updateMatrixWorld(true);
      const vertices = board.geometry.getAttribute('position');
      const game = Object.assign(Object.create(Game.prototype), { body: {}, input: {}, level: { def: L3 } }) as Game;
      for (const aspect of [4 / 3, 16 / 9, 844 / 390]) {
        const camera = new THREE.PerspectiveCamera(75, aspect, 0.05, 400);
        camera.rotation.order = 'YXZ';
        for (const [slot, spawn] of L3.spawns.entries()) {
          (game as any).spawnCampus([spawn.x, spawn.y, spawn.z]);
          camera.position.set(spawn.x, spawn.y! + EYE_H, spawn.z);
          camera.rotation.set(game.input.pitch, game.input.yaw, 0);
          camera.updateMatrixWorld(true);
          for (let i = 0; i < vertices.count; i++) {
            const corner = new THREE.Vector3().fromBufferAttribute(vertices, i).applyMatrix4(board.matrixWorld).project(camera);
            const label = `spawn ${slot + 1}, aspect ${aspect}, corner ${i}`;
            expect(Math.abs(corner.x), label).toBeLessThan(1);
            expect(Math.abs(corner.y), label).toBeLessThan(1);
            expect(corner.z, label).toBeGreaterThan(-1);
            expect(corner.z, label).toBeLessThan(1);
          }
        }
      }
    } finally {
      view.dispose();
      vi.unstubAllGlobals();
    }
  });
});
