import type { Page } from '@playwright/test';

export interface Position { x: number; y: number; z: number }
export interface Area { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }
export function nearPosition(origin: Position, area: Area, dx: number, dz: number): Position;
export function placeNear(page: Page, dx: number, dz: number, options?: { timeout?: number }): Promise<Position & { tick: number }>;
export function assertDebugAvailable(page: Page, options?: { timeout?: number }): Promise<void>;
