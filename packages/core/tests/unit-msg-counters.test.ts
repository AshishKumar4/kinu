// Delegation cross-talk counters — `agents.msg.sent`, `agents.msg.received`
// and `agents.msg.write_collision`.
//
// These assert an INSTRUMENT, which is a different job from asserting a
// behaviour: the defect they exist to catch is a counter that quietly stops
// moving while the thing it counts keeps happening. So every test here pins the
// relation between a delivery and its line — same call count, strictly
// increasing sequence — rather than a literal total, because the counters are
// process-scoped by design and a literal would only pin test order.
//
// Delivery itself is pinned next door, in unit-agents-tool.test.ts, and that
// suite is deliberately untouched: an instrument that changed what it measures
// would be worse than no instrument.
import { describe, test, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestRuntime, toolExecute, createTestActorsOver } from '@kinu.run/test-utils';
import {
  createAgentsTool,
  type AgentsToolInput, type AgentsToolDeps,
  type PeersToolDeps, type TeamToolDeps,
  ROOT_DELEGATION_BUDGET,
  type SubordinateDelivery, type SubordinateRosterEntry,
} from '../src/index';
import { createRecordingLogger, setDiagnosticsSink, type RecordedLog } from '../src/obs/index';
import { EventLog, initEventsHubTables } from '../src/events/hub/index';
import { receivePeerMessage } from '../src/events/ingress/peer';
import { TurnFileLedger } from '../src/tools/file-ledger';
import { makeSqlExec } from './helpers';

type ToolResult = object | string | number | boolean | null | undefined;

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

/** Capture diagnostics for the duration of one test. */
function recording() {
  const logger = createRecordingLogger();
  restore = setDiagnosticsSink(logger);

  return logger;
}

function linesFor(logger: { emitted: readonly RecordedLog[] }, event: string): readonly RecordedLog[] {
  return logger.emitted.filter((line) => line.event === event);
}

function agentsTool(deps: Omit<AgentsToolDeps, 'mode'>) {
  const entry = createAgentsTool({ mode: 'build', ...deps });

  return toolExecute<AgentsToolInput, ToolResult>(entry);
}

interface Call { action: string }

function makePeers(overrides: Partial<PeersToolDeps> = {}) {
  const calls: Call[] = [];

  const deps: PeersToolDeps = {
    listPeers: async () => [{ name: 'scout' }],
    ask: async (input) => {
      calls.push({ action: 'ask' });

      return { status: 'replied', from: input.agent, reply: 'answer' };
    },
    send: async () => {
      calls.push({ action: 'send' });

      return { status: 'delivered', message_id: 'ox1' };
    },
    reply: async () => {
      calls.push({ action: 'reply' });

      return { ok: true };
    },
    spawnWorkspace: async (input) => {
      calls.push({ action: 'spawn_workspace' });

      return { agent: input.name ?? 'specialist', created: true, status: 'replied', from: 'specialist', reply: 'done' };
    },
    ...overrides,
  };

  return { deps, calls };
}

const rosterEntry: SubordinateRosterEntry = {
  name: 'researcher', actorReference: null, birth: null, deleteRequested: false,
  createdBy: 'orchestrator', status: 'idle', currentTask: null, createdAt: 1,
  dismissedAt: null, lifetime: 'durable', taskEventId: null,
};

/** A roster whose two handoff verbs answer with one delivery, so a test can
 *  say "this transport deferred" and read the counter's word for it. The
 *  non-handoff members are the contract's, unexercised here. */
function makeTeam(delivery: SubordinateDelivery) {
  const calls: Call[] = [];
  const handoff = { eventId: 'ev-1', delivery, phase: { busy: false, lastActivityAt: null, workingOn: null } };

  const deps: TeamToolDeps = {
    delegation: ROOT_DELEGATION_BUDGET,
    list: async () => [rosterEntry],
    snapshot: () => [rosterEntry],
    knows: async (name) => name === rosterEntry.name,
    create: async () => ({ name: rosterEntry.name, displayName: 'Researcher', subordinate: rosterEntry }),
    rename: async (input) => ({ ok: true, name: input.name, displayName: input.displayName, subordinate: rosterEntry }),
    recordTitle: async (input) => ({ ok: true, name: input.name, displayName: input.displayName }),
    spawn: async () => ({ name: rosterEntry.name, displayName: 'Researcher' }),
    status: async () => ({ roster: [rosterEntry] }),
    dismiss: async (input) => ({ ok: true, name: input.name, historyKept: true }),
    assign: async (input) => {
      calls.push({ action: 'assign' });

      return { ok: true, name: input.name, ...handoff };
    },
    message: async (input) => {
      calls.push({ action: 'message' });

      return { ok: true, name: input.name, ...handoff };
    },
  };

  return { deps, calls };
}

