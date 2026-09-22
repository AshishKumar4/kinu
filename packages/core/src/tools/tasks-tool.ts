/**
 * `tasks` tool dispatch: add / update / list over one TaskListStore, plus `mode`, the active role.
 * A role switch (profiles/role-change.ts) lands on the next turn; the running step keeps its profile.
 */
import {
  TaskListStore,
  TASK_STATUSES,
  type TaskAddRejection,
  type TaskStatus,
} from '../tasks/store';
import type { AgentConfigStore } from '../config/store';
import * as v from 'valibot';
import {
  TASKS_TOOL_ACTIONS, unknownActionError,
  type TasksToolAction,
} from './registry';
import {
  BUILTIN_ROLE_DEFINITIONS,
  isValidRoleId,
  type ProfileCatalogEnvelope,
} from '../profiles/catalog';
import { changeActiveRole, roleChangeOutcomeText } from '../profiles/role-change';
import { KinuError } from '../obs/index';

const TaskStatusSchema = v.picklist(TASK_STATUSES);

const TasksActionSchema = v.picklist(TASKS_TOOL_ACTIONS);

const TitlesSchema = v.array(v.string());

/** The task-list tool's one input shape. */
export interface TasksToolInput {
  action: TasksToolAction;
  titles?: string[];
  id?: string;
  status?: TaskStatus;
  /** For action=update: set, replace, or clear (null) the item's note. `status` or `note` is required. */
  note?: string | null;
  parent?: string | null;
  /** For action=mode: the role id to switch to. Omit to read the current one. */
  role?: string;
}

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
  const titles = v.safeParse(TitlesSchema, args.titles ?? []);

  if (!titles.success) throw new KinuError('bad_input', 'tasks.add requires `titles` — an array of task titles');

  if (titles.output.length === 0) throw new KinuError('bad_input', 'tasks.add requires `titles` — one or more task titles');
  const { added, rejected } = taskList.add(titles.output, args.parent ?? null, now);

  const result: TasksAdded = {
    added: added.map((task) => ({ id: task.id, title: task.title, parent: task.parentId })),
  };

  if (rejected.length > 0) result.rejected = rejected;

  return result;
}

/** `note` is three-valued: absent leaves it, `null` clears it, a string sets it. */
function readNote(note: string | null | undefined): string | null | undefined {
  if (note === undefined || note === null) return note;
  const parsed = v.safeParse(v.string(), note);

  if (!parsed.success) throw new KinuError('bad_input', 'tasks.update requires `note` — a string, or null to clear');

  return parsed.output;
}

/** `tasks.update` — a status move, a note write, or both on one task. */
function updateTask(taskList: TaskListStore, args: TasksToolInput, now: number): TaskUpdated {
  if (!args.id) throw new KinuError('bad_input', 'tasks.update requires `id`');
  const status = args.status === undefined ? undefined : v.safeParse(TaskStatusSchema, args.status);

  if (status !== undefined && !status.success) {
    throw new KinuError('bad_input', 'tasks.update requires `status` — one of ' + TASK_STATUSES.join(', '));
  }

  if (status === undefined && args.note === undefined) {
    throw new KinuError('bad_input', 'tasks.update requires `status` or `note`');
  }

  const note = readNote(args.note);
  const task = taskList.update(args.id, { status: status?.output, note }, now);

  if (!task) throw new KinuError('missing', 'no task ' + args.id);
  // Warn about still-open children when closing a parent.
  const openSubtasks = status?.output === 'done' ? taskList.countOpenSubtasks(task.id) : 0;
  const result: TaskUpdated = { id: task.id, title: task.title, status: task.status };

  if (openSubtasks > 0) result.open_subtasks = openSubtasks;

  return result;
}

/** Build a tasks dispatcher. Stores are injected: codemode must share the caller's exact
 *  TaskListStore. Without `roleAuthority`, role switching refuses. */
export function createTasksDispatcher(
  taskList: TaskListStore,
  config: AgentConfigStore,
  roleAuthority?: () => ProfileCatalogEnvelope | null,
): (input: TasksToolInput) => TasksToolResult {
  return (args: TasksToolInput) => {
    const now = Date.now();
    // The AI SDK does not validate jsonSchema tool input; answer an unknown action with the vocabulary.
    const action = v.safeParse(TasksActionSchema, args.action);

    if (!action.success) {
      throw new KinuError('bad_input', unknownActionError('tasks', 'action', args.action, TASKS_TOOL_ACTIONS));
    }

    switch (action.output) {
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

        const envelope = roleAuthority?.();

        if (!isValidRoleId(args.role)) {
          throw new KinuError('bad_input', 'tasks.mode requires `role` — a kebab-case role id like task or researcher');
        }

        if (!envelope) {
          throw new KinuError('unsupported', 'tasks.mode cannot switch roles: this agent has no profile authority to validate against');
        }

        const outcome = changeActiveRole({ envelope, config, to: args.role, actor: 'agent' });

        if (outcome.kind === 'refused') {
          const text = roleChangeOutcomeText(args.role, outcome, config.getRoleSelection());

          if (outcome.reason !== 'unknown-role') throw new KinuError('denied', text);
          const known = Object.keys({ ...BUILTIN_ROLE_DEFINITIONS, ...envelope.catalog.roles }).sort();
          throw new KinuError('bad_input', text + ' Known roles: ' + known.join(', ') + '.');
        }

        return { role: args.role };
      }
    }
  };
}
