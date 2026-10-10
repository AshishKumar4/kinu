import type { BackgroundJobStore } from './store';

/** A recorded serving fact, as a read decides whether it answers for it. */
export type ServingScope = (fact: { readonly job: string; readonly port: number }) => boolean;

export interface PortHolders {
  exposedPorts(): Promise<readonly number[]>;
  holders(ports: readonly number[]): Promise<readonly { readonly port: number; readonly stamp: string | null }[] | null>;
  /** Which recorded serving facts this read answers for; null: all. A running job's fact outside it is kept. */
  answersFor(): Promise<ServingScope | null>;
}

export async function recordServingJobs(store: BackgroundJobStore, runtime: PortHolders): Promise<void> {
  const ports = await runtime.exposedPorts();
  const held = ports.length === 0 ? [] : await runtime.holders(ports);

  if (held === null) return;
  store.recordServingInWorkspace(new Map(held.flatMap((holder) => (holder.stamp === null ? [] : [[holder.stamp, holder.port] as const]))), await runtime.answersFor());
}
