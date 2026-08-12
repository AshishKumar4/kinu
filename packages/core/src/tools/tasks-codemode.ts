/**
 * `tasks.*` — the agent's own task list, projected into the codemode
 * sandbox.
 *
 * A PROJECTION: every member calls the SAME `createTasksDispatcher` output
 * the native `tasks` tool is built from (tools/tasks-tool.ts), over the
 * SAME TaskListStore instance — a script and a direct tool call see and
 * mutate the identical list, never a shadow copy.
 */
import type { CodemodeProvider } from '../rlm.js';
import type { TaskListStore } from '../tasks/store.js';
import { createTasksDispatcher } from './tasks-tool.js';

const TYPES = `export declare const tasks: {
  /** Write down the whole plan in one call — one title per task, in the
   *  order you plan to do them. Pass parent to file them under a task you
   *  already wrote. */
  add(titles: string[], parent?: string): Promise<unknown>;
  /** Move one item to active as you start it, done as you finish it, or
   *  dropped when it turns out not to be needed. */
  update(id: string, status: "open" | "active" | "done" | "dropped"): Promise<unknown>;
  /** Read the whole list back, closed items included. */
  list(): Promise<unknown>;
};
`;

/** Build the codemode provider exposing `tasks.*` over one TaskListStore —
 *  constructed once by the caller (same instance the native tool uses),
 *  not per call: unlike memory/release deps, the store never rebinds. */
export function createTasksCodemodeProvider(taskList: TaskListStore): CodemodeProvider {
  const run = createTasksDispatcher(taskList);
  return {
    name: 'tasks',
    types: TYPES,
    positionalArgs: true,
    tools: {
      add: {
        description: 'Write down the whole plan in one call: one title per task.',
        execute: async (...args: unknown[]) => {
          const titles = Array.isArray(args[0]) ? args[0].map(String) : [];
          const parent = typeof args[1] === 'string' ? args[1] : undefined;
          return run({ action: 'add', titles, parent });
        },
      },
      update: {
        description: 'Move one task to active/done/dropped by id.',
        execute: async (...args: unknown[]) => run({
          action: 'update', id: String(args[0] ?? ''),
          status: args[1] as 'open' | 'active' | 'done' | 'dropped',
        }),
      },
      list: {
        description: 'Read the whole task list back, closed items included.',
        execute: async () => run({ action: 'list' }),
      },
    },
  };
}
