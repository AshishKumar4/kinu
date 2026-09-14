export interface SlateProcess {
  readonly id: string;
  /** The port a durable application listens on; null for a private process reached by RPC alone. */
  readonly port: number | null;
  isRunning(): Promise<boolean>;
  stop(): Promise<void>;
}
