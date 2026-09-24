// runHeadInference: the backend-agnostic head loop, driven through the real generateText loop.
import { REAL_CLOCK } from '../src/types/clock';
import { describe, test, expect } from 'bun:test';
import { createTestActors, createTestRuntime, scriptedTurnModel, toolExecute, type ScriptedTurnOptions } from '@kinu.run/test-utils';
import { createTestWorkspace } from './helpers';
import type { LanguageModel, ModelMessage } from 'ai';
import { hostedSeatsOver } from './helpers-actor-host';
import {
  runHeadInference, HeadCapture, buildHeadAccumulatorTools,
  buildHeadSystemPrompt, buildHeadMessages, type HeadInferenceDeps,
} from '../src/heads/head-inference';
import type { Decision, Evidence, HeadInput, SerializedMessage } from '../src/heads/types';
import {
  inheritedContextFromHistory, inheritedContextOmissionNote,
  inheritedContextFromTranscript,
} from '../src/orchestrator/heads-support';
import { SessionHistory } from '../src/session/history';
import { CHAT_SESSION_ID } from '../src/session/transcript-schema';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../src/prompts/evidence-window';
import { defaultLoopOrigin } from '../src/scaffold/bootstrap';

/** One text step, finishReason 'stop', so the head ends in a single step. */
function fakeHeadModel(answer: string, opts?: { throwError?: string; usage?: { inputTokens: number; outputTokens: number } }): LanguageModel {
  const usage = opts?.usage ?? { inputTokens: 10, outputTokens: 20 };

  return scriptedTurnModel({
    provider: 'fake',
    modelId: 'fake-head',
    doGenerate: async () => {
      if (opts?.throwError) throw new Error(opts.throwError);

      return {
        content: answer ? [{ type: 'text', text: answer }] : [],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: {
            total: usage.inputTokens, noCache: usage.inputTokens,
            cacheRead: undefined, cacheWrite: undefined,
          },
          outputTokens: { total: usage.outputTokens, text: usage.outputTokens, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

function headInput(overrides?: Partial<HeadInput>): HeadInput {
  return {
    id: 'h1', rootId: 'r1', parentId: null, depth: 0,
    task: 'analyze the parser', rationale: 'cover the lexer angle',
    mode: 'build',
    inheritedContext: [{ id: 'm1', role: 'user', content: 'the prior user message', createdAt: 1 }],
    budget: { maxDepth: 2, spawnedAt: 2_000_000_000_000 },
    mergeStrategy: 'synthesize',
    loop: defaultLoopOrigin('head'),
    ...overrides,
  };
}

/** A head's deps over a real hosted seat: a head is a logical actor and needs an identity. */
const deps = async (
  model: LanguageModel,
  over?: Partial<HeadInferenceDeps>,
): Promise<HeadInferenceDeps> => {
  const { rt, testSql } = createTestRuntime();
  const seat = await hostedSeatsOver({ rt, db: testSql.db }).seat('head-under-test', 'head');

  return {
    actor: seat.actor, runId: seat.runId, profile: seat.profile, dynamic: seat.dynamic,
    model, tools: {}, capture: new HeadCapture(), clock: REAL_CLOCK, isAborted: () => false, ...over,
    workspaceLayout: over?.workspaceLayout ?? 'shared-workspace',
  };
};

describe('runHeadInference — report assembly', () => {
  test('a completed head: final text → summary, usage summed, steps captured', async () => {
    const report = await runHeadInference(headInput(), await deps(fakeHeadModel('The lexer handles UTF-8 correctly.')));
    expect(report.status).toBe('completed');
    expect(report.summary).toBe('The lexer handles UTF-8 correctly.');
    expect(report.usage).toEqual({ input: 10, output: 20 });
    expect(report.stepCount).toBeGreaterThanOrEqual(1);
    expect(report.id).toBe('h1');
  });

  test('a head summary is the turn\'s answer as the runner selects it, not the last step it saw', async () => {
    // A step cut at the output limit is joined with its continuation, not replaced by it.
    let calls = 0;

    const model = scriptedTurnModel({
      provider: 'fake', modelId: 'fake-head',
      doGenerate: () => {
        const step = calls++;

        return {
          content: [{ type: 'text', text: step === 0 ? 'The lexer handles ' : 'UTF-8 correctly.' }],
          finishReason: { unified: step === 0 ? 'length' : 'stop', raw: undefined },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 20, text: 20, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });

    const report = await runHeadInference(headInput(), await deps(model));
    expect(report.status).toBe('completed');
    expect(calls).toBe(2);
    expect(report.summary).toBe('The lexer handles UTF-8 correctly.');
  });

  test('aborted → status aborted + errorMessage from abortReason', async () => {
    const report = await runHeadInference(
      headInput(),
      await deps(fakeHeadModel('text'), { clock: REAL_CLOCK, isAborted: () => true, abortReason: () => 'operator cancelled' }),
    );

    expect(report.status).toBe('aborted');
    expect(report.errorMessage).toBe('operator cancelled');
  });

  test('model throw → status errored, no steps, message preserved', async () => {
    const report = await runHeadInference(headInput(), await deps(fakeHeadModel('', { throwError: 'model exploded' })));
    expect(report.status).toBe('errored');
    expect(report.errorMessage).toContain('model exploded');
    expect(report.stepCount).toBe(0);
  });

  test('no prose + recorded evidence → summary synthesized from findings', async () => {
    const capture = new HeadCapture();
    capture.recordEvidence({ id: 'e1', kind: 'fact', body: 'Postgres has mature JSONB' });
    capture.recordDecision({ question: 'Which DB?', choice: 'Postgres', rationale: 'JSONB' });
    const report = await runHeadInference(headInput(), await deps(fakeHeadModel(''), { capture }));
    expect(report.status).toBe('completed');
    expect(report.summary).toContain('Postgres');     // synthesizeHeadSummary fallback
    expect(report.evidence).toHaveLength(1);
    expect(report.decisions).toHaveLength(1);
  });
});

describe('buildHeadAccumulatorTools', () => {
  test('record_evidence / record_decision push into the shared capture', async () => {
    const capture = new HeadCapture();
    const tools = buildHeadAccumulatorTools(capture);
    const recordEvidence = toolExecute<Omit<Evidence, 'id'>, string>(tools.record_evidence);
    const recordDecision = toolExecute<Decision, string>(tools.record_decision);
    await recordEvidence({ kind: 'fact', body: 'X holds' });
    await recordDecision({ question: 'q', choice: 'c', rationale: 'r' });
    expect(capture.evidence[0].body).toBe('X holds');
    expect(capture.evidence[0].id).toMatch(/^ev-/);
    expect(capture.decisions[0].choice).toBe('c');
    expect(capture.toolCalls.map((t) => t.name)).toEqual(['record_evidence', 'record_decision']);
  });
});

describe('durable delegated turn opening', () => {
  for (const empty of [false, true]) {
    test(`a fork's first working revision is its seed and survives reopening, empty=${empty}`, async () => {
      const { rt, testSql } = createTestRuntime();
      const seats = hostedSeatsOver({ rt, db: testSql.db });
      const source = await seats.seat('fork-source', 'subordinate');
      const fork = await seats.seat('walked-back-fork', 'subordinate');

      const original: ModelMessage[] = [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second question' },
      ];

      const seed = empty ? [] : original.slice(0, 2);

      try {
        await source.actor.session.restoreHistory(original);
        await fork.actor.session.restoreHistory(seed);
        const selection = fork.actor.stores.history.context.selected();

        if (selection === null) throw new Error('a restored fork must have a selected working context');
        const revisions = fork.actor.stores.history.context.revisions(selection.contextId);
        // Its own log and nothing else: the seed, empty or not, is one authored revision over the initial one.
        expect(revisions.map((row) => row.revision)).toEqual([1, 0]);
        expect((await fork.actor.stores.history.materialize()).messages).toEqual(seed);
        expect((await source.actor.stores.history.materialize()).messages).toEqual(original);

        const reopened = await hostedSeatsOver({ rt, db: testSql.db }).seat('walked-back-fork', 'subordinate');
        await reopened.actor.session.restoreWorkingHistory();
        expect(reopened.actor.session.history).toEqual(seed);
        expect(reopened.actor.stores.history.context.revisions(selection.contextId)).toEqual(revisions);
      } finally {
        testSql.close();
      }
    });
  }

  test('the walk-back is one session method: head, selection, woven blocks and working history move together', async () => {
    const { rt, testSql } = createTestRuntime();
    const seat = await hostedSeatsOver({ rt, db: testSql.db }).seat('walked-back', 'subordinate');
    const { session, stores } = seat.actor;
    const chat = stores.history.transcript(CHAT_SESSION_ID);
    const assertOwner = () => rt.actor.assertCurrent();

    try {
      for (const [ask, answer, text] of [['ask-1', 'answer-1', 'one'], ['ask-2', 'answer-2', 'two']] as const) {
        const input = await stores.history.append({ id: ask, message: { role: 'user', content: text }, origin: 'input', turnId: ask, assertOwner });
        chat.record({ ...await chat.prepareUser({ id: ask, turnId: ask, message: input }), parentId: undefined });
        await stores.history.append({ id: answer, message: { role: 'assistant', content: `${text} answered` }, origin: 'output', turnId: ask, assertOwner });
        chat.appendAssistant(await chat.prepareAssistant({ id: answer, parentId: ask, turnId: ask, runId: ask, parts: [{ messageId: answer, partNo: 0 }], finalText: null }));
      }

      await session.restoreWorkingHistory();
      expect(session.history.map((message) => message.content)).toEqual(['one', 'one answered', 'two', 'two answered']);
      // A block woven against the four-message stream: positioned there, and meaningless anywhere else.
      session.dynamic.weave(session.history, { mode: { workMode: 'build', planSubmission: false } });
      expect(session.dynamic.size).toBe(1);

      // The host's own idle condition is raised inside the same transaction: nothing moves.
      await expect(session.revertConversation(CHAT_SESSION_ID, 'ask-2', () => { throw new Error('a queued turn holds the loop'); }))
        .rejects.toThrow('a queued turn holds the loop');
      expect(chat.ancestry().map((entry) => entry.id)).toEqual(['ask-1', 'answer-1', 'ask-2', 'answer-2']);
      expect(session.dynamic.size).toBe(1);

      await session.revertConversation(CHAT_SESSION_ID, 'ask-2', () => {});
      expect(chat.ancestry().map((entry) => entry.id)).toEqual(['ask-1', 'answer-1']);
      expect(session.history.map((message) => message.content)).toEqual(['one', 'one answered']);
      expect((await stores.history.materialize()).messages.map((message) => message.content)).toEqual(['one', 'one answered']);
      expect(session.dynamic.size).toBe(0);
    } finally {
      testSql.close();
    }
  });

  test('an explicitly empty working revision is authoritative, not a new birth', async () => {
    const { rt, testSql } = createTestRuntime();
    const first = await hostedSeatsOver({ rt, db: testSql.db }).seat('empty-reader', 'subordinate');
    await first.actor.session.restoreHistory([]);
    const restored = await hostedSeatsOver({ rt, db: testSql.db }).seat('empty-reader', 'subordinate');

    try {
      await restored.actor.session.restoreWorkingHistory();

      const report = await runHeadInference(headInput(), {
        ...restored, model: fakeHeadModel('Child answer.'), tools: {}, capture: new HeadCapture(), clock: REAL_CLOCK, isAborted: () => false,
        workspaceLayout: 'shared-workspace',
        framing: { system: 'Read the ledger.', messages: [{ role: 'user', content: 'New assignment.' }] },
        delegation: { assignmentId: 'assignment-a', birthContext: [{ role: 'user', content: 'Do not resurrect this birth prefix.' }] },
      });

      expect(report.status).toBe('completed');
      expect(restored.actor.session.history).toEqual([
        { role: 'user', content: 'New assignment.' },
        { role: 'assistant', content: [{ type: 'text', text: 'Child answer.' }] },
      ]);
    } finally {
      testSql.close();
    }
  });

  test('an exploration re-drive re-seeds its branch instead of appending its inherited prefix again', async () => {
    const input = headInput();
    const execution = await deps(fakeHeadModel('Exploration answer.'));
    expect((await runHeadInference(input, execution)).status).toBe('completed');
    expect((await runHeadInference(input, execution)).status).toBe('completed');
    expect(execution.actor.session.history).toEqual([
      ...buildHeadMessages(input),
      { role: 'assistant', content: [{ type: 'text', text: 'Exploration answer.' }] },
    ]);
  });

  for (const cold of [false, true]) {
    test(`a claim re-drive keeps its assignment once; a distinct equal-text assignment appends, cold=${cold}`, async () => {
      const { rt, testSql } = createTestRuntime();
      const requests: ScriptedTurnOptions[] = [];

      const model = scriptedTurnModel({ doGenerate: (request) => {
        requests.push(request);

        return {
          content: [{ type: 'text', text: 'Prior child answer.' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined } },
          warnings: [],
        };
      } });

      let seat = await hostedSeatsOver({ rt, db: testSql.db }).seat('durable-reader', 'subordinate');

      const run = async (assignmentId: string) => runHeadInference(headInput(), {
        ...seat, model, tools: {}, capture: new HeadCapture(), clock: REAL_CLOCK, isAborted: () => false,
        workspaceLayout: 'shared-workspace',
        framing: { system: 'Read the ledger.', messages: [{ role: 'user', content: 'Check this ledger.' }] },
        delegation: { assignmentId, birthContext: [{ role: 'user', content: 'Frozen birth prefix.' }] },
      });

      try {
        expect((await run('assignment-a')).status).toBe('completed');

        if (cold) seat = await hostedSeatsOver({ rt, db: testSql.db }).seat('durable-reader', 'subordinate');
        expect((await run('assignment-a')).status).toBe('completed');
        expect((await run('assignment-b')).status).toBe('completed');

        const texts = (request: ScriptedTurnOptions | undefined) => request?.prompt.flatMap((message) => message.role === 'system'
          ? [] : message.content.flatMap((part) => part.type === 'text' ? [part.text] : [])) ?? [];

        expect(texts(requests[1]).filter((text) => text === 'Check this ledger.')).toHaveLength(1);
        expect(texts(requests[1])).toContain('Prior child answer.');
        expect(texts(requests[2]).filter((text) => text === 'Check this ledger.')).toHaveLength(2);
        expect(texts(requests[2]).filter((text) => text === 'Frozen birth prefix.')).toHaveLength(1);
      } finally {
        testSql.close();
      }
    });
  }

  test('a staged replacement survives delegation opening and cold restore without resurrecting the birth seed', async () => {
    const { rt, testSql } = createTestRuntime();
    let seat = await hostedSeatsOver({ rt, db: testSql.db }).seat('edited-reader', 'subordinate');
    const model = fakeHeadModel('Child answer.');

    const run = (assignmentId: string, edit: boolean) => runHeadInference(headInput(), {
      ...seat, model, tools: {}, capture: new HeadCapture(), clock: REAL_CLOCK, isAborted: () => false,
      workspaceLayout: 'shared-workspace',
      framing: { system: 'Read the ledger.', messages: [{ role: 'user', content: assignmentId }] },
      delegation: { assignmentId, birthContext: [{ role: 'user', content: 'Original birth prefix.' }] },
      profile: async (input) => {
        if (edit) await seat.actor.session.restoreHistory([{ role: 'user', content: 'Edited working prefix.' }]);

        return seat.profile(input);
      },
    });

    try {
      expect((await run('assignment-a', false)).status).toBe('completed');
      expect((await run('assignment-b', true)).status).toBe('completed');
      seat = await hostedSeatsOver({ rt, db: testSql.db }).seat('edited-reader', 'subordinate');
      expect((await run('assignment-c', false)).status).toBe('completed');
      expect(seat.actor.session.history).toEqual([
        { role: 'user', content: 'Edited working prefix.' },
        { role: 'user', content: 'assignment-b' },
        { role: 'assistant', content: [{ type: 'text', text: 'Child answer.' }] },
        { role: 'user', content: 'assignment-c' },
        { role: 'assistant', content: [{ type: 'text', text: 'Child answer.' }] },
      ]);
    } finally {
      testSql.close();
    }
  });
});

describe('head prompt + messages', () => {
  test('system prompt carries task/rationale/budget; messages carry inherited context', () => {
    const input = headInput();
    const sys = buildHeadSystemPrompt(input);
    expect(sys).toContain('analyze the parser');
    expect(sys).toContain('record_evidence');
    expect(sys).toContain('canonical workspace you were forked from');
    expect(sys).not.toContain('private Nimbus workspace');
    expect(sys).not.toContain('nimbus.*');
    // Inheritance is structural: one message per inherited message, then the task.
    const msgs = buildHeadMessages(input);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: 'user', content: 'the prior user message' });
    expect(msgs[1]).toEqual({ role: 'user', content: 'Now focus on your assigned task: analyze the parser' });
  });

  test('Plan heads are read-only researchers without the top-level submit tool', () => {
    const sys = buildHeadSystemPrompt(headInput({ mode: 'plan' }));

    expect(sys).toContain('In Plan mode');
    expect(sys).toContain('Do not edit, write, or delete files');
    expect(sys).not.toContain('submit_plan');
    expect(sys).not.toContain('release.');
  });
});

describe('buildHeadMessages — a fork inherits real messages, not prose', () => {
  const multiTurn = [
    { id: 'm1', role: 'user', content: 'is the parser sound?', createdAt: 1 },
    { id: 'm2', role: 'assistant', content: 'the lexer looks fine so far', createdAt: 2 },
    { id: 'm3', role: 'user', content: 'check the grammar too', createdAt: 3 },
  ] as const satisfies readonly SerializedMessage[];

  test('one message per inherited message, each carrying its OWN role, task last', () => {
    const msgs = buildHeadMessages(headInput({ inheritedContext: [...multiTurn] }));

    expect(msgs).toHaveLength(multiTurn.length + 1);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user']);

    expect(msgs[1]).toEqual({ role: 'assistant', content: 'the lexer looks fine so far' });

    expect(msgs.at(-1)).toEqual({
      role: 'user',
      content: 'Now focus on your assigned task: analyze the parser',
    });

    for (const [i, inherited] of multiTurn.entries()) {
      expect(msgs[i].content).toBe(inherited.content);
    }
  });

  test('the provider sees the structured conversation, not one user blob', async () => {
    const prompts: Array<Array<{ role: string }>> = [];

    const model = scriptedTurnModel({
      provider: 'fake', modelId: 'fake-head',
      doGenerate: async (options) => {
        prompts.push(options.prompt.map((m) => ({ role: m.role })));

        return {
          content: [{ type: 'text', text: 'done' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });

    const report = await runHeadInference(headInput({ inheritedContext: [...multiTurn] }), await deps(model));

    expect(report.status).toBe('completed');
    expect(prompts).toHaveLength(1);
    expect(prompts[0].map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'user']);
  });

  test("an inherited 'tool' result never reaches the SDK as role:'tool', and keeps its tool identity", () => {
    // role:'tool' needs a matching assistant tool-call id, which a SerializedMessage lacks.
    const msgs = buildHeadMessages(headInput({
      inheritedContext: [{ id: 't1', role: 'tool', content: 'exit status 0', createdAt: 1, toolName: 'shell' }],
    }));

    expect(msgs.map((m) => m.role)).toEqual(['user', 'user']);
    expect(msgs[0].content).toBe('[inherited tool result from shell]\nexit status 0');
  });

  test("an inherited 'system' entry does not become a second system prompt", () => {
    const msgs = buildHeadMessages(headInput({
      inheritedContext: [...inheritedContextOmissionNote(12, 2)],
    }));

    expect(msgs.some((m) => m.role === 'system')).toBe(false);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toContain('10 earlier messages omitted');
  });

  test('an empty inheritance is just the task', () => {
    expect(buildHeadMessages(headInput({ inheritedContext: [] }))).toEqual([
      { role: 'user', content: 'Now focus on your assigned task: analyze the parser' },
    ]);
  });
});

async function seededTranscript(count: number, extra?: (history: SessionHistory) => Promise<void>) {
  const { db, sql, execRaw, vfs } = createTestWorkspace();
  const actor = createTestActors(sql, execRaw).main;

  const history = new SessionHistory({
    sql, actor, transactionSync: (write) => db.transaction(write)(),
    files: async () => ({ vfs, artifactDirectory: '/actor/.kinu/context' }),
  });

  let parentId: string | null = null;

  for (let i = 0; i < count; i++) {
    await history.record(CHAT_SESSION_ID, {
      id: `m${i}`, parentId, origin: i % 2 === 0 ? 'input' : 'output',
      message: { role: i % 2 === 0 ? 'user' : 'assistant', content: `body ${i}` },
    });
    parentId = `m${i}`;
  }

  await extra?.(history);

  return { db, history, transcript: history.transcript(CHAT_SESSION_ID) };
}

/** The inherited-message cap, measured from an over-long transcript rather than restated. */
async function measuredInheritedCap(): Promise<number> {
  const seeded = await seededTranscript(400);
  const inherited = await inheritedContextFromTranscript(seeded.transcript);

  seeded.db.close();
  expect(inherited[0]).toMatchObject({ id: 'ctx-omitted', role: 'system' });

  return inherited.length - 1;
}

describe('inherited context is windowed at READ time, exactly once (C4)', () => {
  test('plain text and SDK text parts inherit the same conversation bytes', () => {
    // An all-text part array serializes to the plain string, so both backends send the same bytes.
    const inherited: SerializedMessage[] = [{ id: 'ctx-0', role: 'user', content: 'Keep cents exact.', createdAt: 0 }];

    expect(inheritedContextFromHistory([{ role: 'user', content: 'Keep cents exact.' }])).toEqual(inherited);
    expect(inheritedContextFromHistory([{ role: 'user', content: [{ type: 'text', text: 'Keep cents exact.' }] }]))
      .toEqual(inherited);
  });
  const cap = EVIDENCE_BUDGETS.inheritedMessage;
  const stored = `HEAD-MARK${'x'.repeat(EVIDENCE_BUDGETS.storedAssistantResponse)}TAIL-MARK`;
  // evidenceWindow keeps both ends plus one disclosure line.
  const bound = cap + 80;

  const seededStoredBody = async (content: string) => seededTranscript(0, async (history) => {
    await history.record(CHAT_SESSION_ID, { id: 'r1', parentId: null, origin: 'output', message: { role: 'assistant', content } });
  });

  test('the transcript read caps each stored body as it builds the digest', async () => {
    const seeded = await seededStoredBody(stored);

    const ctx = await inheritedContextFromTranscript(seeded.transcript);

    expect(ctx).toHaveLength(1);
    expect(ctx[0].content.length).toBeLessThanOrEqual(bound);
    expect(ctx[0].content.length).toBeLessThan(stored.length / 8);
    expect(ctx[0].content.startsWith('HEAD-MARK')).toBe(true);
    expect(ctx[0].content.endsWith('TAIL-MARK')).toBe(true);
    seeded.db.close();
  });

  test('a body within budget passes through byte-identical', async () => {
    const seeded = await seededTranscript(0, async (history) => {
      await history.record(CHAT_SESSION_ID, { id: 'r1', parentId: null, origin: 'input', message: { role: 'user', content: 'short body' } });
    });

    expect((await inheritedContextFromTranscript(seeded.transcript))[0].content).toBe('short body');
    seeded.db.close();
  });

  test('inheritedContextFromHistory caps each live-history body the same way', () => {
    const ctx = inheritedContextFromHistory([{ role: 'assistant', content: stored }], 50);

    expect(ctx).toHaveLength(1);
    expect(ctx[0].content.length).toBeLessThanOrEqual(bound);
    expect(ctx[0].content.startsWith('HEAD-MARK')).toBe(true);
    expect(ctx[0].content.endsWith('TAIL-MARK')).toBe(true);
  });

  test('buildHeadMessages neither expands nor re-windows what the read already capped', async () => {
    const seeded = await seededStoredBody(stored);

    const inheritedContext = await inheritedContextFromTranscript(seeded.transcript);

    seeded.db.close();

    const windowed = inheritedContext[0].content;

    // A second window is observable, so byte identity below detects double application.
    expect(evidenceWindow(windowed, cap)).not.toBe(windowed);

    const msgs = buildHeadMessages(headInput({ inheritedContext }));
    expect(msgs[0]).toEqual({ role: 'assistant', content: windowed });
  });
});

describe('inheritedContextFromTranscript — the canonical store, read once for both hosts', () => {
  test('the newest rows up to the cap, in order, with the omission note core owes a hire', async () => {
    const cap = await measuredInheritedCap();

    // Another session's row: neither inherited nor counted as omitted.
    const seeded = await seededTranscript(cap + 5, async (history) => {
      await history.record('side', { id: 'other', parentId: null, origin: 'input', message: { role: 'user', content: 'elsewhere' } });
    });

    const ctx = await inheritedContextFromTranscript(seeded.transcript);
    expect(ctx[0]).toMatchObject({ id: 'ctx-omitted', role: 'system' });
    expect(ctx[0].content).toContain('5 earlier messages omitted');
    expect(ctx).toHaveLength(cap + 1);
    expect(ctx[1]).toMatchObject({ id: 'm5', role: 'assistant', content: 'body 5' });
    expect(ctx.at(-1)).toMatchObject({ id: `m${cap + 4}` });
    expect(ctx.some((entry) => entry.content === 'elsewhere')).toBe(false);
    seeded.db.close();
  });

  test('a conversation inside the cap carries no note', async () => {
    const seeded = await seededTranscript(1);

    expect(await inheritedContextFromTranscript(seeded.transcript)).toMatchObject([
      { id: 'm0', role: 'user', content: 'body 0' },
    ]);
    seeded.db.close();
  });
});
