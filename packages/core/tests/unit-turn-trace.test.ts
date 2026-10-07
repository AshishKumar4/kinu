/**
 * One turn is a set of spans joined by `kinu.turn`: admitted, one per model step, each tool run and
 * delegation, and settled. None stays open across an await: on Workers a span still open when the
 * object starts another invocation is force-closed with its attributes dropped (11 of 59 turns on
 * staging, 2026-09-26), and a detached turn's work straddles alarms and messages.
 */
import { expect, test } from 'bun:test';
import { jsonSchema, tool } from 'ai';
import { createTestRuntime, scriptedTurnModel, type ScriptedTurnResult } from '@kinu.run/test-utils';
import { hostedSeatsOver } from './helpers-actor-host';
import { recoverActorTurns } from '../src/state/actor-host';
import {
  createAgentsTool, profileCatalogDigest, resolveTurnProfile, ROOT_DELEGATION_BUDGET,
  type ProfileCatalog, type SubordinateHandoff, type SubordinateRosterEntry, type TeamToolDeps,
} from '../src/index';
import {
  createAgentTracing, createRecordingTracer,
} from '../src/obs/index';
import { analyticsDigest } from '../src/obs/analytics/privacy';

const TASK = 'Write the secret plan to plan.txt, then tell the researcher about it.';

const FILE_TEXT = 'launch codes 7731';

const MESSAGE = 'The plan is written; the launch codes are inside.';

const ANSWER = 'Done: plan written and the researcher told.';

const FILE_RESULT = { ok: true, path: 'plan.txt', note: 'wrote launch codes 7731' };

const roster: SubordinateRosterEntry = {
  name: 'researcher', actorReference: null, birth: null, deleteRequested: false,
  origin: 'agent', status: 'idle', currentTask: null, createdAt: 1,
  dismissedAt: null, lifetime: 'durable', taskEventId: null,
};

/** Only `msg`'s path is exercised: the roster lists the researcher and `message` hands off. */
function team() {
  const messages: string[] = [];
  const handoff = { eventId: 'ev-1', delivery: 'starts_now', phase: { busy: false, lastActivityAt: null, workingOn: null } } satisfies SubordinateHandoff;

  const deps: TeamToolDeps = {
    delegation: ROOT_DELEGATION_BUDGET,
    list: async () => [roster],
    snapshot: () => [roster],
    knows: async (name) => name === roster.name,
    create: async () => ({ name: roster.name, displayName: 'Researcher', subordinate: roster }),
    rename: async (input) => ({ ok: true, name: input.name, displayName: input.displayName, subordinate: roster }),
    recordTitle: async (input) => ({ ok: true, name: input.name, displayName: input.displayName }),
    spawn: async () => ({ name: roster.name, displayName: 'Researcher' }),
    status: async () => ({ roster: [roster] }),
    dismiss: async (input) => ({ ok: true, name: input.name, historyKept: true, stoppedJobs: [] }),
    assign: async (input) => ({ ok: true, name: input.name, ...handoff }),
    message: async (input) => {
      messages.push(input.content);

      return { ok: true, name: input.name, ...handoff };
    },
  };

  return { messages, deps };
}

