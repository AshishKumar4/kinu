/**
 * What each namespace member a slate calls does, as its catalog operation's impact: a member the catalog keeps from
 * slates is the agent's alone, and an executor member it does not declare is `administer` (fail closed).
 * `toolCallEffect` reads `NATIVE_ACTION_EFFECTS` from here.
 */
import type { Impact } from '@agent-core/core/facets';
import type { Operation } from '../operations/operation';
import { AGENTS_IMPACTS } from '../operations/agents';
import { DB } from '../operations/db';
import { DEVICE, SANDBOX, WORKSPACE } from '../operations/executors';
import { FILE } from '../operations/file';
import { MEMORY } from '../operations/memory';
import { TASKS } from '../operations/tasks';
import { WEB, WEB_SANDBOX_IMPACTS } from '../operations/web';

/** `workspace.ai.run({ prompt, system?, tier? })`: a model call, never the `shell` tool, whose run was renamed. */
export const AI_RUN_MEMBER = 'run';

/** A tool call's chip: whether it only looked. */
export type ActionEffect = 'read' | 'mutate';

const impacts = (ops: Readonly<Record<string, Operation>>, slate: boolean): Readonly<Record<string, Impact>> => Object.fromEntries(
  Object.values(ops).filter((op) => !slate || op.slate).map((op) => [op.name, op.impact]),
);

/** The eval namespaces' members a slate reaches, each with its impact; a member absent here is the agent's alone. */
const SLATE_MEMBER_IMPACTS = {
  memory: impacts(MEMORY, true),
  tasks: impacts(TASKS, true),
  web: { ...impacts(WEB, true), ...WEB_SANDBOX_IMPACTS },
  db: impacts(DB, true),
} as const satisfies Readonly<Record<string, Readonly<Record<string, Impact>>>>;

/** An executor's own members (`workspace`, `sandbox`, `device`), by name across them. */
const EXECUTOR_MEMBER_IMPACTS = { ...impacts(DEVICE, true), ...impacts(SANDBOX, true), ...impacts(WORKSPACE, true) };

const effectOfImpact = (impact: Impact): ActionEffect => (impact === 'observe' ? 'read' : 'mutate');

function effects(table: Readonly<Record<string, Impact>>): Readonly<Record<string, ActionEffect>> {
  return Object.fromEntries(Object.entries(table).map(([name, impact]) => [name, effectOfImpact(impact)]));
}

/** Per native operation, as each capability tool's `op` names it. */
export const NATIVE_ACTION_EFFECTS = {
  file: effects(impacts(FILE, false)),
  memory: effects(impacts(MEMORY, false)),
  tasks: effects(impacts(TASKS, false)),
  web: effects(impacts(WEB, false)),
  agents: effects(AGENTS_IMPACTS),
} as const satisfies Readonly<Record<string, Readonly<Record<string, ActionEffect>>>>;

const lookup = <T>(table: Readonly<Record<string, T>>, name: string): T | undefined => Object.entries(table).find(([key]) => key === name)?.[1];

/** A namespace's member, or an executor's; `null` for one the agent keeps from slates. */
function namespaceMemberImpact(namespace: string, member: string): Impact | null {
  const table = lookup<Readonly<Record<string, Impact>>>(SLATE_MEMBER_IMPACTS, namespace);

  if (table !== undefined) return lookup(table, member) ?? null;

  return lookup<Impact>(EXECUTOR_MEMBER_IMPACTS, member) ?? 'administer';
}

/**
 * What a call on a slate's surface does; `null` for a member kept from slates. An MCP tool sends with your
 * credentials unless its server marks it read-only, which only the server's own listing says.
 */
export function slateAddressImpact(address: { readonly namespace: string; readonly member: string }): Impact | null {
  const [head] = address.namespace.split('.');

  switch (head) {
    case 'slates':
    case 'reads': return 'observe';
    case 'mcp': return 'externalSend';
    case 'tools': return 'execute';
    default: break;
  }

  if (address.namespace === 'agent' && address.member === 'send') return 'externalSend';

  // `ai` has one member; any other is no model call, and no namespace of the actor's either.
  if (address.namespace === 'ai') return address.member === AI_RUN_MEMBER ? 'execute' : null;

  return namespaceMemberImpact(address.namespace, address.member);
}
