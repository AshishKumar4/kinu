import * as v from 'valibot';
import { ROOT_DELEGATION_BUDGET, JsonObjectSchema, type JsonObject, type PeersToolDeps, type SubordinateDelivery, type SubordinateHandoff, type SubordinateRosterEntry, type TeamToolDeps } from '../src/index';

interface Call { action: string; input: JsonObject }

function recordCall(calls: Call[], action: string, call: { input: unknown }): void {
  calls.push({ action, input: v.parse(JsonObjectSchema, call.input) });
}

export const rosterEntry: SubordinateRosterEntry = { name: 'researcher', actorReference: null, birth: null, deleteRequested: false, origin: 'agent', status: 'idle', currentTask: null, createdAt: 1000, dismissedAt: null, lifetime: 'durable', taskEventId: null };

interface HandoffEcho {
  action: string;
  input: { name: string };
  delivery: SubordinateDelivery;
  busy: boolean;
}

function echoHandoff(calls: Call[], echo: HandoffEcho) {
  recordCall(calls, echo.action, { input: echo.input });

  return { ok: true as const, name: echo.input.name, ...handoff(echo.delivery, echo.busy) };
}

export const handoff = (delivery: SubordinateDelivery, busy: boolean): SubordinateHandoff => ({
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

export function makeTeam(
  overrides: Partial<TeamToolDeps> = {},
) {
  const calls: Call[] = [];

  const deps: TeamToolDeps = {
    delegation: ROOT_DELEGATION_BUDGET,
    temporary: temporaryPortStub,
    snapshot: () => [rosterEntry],
    list: async () => [rosterEntry],
    create: async (input) => ({
      name: input.name ?? 'researcher',
      displayName: 'Researcher',
      subordinate: { name: input.name ?? 'researcher', displayName: 'Researcher', role: input.role ?? 'task', actorReference: null, birth: null, deleteRequested: false, origin: 'user', status: 'idle', currentTask: null, createdAt: 1, dismissedAt: null, lifetime: 'durable', taskEventId: null },
    }),
    rename: async (input) => {
      recordCall(calls, 'rename', { input });

      return {
        ok: true, name: input.name, displayName: input.displayName,
        subordinate: { ...rosterEntry, name: input.name, displayName: input.displayName },
      };
    },
    recordTitle: async (input) => {
      recordCall(calls, 'recordTitle', { input });

      return { ok: true, name: input.name, displayName: input.displayName, applied: true };
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

