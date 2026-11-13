export function reconnectProxy(targetPort?: number): Promise<{
  port: number;
  blackholeExisting(): void;
  close(): Promise<void>;
}>;
