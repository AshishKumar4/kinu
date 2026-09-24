/** `tasks.*` in codemode: projects the native `tasks` dispatcher over the same TaskListStore. */
import { codemodeText, type CodemodeProvider } from './sandbox-contract';
import * as v from 'valibot';
import { TASK_STATUSES, type TaskListStore } from '../tasks/store';
import type { AgentConfigStore } from '../config/store';
import { TOOL_REACH } from './registry';
import type { ProfileCatalogEnvelope } from '../types/profile';
import { decodeJsonValue } from '../utils/json';
import { createTasksDispatcher } from './tasks-tool';
import { branchableToolCall } from './outcome';
import { KinuError } from '../obs';

const TitlesSchema = v.array(v.string());

const ParentSchema = v.optional(v.string());

const TaskStatusSchema = v.picklist(TASK_STATUSES);

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
          const titles = v.safeParse(TitlesSchema, args[0]);
          const parent = v.safeParse(ParentSchema, args[1]);

          if (!titles.success || !parent.success) {
            throw new KinuError('bad_input', 'tasks.add requires string titles and an optional string parent');
          }

          return decodeJsonValue({
            value: run({ action: 'add', titles: titles.output, parent: parent.output }),
          });
        }),
      },
      update: {
        planAllowed: true,
        description: 'Move one task to active/done/dropped by id.',
        execute: (...args: unknown[]) => branchableToolCall(async () => {
          const status = args[1] === undefined ? undefined : v.safeParse(TaskStatusSchema, args[1]);

          if (status !== undefined && !status.success) {
            throw new KinuError('bad_input', `tasks.update(id, status) takes status as one of ${TASK_STATUSES.join(', ')}`);
          }

          return decodeJsonValue({
            value: run({
              action: 'update',
              id: codemodeText({ value: args[0], parameter: 'tasks.update(id)' }),
              status: status?.output,
            }),
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
          const parsedRole = v.safeParse(v.string(), args[0]);
          const role = parsedRole.success ? parsedRole.output : undefined;

          return decodeJsonValue({
            value: run({ action: 'mode', role }),
          });
        }),
      },
    },
  };
}