test('a turn records admitted, each step, tool run and delegation, and settled, each closed where it opens, joined by the turn, with no text', async () => {
  const { rt, testSql } = createTestRuntime();
  const tracer = createRecordingTracer();
  const tracing = createAgentTracing({ tracer, isolateGen: 3, selfPath: [], actor: { id: rt.actor.actorId, kind: 'main' } });
  const seats = hostedSeatsOver({ rt, db: testSql.db, tracing });
  const { actor } = await seats.seat('planner', 'agent');
  const { deps, messages } = team();

  const tools = {
    file: tool({ description: 'Write a file', inputSchema: jsonSchema({ type: 'object' }), execute: async () => FILE_RESULT }),
    agents: createAgentsTool({ mode: 'build', swarms: true, team: deps }),
  };

  const catalog = { roles: { planner: { description: 'Plan', instructions: 'Plan.',
    tier: 'default', preset: 'ideate', allowedTools: ['file', 'agents'] } }, tiers: { default: { model: 'test-model' } } } satisfies ProfileCatalog;

  const inputs = { envelope: { authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog },
    provider: { revision: 'trace-test', availableModels: ['test-model'] } } satisfies Parameters<typeof actor.session.bindProfile>[2];

  const profile = resolveTurnProfile({ ...inputs, roleId: 'planner', workMode: 'build', availableTools: Object.keys(tools), activeSkills: [] });
  let calls = 0;

  const model = scriptedTurnModel({ doGenerate: (): ScriptedTurnResult => {
    const step = calls++;

    const steps: ScriptedTurnResult['content'][] = [
      [{ type: 'tool-call', toolName: 'file', toolCallId: 'call-file', input: JSON.stringify({ action: 'write', path: 'plan.txt', content: FILE_TEXT }) }],
      [{ type: 'tool-call', toolName: 'agents', toolCallId: 'call-msg', input: JSON.stringify({ action: 'msg', agent: 'researcher', message: MESSAGE }) }],
    ];

    const content = steps[step] ?? [{ type: 'text', text: ANSWER }];

    return { content, finishReason: { unified: step < 2 ? 'tool-calls' : 'stop', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] };
  } });

  try {
    const lease = actor.session.beginTurn({ runId: 'run-trace', turnId: 'turn-trace' }, 'build', 0);
    actor.session.bindProfile(lease, profile, inputs);
    await actor.session.openTurnInput(lease, { item: {}, message: { role: 'user', content: TASK }, birthContext: async () => [] });

    try {
      const result = await actor.session.execute(lease, {
        task: TASK, loopVersion: await actor.runtime.identity.scaffold.version(),
        chat: { modelSpec: 'test/model', model, system: 'Plan.', tools }, extensions: [],
        dynamic: () => ({ factsBlock: '' }),
      }, () => {});

      expect(result.failure).toBeNull();
      expect(messages).toEqual([MESSAGE]);
      // As the chat loop does once the answer is durable.
      actor.session.settleTurnClaim(lease, 'completed');
    } finally {
      actor.session.finishTurn(lease);
    }
  } finally {
    seats.host.releaseAll();
    testSql.close();
  }

  const spans = tracer.opened;

  expect(spans.map((span) => span.name)).toEqual([
    'turn.admitted',
    'turn.tool_call', 'turn.step',
    'turn.delegation', 'turn.tool_call', 'turn.step',
    'turn.step',
    'turn.settled',
  ]);

  // Opened and closed in one callback: nothing is left open for another invocation's start to force-close.
  expect(spans.filter((span) => span.openAcrossAwait).map((span) => span.name)).toEqual([]);

  const attribute = (name: string, key: string) => spans.filter((span) => span.name === name).map((span) => span.attributes.get(key));

  expect(attribute('turn.step', 'kinu.step')).toEqual([0, 1, 2]);
  expect(attribute('turn.step', 'gen_ai.response.finish_reasons')).toEqual(['tool-calls', 'tool-calls', 'stop']);
  expect(attribute('turn.step', 'gen_ai.usage.output_tokens')).toEqual([1, 1, 1]);
  expect(attribute('turn.tool_call', 'gen_ai.tool.name')).toEqual(['file', 'agents']);
  expect(attribute('turn.tool_call', 'kinu.step')).toEqual([0, 1]);
  expect(attribute('turn.delegation', 'kinu.delegation.action')).toEqual(['msg']);
  expect(attribute('turn.delegation', 'kinu.step')).toEqual([1]);
  expect(attribute('turn.settled', 'kinu.turn.steps')).toEqual([3]);
  expect(attribute('turn.settled', 'kinu.turn.outcome')).toEqual(['completed']);

  for (const span of spans) {
    // The join: one digested turn id and its epoch on every span, since no span is another's parent.
    expect(span.attributes.get('kinu.turn')).toBe(analyticsDigest('turn-trace'));
    expect(span.attributes.get('kinu.turn.epoch')).toBe(1);
    expect(span.attributes.get('kinu.duration_ms')).toBeGreaterThanOrEqual(0);
    // The hosted actor, not the object's root, owns every span of its turn.
    expect(span.attributes.get('kinu.actor')).toBe(analyticsDigest(actor.handle.actorId));
    expect(span.attributes.get('kinu.actor_kind')).toBe('subordinate');
    expect(span.exceptions).toEqual([]);
  }

  const values = spans.flatMap((span) => [...span.attributes.values()]).map(String);

  for (const text of [TASK, FILE_TEXT, MESSAGE, ANSWER, 'launch codes', 'researcher', 'plan.txt', 'Plan.', 'turn-trace']) {
    expect(values.filter((value) => value.includes(text))).toEqual([]);
  }
});

test('a turn a dead process left admitted is recorded settled when recovery closes it, once', async () => {
  const { rt, testSql } = createTestRuntime();
  const tracer = createRecordingTracer();
  const tracing = createAgentTracing({ tracer, isolateGen: 3, selfPath: [], actor: { id: rt.actor.actorId, kind: 'main' } });
  const seats = hostedSeatsOver({ rt, db: testSql.db, tracing });
  const { actor } = await seats.seat('planner', 'agent');

  try {
    const admitted = await actor.stores.claims.admit({
      runId: 'run-dead', turnId: 'turn-dead', workMode: 'build',
      context: actor.stores.history.context.selected() ?? actor.stores.history.context.initialize(),
      program: { kind: 'builtin', version: 0, digest: null, build: 'test-build' },
    });

    // The process that admitted it died before its first request was recorded.
    testSql.db.exec("DELETE FROM actor_requests WHERE turn_id = 'turn-dead'");

    expect(await recoverActorTurns(seats.host)).toMatchObject({ failed: ['turn-dead'] });
    expect(await recoverActorTurns(seats.host)).toMatchObject({ failed: [] });

    expect(tracer.opened.map((span) => span.name)).toEqual(['turn.settled']);
    const [settled] = tracer.opened;
    expect(Object.fromEntries(settled?.attributes ?? [])).toMatchObject({
      'kinu.turn': analyticsDigest('turn-dead'), 'kinu.turn.epoch': admitted.epoch,
      'kinu.turn.outcome': 'error', 'kinu.turn.recovered': true,
      'kinu.actor': analyticsDigest(actor.handle.actorId), 'kinu.actor_kind': 'subordinate',
    });
    expect(settled?.openAcrossAwait).toBe(false);
  } finally {
    seats.host.releaseAll();
    testSql.close();
  }
});
