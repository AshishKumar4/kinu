/** `tasks.*` in codemode: projects the native `tasks` dispatcher over the same TaskListStore. */
import { codemodeText, type CodemodeProvider } from './sandbox-contract';
import type { z } from 'zod';
import { TASK_STATUSES, type TaskListStore } from '../tasks/store';
import type { AgentConfigStore } from '../config/store';
import { TOOL_REACH } from './registry';
import type { ProfileCatalogEnvelope } from '../types/profile';
import { decodeJsonValue } from '../utils/json';
import {
  createTasksDispatcher, TaskParentSchema, TaskRoleSchema, TaskStatusSchema, TaskTitlesSchema,
} from './tasks-tool';
import { refusedInput } from '../obs/index';
import { branchableToolCall } from './outcome';

function parsed<T>(call: string, result: z.ZodSafeParseResult<T>): T {
  if (!result.success) throw refusedInput(call, result.error);

  return result.data;
}

const STATUS_UNION = TASK_STATUSES.map((s) => `"${s}"`).join(' | ');

const TYPES = `export declare const tasks: {
  /** One title per task, in order; \`parent\` files them under an existing task. */
  add(titles: string[], parent?: string): Promise<unknown>;
  update(id: string, status: ${STATUS_UNION}): Promise<unknown>;
  list(): Promise<unknown>;
  /** Switch your role from the next turn; with no argument, read it. */
  mode(role?: string): Promise<unknown>;
};
`;

/** Stores are the native tool's instances, bound once: neither rebinds. */
export function createTasksCodemodeProvider(
  taskList: TaskListStore,
  config: AgentConfigStore,
  roleAuthority?: () => ProfileCatalogEnvelope | null,
): CodemodeProvider {
  const run = createTasksDispatcher(taskList, config, roleAuthority);

  return {
    name: TOOL_REACH.tasks.codemode,
    types: TYPES,
    positionalArgs: true,
    tools: {
      add: {
        planAllowed: true,
        description: 'Write down the whole plan in one call: one title per task.',
        execute: (...args: unknown[]) => branchableToolCall(async () => {
          const titles = parsed('tasks.add(titles)', TaskTitlesSchema.safeParse(args[0]));
          const parent = parsed('tasks.add(parent)', TaskParentSchema.safeParse(args[1]));

          return decodeJsonValue({ value: run({ action: 'add', titles, parent }) });
        }),
      },
      update: {
        planAllowed: true,
        description: 'Move one task to active/done/dropped by id.',
        execute: (...args: unknown[]) => branchableToolCall(async () => {
          const status = parsed('tasks.update(id, status)', TaskStatusSchema.safeParse(args[1]));

          return decodeJsonValue({
            value: run({ action: 'update', id: codemodeText({ value: args[0], parameter: 'tasks.update(id)' }), status }),
          });
        }),
      },
      list: {
        planAllowed: true,
        description: 'Read the whole task list back, closed items included.',
        execute: () => branchableToolCall(async () => decodeJsonValue({ value: run({ action: 'list' }) })),
      },
      mode: {
        planAllowed: true,
        description: 'Switch your durable active role by id (applies from your next turn), or read the current role id with no argument.',
        execute: (...args: unknown[]) => branchableToolCall(async () => {
          const role = parsed('tasks.mode(role)', TaskRoleSchema.safeParse(args[0]));

          return decodeJsonValue({ value: run({ action: 'mode', role }) });
        }),
      },
    },
  };
}
