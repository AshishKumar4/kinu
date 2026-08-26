/**
 * The `tasks` tool's dispatch logic — add / update / list over one
 * TaskListStore, plus `mode`, the agent's durable active role.
 *
 * The role lives in `agent_config`: one key per agent, resolved fresh at every
 * turn boundary (profiles/resolve.ts), so a switch made here lands on the NEXT
 * turn while the running step keeps the profile it already resolved. Switching
 * goes through profiles/role-change.ts — the owner's allow/approval/locked
 * policy decides whether a self-switch lands, stages or refuses.
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
import { changeActiveRole } from '../profiles/role-change';

const TaskStatusSchema = v.picklist(TASK_STATUSES);
const TasksActionSchema = v.picklist(TASKS_TOOL_ACTIONS);
const TitlesSchema = v.array(v.string());

/** The task-list tool's one input shape. `titles` writes, `id` + `status`
 *  moves, `list` needs neither, and `mode` reads or switches the active role. */
export interface TasksToolInput {
  action: TasksToolAction;
  titles?: string[];
  id?: string;
  status?: TaskStatus;
  parent?: string | null;
  /** For action=mode: the role id to switch to. Omit to read the current one. */
  role?: string;
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

interface RoleSet {
  role: string;
  /** Set when the switch staged for owner approval instead of landing now. */
  staged?: true;
  /** Why the switch did not land immediately. */
  note?: string;
}

export type TasksToolResult = TasksError | TasksAdded | TaskUpdated | TasksListed | RoleSet;

/** Build a tasks dispatcher over one runtime's task list and config. Both
 *  stores are injected, not constructed: the codemode projection must share
 *  the caller's exact TaskListStore instance (the one the dynamic-context
 *  snapshot reads), and the config store is the same handle the backend reads
 *  the active role from when it resolves the turn profile. `roleAuthority`
 *  supplies THIS turn's catalog envelope — without one there is nothing to
 *  validate a switch against, so switching refuses rather than storing blind. */
export function createTasksDispatcher(
  taskList: TaskListStore,
  config: AgentConfigStore,
  roleAuthority?: () => ProfileCatalogEnvelope | null,
): (input: TasksToolInput) => TasksToolResult {
  return (args: TasksToolInput) => {
    const now = Date.now();
    // `action` arrives from the model, and the AI SDK does NOT validate a
    // jsonSchema-declared tool input: `Schema.validate` is left undefined, so
    // `safeValidateTypes` returns the raw JSON untouched. The declared
    // `TasksToolAction` is therefore a claim about this value, not a fact — and
    // the switch below has four literal cases, so an unrecognised action fell
    // out of the bottom into a branch the compiler believes unreachable. The
    // model was answered `unknown tasks action 'list">'`: true, useless, and
    // silent about the four words that would have worked.
    //
    // Parsed the way `status` already is below, and answered the way `agents`
    // answers an unavailable action (agents-tool.ts) — WITH the vocabulary,
    // which is what makes the model's next call succeed instead of repeat.
    const action = v.safeParse(TasksActionSchema, args.action);
    if (!action.success) {
      return { error: unknownActionError('tasks', 'action', args.action, TASKS_TOOL_ACTIONS) };
    }
    switch (action.output) {
      case 'add': {
        const titles = v.safeParse(TitlesSchema, args.titles ?? []);
        if (!titles.success) return { error: 'tasks.add requires `titles` — an array of task titles' };
        if (titles.output.length === 0) return { error: 'tasks.add requires `titles` — one or more task titles' };
        const { added, rejected } = taskList.add(titles.output, args.parent ?? null, now);
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
      case 'mode': {
        // No argument = read the current one.
        if (args.role === undefined) {
          const selection = config.getRoleSelection();
          return { role: selection.kind === 'catalog' ? selection.roleId : 'general', roleSource: selection.kind };
        }
        const envelope = roleAuthority?.();
        if (!isValidRoleId(args.role)) {
          return { error: 'tasks.mode requires `role` — a kebab-case role id like general or researcher' };
        }
        if (!envelope) {
          return { error: 'tasks.mode cannot switch roles: this agent has no profile authority to validate against' };
        }
        const outcome = changeActiveRole({ envelope, config, to: args.role, actor: 'agent' });
        if (outcome.kind === 'refused') {
          const known = Object.keys({ ...BUILTIN_ROLE_DEFINITIONS, ...envelope.catalog.roles }).sort();
          return { error: outcome.reason === 'unknown-role'
            ? `unknown role ${args.role} — known roles: ${known.join(', ')}`
            : outcome.reason === 'locked'
              ? 'the owner has locked role changes for this agent; ask them to switch the role'
              : `invalid role id ${args.role}` };
        }
        const result: RoleSet = { role: args.role };
        if (outcome.kind === 'staged') {
          result.staged = true;
          return { ...result, note: 'staged for owner approval; the active role is unchanged until they approve it' };
        }
        return result;
      }
    }
  };
}
