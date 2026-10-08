/**
 * What each namespace member a slate calls does, read from its catalog operation alone: a slate reaches an operation
 * its entry marks `slate`, with that entry's impact. Anything the catalog does not declare, or keeps from slates, is
 * off a slate's surface (fail closed). `toolCallEffect` reads `NATIVE_ACTION_EFFECTS` from here.
 */
import type { Impact } from '@agent-core/core/facets';
import type { Operation } from '../operations/operation';
import { AGENT } from '../operations/agent';
import { AGENTS_IMPACTS, AGENTS_SLATE } from '../operations/agents';
import { DB } from '../operations/db';
import { DEVICE, PARENT, SANDBOX, WORKSPACE } from '../operations/executors';
import { FILE } from '../operations/file';
import { MEMORY } from '../operations/memory';
import { STATE } from '../operations/state';
import { TASKS } from '../operations/tasks';
import { WEB, WEB_SANDBOX_IMPACTS } from '../operations/web';

/** `workspace.ai.run({ prompt, system?, tier? })`: a model call, never the `shell` tool, whose run was renamed. */
export const AI_RUN_MEMBER = 'run';

/** `workspace.ai.stream({ prompt, system?, tier? })`: the same call, its text handed over as it is written. */
export const AI_STREAM_MEMBER = 'stream';

/** `workspace.agent.ask({ text, data? })`: `agent.send` answered with the agent's own reply as it writes it. */
export const AGENT_ASK_MEMBER = 'ask';

/** A tool call's chip: whether it only looked. */
export type ActionEffect = 'read' | 'mutate';

/** Every eval namespace the catalog declares, each operation by its name. */
const DECLARED = new Map(Object.entries({
  memory: MEMORY, tasks: TASKS, web: WEB, file: FILE, db: DB, state: STATE, agent: AGENT,
  workspace: WORKSPACE, sandbox: SANDBOX, device: DEVICE, parent: PARENT,
}).map(([namespace, ops]) => [namespace, new Map(Object.values<Operation>(ops).map((op) => [op.name, op]))]));

const impacts = (ops: Readonly<Record<string, Operation>>): Readonly<Record<string, Impact>> => Object.fromEntries(
  Object.values(ops).map((op) => [op.name, op.impact]),
);

const effectOfImpact = (impact: Impact): ActionEffect => (impact === 'observe' ? 'read' : 'mutate');

function effects(table: Readonly<Record<string, Impact>>): Readonly<Record<string, ActionEffect>> {
  return Object.fromEntries(Object.entries(table).map(([name, impact]) => [name, effectOfImpact(impact)]));
}

/** Per native operation, as each capability tool's `op` names it. */
export const NATIVE_ACTION_EFFECTS = {
  file: effects(impacts(FILE)),
  memory: effects(impacts(MEMORY)),
  tasks: effects(impacts(TASKS)),
  web: effects(impacts(WEB)),
  agents: effects(AGENTS_IMPACTS),
} as const satisfies Readonly<Record<string, Readonly<Record<string, ActionEffect>>>>;

/** The browser members a program's sandbox holds, declared beside `web`'s operations. */
const SANDBOX_WEB = new Map<string, Impact>(Object.entries(WEB_SANDBOX_IMPACTS));

/** Namespaces the wiring declares per actor (`agents.*`): what each member does, and who reaches it from a slate. */
const WIRED = new Map<string, { readonly impacts: ReadonlyMap<string, Impact>; readonly slate: Operation['slate'] }>([
  ['agents', { impacts: new Map(Object.entries(AGENTS_IMPACTS)), slate: AGENTS_SLATE }],
]);

/** A declared operation a slate may call, by its catalog entry; `null` for one it may not, or one never declared. */
function namespaceMemberImpact(namespace: string, member: string): Impact | null {
  const sandboxWeb = namespace === 'web' ? SANDBOX_WEB.get(member) : undefined;

  if (sandboxWeb !== undefined) return sandboxWeb;

  const wired = WIRED.get(namespace);

  if (wired !== undefined) return wired.slate === false ? null : wired.impacts.get(member) ?? null;
  const op = DECLARED.get(namespace)?.get(member);

  return op?.slate === true || op?.slate === 'owner' ? op.impact : null;
}

/** A member only the owner's own slate reaches, as the owner: a share never grants it, a hosted actor's slate never holds it. */
export function slateOwnerOnly(address: { readonly namespace: string; readonly member: string }): boolean {
  // A reply is the owner's agent speaking to the owner: no share's viewer is handed it.
  if (address.namespace === 'agent' && address.member === AGENT_ASK_MEMBER) return true;

  const wired = WIRED.get(address.namespace);

  if (wired !== undefined) return wired.slate === 'owner' && wired.impacts.has(address.member);

  return DECLARED.get(address.namespace)?.get(address.member)?.slate === 'owner';
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

  if (address.namespace === 'agent' && (address.member === 'send' || address.member === AGENT_ASK_MEMBER)) return 'externalSend';

  // `ai` has two members, one call answered whole or as it is written; any other is no model call, and no namespace of the actor's either.
  if (address.namespace === 'ai') return address.member === AI_RUN_MEMBER || address.member === AI_STREAM_MEMBER ? 'execute' : null;

  return namespaceMemberImpact(address.namespace, address.member);
}