// ── agents.msg.sent ─────────────────────────────────────────────────────────

describe('agents.msg.sent', () => {
  // THE RED PROOF. Delete the `countedMsgSend` wrapper from the peer arm of
  // `dispatchAgentsAction` and the transport still delivers both messages —
  // every existing assertion about delivery stays green — while this one fails
  // on `0 !== 2`. That asymmetry is the whole point: a counter is the one kind
  // of code whose absence is invisible to every other test in the tree.
  test('every peer message delivered moves the counter, once each', async () => {
    const logger = recording();
    const { deps, calls } = makePeers();
    const execute = agentsTool({ peers: deps });

    await execute({ action: 'msg', agent: 'scout', message: 'first' });
    await execute({ action: 'msg', agent: 'scout', message: 'second one' });

    const sent = linesFor(logger, 'agents.msg.sent');
    expect(calls).toHaveLength(2);
    expect(sent).toHaveLength(calls.length);

    expect(sent[0]?.fields).toMatchObject({
      action: 'msg',
      transport: 'peer',
      addressing: 'agent',
      target: 'scout',
      outcome: 'delivered',
      message_id: 'ox1',
      chars: 'first'.length,
    });
    expect(sent[1]?.fields.chars).toBe('second one'.length);

    // Monotone, not a literal: the sequence is process-scoped so only its
    // MOVEMENT is a property of this delivery. An absent field yields NaN and
    // fails, so this cannot be satisfied by a line that carries no sequence.
    const first = Number(sent[0]?.fields.sent);
    expect(first).toBeGreaterThan(0);
    expect(sent[1]?.fields.sent).toBe(first + 1);
  });

  // Each transport answers in its own words; the counter has one vocabulary, so
  // a deferred delivery has to stay distinguishable from a made one no matter
  // which substrate carried it. This is the field the throughput question is
  // actually asked of.
  test('each transport\'s answer maps onto one outcome vocabulary', async () => {
    const logger = recording();

    const queued = makePeers({
      send: async () => ({ status: 'queued', message_id: 'ox9' }),
    });

    const refused = makePeers({
      send: async () => ({ status: 'rejected', reason: 'no grant' }),
    });

    const team = makeTeam('queued');

    await agentsTool({ peers: queued.deps })({ action: 'msg', agent: 'scout', message: 'a' });
    await agentsTool({ peers: refused.deps })({ action: 'msg', agent: 'scout', message: 'b' });
    await agentsTool({ peers: queued.deps })({ action: 'msg', event_id: 'pe1', message: 'c' });
    await agentsTool({ peers: queued.deps })({ action: 'hire', agent: 'scout', message: 'd' });
    await agentsTool({ team: team.deps })({ action: 'msg', agent: 'researcher', message: 'e' });
    await agentsTool({ team: team.deps })({ action: 'hire', agent: 'researcher', message: 'f' });

    expect(linesFor(logger, 'agents.msg.sent').map((line) => [
      line.fields.action, line.fields.transport, line.fields.addressing, line.fields.outcome,
    ])).toEqual([
      ['msg', 'peer', 'agent', 'queued'],
      ['msg', 'peer', 'agent', 'rejected'],
      ['msg', 'peer', 'event', 'delivered'],
      // `replied` and not `delivered`: an ask's wait contains the other agent's
      // whole turn, and folding it in with an enqueue would put a think time
      // and a hand-off in one distribution.
      ['hire', 'peer', 'agent', 'replied'],
      ['msg', 'subordinate', 'agent', 'queued'],
      ['hire', 'subordinate', 'agent', 'queued'],
    ]);
  });

  // A transport that throws is still traffic that was attempted, and it is the
  // most interesting kind: a counter that only counted successes would report a
  // wedged peer as silence.
  test('a throwing transport is counted as failed and still throws', async () => {
    const logger = recording();
    const { deps } = makePeers({ send: async () => { throw new Error('hub down'); } });

    await expect(agentsTool({ peers: deps })({ action: 'msg', agent: 'scout', message: 'x' }))
      .rejects.toThrow('hub down');

    expect(linesFor(logger, 'agents.msg.sent')[0]?.fields).toMatchObject({
      outcome: 'failed', target: 'scout', message_id: '',
    });
  });

  // The rule the whole lane is built under: count it and time it, never record
  // it. Asserted over every field of every line rather than over the one field
  // that looked risky, because the next field added is the one that leaks.
  test('no counter line carries a word of the message', async () => {
    const logger = recording();
    const secret = 'the-body-nobody-may-log';
    const { deps } = makePeers();
    const team = makeTeam('starts_now');
    const execute = agentsTool({ peers: deps, team: team.deps });

    await execute({ action: 'msg', agent: 'scout', message: secret });
    await execute({ action: 'msg', agent: 'researcher', message: secret });
    await execute({ action: 'msg', event_id: 'pe1', message: secret });
    await execute({ action: 'hire', agent: 'scout', message: secret });

    const lines = linesFor(logger, 'agents.msg.sent');
    expect(lines).toHaveLength(4);

    for (const line of lines) {
      for (const value of Object.values(line.fields)) {
        expect(String(value)).not.toContain(secret);
      }

      // …and the size IS recorded, so "nothing leaked" cannot be satisfied by
      // an instrument that recorded nothing at all.
      expect(line.fields.chars).toBe(secret.length);
    }
  });
});

