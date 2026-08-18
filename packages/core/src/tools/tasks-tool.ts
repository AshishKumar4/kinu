/**
 * The `tasks` tool's dispatch logic — add / update / list over one
 * TaskListStore, plus `mode`, the agent's own working stance.
 *
 * Factored out so `tasks.*` can reach the SAME implementation from inside
 * execute_tools (tools/tasks-codemode.ts) that the native `tasks` tool
 * calls — one dispatcher, two callers, mirroring tools/memory-tool.ts.
 *
 * The stance lives in `agent_config` rather than a table of its own: it is one
 * durable workspace value, which is exactly what AgentConfigStore is. It rides
 * this tool because it is the same class of state as the task list — the
 * agent's own record of the work in front of it — and because a ninth native
 * tool is not on the table.
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
  isAgentStance, AGENT_STANCES, TASKS_TOOL_ACTIONS, unknownActionError,
  type AgentStance, type TasksToolAction,
} from './registry';

const TaskStatusSchema = v.picklist(TASK_STATUSES);
const TasksActionSchema = v.picklist(TASKS_TOOL_ACTIONS);
const TitlesSchema = v.array(v.string());

/** The task-list tool's one input shape. `titles` writes, `id` + `status`
 *  moves, `list` needs neither, and `stance` sets the working stance. */
export interface TasksToolInput {
  action: TasksToolAction;
  titles?: string[];
  parent?: string;
  id?: string;
  status?: TaskStatus;
  stance?: AgentStance;
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

interface StanceSet {
  stance: AgentStance;
}

export type TasksToolResult = TasksError | TasksAdded | TaskUpdated | TasksListed | StanceSet;

/** Build a tasks dispatcher over one runtime's task list and config. Both
 *  stores are injected, not constructed: the codemode projection must share
 *  the caller's exact TaskListStore instance (the one the dynamic-context
 *  snapshot reads), and the config store is the same handle the backend reads
 *  the stance from when it builds the turn's system prompt. */
export function createTasksDispatcher(
  taskList: TaskListStore,
  config: AgentConfigStore,
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
        // No stance argument = read the current one. A named stance that is
        // not one of ours is answered with the list rather than stored, so
        // the model learns the vocabulary instead of silently getting general.
        if (args.stance === undefined) return { stance: config.getStance() };
        if (!isAgentStance(args.stance)) {
          return { error: `tasks.mode requires \`stance\` — one of ${AGENT_STANCES.join(', ')}` };
        }
        config.setStance(args.stance);
        return { stance: args.stance };
      }
    }
  };
}
