import type { BackgroundJobStore } from './store';

export interface PortHolders {
  exposedPorts(): Promise<readonly number[]>;
  holders(ports: readonly number[]): Promise<readonly { readonly port: number; readonly stamp: string | null }[] | null>;
  /** The running jobs whose serving this read answers for; null: every job. A job outside it keeps its record. */
  answersFor(): Promise<ReadonlySet<string> | null>;
}

export async function recordServingJobs(store: BackgroundJobStore, runtime: PortHolders): Promise<void> {
  const ports = await runtime.exposedPorts();
  const held = ports.length === 0 ? [] : await runtime.holders(ports);

  if (held === null) return;
  store.recordServingInWorkspace(new Map(held.flatMap((holder) => (holder.stamp === null ? [] : [[holder.stamp, holder.port] as const]))), await runtime.answersFor());
}
