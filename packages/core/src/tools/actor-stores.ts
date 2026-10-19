/**
 * An actor's file, memory and task operations, served once over one set of stores: its native `file`, `memory` and
 * `tasks` tools, a program's `tools.*` (the native tools themselves) and its named `file.*`, `memory.*`, `tasks.*` and
 * `<machine>.fs.*` are projections of one served set, so every spelling runs the same operation over the same read
 * ledger. A caller's policy chooses among the projections; it never serves its own.
 */
import type { AgentConfigStore } from '../config/store';
import type { Served } from '../operations/operation';
import type { FILE } from '../operations/file';
import { serveFile, type FileDeps } from './file-operations';
import { serveMemory, type MemoryDeps } from './memory-operations';
import { serveTasks, type RoleSwitch } from './tasks-operations';
import type { TaskListStore } from './task-store';

/** What an actor's store operations run over, read per call: a turn's ledger, a rebound store. */
export interface StoreDeps {
  readonly files: () => FileDeps;
  readonly memory: () => MemoryDeps;
  /** `roleSwitch` null: its role is not its own to switch, as a hire's is its hirer's. */
  readonly tasks: () => { readonly list: TaskListStore; readonly config: AgentConfigStore; readonly roleSwitch: RoleSwitch | null };
}

export interface ServedStores {
  /** What they run over, for a projection that needs more than the operations: the native file tool's clamp. */
  readonly deps: StoreDeps;
  readonly file: Readonly<Record<keyof typeof FILE, Served>>;
  /** As a caller reaching the account's memory sees it, and as one that does not (a slate's): one store, two schemas. */
  readonly memory: { readonly account: readonly Served[]; readonly own: readonly Served[] };
  readonly tasks: readonly Served[];
}

export function serveStores(deps: StoreDeps): ServedStores {
  const tasks = deps.tasks();

  return {
    deps,
    file: serveFile(deps.files),
    memory: { account: serveMemory(deps.memory), own: serveMemory(() => ({ ...deps.memory(), account: undefined })) },
    tasks: serveTasks(tasks.list, tasks.config, tasks.roleSwitch ?? undefined),
  };
}
