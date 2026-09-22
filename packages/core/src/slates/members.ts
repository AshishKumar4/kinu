/**
 * Read-only versus mutating per (binding, member); unnamed members are mutating (fail closed).
 * `tool` rows restate `toolCallEffect`/`replayPolicyFor`, which this layer cannot import; a test pins them.
 */
import * as v from 'valibot';
import type { JsonObject } from '../utils/json';

export type SlateMemberEffect = 'read' | 'mutate';

const EXECUTOR_MEMBER_EFFECTS = {
  readFile: 'read', readdir: 'read', exists: 'read', stat: 'read', searchMemory: 'read', listTools: 'read',
  writeFile: 'mutate', editFile: 'mutate', mkdir: 'mutate', remove: 'mutate', exec: 'mutate',
  saveNote: 'mutate', createTool: 'mutate', slate: 'mutate', git: 'mutate',
} as const satisfies Readonly<Record<string, SlateMemberEffect>>;

export const MEMORY_MEMBER_EFFECTS = {
  search: 'read', recall: 'read', conversations: 'read',
  save: 'mutate', remember: 'mutate', forget: 'mutate',
} as const satisfies Readonly<Record<string, SlateMemberEffect>>;

export const TASKS_MEMBER_EFFECTS = {
  list: 'read', add: 'mutate', update: 'mutate', mode: 'mutate',
} as const satisfies Readonly<Record<string, SlateMemberEffect>>;

export const WEB_MEMBER_EFFECTS = {
  search: 'read', fetch: 'read',
} as const satisfies Readonly<Record<string, SlateMemberEffect>>;

/** Tools with one undifferentiated `call` member have no read shape, so `call` is mutating. */
export const TOOL_ACTION_EFFECTS = {
  file: { read: 'read', list: 'read', stat: 'read', search: 'read', write: 'mutate', edit: 'mutate' },
  memory: MEMORY_MEMBER_EFFECTS,
  tasks: TASKS_MEMBER_EFFECTS,
  web: WEB_MEMBER_EFFECTS,
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

/** The action for a discriminating tool; `call` otherwise, or when the input carries no string action. */
export function toolActionMember(tool: string, input: JsonObject): string {
  const actions = actionTable(tool);

  if (actions === undefined || (Object.keys(actions).length === 1 && 'call' in actions)) return 'call';

  return v.is(v.string(), input.action) ? input.action : 'call';
}

export function toolActionEffect(tool: string, member: string): SlateMemberEffect {
  const actions = actionTable(tool);

  return actions === undefined ? 'mutate' : effectOf(actions, member);
}

export function toolMembers(tool: string): readonly string[] {
  const actions = actionTable(tool);

  return actions === undefined ? ['call'] : Object.keys(actions);
}
