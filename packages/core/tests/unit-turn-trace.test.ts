/** One turn is one span tree: the turn, its model call, each tool run, and a delegation under the tool that made it. */
import { expect, test } from 'bun:test';
import { jsonSchema, tool } from 'ai';
import { createTestRuntime, scriptedTurnModel, type ScriptedTurnResult } from '@kinu.run/test-utils';
import { hostedSeatsOver } from './helpers-actor-host';
import {
  createAgentsTool, profileCatalogDigest, resolveTurnProfile, ROOT_DELEGATION_BUDGET,
  type ProfileCatalog, type SubordinateHandoff, type SubordinateRosterEntry, type TeamToolDeps,
} from '../src/index';
import {
  createAgentTracing, createRecordingTracer, SPAN_ATTR_ERROR,
} from '../src/obs/index';
import { analyticsDigest } from '../src/obs/analytics/privacy';

const TASK = 'Write the secret plan to plan.txt, then tell the researcher about it.';

const FILE_TEXT = 'launch codes 7731';

const MESSAGE = 'The plan is written; the launch codes are inside.';

const ANSWER = 'Done: plan written and the researcher told.';

const FILE_RESULT = { ok: true, path: 'plan.txt', note: 'wrote launch codes 7731' };

const roster: SubordinateRosterEntry = {
  name: 'researcher', actorReference: null, birth: null, deleteRequested: false,
  createdBy: 'orchestrator', status: 'idle', currentTask: null, createdAt: 1,
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
    dismiss: async (input) => ({ ok: true, name: input.name, historyKept: true }),
    assign: async (input) => ({ ok: true, name: input.name, ...handoff }),
    message: async (input) => {
      messages.push(input.content);

      return { ok: true, name: input.name, ...handoff };
    },
  };

  return { messages, deps };
}

test('a turn with a model call, a tool call and a delegation records one tree, with the actor on every span and no text', async () => {
  const { rt, testSql } = createTestRuntime();
  const tracer = createRecordingTracer();
  const tracing = createAgentTracing({ tracer, isolateGen: 3, selfPath: [], actor: { id: rt.actor.actorId, kind: 'main' } });
  const seats = hostedSeatsOver({ rt, db: testSql.db, tracing });
  const { actor } = await seats.seat('planner', 'subordinate');
  const { deps, messages } = team();

  const tools = {
    file: tool({ description: 'Write a file', inputSchema: jsonSchema({ type: 'object' }), execute: async () => FILE_RESULT }),
    agents: createAgentsTool({ mode: 'build', team: deps }),
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
        chat: { model, system: 'Plan.', tools }, extensions: [],
        dynamic: () => ({ factsBlock: '' }),
      }, () => {});

      expect(result.failure).toBeNull();
      expect(messages).toEqual([MESSAGE]);
    } finally {
      actor.session.finishTurn(lease);
    }
  } finally {
    seats.host.releaseAll();
    testSql.close();
  }

  const spans = tracer.opened;
  const tree = spans.map((span) => [span.name, span.parent === null ? null : spans[span.parent]?.name]);

  expect(tree).toEqual([
    ['turn', null],
    ['turn.model_call', 'turn'],
    ['turn.tool_call', 'turn.model_call'],
    ['turn.tool_call', 'turn.model_call'],
    ['turn.delegation', 'turn.tool_call'],
  ]);

  const toolNames = spans.filter((span) => span.name === 'turn.tool_call').map((span) => span.attributes.get('gen_ai.tool.name'));
  expect(toolNames).toEqual(['file', 'agents']);
  expect(spans[4]?.attributes.get('kinu.delegation.action')).toBe('msg');
  expect(spans[1]?.attributes.get('kinu.model.steps')).toBe(3);

  // The hosted actor, not the object's root, owns every span of its turn.
  for (const span of spans) {
    expect(span.attributes.get('kinu.actor')).toBe(analyticsDigest(actor.handle.actorId));
    expect(span.attributes.get('kinu.actor_kind')).toBe('subordinate');
    expect(span.attributes.has(SPAN_ATTR_ERROR)).toBe(false);
  }

  const values = spans.flatMap((span) => [...span.attributes.values()]).map(String);

  for (const text of [TASK, FILE_TEXT, MESSAGE, ANSWER, 'launch codes', 'researcher', 'plan.txt', 'Plan.']) {
    expect(values.filter((value) => value.includes(text))).toEqual([]);
  }
});
