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
import * as v from 'valibot';
import { TASK_STATUSES, type TaskListStore } from '../tasks/store.js';
import type { AgentConfigStore } from '../config/store.js';
import { AGENT_STANCES, STANCE_CHOICES, TOOL_REACH } from './registry.js';
import { decodeJsonValue } from '../utils/json.js';
import { createTasksDispatcher } from './tasks-tool.js';

const TitlesSchema = v.array(v.string());
const ParentSchema = v.optional(v.string());
const TaskStatusSchema = v.picklist(TASK_STATUSES);
const StanceSchema = v.picklist(AGENT_STANCES);

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
  /** Set the stance you work in, or read it back with no argument.
   *  ${STANCE_CHOICES} */
  mode(stance?: ${AGENT_STANCES.map((stance) => `"${stance}"`).join(' | ')}): Promise<unknown>;
};
`;

/** Build the codemode provider exposing `tasks.*` over one TaskListStore and
 *  one AgentConfigStore — constructed once by the caller (the same instances
 *  the native tool uses), not per call: unlike memory/release deps, neither
 *  store rebinds. */
export function createTasksCodemodeProvider(
  taskList: TaskListStore,
  config: AgentConfigStore,
): CodemodeProvider {
  const run = createTasksDispatcher(taskList, config);
  return {
    name: TOOL_REACH.tasks.codemode,
    types: TYPES,
    positionalArgs: true,
    tools: {
      add: {
        description: 'Write down the whole plan in one call: one title per task.',
        execute: async (...args: unknown[]) => {
          const titles = v.safeParse(TitlesSchema, args[0]);
          const parent = v.safeParse(ParentSchema, args[1]);
          if (!titles.success || !parent.success) {
            return { error: 'tasks.add requires string titles and an optional string parent' };
          }
          return decodeJsonValue({
            value: run({ action: 'add', titles: titles.output, parent: parent.output }),
          });
        },
      },
      update: {
        description: 'Move one task to active/done/dropped by id.',
        execute: async (...args: unknown[]) => {
          const status = v.safeParse(TaskStatusSchema, args[1]);
          return decodeJsonValue({
            value: run({
              action: 'update',
              id: String(args[0] ?? ''),
              status: status.success ? status.output : undefined,
            }),
          });
        },
      },
      list: {
        description: 'Read the whole task list back, closed items included.',
        execute: async () => decodeJsonValue({ value: run({ action: 'list' }) }),
      },
      mode: {
        description: `Set the stance you work in, or read it back with no argument. ${STANCE_CHOICES}`,
        execute: async (...args: unknown[]) => {
          const stance = v.safeParse(StanceSchema, args[0]);
          return decodeJsonValue({
            value: run({ action: 'mode', stance: stance.success ? stance.output : undefined }),
          });
        },
      },
    },
  };
}
