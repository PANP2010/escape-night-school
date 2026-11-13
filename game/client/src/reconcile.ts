import { moveCapsule, type Body, type Capsule, type CollisionWorld } from '../../shared/campus/collision.ts';

/** One predicted frame: the (dx, dz) asked of moveCapsule over dt s, part of the input that will be sent as `seq`. */
export interface Move { seq: number; dx: number; dz: number; dt: number }

/**
 * The client's recent predicted moves, for reconciliation: when the server rejects input `ack` and sends back its
 * position (where it was before that input), every later move is replayed from there with the same moveCapsule, so a
 * correction only removes what the server refused instead of throwing away the last RTT of walking.
 */
export class MoveLog {
  private moves: Move[] = [];
  private cap: number;
  constructor(cap = 240) { this.cap = cap; }

  push(m: Move) {
    this.moves.push(m);
    if (this.moves.length > this.cap) this.moves.splice(0, this.moves.length - this.cap);
  }

  clear() { this.moves.length = 0; }

  get size() { return this.moves.length; }

  /** Drop the refused input `ack` and everything before it, run the rest from `p` (feet, grounded), return that body. */
  replay(world: CollisionWorld, p: readonly [number, number, number], ack: number, capsule: Capsule): Body {
    this.moves = this.moves.filter((m) => m.seq > ack);
    const b: Body = { x: p[0], y: p[1], z: p[2], vy: 0, grounded: true };
    for (const m of this.moves) moveCapsule(world, b, m.dx, m.dz, m.dt, capsule);
    return b;
  }
}
