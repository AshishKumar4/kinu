/**
 * One turn is a set of spans joined by `kinu.turn`: admitted, one per model step, each tool run and
 * delegation, and settled. None stays open across an await: on Workers a span still open when the
 * object starts another invocation is force-closed with its attributes dropped (11 of 59 turns on
 * staging, 2026-09-26), and a detached turn's work straddles alarms and messages.
 */
import { expect, test } from 'bun:test';
import { jsonSchema, tool } from 'ai';
import { scriptedTurnModel, type ScriptedTurnResult } from '@kinu.run/test-utils';
import { sessionFixture } from './helpers-session';
import { recoverActorTurns } from '../src/state/actor-host';
import { createAgentsTool, ROOT_DELEGATION_BUDGET, type SubordinateHandoff, type SubordinateRosterEntry, type TeamToolDeps } from '../src/index';
import {
  createAgentTracing, createRecordingTracer,
} from '../src/obs/index';

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
  const tracer = createRecordingTracer();
  const tracing = createAgentTracing({ tracer, isolateGen: 3, selfPath: [], actor: { id: 'root-trace', kind: 'main' } });
  const { deps, messages } = team();

  const tools = {
    file: tool({ description: 'Write a file', inputSchema: jsonSchema({ type: 'object' }), execute: async () => FILE_RESULT }),
    agents: createAgentsTool({ mode: 'build', swarms: true, team: deps }),
  };

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

  const fixture = await sessionFixture({
    model, tools, tracing, actorId: '00000000-0000-4000-8000-000000000003',
  });

  try {
    await fixture.chat.send(TASK, { id: 'turn-trace' });
    expect(messages).toEqual([MESSAGE]);
    expect(fixture.events.filter(event => event.type === 'turn-end')).toHaveLength(1);
    expect(fixture.actor.stores.claims.unsettled(1)).toEqual([]);
  } finally { fixture.close(); }

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
    expect(span.attributes.get('kinu.turn')).toBe('36a55a83331e87fe');
    expect(span.attributes.get('kinu.turn.epoch')).toBe(1);
    expect(span.attributes.get('kinu.duration_ms')).toBeGreaterThanOrEqual(0);
    // The hosted actor, not the object's root, owns every span of its turn.
    expect(span.attributes.get('kinu.actor')).toBe('cc1ea3f2cd703a7c');
    expect(span.attributes.get('kinu.actor_kind')).toBe('subordinate');
    expect(span.exceptions).toEqual([]);
  }

  const values = spans.flatMap((span) => [...span.attributes.values()]).map(String);

  for (const text of [TASK, FILE_TEXT, MESSAGE, ANSWER, 'launch codes', 'researcher', 'plan.txt', 'Plan.', 'turn-trace']) {
    expect(values.filter((value) => value.includes(text))).toEqual([]);
  }
});

test('a turn a dead process left admitted is recorded settled when recovery closes it, once', async () => {
  const tracer = createRecordingTracer();
  const tracing = createAgentTracing({ tracer, isolateGen: 3, selfPath: [], actor: { id: 'root-trace', kind: 'main' } });

  const fixture = await sessionFixture({
    model: scriptedTurnModel({ doGenerate: () => { throw new Error('recovery must not request inference'); } }),
    tracing, actorId: '00000000-0000-4000-8000-000000000004',
  });

  const { actor, seats } = fixture;

  try {
    const admitted = await actor.stores.claims.admit({
      runId: 'run-dead', turnId: 'turn-dead', workMode: 'build',
      context: actor.stores.history.context.selected() ?? actor.stores.history.context.initialize(),
      program: { kind: 'builtin', version: 0, digest: null, build: 'test-build' },
    });

    // The process that admitted it died before its first request was recorded.
    actor.runtime.storage.execRaw("DELETE FROM actor_requests WHERE turn_id = 'turn-dead'");

    expect(await recoverActorTurns(seats.host)).toMatchObject({ failed: ['turn-dead'] });
    expect(await recoverActorTurns(seats.host)).toMatchObject({ failed: [] });

    expect(tracer.opened.map((span) => span.name)).toEqual(['turn.settled']);
    const [settled] = tracer.opened;
    expect(Object.fromEntries(settled?.attributes ?? [])).toMatchObject({
      'kinu.turn': 'dad8e99b8d206857', 'kinu.turn.epoch': admitted.epoch,
      'kinu.turn.outcome': 'error', 'kinu.turn.recovered': true,
      'kinu.actor': 'cd1ea585cc7038e9', 'kinu.actor_kind': 'subordinate',
    });
    expect(settled?.openAcrossAwait).toBe(false);
  } finally {
    fixture.close();
  }
});
