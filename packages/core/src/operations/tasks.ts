/**
 * The agent's task list, shown in its context at every step, and its active role. A role switch
 * (profiles/role-change.ts) lands on the next turn; the running step keeps its profile.
 */
import * as v from 'valibot';
import { isValidRoleId } from '../types/profile';
import { defineOperation, type Operation } from './operation';

export const TASK_STATUSES = ['open', 'active', 'done', 'dropped'] as const;

const described = <S extends v.GenericSchema>(schema: S, text: string) => v.pipe(schema, v.description(text));

const Id = described(v.pipe(v.string(), v.nonEmpty()), 'A task id, such as "t3".');

const Status = v.picklist(TASK_STATUSES);

const Entry = { id: v.string(), title: v.string(), status: Status };

const Listed = v.strictObject({ ...Entry, note: v.optional(v.string()) });

// The list is read every step, so writing it is planning: Plan turns keep it.
const tasksOp = <const I extends v.StrictObjectSchema<v.ObjectEntries, undefined>, const O extends v.GenericSchema>(
  op: Pick<Operation<I, O>, 'name' | 'help' | 'impact' | 'input' | 'output'>,
) => defineOperation({ ns: 'tasks', slate: op.name !== 'switchRole', plan: true, ...op });

export const TASKS = {
  add: tasksOp({
    name: 'add',
    help: 'Write down tasks in order, one title each; give the whole plan in one call.',
    impact: 'mutate',
    input: v.strictObject({
      titles: v.pipe(v.array(v.pipe(v.string(), v.nonEmpty())), v.minLength(1)),
      parent: v.optional(described(v.string(), 'The task id these are subtasks of; one level only.')),
    }),
    output: v.strictObject({
      added: v.array(v.strictObject({ id: v.string(), title: v.string(), parent: v.nullable(v.string()) })),
      rejected: v.array(v.strictObject({ title: v.string(), reason: v.string() })),
    }),
  }),
  update: tasksOp({
    name: 'update',
    help: "Move a task to another status.",
    impact: 'mutate',
    input: v.strictObject({ id: Id, status: Status }),
    output: v.strictObject({ ...Entry, openSubtasks: described(v.number(), "Subtasks still open under a task marked done.") }),
  }),
  note: tasksOp({
    name: 'note',
    help: 'Set the one-line note beside a task; null clears it.',
    impact: 'mutate',
    input: v.strictObject({ id: Id, note: v.nullable(v.string()) }),
    output: v.strictObject(Entry),
  }),
  list: tasksOp({
    name: 'list',
    help: 'The whole task list, closed items included.',
    impact: 'observe',
    input: v.strictObject({}),
    output: v.strictObject({
      tasks: v.array(v.strictObject({ ...Listed.entries, subtasks: v.array(Listed) })),
      notShown: described(v.number(), 'Tasks the list holds beyond those shown.'),
    }),
  }),
  role: tasksOp({
    name: 'role',
    help: 'Your active role id.',
    impact: 'observe',
    input: v.strictObject({}),
    output: v.strictObject({ role: v.string() }),
  }),
  switchRole: tasksOp({
    name: 'switchRole',
    help: 'Switch your active role from your next turn.',
    impact: 'administer',
    input: v.strictObject({ role: described(v.pipe(v.string(), v.guard(isValidRoleId, 'a kebab-case role id like task or researcher')), 'A role id.') }),
    output: v.strictObject({ role: v.string() }),
  }),
} as const;
