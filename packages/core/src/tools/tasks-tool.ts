/**
 * The `tasks` tool's dispatch logic — add / update / list over one
 * TaskListStore.
 *
 * Factored out so `tasks.*` can reach the SAME implementation from inside
 * execute_tools (tools/tasks-codemode.ts) that the native `tasks` tool
 * calls — one dispatcher, two callers, mirroring tools/memory-tool.ts.
 */
import { TaskListStore, TASK_STATUSES, type TaskStatus } from '../tasks/store.js';
import type { TasksToolAction } from './registry.js';

/** The task-list tool's one input shape. `titles` writes, `id` + `status`
 *  moves, and `list` needs neither. */
export interface TasksToolInput {
  action: TasksToolAction;
  titles?: string[];
  parent?: string;
  id?: string;
  status?: TaskStatus;
}

/** Build a tasks dispatcher over one runtime's task list. Constructed once —
 *  the store holds no state of its own beyond the SQL handle. */
export function createTasksDispatcher(taskList: TaskListStore): (input: TasksToolInput) => unknown {
  return (args: TasksToolInput): unknown => {
    const now = Date.now();
    switch (args.action) {
      case 'add': {
        const titles = Array.isArray(args.titles) ? args.titles.filter((t) => typeof t === 'string') : [];
        if (titles.length === 0) return { error: 'tasks.add requires `titles` — one or more task titles' };
        const { added, rejected } = taskList.add(titles, args.parent ?? null, now);
        return {
          added: added.map((task) => ({ id: task.id, title: task.title, parent: task.parentId })),
          ...(rejected.length > 0 ? { rejected } : {}),
        };
      }
      case 'update': {
        if (!args.id) return { error: 'tasks.update requires `id`' };
        if (!args.status || !(TASK_STATUSES as readonly string[]).includes(args.status)) {
          return { error: `tasks.update requires \`status\` — one of ${TASK_STATUSES.join(', ')}` };
        }
        const task = taskList.setStatus(args.id, args.status, now);
        if (!task) return { error: `no task ${args.id}` };
        // The one thing closing a parent hides: work filed under it that is
        // still open. Said at the moment the model would otherwise move on.
        const openSubtasks = args.status === 'done' ? taskList.countOpenSubtasks(task.id) : 0;
        return {
          id: task.id, title: task.title, status: task.status,
          ...(openSubtasks > 0 ? { open_subtasks: openSubtasks } : {}),
        };
      }
      case 'list': {
        const tasks = taskList.list();
        const shown = tasks.reduce((n, task) => n + 1 + task.subtasks.length, 0);
        const total = taskList.count();
        return {
          tasks: tasks.map((task) => ({
            id: task.id, title: task.title, status: task.status,
            ...(task.subtasks.length > 0
              ? { subtasks: task.subtasks.map((sub) => ({ id: sub.id, title: sub.title, status: sub.status })) }
              : {}),
          })),
          ...(total > shown ? { not_shown: total - shown } : {}),
        };
      }
      default:
        return { error: `unknown tasks action '${String(args.action)}'` };
    }
  };
}
