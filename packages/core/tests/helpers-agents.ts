import * as v from 'valibot';
import type { Database } from 'bun:sqlite';
import { ROOT_DELEGATION_BUDGET, JsonObjectSchema, type JsonObject, type PeersToolDeps, type SubagentDelivery, type SubagentHandoff, type SubagentRosterEntry, type TeamToolDeps } from '../src/index';
import { makeExecRaw, makeSql, makeSqlExec } from './helpers';
import { initHeadsTables } from '../src/heads/schema';
import { initSearchTables } from '../src/mcts/schemas';
import { initMctsSearchTable } from '../src/mcts/search-store';
import { initSwarmNodeRecords } from '../src/strategy/swarm-resume';
import { initRunEventTables } from '../src/events/recorder';
import { initAgentFiguresTable, readAgentFigures } from '../src/read-models/agent-figures';
import { initOwnerRequestsTable } from '../src/safety/owner-requests';
import { readWorkspaceAgents } from '../src/read-models/workspace-agents';
import type { ActorHandle } from '../src/identity/actor-handle';
import type { WorkspaceActorDirectory } from '../src/identity/workspace-actors';
import type { EventLog } from '../src/events/hub/log';

interface Call { action: string; input: JsonObject }

function recordCall(calls: Call[], action: string, call: { input: unknown }): void {
  calls.push({ action, input: v.parse(JsonObjectSchema, call.input) });
}

export const rosterEntry: SubagentRosterEntry = { name: 'researcher', actorReference: null, birth: null, deleteRequested: false, origin: 'agent', status: 'idle', currentTask: null, createdAt: 1000, dismissedAt: null, lifetime: 'durable', taskEventId: null };

interface HandoffEcho {
  action: string;
  input: { name: string };
  delivery: SubagentDelivery;
  busy: boolean;
}

function echoHandoff(calls: Call[], echo: HandoffEcho) {
  recordCall(calls, echo.action, { input: echo.input });

  return { ok: true as const, name: echo.input.name, ...handoff(echo.delivery, echo.busy) };
}

export const handoff = (delivery: SubagentDelivery, busy: boolean): SubagentHandoff => ({
  eventId: `evt-${delivery}`,
  delivery,
  phase: { busy, lastActivityAt: 1234, workingOn: busy ? 'reading src/auth.ts' : null },
});

/** Temporary rung port stub; its behaviour is covered by unit-temporary-agents. */
export const temporaryPortStub = {
  start: async () => ({
    status: 'working' as const,
    agent: 'ask-auditor-x',
    lifetime: 'task' as const,
    role: 'auditor',
    answer: 'answered',
    transcript: 'kept' as const,
  }),
  release: async () => {},
  reclaim: () => null,
  answered: () => [],
  forget: () => {},
};

/** A roster no agent has joined yet: its owner alone. */
export const lonelyTree: TeamToolDeps['tree'] = async () => ({
  tree: [{ name: 'main', kind: 'main', status: 'running', depth: 0, active: 'now', you: true }],
  counts: { running: 0, waiting: 0, idle: 0, failed: 0, retired: 0, shown: 1, notShown: 0 },
});

/** What `createTeamToolDeps` reads the tree from as a workspace reads it: the sidebar's read model over this database,
 *  whose event tables the suite has made. */
export function readModelTree(db: Database, world: { readonly main: ActorHandle; readonly directory: WorkspaceActorDirectory }, events: EventLog) {
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);

  for (const init of [initSearchTables, initMctsSearchTable, initHeadsTables, initSwarmNodeRecords, initRunEventTables, initAgentFiguresTable, initOwnerRequestsTable]) init(execRaw);

  return {
    workspaceAgents: async () => await readWorkspaceAgents({
      sql, exec: makeSqlExec(db), root: world.main, actors: world.directory.list({ retired: true }), retained: true,
      figures: (actorIds) => readAgentFigures(sql, actorIds), queued: () => false, chat: () => null,
    }),
    treeOwner: 'main',
    events,
  };
}

/** What `createTeamToolDeps` reads the tree from, for a suite that never lists it. */
export const unlistedTree = { workspaceAgents: async () => [], treeOwner: 'main', events: { pending: () => [] } };

export function makeTeam(
  overrides: Partial<TeamToolDeps> = {},
) {
  const calls: Call[] = [];

  const deps: TeamToolDeps = {
    delegation: ROOT_DELEGATION_BUDGET,
    temporary: temporaryPortStub,
    snapshot: () => [rosterEntry],
    list: async () => [rosterEntry],
    tree: lonelyTree,
    create: async (input) => ({
      name: input.name ?? 'researcher',
      displayName: 'Researcher',
      subagent: { name: input.name ?? 'researcher', displayName: 'Researcher', role: input.role ?? 'task', actorReference: null, birth: null, deleteRequested: false, origin: 'user', status: 'idle', currentTask: null, createdAt: 1, dismissedAt: null, lifetime: 'durable', taskEventId: null },
    }),
    rename: async (input) => {
      recordCall(calls, 'rename', { input });

      return {
        ok: true, name: input.name, displayName: input.displayName,
        subagent: { ...rosterEntry, name: input.name, displayName: input.displayName },
      };
    },
    spawn: async (input) => {
      recordCall(calls, 'spawn', { input });

      return { name: input.name ?? 'researcher', displayName: 'Researcher' };
    },
    assign: async (input) => echoHandoff(calls, {
      action: 'assign', input, delivery: 'queued', busy: true,
    }),
    knows: async () => true,
    status: async (input) => {
      recordCall(calls, 'status', { input });

      return { roster: [rosterEntry] };
    },
    message: async (input) => echoHandoff(calls, {
      action: 'message', input, delivery: 'starts_now', busy: false,
    }),
    dismiss: async (input) => {
      recordCall(calls, 'dismiss', { input });

      return { ok: true, name: input.name, historyKept: input.keepHistory ?? false, stoppedJobs: [] };
    },
    ...overrides,
  };

  return { deps, calls };
}

export function makePeers(overrides: Partial<PeersToolDeps> = {}) {
  const calls: Call[] = [];

  const deps: PeersToolDeps = {
    listPeers: async () => [{ name: 'scout', displayName: 'Scout' }],
    ask: async (input) => {
      recordCall(calls, 'ask', { input });

      return { status: 'replied', from: input.agent, reply: 'answer' };
    },
    send: async (input) => {
      recordCall(calls, 'send', { input });

      return { status: 'delivered', message_id: 'ox1' };
    },
    reply: async (input) => {
      recordCall(calls, 'reply', { input });

      return { ok: true };
    },
    spawnWorkspace: async (input) => {
      recordCall(calls, 'spawn_workspace', { input });

      return { agent: input.name ?? 'specialist', created: true, status: 'replied', from: 'specialist', reply: 'done' };
    },
    ...overrides,
  };

  return { deps, calls };
}

