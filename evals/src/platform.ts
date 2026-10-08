/**
 * What the platform did to a leg's workspaces while its trials ran, read from Workers Logs by eval workspace name
 * (`evals/scripts/platform-bugs.ts`): invocations that did not end ok, failures the product logged with a code, and
 * alarms that woke an object with nothing to do. A leg the logs could not be read for says why, and is not compared.
 */
import * as v from 'valibot';

const Count = v.pipe(v.number(), v.integer(), v.minValue(0));

const WorkspaceReadSchema = v.object({
  workspace: v.string(),
  /** The Durable Objects that logged this workspace's name: the workspace and the agents it hosts. */
  objects: Count,
  /** Invocations by how they ended, `ok` aside: `exception`, `exceededCpu`, `exceededMemory`, `canceled`, … */
  ended: v.array(v.object({ outcome: v.string(), count: Count })),
  /** Rows the product logged with a failure code, by event and code. */
  failures: v.array(v.object({ event: v.string(), code: v.string(), count: Count })),
  /** Alarms with no work of their object within five minutes (`idleWakeHours`, scripts/prod-logs.ts). */
  idleWakes: Count,
});

export type WorkspaceRead = v.InferOutput<typeof WorkspaceReadSchema>;

export const PlatformReportSchema = v.variant('measured', [
  v.object({
    measured: v.literal(true), worker: v.string(), from: v.number(), to: v.number(),
    /** Above 1 the logs were sampled, and every count is an estimate. */
    sampling: v.number(),
    workspaces: v.array(WorkspaceReadSchema),
  }),
  v.object({ measured: v.literal(false), why: v.string() }),
]);

export type PlatformReport = v.InferOutput<typeof PlatformReportSchema>;

/** How an invocation ends when the platform, not the product, ended it for what it spent. */
const EXCEEDED = /^exceeded/u;

/** A workspace's read holds a platform bug: an invocation that threw or that the platform ended for what it spent,
 *  or an idle wake. A cancelled invocation is a client going away, and is reported without counting as one. */
export function platformBug(read: WorkspaceRead): boolean {
  return read.idleWakes > 0 || read.ended.some(({ outcome }) => outcome === 'exception' || EXCEEDED.test(outcome));
}

export function parsePlatformReport(text: string): PlatformReport {
  return v.parse(PlatformReportSchema, JSON.parse(text));
}

/** One task's trials as the platform logs saw them on one leg. */
export type TaskPlatform = {
  readonly trials: number;
  /** Trials whose workspace saw a platform bug (`platformBug`). */
  readonly bugTrials: number;
  readonly exceptions: number;
  /** Invocations the platform ended for the CPU or memory they spent. */
  readonly exceeded: number;
  readonly canceled: number;
  readonly idleWakes: number;
  /** The product's coded failure rows, summed over the task's workspaces, most first. */
  readonly failures: readonly { readonly event: string; readonly code: string; readonly count: number }[];
};

/** Each task's trials as `report` read them, by the workspace each trial ran in; null for a leg that was not read. */
export function platformByTask(trials: readonly { readonly task: string; readonly workspace: string | null }[], report: PlatformReport | null): Map<string, TaskPlatform> | null {
  if (report === null || !report.measured) return null;
  const reads = new Map(report.workspaces.map((read) => [read.workspace, read]));
  const tasks = new Map<string, TaskPlatform>();

  for (const { task, workspace } of trials) {
    const read = workspace === null ? undefined : reads.get(workspace);
    const held = tasks.get(task) ?? { trials: 0, bugTrials: 0, exceptions: 0, exceeded: 0, canceled: 0, idleWakes: 0, failures: [] };
    const ended = (match: (outcome: string) => boolean) => (read?.ended ?? []).filter(({ outcome }) => match(outcome)).reduce((sum, row) => sum + row.count, 0);
    const failures = new Map(held.failures.map((row) => [`${row.event}\u0000${row.code}`, row]));

    for (const row of read?.failures ?? []) {
      const key = `${row.event}\u0000${row.code}`;

      failures.set(key, { ...row, count: (failures.get(key)?.count ?? 0) + row.count });
    }

    tasks.set(task, {
      trials: held.trials + 1,
      bugTrials: held.bugTrials + (read !== undefined && platformBug(read) ? 1 : 0),
      exceptions: held.exceptions + ended((outcome) => outcome === 'exception'),
      exceeded: held.exceeded + ended((outcome) => EXCEEDED.test(outcome)),
      canceled: held.canceled + ended((outcome) => outcome === 'canceled'),
      idleWakes: held.idleWakes + (read?.idleWakes ?? 0),
      failures: [...failures.values()].sort((left, right) => right.count - left.count),
    });
  }

  return tasks;
}
