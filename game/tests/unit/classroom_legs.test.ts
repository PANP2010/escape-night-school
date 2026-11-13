import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CAMPUS } from '../../client/src/campus/world/campus.ts';
import { classroomFacing, classroomFurniture, DESK, furnitureGeometry, roomFrame, seatGrid } from '../../client/src/campus/world/classroom.ts';
import { storeyRooms } from '../../client/src/campus/world/rooms.ts';

const building = CAMPUS.buildings.find(b => b.id === 'A')!;
const rooms = storeyRooms(building, 1).filter(r => r.kind === 'classroom');

describe('classroom desk and chair frames from below', () => {
  it.each(rooms.map(r => [r.id, r] as const))('%s has four square legs per desk/chair, never a full-depth sheet', (_, room) => {
    const { pairs, rows } = seatGrid(building, room);
    const steel = classroomFurniture(building, room, 0).render.filter(q => q.kind === 'steel');
    const legs = steel.filter(q => q.y0 === 0);
    expect(legs).toHaveLength(pairs.length * rows.length * 2 * 8);
    for (const leg of legs) {
      expect(leg.x1 - leg.x0).toBeCloseTo(DESK.tube);
      expect(leg.z1 - leg.z0).toBeCloseTo(DESK.tube);
      expect(leg.skip).not.toContain('+x'); expect(leg.skip).not.toContain('-x');
      expect(leg.skip).not.toContain('+z'); expect(leg.skip).not.toContain('-z');
      expect(leg.y1).toBeGreaterThan(.35);
    }
  });

  it('builds side faces with real 30 mm thickness and hits all four sides with ordinary front-face raycasting', () => {
    const leg = classroomFurniture(building, rooms[0], 0).render.find(q => q.kind === 'steel' && q.y0 === 0)!;
    const geometry = furnitureGeometry(building, [leg]);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.FrontSide }));
    mesh.updateMatrixWorld(); geometry.computeBoundingBox();
    const bounds = geometry.boundingBox!, centre = bounds.getCenter(new THREE.Vector3());
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(.03, 4);
    expect(bounds.max.z - bounds.min.z).toBeCloseTo(.03, 4);
    const normals = geometry.getAttribute('normal'), sides = new Set<string>();
    for (let i = 0; i < normals.count; i++) sides.add(`${normals.getX(i)},${normals.getY(i)},${normals.getZ(i)}`);
    expect([...sides].sort()).toEqual(['-1,0,0', '0,0,-1', '0,0,1', '1,0,0']);
    for (const direction of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)]) {
      const origin = centre.clone().addScaledVector(direction, .3);
      const hits = new THREE.Raycaster(origin, direction.clone().negate(), 0, .4).intersectObject(mesh);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].distance).toBeCloseTo(.285, 4);
      expect(hits[0].face!.normal.dot(direction)).toBeCloseTo(1);
    }
    geometry.dispose(); (mesh.material as THREE.Material).dispose();
  });

  it.each(rooms.map(r => [r.id, r] as const))('%s retains the original combined desk/chair collision boxes at every storey', (_, room) => {
    const { pairs, rows } = seatGrid(building, room), frame = roomFrame(room, classroomFacing(building, room));
    for (const y of [0, 3.6, 7.2, 10.8]) {
      const solids = classroomFurniture(building, room, y).solid;
      const deskSolids = pairs.flatMap(v => rows.map(a => frame.box(a - DESK.behind - DESK.cd / 2,
        a + DESK.d / 2, v - DESK.w, v + DESK.w, y, y + DESK.back)));
      expect(solids.slice(0, deskSolids.length)).toEqual(deskSolids);
    }
  });
});