// ── agents.msg.received ─────────────────────────────────────────────────────

describe('agents.msg.received', () => {
  function receiver() {
    const db = new Database(':memory:');
    const sql = makeSqlExec(db);
    initEventsHubTables(sql);
    const { rt } = createTestRuntime();

    return {
      log: new EventLog(sql, createTestActorsOver(db).main),
      vfs: rt.storage.vfs,
    };
  }

  function inbound(id: string) {
    return {
      sender_event_id: id,
      sender_agent_name: 'scout',
      sender_user_id: 'u1',
      topic: 'research',
      body: { text: 'hello' },
      mode: 'build' as const,
    };
  }

  // The arrival half. Without it `sent` has no comparand and the queue wait
  // before delivery is unobservable: the sender's own line stops at `queued`.
  test('an admitted message is counted, carrying the sender id both lines join on', async () => {
    const logger = recording();
    const deps = { ...receiver(), isSameOwner: async () => true, hasGrant: async () => true };

    const result = await receivePeerMessage(deps, inbound('ox-join'), 1_000);

    expect(result.admitted).toBe(true);
    const received = linesFor(logger, 'agents.msg.received');
    expect(received).toHaveLength(1);
    expect(received[0]?.fields).toMatchObject({
      from: 'scout', topic: 'research', message_id: 'ox-join', admitted: true,
    });
    expect(received[0]?.fields.chars).toBe(JSON.stringify({ text: 'hello' }).length);
  });

  // A refused message is traffic that arrived and was turned away — the exact
  // shape a cross-owner fan-out produces, and a counter that dropped it would
  // report a rejected flood as an idle transport.
  test('a message refused for want of a grant is still counted, as not admitted', async () => {
    const logger = recording();
    const deps = { ...receiver(), isSameOwner: async () => false, hasGrant: async () => false };

    const result = await receivePeerMessage(deps, inbound('ox-denied'), 1_000);

    expect(result.admitted).toBe(false);
    expect(linesFor(logger, 'agents.msg.received')[0]?.fields).toMatchObject({
      message_id: 'ox-denied', admitted: false,
    });
  });
});

// ── agents.msg.write_collision ──────────────────────────────────────────────

describe('agents.msg.write_collision', () => {
  // The shared-workspace hire condition, measured rather than assumed: two
  // agents seated on one workspace, both applying an edit to one path with
  // nothing between them. One ledger per actor is what makes "a different
  // agent" answerable at the write.
  test('two agents applying an edit to one path is one counted collision', () => {
    const logger = recording();
    const first = new TurnFileLedger();
    const second = new TurnFileLedger();
    const path = 'src/collision/two-agents.ts';

    first.recordEdit(path, null);
    second.recordEdit(path, null);

    const lines = linesFor(logger, 'agents.msg.write_collision');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields.path).toBe(path);
    expect(lines[0]?.fields.writer).not.toBe(lines[0]?.fields.other);
    expect(Number(lines[0]?.fields.gap_ms)).toBeGreaterThanOrEqual(0);
  });

  // One agent editing then fixing its own file is the ordinary shape of work.
  // Counting it would bury the real signal under every multi-step edit in the
  // tree, which is how a contention counter becomes one nobody reads.
  test('an agent rewriting its own file is not a collision', () => {
    const logger = recording();
    const only = new TurnFileLedger();
    const path = 'src/collision/same-agent.ts';

    only.recordEdit(path, null);
    only.recordEdit(path, null);
    only.recordEdit(path, null);

    expect(linesFor(logger, 'agents.msg.write_collision')).toHaveLength(0);
  });

  // A refused edit changed no bytes, so there is nothing for the next agent to
  // have failed to see.
  test('an edit that never landed cannot collide', () => {
    const logger = recording();
    const first = new TurnFileLedger();
    const second = new TurnFileLedger();
    const path = 'src/collision/refused.ts';

    first.recordEdit(path, 'stale');
    second.recordEdit(path, null);
    first.recordEdit(path, 'unread');

    expect(linesFor(logger, 'agents.msg.write_collision')).toHaveLength(0);
  });
});
