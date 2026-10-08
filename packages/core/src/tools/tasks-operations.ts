/** The task operations served over an agent's task list and config, natively and as `tasks.*`. */
import { Effect } from 'effect';
import type { AgentTask, TaskListStore } from './task-store';
import type { AgentConfigStore } from '../config/store';
import type { RoleId } from '../types/profile';
import { KinuError } from '../obs/index';
import type { CodemodeProvider } from '../types/codemode';
import { serve, type Served } from '../operations/operation';
import { codemodeNamespace } from './operation-surfaces';
import { TASK_STATUSES, TASKS } from '../operations/tasks';

export type RoleSwitchOutcome =
  | { readonly kind: 'applied' }
  | { readonly kind: 'no-authority' }
  | { readonly kind: 'denied'; readonly text: string }
  | { readonly kind: 'unknown-role'; readonly text: string; readonly known: readonly string[] };

/** Bound by the harness (`agentRoleSwitch`). */
export type RoleSwitch = (input: { config: AgentConfigStore; to: RoleId }) => RoleSwitchOutcome;

/** Stores are injected, so a program and the native tool share the one TaskListStore. Without `roleSwitch`, switching refuses. */
export function serveTasks(taskList: TaskListStore, config: AgentConfigStore, roleSwitch?: RoleSwitch): readonly Served[] {
  const updated = (id: string, change: { readonly status?: (typeof TASK_STATUSES)[number]; readonly note?: string | null }): Effect.Effect<AgentTask, KinuError> => {
    const task = taskList.update(id, change, Date.now());

    return task === null ? Effect.fail(new KinuError('missing', `no task ${id}`)) : Effect.succeed(task);
  };

  return [
    serve(TASKS.add, async ({ titles, parent }) => {
      const { added, rejected } = taskList.add(titles, parent ?? null, Date.now());

      return { added: added.map((task) => ({ id: task.id, title: task.title, parent: task.parentId })), rejected };
    }),
    serve(TASKS.update, ({ id, status }) => updated(id, { status }).pipe(Effect.map((task) => ({
      // A parent closed over open children says how many.
      id: task.id, title: task.title, status: task.status, openSubtasks: status === 'done' ? taskList.countOpenSubtasks(task.id) : 0,
    })))),
    serve(TASKS.note, ({ id, note }) => updated(id, { note }).pipe(Effect.map((task) => ({ id: task.id, title: task.title, status: task.status })))),
    serve(TASKS.list, async () => {
      const listed = (task: { id: string; title: string; status: (typeof TASK_STATUSES)[number]; note: string | null }) => ({
        id: task.id, title: task.title, status: task.status, ...(task.note !== null && { note: task.note }),
      });

      const tasks = taskList.list();
      const shown = tasks.reduce((n, task) => n + 1 + task.subtasks.length, 0);

      return { tasks: tasks.map((task) => ({ ...listed(task), subtasks: task.subtasks.map(listed) })), notShown: taskList.count() - shown };
    }),
    serve(TASKS.role, async () => ({ role: config.getRoleSelection() })),
    serve(TASKS.switchRole, ({ role }) => {
      const outcome = roleSwitch?.({ config, to: role }) ?? { kind: 'no-authority' as const };

      switch (outcome.kind) {
        case 'no-authority':
          return Effect.fail(new KinuError('unsupported', 'cannot switch roles: this agent has no profile authority to validate against'));
        case 'denied':
          return Effect.fail(new KinuError('denied', outcome.text));
        case 'unknown-role':
          return Effect.fail(new KinuError('bad_input', `${outcome.text} Known roles: ${outcome.known.join(', ')}.`));
        case 'applied':
          return Effect.succeed({ role });
      }
    }),
  ];
}

/** `tasks.*` for programs and slates, over the native tool's stores. */
export function createTasksCodemodeProvider(taskList: TaskListStore, config: AgentConfigStore, roleSwitch?: RoleSwitch): CodemodeProvider {
  return codemodeNamespace('tasks', serveTasks(taskList, config, roleSwitch));
}
