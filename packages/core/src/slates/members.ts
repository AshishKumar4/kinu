/**
 * Read-only versus mutating per (binding, member); unnamed members are mutating (fail closed). An operation's effect is
 * its impact: observing reads, anything else acts. `toolCallEffect` reads `NATIVE_ACTION_EFFECTS` from here.
 */
import * as v from 'valibot';
import type { JsonObject } from '../utils/json';
import type { Operation } from '../operations/operation';
import { MEMORY } from '../operations/memory';
import { TASKS } from '../operations/tasks';
import { WEB } from '../operations/web';
import { FILE } from '../operations/file';
import { AGENTS_IMPACTS } from '../operations/agents';

export type SlateMemberEffect = 'read' | 'mutate';

const effectOfImpact = (impact: Operation['impact']): SlateMemberEffect => (impact === 'observe' ? 'read' : 'mutate');

/** Each operation a slate may reach, by name, with its effect. */
function effects(ops: Readonly<Record<string, Operation>>): Readonly<Record<string, SlateMemberEffect>> {
  return Object.fromEntries(Object.values(ops).filter((op) => op.slate).map((op) => [op.name, effectOfImpact(op.impact)]));
}

const EXECUTOR_MEMBER_EFFECTS = {
  readFile: 'read', readdir: 'read', exists: 'read', stat: 'read', listTools: 'read',
  writeFile: 'mutate', mkdir: 'mutate', remove: 'mutate', exec: 'mutate', createTool: 'mutate', slate: 'mutate', git: 'mutate',
} as const satisfies Readonly<Record<string, SlateMemberEffect>>;

export const MEMORY_MEMBER_EFFECTS = effects(MEMORY);

export const TASKS_MEMBER_EFFECTS = effects(TASKS);

/** An `ai` binding's one member, `env.<name>.run({ prompt, system?, tier? })`: a model call, never a tool's name. */
export const AI_RUN_MEMBER = 'run';

export const WEB_MEMBER_EFFECTS = effects(WEB);

/** Per native operation, named by `op`. */
export const NATIVE_ACTION_EFFECTS = {
  file: effects(FILE),
  memory: MEMORY_MEMBER_EFFECTS,
  tasks: Object.fromEntries(Object.values(TASKS).map((op) => [op.name, effectOfImpact(op.impact)])),
  web: WEB_MEMBER_EFFECTS,
  agents: Object.fromEntries(Object.entries(AGENTS_IMPACTS).map(([op, impact]) => [op, effectOfImpact(impact)])),
} as const satisfies Readonly<Record<string, Readonly<Record<string, SlateMemberEffect>>>>;

/** Tools with one undifferentiated `call` member have no read shape, so `call` is mutating. */
export const TOOL_ACTION_EFFECTS = {
  file: NATIVE_ACTION_EFFECTS.file,
  memory: NATIVE_ACTION_EFFECTS.memory,
  tasks: NATIVE_ACTION_EFFECTS.tasks,
  web: NATIVE_ACTION_EFFECTS.web,
  run: { call: 'mutate' },
  eval: { call: 'mutate' },
  report: { call: 'mutate' },
  agents: { call: 'mutate' },
} as const satisfies Readonly<Record<string, Readonly<Record<string, SlateMemberEffect>>>>;

/** A member the table does not name is mutating: fail closed. */
function effectOf(table: Readonly<Record<string, SlateMemberEffect>>, member: string): SlateMemberEffect {
  return Object.hasOwn(table, member) ? table[member] : 'mutate';
}

function actionTable(tool: string): Readonly<Record<string, SlateMemberEffect>> | undefined {
  return Object.entries(TOOL_ACTION_EFFECTS).find(([name]) => name === tool)?.[1];
}

/** `rpc` members are read models; `agent` and `ai` members are always acts. */
export function memberEffect(
  kind: 'namespace' | 'memory' | 'tasks' | 'web' | 'rpc' | 'agent' | 'ai',
  member: string,
): SlateMemberEffect {
  switch (kind) {
    case 'namespace': return effectOf(EXECUTOR_MEMBER_EFFECTS, member);
    case 'memory': return effectOf(MEMORY_MEMBER_EFFECTS, member);
    case 'tasks': return effectOf(TASKS_MEMBER_EFFECTS, member);
    case 'web': return effectOf(WEB_MEMBER_EFFECTS, member);
    case 'rpc': return 'read';
    case 'agent':
    case 'ai': return 'mutate';
  }
}

/** The operation a capability tool's call names; `call` otherwise, or when the input names none. */
export function toolActionMember(tool: string, input: JsonObject): string {
  const actions = actionTable(tool);

  if (actions === undefined || (Object.keys(actions).length === 1 && 'call' in actions)) return 'call';

  return v.is(v.string(), input.op) ? input.op : 'call';
}

export function toolActionEffect(tool: string, member: string): SlateMemberEffect {
  const actions = actionTable(tool);

  return actions === undefined ? 'mutate' : effectOf(actions, member);
}

export function toolMembers(tool: string): readonly string[] {
  const actions = actionTable(tool);

  return actions === undefined ? ['call'] : Object.keys(actions);
}
