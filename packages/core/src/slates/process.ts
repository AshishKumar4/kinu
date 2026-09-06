export interface SlateProcess {
  readonly id: string;
  readonly port: number;
  isRunning(): Promise<boolean>;
  stop(): Promise<void>;
}
