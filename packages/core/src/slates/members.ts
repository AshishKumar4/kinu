/**
 * What each namespace member a slate calls does, as agent-core's impact; a member no table names is `administer`
 * (fail closed). `toolCallEffect` reads `NATIVE_ACTION_EFFECTS` from here.
 */
import type { Impact } from '@agent-core/core/facets';

/** A tool call's chip: whether it only looked. */
export type ActionEffect = 'read' | 'mutate';

/**
 * The eval namespaces' members a slate reaches, each with its impact; a member absent here is the agent's alone. One
 * table until the operation catalog states each operation's impact and slate reach for itself.
 */
const SLATE_MEMBER_IMPACTS = {
  memory: { search: 'observe', recall: 'observe', conversations: 'observe', save: 'mutate', remember: 'mutate', forget: 'mutate' },
  // `tasks.mode` switches the agent's own role: steering itself, which a slate never does.
  tasks: { list: 'observe', add: 'mutate', update: 'mutate' },
  web: {
    search: 'observe', fetch: 'observe', screenshot: 'observe', browsers: 'observe',
    openBrowser: 'execute', closeBrowser: 'mutate', connectBrowser: 'execute', pageTools: 'observe', callPageTool: 'execute',
  },
  db: {
    listTables: 'observe', schema: 'observe', select: 'observe', count: 'observe',
    createTable: 'mutate', insert: 'mutate', update: 'mutate', deleteRows: 'mutate', batch: 'mutate', dropTable: 'mutate',
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, Impact>>>>;

/** An executor's own members (`workspace`, `sandbox`, `device`); its process and port members fall to `administer`. */
const EXECUTOR_MEMBER_IMPACTS = {
  readFile: 'observe', readdir: 'observe', exists: 'observe', stat: 'observe', searchMemory: 'observe', listTools: 'observe',
  writeFile: 'mutate', editFile: 'mutate', mkdir: 'mutate', remove: 'mutate', saveNote: 'mutate', exec: 'execute', git: 'execute',
} as const satisfies Readonly<Record<string, Impact>>;

const effectOfImpact = (impact: Impact): ActionEffect => (impact === 'observe' ? 'read' : 'mutate');

function effects(impacts: Readonly<Record<string, Impact>>): Readonly<Record<string, ActionEffect>> {
  return Object.fromEntries(Object.entries(impacts).map(([name, impact]) => [name, effectOfImpact(impact)]));
}

/** Per native action; the native web tool writes (a spilled page, a screenshot). */
export const NATIVE_ACTION_EFFECTS = {
  file: { read: 'read', list: 'read', stat: 'read', search: 'read', write: 'mutate', edit: 'mutate' },
  memory: effects(SLATE_MEMBER_IMPACTS.memory),
  tasks: { ...effects(SLATE_MEMBER_IMPACTS.tasks), mode: 'mutate' },
  web: { search: 'read', fetch: 'mutate', screenshot: 'mutate' },
  agents: { list: 'read', swarm: 'mutate', hire: 'mutate', msg: 'mutate', dismiss: 'mutate' },
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

  if (address.namespace === 'ai' && address.member === 'run') return 'execute';

  return namespaceMemberImpact(address.namespace, address.member);
}
