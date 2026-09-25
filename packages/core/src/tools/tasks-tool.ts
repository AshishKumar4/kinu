/**
 * `tasks` tool dispatch: add / update / list over one TaskListStore, plus `mode`, the active role.
 * A role switch (profiles/role-change.ts) lands on the next turn; the running step keeps its profile.
 */
import {
  TaskListStore,
  TASK_STATUSES,
  type TaskAddRejection,
  type TaskStatus,
} from './task-store';
import type { AgentConfigStore } from '../config/store';
import { z } from 'zod';
import { oneOf } from './tool-schema';
import { TASKS_TOOL_ACTIONS } from './registry';
import { isValidRoleId, type RoleId } from '../types/profile';
import { KinuError } from '../obs/index';

/** Fields `tasks.*` in eval takes positionally. */
export const TaskTitlesSchema = z.array(z.string()).describe('For add: one title per task, in order.').optional();

export const TaskParentSchema = z.string().describe('For add: the task id these are subtasks of; one level only.').optional();

export const TaskStatusSchema = oneOf(TASK_STATUSES).describe('For update.').optional();

export const TaskRoleSchema = z.string()
  .describe('For mode: the role id to switch to from your next turn; omit it to read the active role.').optional();

/** Input of the native tool and of `tasks.*` in eval. */
export const TasksToolInputSchema = z.object({
  action: oneOf(TASKS_TOOL_ACTIONS).describe('add, update or list tasks; mode reads or switches your role.'),
  titles: TaskTitlesSchema,
  parent: TaskParentSchema,
  id: z.string().describe('For update: the task id, such as "t3".').optional(),
  status: TaskStatusSchema,
  note: z.string().nullable()
    .describe('For update: a one-line note beside the item; null clears it. Update needs `status` or `note`.').optional(),
  role: TaskRoleSchema,
});

export type TasksToolInput = z.infer<typeof TasksToolInputSchema>;

interface AddedTask {
  id: string;
  title: string;
  parent: string | null;
}

interface TasksAdded {
  added: AddedTask[];
  rejected?: TaskAddRejection[];
}

interface TaskUpdated {
  id: string;
  title: string;
  status: TaskStatus;
  open_subtasks?: number;
}

interface ListedTask {
  id: string;
  title: string;
  status: TaskStatus;
  /** The operator's annotation, when the item has one. */
  note?: string;
  subtasks?: ListedTask[];
}

interface TasksListed {
  tasks: ListedTask[];
  not_shown?: number;
}

interface RoleSet {
  role: string;
}

export type TasksToolResult = TasksAdded | TaskUpdated | TasksListed | RoleSet;

/** `tasks.add` — one title row per task, rejections carried alongside. */
function addTasks(taskList: TaskListStore, args: TasksToolInput, now: number): TasksAdded {
  const titles = args.titles ?? [];

  if (titles.length === 0) throw new KinuError('bad_input', 'tasks.add requires `titles` — one or more task titles');
  const { added, rejected } = taskList.add(titles, args.parent ?? null, now);

  const result: TasksAdded = {
    added: added.map((task) => ({ id: task.id, title: task.title, parent: task.parentId })),
  };

  if (rejected.length > 0) result.rejected = rejected;

  return result;
}

/** `tasks.update` — a status move, a note write, or both on one task. `note` is three-valued: absent leaves it,
 *  `null` clears it, a string sets it. */
function updateTask(taskList: TaskListStore, args: TasksToolInput, now: number): TaskUpdated {
  if (!args.id) throw new KinuError('bad_input', 'tasks.update requires `id`');

  if (args.status === undefined && args.note === undefined) {
    throw new KinuError('bad_input', 'tasks.update requires `status` or `note`');
  }

  const task = taskList.update(args.id, { status: args.status, note: args.note }, now);

  if (!task) throw new KinuError('missing', 'no task ' + args.id);
  // Warn about still-open children when closing a parent.
  const openSubtasks = args.status === 'done' ? taskList.countOpenSubtasks(task.id) : 0;
  const result: TaskUpdated = { id: task.id, title: task.title, status: task.status };

  if (openSubtasks > 0) result.open_subtasks = openSubtasks;

  return result;
}

export type RoleSwitchOutcome =
  | { readonly kind: 'applied' }
  | { readonly kind: 'no-authority' }
  | { readonly kind: 'denied'; readonly text: string }
  | { readonly kind: 'unknown-role'; readonly text: string; readonly known: readonly string[] };

/** Bound by the harness (`agentRoleSwitch`). */
export type RoleSwitch = (input: { config: AgentConfigStore; to: RoleId }) => RoleSwitchOutcome;

/** Build a tasks dispatcher. Stores are injected: codemode must share the caller's exact
 *  TaskListStore. Without `roleSwitch`, role switching refuses. */
export function createTasksDispatcher(
  taskList: TaskListStore,
  config: AgentConfigStore,
  roleSwitch?: RoleSwitch,
): (input: TasksToolInput) => TasksToolResult {
  return (args: TasksToolInput) => {
    const now = Date.now();

    switch (args.action) {
      case 'add':
        return addTasks(taskList, args, now);

      case 'update':
        return updateTask(taskList, args, now);

      case 'list': {
        const tasks = taskList.list();
        const shown = tasks.reduce((n, task) => n + 1 + task.subtasks.length, 0);
        const total = taskList.count();

        const listed = tasks.map((task): ListedTask => {
          const item: ListedTask = { id: task.id, title: task.title, status: task.status };

          if (task.note !== null) item.note = task.note;

          if (task.subtasks.length > 0) {
            item.subtasks = task.subtasks.map((sub): ListedTask => {
              const s: ListedTask = { id: sub.id, title: sub.title, status: sub.status };

              if (sub.note !== null) s.note = sub.note;

              return s;
            });
          }

          return item;
        });

        const result: TasksListed = { tasks: listed };

        if (total > shown) result.not_shown = total - shown;

        return result;
      }

      case 'mode': {
        // No argument = read the current one.
        if (args.role === undefined) {
          return { role: config.getRoleSelection() };
        }

        if (!isValidRoleId(args.role)) {
          throw new KinuError('bad_input', 'tasks.mode requires `role` — a kebab-case role id like task or researcher');
        }

        const outcome = roleSwitch?.({ config, to: args.role }) ?? { kind: 'no-authority' };

        switch (outcome.kind) {
          case 'no-authority':
            throw new KinuError('unsupported', 'tasks.mode cannot switch roles: this agent has no profile authority to validate against');
          case 'denied':
            throw new KinuError('denied', outcome.text);
          case 'unknown-role':
            throw new KinuError('bad_input', outcome.text + ' Known roles: ' + outcome.known.join(', ') + '.');
          case 'applied':
            return { role: args.role };
        }
      }
    }
  };
}
