/**
 * Read-only versus mutating, per (binding, member) — the one classification a
 * share grant, the capability graph and the audit row all read. A member the
 * table does not name is mutating: the safe answer for a member nobody has
 * classified is the one that asks the owner.
 *
 * The `tool` rows restate the native tools' own classification — what
 * `toolCallEffect` and `replayPolicyFor` in `tools/` already decided — because
 * this platform layer cannot import them. `unit-slate-members.test.ts` pins
 * every row of `TOOL_ACTION_EFFECTS` against those two, so a drift between
 * here and there is a red test, not a silent lie.
 */
import * as v from 'valibot';
import type { JsonObject } from '../utils/json';

export type SlateMemberEffect = 'read' | 'mutate';

/** The members every executor namespace admits (`workspace`, `sandbox`, `pc`,
 *  a laptop mount — the plane names differ, the member vocabulary is the
 *  executor's own). */
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

/** The native tools' actions as grant members. A tool that answers one
 *  undifferentiated `call` member — `run`, `eval`, `report`, `agents`
 *  and any crafted tool — has no read shape, so `call` is mutating. */
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

/** The tool's action table, or none when the tool is not one this module
 *  knows — a crafted tool has the single `call` member by construction. */
function actionTable(tool: string): Readonly<Record<string, SlateMemberEffect>> | undefined {
  return Object.entries(TOOL_ACTION_EFFECTS).find(([name]) => name === tool)?.[1];
}

/** The effect of one member on one binding kind. `rpc` members are read
 *  models; `agent` and `ai` members are always acts. */
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

/** The grant member a `call` to this tool's `input` names: the action for a
 *  tool that discriminates, `call` for one that does not and for inputs that
 *  carry no string action. */
export function toolActionMember(tool: string, input: JsonObject): string {
  const actions = actionTable(tool);

  if (actions === undefined || (Object.keys(actions).length === 1 && 'call' in actions)) return 'call';

  return v.is(v.string(), input.action) ? input.action : 'call';
}

/** The effect of one action member of a tool; unknown tool or member is
 *  mutating. */
export function toolActionEffect(tool: string, member: string): SlateMemberEffect {
  const actions = actionTable(tool);

  return actions === undefined ? 'mutate' : effectOf(actions, member);
}

/** The member names a `tool` binding grants over — the tool's own actions, or
 *  the single `call` of a tool this table does not know. */
export function toolMembers(tool: string): readonly string[] {
  const actions = actionTable(tool);

  return actions === undefined ? ['call'] : Object.keys(actions);
}
