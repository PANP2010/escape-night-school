import WebSocket from 'ws';
export function delay(ms: number): Promise<void>;
export function waitFor<T>(read: () => T, label: string, timeout?: number): Promise<NonNullable<T>>;
export function near(a: number[] | undefined, b: number[] | undefined, tolerance?: number): boolean;
export class ReconnectPeer {
  constructor(url: string, name: string, options?: { autoPong?: boolean });
  name: string;
  id: number;
  token?: string;
  seq: number;
  socket: WebSocket;
  opened: Promise<void>;
  history: any[];
  latest: Map<string, any>;
  players: Map<number, any>;
  correction?: any;
  closed?: { code: number; at: number };
  fault?: string;
  mark(): number;
  last(type: string): any;
  since(mark: number, read: (message: any) => boolean): any[];
  send(message: Record<string, unknown>): void;
  after(mark: number, read: (message: any) => boolean, label: string, timeout?: number): Promise<any>;
  hello(resume?: string): Promise<any>;
  input(p: number[], c?: number, extra?: Record<string, unknown>): void;
  terminate(): Promise<void>;
}
