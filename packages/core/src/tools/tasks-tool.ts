/**
 * The `tasks` tool's dispatch logic — add / update / list over one
 * TaskListStore.
 *
 * Factored out so `tasks.*` can reach the SAME implementation from inside
 * execute_tools (tools/tasks-codemode.ts) that the native `tasks` tool
 * calls — one dispatcher, two callers, mirroring tools/memory-tool.ts.
 */
import {
  TaskListStore,
  TASK_STATUSES,
  type TaskAddRejection,
  type TaskStatus,
} from '../tasks/store.js';
import * as v from 'valibot';
import type { TasksToolAction } from './registry.js';

const TaskStatusSchema = v.picklist(TASK_STATUSES);

/** The task-list tool's one input shape. `titles` writes, `id` + `status`
 *  moves, and `list` needs neither. */
export interface TasksToolInput {
  action: TasksToolAction;
  titles?: string[];
  parent?: string;
  id?: string;
  status?: TaskStatus;
}

interface TasksError {
  error: string;
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
  subtasks?: ListedTask[];
}

interface TasksListed {
  tasks: ListedTask[];
  not_shown?: number;
}

export type TasksToolResult = TasksError | TasksAdded | TaskUpdated | TasksListed;

/** Build a tasks dispatcher over one runtime's task list. Constructed once —
 *  the store holds no state of its own beyond the SQL handle. */
export function createTasksDispatcher(taskList: TaskListStore): (input: TasksToolInput) => TasksToolResult {
  return (args: TasksToolInput) => {
    const now = Date.now();
    switch (args.action) {
      case 'add': {
        const titles = args.titles ?? [];
        if (titles.length === 0) return { error: 'tasks.add requires `titles` — one or more task titles' };
        const { added, rejected } = taskList.add(titles, args.parent ?? null, now);
        const result: TasksAdded = {
          added: added.map((task) => ({ id: task.id, title: task.title, parent: task.parentId })),
        };
        if (rejected.length > 0) result.rejected = rejected;
        return result;
      }
      case 'update': {
        if (!args.id) return { error: 'tasks.update requires `id`' };
        const status = v.safeParse(TaskStatusSchema, args.status);
        if (!status.success) {
          return { error: `tasks.update requires \`status\` — one of ${TASK_STATUSES.join(', ')}` };
        }
        const task = taskList.setStatus(args.id, status.output, now);
        if (!task) return { error: `no task ${args.id}` };
        // The one thing closing a parent hides: work filed under it that is
        // still open. Said at the moment the model would otherwise move on.
        const openSubtasks = status.output === 'done' ? taskList.countOpenSubtasks(task.id) : 0;
        const result: TaskUpdated = { id: task.id, title: task.title, status: task.status };
        if (openSubtasks > 0) result.open_subtasks = openSubtasks;
        return result;
      }
      case 'list': {
        const tasks = taskList.list();
        const shown = tasks.reduce((n, task) => n + 1 + task.subtasks.length, 0);
        const total = taskList.count();
        const listed = tasks.map((task): ListedTask => {
          const item: ListedTask = { id: task.id, title: task.title, status: task.status };
          if (task.subtasks.length > 0) {
            item.subtasks = task.subtasks.map((sub) => ({
              id: sub.id,
              title: sub.title,
              status: sub.status,
            }));
          }
          return item;
        });
        const result: TasksListed = { tasks: listed };
        if (total > shown) result.not_shown = total - shown;
        return result;
      }
      default:
        return { error: `unknown tasks action '${String(args.action)}'` };
    }
  };
}
