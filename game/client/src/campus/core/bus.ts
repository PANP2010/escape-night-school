import type { FlagValue, Relation } from './state.ts';

/** Every event the game can emit. Payloads must be plain data (no class instances). */
export interface GameEvents {
  'flag:changed': { key: string; value: FlagValue | undefined; prev: FlagValue | undefined };
  'relation:changed': { who: Relation; value: number; prev: number };
  'dissociation:changed': { value: number; prev: number };
  'time:changed': { day: number; minute: number };
  'position:changed': { scene: string; x: number; y: number; z: number };
  'state:loaded': Record<string, never>;
}

type Handler<T> = (payload: T) => void;

/** Typed synchronous pub/sub. Handlers run in subscription order. */
export class Bus<E extends object = GameEvents> {
  private handlers = new Map<keyof E, Set<Handler<any>>>();

  /** Subscribe; returns an unsubscribe function. */
  on<K extends keyof E>(type: K, fn: Handler<E[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => this.off(type, fn);
  }

  once<K extends keyof E>(type: K, fn: Handler<E[K]>): () => void {
    const off = this.on(type, p => { off(); fn(p); });
    return off;
  }

  off<K extends keyof E>(type: K, fn: Handler<E[K]>): void {
    const set = this.handlers.get(type);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) this.handlers.delete(type);
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    // Snapshot so handlers may (un)subscribe during dispatch without affecting this emit.
    for (const fn of [...set]) fn(payload);
  }

  count<K extends keyof E>(type: K): number { return this.handlers.get(type)?.size ?? 0; }

  clear(): void { this.handlers.clear(); }
}
