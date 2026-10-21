/**
 * What `agents.list` shows: the caller's own subtree of the workspace's agents, from the read model the person's sidebar
 * draws (`readWorkspaceAgents`), so the tool and the sidebar read one walk. Main's subtree is the whole workspace; a
 * hire's is itself and what it started. The order and the cap are OMP's hub roster's: running before idle before
 * retired, each by its last activity, 32 rows unless asked for more, and what is retired only when asked.
 */
import type { AgentActivity, PanelAgent } from '../read-models/workspace-agents';
import type { EventLog } from '../events/hub/log';
import { timeAgo } from '../utils/format';

export const AGENT_TREE_LIMIT = 32;

export const AGENT_TREE_MAX = 200;

type TreeStatus = 'running' | 'waiting on the owner' | 'idle' | 'failed' | 'done' | 'stopped' | 'dismissed';

const STATUS: Record<AgentActivity, TreeStatus> = {
  working: 'running', waiting: 'waiting on the owner', idle: 'idle', failed: 'failed', done: 'done', stopped: 'stopped', dismissed: 'dismissed',
};

/** Siblings run first, then wait on the owner, rest, and failed; what retired comes last. */
const RANK: Record<AgentActivity, number> = { working: 0, waiting: 1, idle: 2, failed: 3, done: 4, stopped: 4, dismissed: 4 };

const RETIRED_RANK = 4;

const KIND: Record<PanelAgent['category'], string> = { main: 'main', user: 'chat', hired: 'hired', swarm: 'swarm worker', background: 'background' };

/** One agent, after the one that started it, `depth` levels below Main. */
interface AgentTreeRow {
  /** What `agents` addresses it by; a swarm worker, which takes no messages, by its task. */
  readonly name: string;
  readonly title?: string;
  readonly kind: string;
  readonly status: TreeStatus;
  readonly depth: number;
  readonly active?: string;
  readonly doing?: string;
  /** Its reports to the caller that no turn of the caller's has read yet. */
  readonly unreadReports?: number;
  readonly you?: true;
}

export interface AgentTreeView {
  readonly tree: readonly AgentTreeRow[];
  readonly counts: {
    readonly running: number;
    readonly waiting: number;
    readonly idle: number;
    readonly failed: number;
    readonly retired: number;
    readonly shown: number;
    readonly notShown: number;
  };
  readonly note?: string;
}

/** The reports each child sent that no turn of its hirer's has read yet, by the child's name. */
export function unreadReports(events: Pick<EventLog, 'pending'>): ReadonlyMap<string, number> {
  const unread = new Map<string, number>();

  // Every one: the default is a drain's batch, not a count.
  for (const event of events.pending({ variant: 'subagent_report', limit: Number.MAX_SAFE_INTEGER })) {
    if (event.variant === 'subagent_report' && (event.payload_visibility === 'full' || event.payload_visibility === 'redact')) {
      unread.set(event.payload.from_subagent, (unread.get(event.payload.from_subagent) ?? 0) + 1);
    }
  }

  return unread;
}

/** Dismissed, or a swarm worker whose search let it go. */
function retiredAgent(agent: PanelAgent): boolean {
  return agent.activity === 'dismissed' || (agent.category === 'swarm' && agent.activity !== 'working');
}

function nameOf(agent: PanelAgent): string {
  if (agent.category === 'main') return 'main';

  return agent.open.kind === 'chat' && agent.open.path !== null ? agent.open.path.split('/').at(-1) ?? agent.label : agent.label;
}

/**
 * The subtree under `owner` (`main`, or an agent's actor id), in preorder. `unread` counts the caller's unread reports by
 * the name of the child that sent them.
 */
export function agentTree(input: {
  readonly agents: readonly PanelAgent[];
  readonly owner: string;
  readonly unread: ReadonlyMap<string, number>;
  readonly retired: boolean;
  readonly limit: number;
}): AgentTreeView {
  const children = new Map<string, PanelAgent[]>();
  const byKey = new Map(input.agents.map((agent) => [agent.key, agent]));

  for (const agent of input.agents) {
    if (agent.parent !== null) children.set(agent.parent, [...children.get(agent.parent) ?? [], agent]);
  }

  const lastActive = (agent: PanelAgent): number => agent.figures.lastActiveAt ?? 0;
  const rank = (agent: PanelAgent): number => (retiredAgent(agent) ? RETIRED_RANK : RANK[agent.activity]);

  const ordered = (key: string): PanelAgent[] => [...children.get(key) ?? []]
    .sort((a, b) => rank(a) - rank(b) || lastActive(b) - lastActive(a) || a.label.localeCompare(b.label));

  const depths = new Map<string, number>([['main', 0]]);

  const depthOf = (agent: PanelAgent): number => {
    const known = depths.get(agent.key);

    if (known !== undefined) return known;
    const parent = agent.parent === null ? undefined : byKey.get(agent.parent);
    const depth = parent === undefined ? 0 : depthOf(parent) + 1;
    depths.set(agent.key, depth);

    return depth;
  };

  const row = (agent: PanelAgent): AgentTreeRow => {
    const name = nameOf(agent);
    const unread = agent.parent === input.owner ? input.unread.get(name) ?? 0 : 0;
    const at = agent.figures.lastActiveAt;

    return {
      name,
      ...(agent.label.toLowerCase() !== name && agent.category !== 'swarm' && { title: agent.label }),
      kind: KIND[agent.category],
      status: STATUS[agent.activity],
      depth: depthOf(agent),
      ...(agent.activity === 'working' ? { active: 'now' } : at !== undefined && { active: timeAgo(at) }),
      ...(agent.doing !== undefined && { doing: agent.doing.slice(0, 160) }),
      ...(unread > 0 && { unreadReports: unread }),
      ...(agent.key === input.owner && { you: true }),
    };
  };

  const counts = { running: 0, waiting: 0, idle: 0, failed: 0, retired: 0 };
  const listed: AgentTreeRow[] = [];

  const visit = (agent: PanelAgent, own: boolean): void => {
    const gone = retiredAgent(agent);

    if (!own) {
      if (gone) counts.retired += 1;
      else if (agent.activity === 'working') counts.running += 1;
      else if (agent.activity === 'waiting') counts.waiting += 1;
      else if (agent.activity === 'failed') counts.failed += 1;
      else counts.idle += 1;
    }

    // Retired, it is counted and listed only when asked for; what it started is walked all the same.
    if (own || !gone || input.retired) listed.push(row(agent));

    for (const child of ordered(agent.key)) visit(child, false);
  };

  const self = byKey.get(input.owner);

  if (self !== undefined) visit(self, true);
  else for (const child of ordered(input.owner)) visit(child, false);

  const limit = Math.min(Math.max(1, Math.floor(input.limit)), AGENT_TREE_MAX);
  const tree = listed.slice(0, limit);
  const notShown = listed.length - tree.length;
  const unlisted = input.retired ? 0 : counts.retired;

  const notes = [
    ...(notShown > 0 ? [`${String(notShown)} not shown: list({limit}) shows up to ${String(AGENT_TREE_MAX)}`] : []),
    ...(unlisted > 0 ? [`${String(unlisted)} retired not listed: list({retired:true}) lists them`] : []),
  ];

  return {
    tree,
    counts: { ...counts, shown: tree.length, notShown },
    ...(notes.length > 0 && { note: `${notes.join('; ')}.` }),
  };
}
