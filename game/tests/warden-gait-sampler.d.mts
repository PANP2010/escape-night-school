import type { Object3D, Bone, AnimationAction } from 'three';

type Gaits = Record<'walk' | 'chase' | 'sprint', { duty: number; stride: number }>;
type Sole = { y: number; z: number; a: number; b: number };
type Rig = { root: Object3D; mesh: Object3D; bones: { footL: Bone; footR: Bone };
  anim: { planted(i: number): boolean; actions: Record<'walk' | 'chase' | 'sprint', AnimationAction> } };
type Distribution = { samples: number; medianMps: number | null; p90Mps: number | null; maxMps: number | null };
export type GaitSegmentReport = { frames: number; airborneFrames: number; unplantedFootSamples: number; phaseFlightFootSamples: number;
  supportBoundaryExcluded: number; segmentBoundaryExcluded: number; oneSidedSamples: number; maxFootStepM: number; gaitDutyMin: number | null;
  gaitDutyMax: number | null; worldScale: number[]; full: Distribution; interior: Distribution; edges: Distribution };
export function createGaitSampler(gait: Gaits, sole: Sole): {
  add(warden: Rig, sample: { time: number; segment: string; ground?: [number, number] }): void;
  report(): Record<string, GaitSegmentReport>;
};
