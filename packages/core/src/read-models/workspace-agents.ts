import type { SqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { WorkspaceActor } from '../identity/workspace-actors';
import { tableExists } from '../identity/schema';
import { SubordinateRosterStore, subordinateTitle } from '../subordinates/roster';
import { ownerFacingSubordinate } from '../protocol';
import { codenameFor } from '../identity/naming';
import type { SubordinateRosterEntry } from '../delegation/agents-tool';
import { headStatusUnsettled } from '../heads/types';
import { HeadJournal } from '../heads/journal';
import type { HeadRunView } from '../heads/types';
import { actorReadHandle } from './workspace-work';

export type AgentCategory = 'main' | 'user' | 'hired' | 'swarm' | 'background';

export type AgentActivity = 'working' | 'waiting' | 'idle' | 'done' | 'stopped' | 'failed' | 'dismissed';

/** `owner`: its swarm's agent's path; null is main. */
export type AgentOpening =
  | { readonly kind: 'chat'; readonly path: string | null }
  | { readonly kind: 'node'; readonly runId: string; readonly nodeId: string; readonly owner: string | null };

export interface PanelAgent {
  readonly key: string;
  readonly label: string;
  readonly category: AgentCategory;
  readonly activity: AgentActivity;
  readonly parent: string | null;
  readonly open: AgentOpening;
  readonly tab: boolean;
  readonly input: boolean;
}

export function agentActive(agent: Pick<PanelAgent, 'activity'>): boolean {
  return agent.activity === 'working' || agent.activity === 'waiting';
}

const SWARM_RUNS = 20;

function subordinateCategory(entry: SubordinateRosterEntry): AgentCategory {
  if (entry.createdBy === 'user') return 'user';

  return entry.createdBy === 'evolution' ? 'background' : 'hired';
}

/** Working: an open turn claim. */
function subordinateActivity(entry: SubordinateRosterEntry, inTurn: boolean): AgentActivity {
  if (entry.status === 'dismissed') return 'dismissed';

  if (entry.status === 'awaiting_input') return 'waiting';

  return inTurn ? 'working' : 'idle';
}

function headActivity(status: string, runRunning: boolean): AgentActivity {
  if (headStatusUnsettled(status)) return runRunning ? 'working' : 'failed';

  if (status === 'completed') return 'done';

  // Stopped by the owner or with its search, not failed.
  return status === 'aborted' ? 'stopped' : 'failed';
}

/** Parents first: creation times tie. */
function treeOrder(rootId: string, actors: readonly WorkspaceActor[]): WorkspaceActor[] {
  const children = new Map<string, WorkspaceActor[]>();

  for (const row of actors) {
    if (row.kind !== 'subordinate' || row.deletedAt !== null || row.parentActorId === null) continue;
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

interface Walk {
  readonly sql: SqlExecutor;
  readonly exec: SqlExec;
  readonly root: ActorHandle;
  readonly actors: readonly WorkspaceActor[];
  readonly labels: Map<string, string>;
  readonly paths: Map<string, string>;
  readonly handleOf: (row: WorkspaceActor) => ActorHandle;
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

function rosterAgents({ sql, exec, root, actors, labels, paths, handleOf }: Walk): PanelAgent[] {
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
    labels.set(row.actorId, label);
    const category = subordinateCategory(entry);

    agents.push({
      key: row.actorId, label, category, activity: subordinateActivity(entry, turnOpen(sql, row.actorId)), parent: labels.get(row.parentActorId ?? '') ?? null,
      open: { kind: 'chat', path }, tab: row.parentActorId === root.actorId && ownerFacingSubordinate(entry),
      input: category !== 'background',
    });
  }

  return agents;
}

function swarmAgents({ sql, root, actors, labels, paths, handleOf }: Walk): PanelAgent[] {
  const agents: PanelAgent[] = [];

  for (const owner of [root, ...actors.filter((row) => row.kind === 'subordinate' && row.deletedAt === null).map(handleOf)]) {
    const ownerLabel = labels.get(owner.actorId) ?? owner.name;
    const ownerPath = paths.get(owner.actorId) ?? null;

    // Search-tree branches are model calls, not agents.
    for (const run of swarmRuns(sql, owner)) {
      const running = run.status === 'running';
      const nodeLabels = new Map<string, string>();

      for (const node of run.heads) {
        const label = node.task.trim().split('\n')[0]?.slice(0, 80) || node.id;
        nodeLabels.set(node.id, label);

        agents.push({
          key: `${run.rootId}/${node.id}`, label, category: 'swarm', activity: headActivity(node.status, running),
          parent: (node.parentId === null ? undefined : nodeLabels.get(node.parentId)) ?? ownerLabel,
          open: { kind: 'node', runId: run.rootId, nodeId: node.id, owner: ownerPath }, tab: false, input: false,
        });
      }
    }
  }

  return agents;
}

export function readWorkspaceAgents(input: {
  readonly sql: SqlExecutor;
  readonly exec: SqlExec;
  readonly root: ActorHandle;
  readonly rootLabel: string;
  readonly actors: readonly WorkspaceActor[];
}): PanelAgent[] {
  const { sql, root } = input;
  root.assertCurrent();
  const handles = new Map<string, ActorHandle>([[root.actorId, root]]);

  const walk: Walk = {
    ...input, labels: new Map([[root.actorId, input.rootLabel]]), paths: new Map(),
    handleOf: (row) => handles.get(row.actorId) ?? handles.set(row.actorId, actorReadHandle(sql, row)).get(row.actorId) ?? root,
  };

  const hired = tableExists(sql, 'actor_subordinates') ? rosterAgents(walk) : [];
  const swarms = tableExists(sql, 'head_journal') ? swarmAgents(walk) : [];

  return [...hired, ...swarms];
}
