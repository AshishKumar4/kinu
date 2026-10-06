import type { SqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { isSubordinateOrigin, type WorkspaceActor } from '../identity/workspace-actors';
import { tableExists } from '../identity/schema';
import { SubordinateRosterStore, subordinateTitle } from '../subordinates/roster';
import { codenameFor } from '../identity/naming';
import type { SubordinateRosterEntry } from '../delegation/agents-tool';
import { headStatusUnsettled, shownHeadStatus } from '../heads/types';
import { HeadJournal } from '../heads/journal';
import type { HeadRunView } from '../heads/types';
import { actorReadHandle } from './workspace-work';
import { explorationActorKey } from '../identity/actor-key';
import { usageTotal } from '../usage';
import { NO_FIGURES, type AgentFigures } from './agent-figures';
import { EventLog } from '../events/hub/log';

export type AgentCategory = 'main' | 'user' | 'hired' | 'swarm' | 'background';

export type AgentActivity = 'working' | 'waiting' | 'idle' | 'done' | 'stopped' | 'failed' | 'dismissed';

/** `owner`: its swarm's agent's path; null is main. */
export type AgentOpening =
  | { readonly kind: 'chat'; readonly path: string | null }
  | { readonly kind: 'node'; readonly runId: string; readonly nodeId: string; readonly owner: string | null };

/** `parent`: the key of the agent that started this one; `tab`: a chat the person opened, at the top level. */
export interface PanelAgent {
  readonly key: string;
  readonly label: string;
  readonly category: AgentCategory;
  readonly activity: AgentActivity;
  readonly parent: string | null;
  readonly open: AgentOpening;
  readonly tab: boolean;
  readonly input: boolean;
  readonly actorId?: string;
  readonly figures: AgentFigures;
}

const SWARM_RUNS = 20;

function subordinateCategory(entry: SubordinateRosterEntry): AgentCategory {
  if (entry.origin === 'user') return 'user';

  return entry.origin === 'evolution' ? 'background' : 'hired';
}

/** A question only the person can answer outranks a running turn; a failed last turn shows until the next one starts. */
function chatActivity(sql: SqlExecutor, actorId: string, running: boolean): AgentActivity {
  if (asksThePerson(sql, actorId)) return 'waiting';

  if (running) return 'working';

  return lastTurnFailed(sql, actorId) ? 'failed' : 'idle';
}

function asksThePerson(sql: SqlExecutor, actorId: string): boolean {
  return (tableExists(sql, 'deferred_approvals')
      && sql<{ x: number }>`SELECT 1 AS x FROM deferred_approvals WHERE actor_id = ${actorId} AND status = 'queued' LIMIT 1`.length > 0)
    || (tableExists(sql, 'plan_reviews')
      && sql<{ x: number }>`SELECT 1 AS x FROM plan_reviews WHERE actor_id = ${actorId} AND status = 'pending' LIMIT 1`.length > 0);
}

function deviceAsks(sql: SqlExecutor, now: number): boolean {
  return tableExists(sql, 'device_consent_requests')
    && sql<{ x: number }>`SELECT 1 AS x FROM device_consent_requests WHERE expires_at > ${now} LIMIT 1`.length > 0;
}

function lastTurnFailed(sql: SqlExecutor, actorId: string): boolean {
  return tableExists(sql, 'actor_turn_claims')
    && sql<{ outcome: string | null }>`SELECT outcome FROM actor_turn_claims WHERE actor_id = ${actorId} ORDER BY claimed_at DESC LIMIT 1`[0]?.outcome === 'error';
}

function subordinateActivity(sql: SqlExecutor, entry: SubordinateRosterEntry, actorId: string, running: boolean): AgentActivity {
  if (entry.status === 'dismissed') return 'dismissed';

  // A hire's blocked report waits on the agent that hired it; a chat the person opened waits on the person.
  if (entry.status === 'awaiting_input' && entry.origin === 'user') return 'waiting';

  return chatActivity(sql, actorId, running);
}

function headActivity(status: string, errorMessage: string | null, runRunning: boolean): AgentActivity {
  if (headStatusUnsettled(status)) return runRunning ? 'working' : 'failed';

  if (status === 'completed') return 'done';

  return shownHeadStatus(status, errorMessage) === 'stopped' ? 'stopped' : 'failed';
}

/** Parents first: creation times tie. */
function treeOrder(rootId: string, actors: readonly WorkspaceActor[]): WorkspaceActor[] {
  const children = new Map<string, WorkspaceActor[]>();

  for (const row of actors) {
    if (!isSubordinateOrigin(row.origin) || row.deletedAt !== null || row.parentActorId === null) continue;
    children.set(row.parentActorId, [...children.get(row.parentActorId) ?? [], row]);
  }

  const ordered: WorkspaceActor[] = [];

  for (let frontier = [rootId]; frontier.length > 0;) {
    const next = frontier.flatMap((id) => children.get(id) ?? []);
    ordered.push(...next);
    frontier = next.map((row) => row.actorId);
  }

  return ordered;
}

function turnOpen(sql: SqlExecutor, actorId: string): boolean {
  return tableExists(sql, 'actor_turn_claims')
    && sql<{ x: number }>`SELECT 1 AS x FROM actor_turn_claims WHERE actor_id = ${actorId} AND outcome IS NULL LIMIT 1`.length > 0;
}

function turnOwed({ sql, exec, now }: Pick<Walk, 'sql' | 'exec' | 'now'>, actor: ActorHandle): boolean {
  if (!tableExists(sql, 'agent_log')) return false;
  const log = new EventLog(exec, actor);

  return log.pending({ variant: 'subordinate_task', limit: 1 }).length > 0 || log.nextPendingDrainAt(now) === now;
}

interface Walk {
  readonly sql: SqlExecutor;
  readonly exec: SqlExec;
  readonly root: ActorHandle;
  readonly actors: readonly WorkspaceActor[];
  readonly paths: Map<string, string>;
  readonly handleOf: (row: WorkspaceActor) => ActorHandle;
  readonly now: number;
}

/** A running head's run is listed however old. */
function swarmRuns(sql: SqlExecutor, owner: ActorHandle): HeadRunView[] {
  const journal = new HeadJournal(sql, owner);
  const recent = journal.listRuns(SWARM_RUNS);
  const shown = new Set(recent.map((run) => run.rootId));
  const live = sql<{ root_id: string }>`SELECT DISTINCT root_id FROM head_journal WHERE actor_id = ${owner.actorId} AND status = 'running'`;
  const older = live.filter((row) => !shown.has(row.root_id)).map((row) => journal.readRun(row.root_id));

  return [...older.filter((run) => run !== null), ...recent];
}

function rosterAgents({ sql, exec, root, actors, paths, handleOf, now }: Walk): PanelAgent[] {
  const byId = new Map(actors.map((row) => [row.actorId, row]));
  const agents: PanelAgent[] = [];

  for (const row of treeOrder(root.actorId, actors)) {
    const parentRow = row.parentActorId === root.actorId ? null : byId.get(row.parentActorId ?? '');
    const parentPath = parentRow === null ? '' : paths.get(row.parentActorId ?? '');

    if (parentRow === undefined || parentPath === undefined) continue;
    const entry = new SubordinateRosterStore(exec, parentRow === null ? root : handleOf(parentRow)).get(row.name);

    if (entry === null || entry.actorReference?.actorId !== row.actorId) continue;
    const path = parentPath === '' ? row.name : `${parentPath}/${row.name}`;
    const { displayName } = subordinateTitle(entry, handleOf(row).config);
    const label = displayName.trim() === '' ? codenameFor(row.name) : displayName;
    paths.set(row.actorId, path);
    const category = subordinateCategory(entry);

    const running = turnOpen(sql, row.actorId) || turnOwed({ sql, exec, now }, handleOf(row));

    agents.push({
      key: row.actorId, label, category, activity: subordinateActivity(sql, entry, row.actorId, running), parent: row.parentActorId === root.actorId ? 'main' : row.parentActorId,
      open: { kind: 'chat', path }, tab: category === 'user' && row.parentActorId === root.actorId && entry.status !== 'dismissed',
      input: category !== 'background', actorId: row.actorId, figures: NO_FIGURES,
    });
  }

  return agents;
}

function swarmAgents({ sql, root, actors, paths, handleOf }: Walk): PanelAgent[] {
  const agents: PanelAgent[] = [];

  for (const owner of [root, ...actors.filter((row) => isSubordinateOrigin(row.origin) && row.deletedAt === null).map(handleOf)]) {
    const ownerKey = owner.actorId === root.actorId ? 'main' : owner.actorId;
    const ownerPath = paths.get(owner.actorId) ?? null;

    // Search-tree branches are model calls, not agents.
    for (const run of swarmRuns(sql, owner)) {
      const running = run.status === 'running';

      for (const node of run.heads) {
        const label = node.task.trim().split('\n')[0]?.slice(0, 80) || node.id;

        const tokens = usageTotal(node.usage);
        const nodeActor = actors.find((row) => row.origin === 'swarm' && row.parentActorId === owner.actorId && row.name === explorationActorKey(node.id));

        agents.push({
          key: `${run.rootId}/${node.id}`, label, category: 'swarm', activity: headActivity(node.status, node.errorMessage, running),
          parent: node.parentId === null ? ownerKey : `${run.rootId}/${node.parentId}`,
          open: { kind: 'node', runId: run.rootId, nodeId: node.id, owner: ownerPath }, tab: false, input: false,
          ...(nodeActor !== undefined && { actorId: nodeActor.actorId }),
          figures: { ...(tokens !== undefined && { tokens }), activeMs: node.wallClockMs, cacheEma: null },
        });
      }
    }
  }

  return agents;
}

export async function readWorkspaceAgents(input: {
  readonly sql: SqlExecutor;
  readonly exec: SqlExec;
  readonly root: ActorHandle;
  readonly actors: readonly WorkspaceActor[];
  readonly figures: (actorIds: readonly string[]) => ReadonlyMap<string, AgentFigures> | Promise<ReadonlyMap<string, AgentFigures>>;
  /** The root's chat holds a turn. */
  readonly queued: boolean;
}): Promise<PanelAgent[]> {
  const { sql, root } = input;
  root.assertCurrent();
  const handles = new Map<string, ActorHandle>([[root.actorId, root]]);

  const walk: Walk = {
    ...input, paths: new Map(), now: Date.now(),
    handleOf: (row) => handles.get(row.actorId) ?? handles.set(row.actorId, actorReadHandle(sql, row)).get(row.actorId) ?? root,
  };

  const hired = tableExists(sql, 'actor_subordinates') ? rosterAgents(walk) : [];
  const swarms = tableExists(sql, 'head_journal') ? swarmAgents(walk) : [];

  const main: PanelAgent = {
    key: 'main', label: root.config.getChatTitle() ?? 'Main', category: 'main', parent: null,
    // A device's consent request names no actor: it is the workspace's, so Main is the chat that needs the person.
    activity: deviceAsks(sql, walk.now) ? 'waiting' : chatActivity(sql, root.actorId, turnOpen(sql, root.actorId) || input.queued || turnOwed(walk, root)),
    open: { kind: 'chat', path: null }, tab: true, input: true, actorId: root.actorId, figures: NO_FIGURES,
  };

  const listed = [main, ...hired, ...swarms];
  const figures = await input.figures(listed.flatMap((agent) => (agent.actorId === undefined ? [] : [agent.actorId])));

  return listed.map((agent) => {
    const logged = (agent.actorId === undefined ? undefined : figures.get(agent.actorId)) ?? NO_FIGURES;

    return {
      ...agent,
      figures: {
        ...agent.figures,
        ...logged,
        ...(logged.tokens === undefined && agent.figures.tokens !== undefined && { tokens: agent.figures.tokens }),
        activeMs: logged.activeMs || agent.figures.activeMs,
      },
    };
  });
}
