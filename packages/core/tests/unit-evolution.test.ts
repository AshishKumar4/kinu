/** EvolutionEngine: turn-level evolution rated from the user's next message. */

import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import { createTestRuntime } from './helpers';
import { seedTranscriptEntry, createTestActors } from '@kinu.run/test-utils';
import { EvolutionEngine } from '../src/evolution/engine';
import type { EvolutionEvent, CompletedTurn, CompletedSession } from '../src/evolution/types';
import { DELEGATION_RUBRIC } from '../src/evolution/delegation-features';
import { listLessons, recordLesson, renderRecentLessons } from '../src/evolution/outcomes';
import { listTurnRatings, recordTurnRating } from '../src/evolution/ratings';
import type { DecisionPort } from '../src/providers/decision-model';
import type { AgentRuntime } from '../src/types/agent-runtime';
import { initSearchTables } from '../src/mcts/schemas';
import { initScaffoldTables } from '../src/scaffold/schemas';

function makeTurn(overrides: Partial<CompletedTurn> = {}): CompletedTurn {
  return {
    userMessage: 'how do I rotate the API keys for the staging cluster?',
    assistantResponse: 'test response that is long enough to have substance in it for quality assessment',
    toolCalls: [],
    steps: 1,
    durationMs: 5000,
    feedback: null,
    hadError: false,
    turnId: 'msg-1',
    sessionId: 'default',
    origin: 'user',
    ...overrides,
  };
}

/** The decision model's answer for a reply that accepts, corrects, or gives up on the turn. */
const READS = {
  accepted: { score: 3.6, corrected: 0.05, wrong: 'nothing' },
  corrected: { score: 0.5, corrected: 0.95, wrong: 'misunderstood' },
  frustrated: { score: 0.1, corrected: 0.9, wrong: 'incorrect' },
} as const;

/** Rates every reply as `read`, counting the calls. */
function ratedAs(rt: AgentRuntime, read: keyof typeof READS) {
  let calls = 0;
  const answer = READS[read];

  const decide: DecisionPort = async () => {
    calls++;

    return {
      satisfaction: { type: 'score', score: answer.score },
      corrected: { type: 'noul', noul: answer.corrected },
      wrong: { type: 'choice', choice: answer.wrong },
    };
  };

  rt.decide = decide;

  return { calls: () => calls };
}

describe('EvolutionEngine.reviewTurn — the rating signal', () => {
  test('a correcting reply: rated low, feedback negative, reflects into the corroborated ledger', async () => {
    const { rt, stores } = createTestRuntime();
    ratedAs(rt, 'corrected');
    const prompts: string[] = [];
    const complete = rt.llm.complete.bind(rt.llm);
    rt.llm.complete = async (prompt: string) => {
      prompts.push(prompt);

      return complete(prompt);
    };

    const engine = new EvolutionEngine(rt, stores.history);
    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    const turn = makeTurn({ steps: 41, durationMs: 372_000 });
    await engine.reviewTurn(turn, 'No — that rotates production keys. I said STAGING.');

    expect(turn.feedback).toBe('negative');
    const rows = listTurnRatings(rt.storage.sql, rt.actor);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ turnId: 'msg-1', source: 'model', score: 1.5, wrong: 'misunderstood' });
    expect(events.some(e => e.type === 'reflection')).toBe(true);
    // The user's correction ⇒ the lesson is corroborated and durable.
    expect(listLessons(rt.storage.sql, rt.actor, { status: 'corroborated' })).toHaveLength(1);
    // …through the derived view, not a MEMORY.md copy.
    expect(renderRecentLessons(rt.storage.sql, rt.actor)).not.toBe('');
    const reflectionPrompt = prompts.find((prompt) => prompt.includes('In one sentence')) ?? '';
    expect(reflectionPrompt).toContain('rated 1.5/5 by the user\'s reply; what went wrong: misunderstood');
    expect(reflectionPrompt).toContain(
      'Turn process: 41 sequential steps, 0 hiring, 0 exploration, 0 messaging, 0 eval, 6.2min wall clock',
    );
    // One shared rubric string for both reflection prompts.
    expect(reflectionPrompt).toContain(DELEGATION_RUBRIC);
    expect(reflectionPrompt).toContain('is a lesson to decompose the work and delegate it');
    expect(reflectionPrompt).toContain('An accepted turn that hired or explored effectively earns credit');
    expect(reflectionPrompt).toContain('Spawns that contributed nothing are delegation overhead');
  });

  test('an accepting reply: positive feedback, no reflection, extracts a pattern from tool use', async () => {
    const { rt, stores } = createTestRuntime({
      llmResponses: {
        'Extract a reusable pattern': '{"name":"compute_value","description":"Execute code and return result","params":{"type":"object","properties":{"code":{"type":"string"}},"required":["code"]},"code":"async (args) => { return args.code; }"}',
      },
    });

    ratedAs(rt, 'accepted');

    const engine = new EvolutionEngine(rt, stores.history);
    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    const turn = makeTurn({
      toolCalls: [{ name: 'eval', args: { code: 'return 42' }, result: 42 }],
    });

    await engine.reviewTurn(turn, 'great, now do the same for the prod cluster');

    expect(turn.feedback).toBe('positive');
    expect(events.filter(e => e.type === 'reflection')).toHaveLength(0);
    expect(events.some(e => e.type === 'craft_discovered')).toBe(true);
    expect(listTurnRatings(rt.storage.sql, rt.actor)[0]?.score).toBeCloseTo(4.6);
  });

  test('craft EMA moves on ratings: a low one pushes a tool score down, a high one up', async () => {
    const { rt, stores } = createTestRuntime();
    ratedAs(rt, 'corrected');
    void rt.storage.sql`INSERT INTO crafted_tools (name, score, uses, last_used_at)
        VALUES ('my_crafted_tool', 0.5, 1, ${Date.now()})`;
    const engine = new EvolutionEngine(rt, stores.history);

    const turn = makeTurn({
      toolCalls: [{ name: 'eval', args: {}, result: 'x' }],
      craftedToolsUsed: ['my_crafted_tool'],
    });

    await engine.reviewTurn(turn, 'wrong again — that broke the deploy');

    const after = rt.storage.sql<{ score: number }>`
      SELECT score FROM crafted_tools WHERE name = 'my_crafted_tool'`[0];

    expect(after.score).toBeLessThan(0.5);

    const { rt: rt2, stores: stores2 } = createTestRuntime({ llmResponses: { 'Extract a reusable pattern': 'not json' } });
    ratedAs(rt2, 'accepted');

    void rt2.storage.sql`INSERT INTO crafted_tools (name, score, uses, last_used_at)
        VALUES ('my_crafted_tool', 0.5, 1, ${Date.now()})`;
    const engine2 = new EvolutionEngine(rt2, stores2.history);
    await engine2.reviewTurn(makeTurn({
      toolCalls: [{ name: 'eval', args: {}, result: 'x' }],
      craftedToolsUsed: ['my_crafted_tool'],
    }), 'thanks, that worked — next please deploy it');

    const after2 = rt2.storage.sql<{ score: number }>`
      SELECT score FROM crafted_tools WHERE name = 'my_crafted_tool'`[0];

    expect(after2.score).toBeGreaterThan(0.5);
  });

  test('an MCP tool call is not a crafted-tool use and scores nothing', async () => {
    // Crafted tools are codemode-only, so the EMA must come from the turn record.
    const { rt, stores } = createTestRuntime();
    ratedAs(rt, 'corrected');
    const engine = new EvolutionEngine(rt, stores.history);
    await engine.reviewTurn(makeTurn({
      toolCalls: [{ name: 'mcp__github__create_issue', args: {}, result: 'x' }],
      craftedToolsUsed: [],
    }), 'wrong again — that broke the deploy');
    expect(rt.storage.sql`SELECT name FROM crafted_tools WHERE uses > 0`).toEqual([]);
  });

  test('trivial turn (greeting): no model call, no rating, no events', async () => {
    let llmCalls = 0;
    const { rt, stores } = createTestRuntime();
    const rated = ratedAs(rt, 'corrected');
    const realComplete = rt.llm.complete.bind(rt.llm);
    rt.llm.complete = async (prompt: string) => {
      llmCalls++;

      return realComplete(prompt);
    };

    const engine = new EvolutionEngine(rt, stores.history);
    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    await engine.reviewTurn(makeTurn({ userMessage: 'thanks!', assistantResponse: 'You are welcome!' }), 'now another thing');
    expect(llmCalls + rated.calls()).toBe(0);
    expect(listTurnRatings(rt.storage.sql, rt.actor)).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  test('no follow-up: no rating at all — an absent reply is not a neutral one', async () => {
    const { rt, stores } = createTestRuntime();
    const rated = ratedAs(rt, 'accepted');
    const engine = new EvolutionEngine(rt, stores.history);
    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    const clean = makeTurn();
    await engine.reviewTurn(clean, null);
    expect(clean.feedback).toBeNull();
    expect(rated.calls()).toBe(0);
    expect(listTurnRatings(rt.storage.sql, rt.actor)).toHaveLength(0);
    expect(events.filter(e => e.type === 'reflection')).toHaveLength(0);
    // The unrated turn is still visible, not counted as a win.
    const complete = events.filter(e => e.type === 'turn_complete');
    expect(complete).toHaveLength(1);
    expect(complete[0].message).toContain('unrated');
    const completionData = v.parse(v.object({ rated: v.boolean(), source: v.nullable(v.string()) }), complete[0].data);
    expect(completionData.rated).toBe(false);
    expect(completionData.source).toBeNull();
  });

  // A tool that exited cleanly is not a user who was served: tool work alone rates nothing and mints nothing.
  // Both directions are asserted, since a guard refusing every promotion passes the first half.
  test('tool work with no reply is unrated and promotes no procedure; the same turn rated high does', async () => {
    const pattern = JSON.stringify({
      name: 'rotate_deploy_keys', description: 'rotate staging keys',
      params: { type: 'object', properties: {}, required: [] },
      code: 'async (args) => ({ ok: true })',
    });

    const acted: Partial<CompletedTurn> = {
      toolCalls: [{ name: 'shell', args: { command: 'bun test' }, result: 'ok', outcome: { success: true } }],
    };

    const headless = createTestRuntime({ llmResponses: { 'Extract a reusable pattern': pattern } });
    ratedAs(headless.rt, 'accepted');
    const turn = makeTurn({ turnId: 'exec-promote', ...acted });
    await new EvolutionEngine(headless.rt, headless.stores.history).reviewTurn(turn, null);
    expect(turn.feedback).toBeNull();
    expect(listTurnRatings(headless.rt.storage.sql, headless.rt.actor)).toEqual([]);
    expect(headless.rt.storage.sql<{ n: number }>`SELECT COUNT(*) AS n FROM crafted_tools`[0]?.n).toBe(0);
    expect(headless.rt.storage.sql<{ n: number }>`SELECT COUNT(*) AS n FROM pattern_extractions`[0]?.n).toBe(0);

    const asked = createTestRuntime({ llmResponses: { 'Extract a reusable pattern': pattern } });
    ratedAs(asked.rt, 'accepted');

    await new EvolutionEngine(asked.rt, asked.stores.history).reviewTurn(
      makeTurn({ turnId: 'graded-promote', ...acted }), 'perfect, thanks',
    );
    expect(asked.rt.storage.sql<{ name: string }>`SELECT name FROM crafted_tools`.map((r) => r.name))
      .toEqual(['rotate_deploy_keys']);
  });

  test('a turn that errored with no reply writes nothing: no rating, no lesson', async () => {
    const { rt, stores } = createTestRuntime();
    ratedAs(rt, 'corrected');
    const engine = new EvolutionEngine(rt, stores.history);

    await engine.reviewTurn(makeTurn({
      turnId: 'exec-2', hadError: true,
      toolCalls: [{ name: 'shell', args: { command: 'bun test' }, result: { error: 'exit 1' } }],
    }), null);

    expect(listTurnRatings(rt.storage.sql, rt.actor)).toEqual([]);
    expect(listLessons(rt.storage.sql, rt.actor)).toEqual([]);
  });

  test('a decision model failure records nothing and fails the review, to be retried', async () => {
    const { rt, stores } = createTestRuntime();
    rt.decide = async () => ({ satisfaction: { type: 'score', score: 2 } });
    const engine = new EvolutionEngine(rt, stores.history);
    const turn = makeTurn();

    await expect(engine.reviewTurn(turn, 'hmm, interesting')).rejects.toThrow('left a rating question unanswered');
    expect(turn.feedback).toBeNull();
    expect(listTurnRatings(rt.storage.sql, rt.actor)).toHaveLength(0);
  });

  test("a thumb beats the decision model (no model call) and rides the same ledger", async () => {
    let llmCalls = 0;
    const { rt, stores } = createTestRuntime();
    const rated = ratedAs(rt, 'corrected');
    rt.llm.complete = async () => {
      llmCalls++;

      return 'unused';
    };

    const engine = new EvolutionEngine(rt, stores.history);
    await engine.applyExplicitFeedback('msg-1', 'positive');

    const turn = makeTurn();
    await engine.reviewTurn(turn, 'whatever text — the thumb already decided');
    expect(turn.feedback).toBe('positive');
    expect(listTurnRatings(rt.storage.sql, rt.actor)).toMatchObject([{ turnId: 'msg-1', score: 5, source: 'thumbs' }]);
    expect(llmCalls + rated.calls()).toBe(0);
  });

  /**
     * Message ids are minted per actor, so both rows share one id on purpose. The
     * sibling's row is written first so an unscoped read would reach it.
     */
  test('a sibling actor\'s thumbs-down does not decide this actor\'s turn', async () => {
    let llmCalls = 0;
    const { rt, stores } = createTestRuntime();
    const rated = ratedAs(rt, 'corrected');
    // Counted rather than thrown, so a wrong-row read fails on the verdict it produced.
    rt.llm.complete = async () => {
      llmCalls++;

      return 'unused';
    };

    // A real second actor from the production directory, so the ids genuinely collide.
    const sibling = createTestActors(rt.storage.sql, rt.storage.execRaw, { name: rt.actor.name })
      .sibling('thumbs-sibling');

    recordTurnRating(rt.storage.sql, sibling, {
      turnId: 'msg-1', score: 1, corrected: 1, wrong: null, source: 'thumbs', request: 'q', answer: 'a', now: 1,
    });
    recordTurnRating(rt.storage.sql, rt.actor, {
      turnId: 'msg-1', score: 5, corrected: 0, wrong: null, source: 'thumbs', request: 'q', answer: 'a', now: 2,
    });

    const turn = makeTurn();
    await new EvolutionEngine(rt, stores.history).reviewTurn(turn, 'whatever text — the thumb already decided');

    // This actor's own rating decides.
    expect(turn.feedback).toBe('positive');
    expect(listTurnRatings(rt.storage.sql, rt.actor)).toMatchObject([{ score: 5, source: 'thumbs' }]);
    // A thumbs-up needs no model; reading the sibling's row would trigger reflection.
    expect(llmCalls + rated.calls()).toBe(0);
    // The sibling's row is untouched.
    expect(listTurnRatings(rt.storage.sql, sibling)).toMatchObject([{ score: 1 }]);
  });

  test('an Alternate Takes pick beats the decision model and its rating survives the review', async () => {
    let llmCalls = 0;
    const { rt, stores } = createTestRuntime();
    const rated = ratedAs(rt, 'accepted');
    const engine = new EvolutionEngine(rt, stores.history);
    rt.llm.complete = async () => {
      llmCalls++;

      return 'unused';
    };

    // recordTakePick already rated the delivered answer.
    recordTurnRating(rt.storage.sql, rt.actor, {
      turnId: 'msg-1', score: 2, corrected: 1, wrong: null, source: 'take_pick', request: 'q', answer: 'a',
      followup: 'the chosen take', now: 1,
    });

    const turn = makeTurn();
    await engine.reviewTurn(turn, 'follow-up that would have read as accepted');
    expect(turn.feedback).toBe('negative');
    expect(listTurnRatings(rt.storage.sql, rt.actor)).toMatchObject([{ source: 'take_pick', score: 2 }]);
    expect(rated.calls()).toBe(0);
    expect(llmCalls).toBe(1); // the low rating still warrants the reflection call
  });

  test('programmatic turn without errors: no rating, no evolution side effects', async () => {
    const { rt, stores } = createTestRuntime();
    const engine = new EvolutionEngine(rt, stores.history);
    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    await engine.reviewTurn(makeTurn({ origin: 'programmatic' }), null);
    expect(listTurnRatings(rt.storage.sql, rt.actor)).toHaveLength(0);
    expect(events.filter(e => e.type === 'reflection')).toHaveLength(0);
    expect(events.filter(e => e.type === 'turn_complete')).toHaveLength(1); // visibility only
  });

  test('a later low rating corroborates a provisional lesson into the derived view', async () => {
    const { rt, stores } = createTestRuntime();
    ratedAs(rt, 'frustrated');
    const engine = new EvolutionEngine(rt, stores.history);
    recordLesson(rt.storage.sql, rt.actor, {
      turnIds: ['msg-1'], text: 'verify cluster names before acting',
      source: 'turn_reflection', status: 'provisional',
    });

    await engine.reviewTurn(makeTurn(), 'this is useless, you keep breaking staging');
    expect(listLessons(rt.storage.sql, rt.actor, { status: 'provisional' })).toHaveLength(0);
    expect(listLessons(rt.storage.sql, rt.actor, { status: 'corroborated' })
      .some(l => l.text.includes('verify cluster names before acting'))).toBe(true);
    // Corroboration is a row-status change only: MEMORY.md is untouched.
    expect(await rt.memory.read('memory/MEMORY.md')).toBeNull();
    expect(renderRecentLessons(rt.storage.sql, rt.actor)).toContain('verify cluster names before acting');
  });

  test('a late thumbs-down rates the turn and corroborates its lessons', async () => {
    const { rt, stores } = createTestRuntime();
    const engine = new EvolutionEngine(rt, stores.history);
    await seedTranscriptEntry(stores.history, 'default', { id: 'u1', message: { role: 'user', content: 'the task' }, origin: 'input' });
    await seedTranscriptEntry(stores.history, 'default', { id: 'a1', message: { role: 'assistant', content: 'the answer' }, origin: 'output' });
    recordLesson(rt.storage.sql, rt.actor, {
      turnIds: ['a1'], text: 'late-corroborated lesson', source: 'turn_reflection', status: 'provisional',
    });

    await engine.applyExplicitFeedback('a1', 'negative');
    expect(listTurnRatings(rt.storage.sql, rt.actor))
      .toMatchObject([{ turnId: 'a1', score: 1, source: 'thumbs', request: 'the task', answer: 'the answer' }]);
    expect(listLessons(rt.storage.sql, rt.actor, { status: 'corroborated' })
      .some(l => l.text.includes('late-corroborated lesson'))).toBe(true);
    expect(await rt.memory.read('memory/MEMORY.md')).toBeNull();
    expect(renderRecentLessons(rt.storage.sql, rt.actor)).toContain('late-corroborated lesson');
  });

  test('respects enabled=false config', async () => {
    const { rt, stores } = createTestRuntime();
    const rated = ratedAs(rt, 'corrected');
    const engine = new EvolutionEngine(rt, stores.history, { enabled: false });
    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    await engine.reviewTurn(makeTurn({ hadError: true }), 'this is broken');
    expect(events).toHaveLength(0);
    expect(rated.calls()).toBe(0);
    expect(listTurnRatings(rt.storage.sql, rt.actor)).toHaveLength(0);
  });
});

describe('EvolutionEngine — Session-level', () => {
  function session(turns: CompletedTurn[]): CompletedSession {
    return { sessionId: 'test', turns, startedAt: Date.now() - 60000, endedAt: Date.now() };
  }

  test('reflects on a ≥3-turn window carrying negative signal (a corroborated session lesson)', async () => {
    const { rt, stores } = createTestRuntime();
    ratedAs(rt, 'corrected');
    const engine = new EvolutionEngine(rt, stores.history, { lifetimeEvolutionInterval: 100 });
    recordLesson(rt.storage.sql, rt.actor, {
      turnIds: ['w1'], text: 'Previous lesson content',
      source: 'turn_reflection', status: 'corroborated',
    });

    // A low rating lands on one window turn.
    const graded = makeTurn({ turnId: 'w2' });
    await engine.reviewTurn(graded, 'no — wrong cluster again');

    await engine.onSessionComplete(session([makeTurn({ turnId: 'w1' }), graded, makeTurn({ turnId: 'w3' })]));

    expect(listLessons(rt.storage.sql, rt.actor, { status: 'corroborated' })
      .some(l => l.source === 'session_reflection')).toBe(true);
    // The derived view carries it, not MEMORY.md.
    expect(await rt.memory.read('memory/MEMORY.md')).toBeNull();
  });

  test('accepted streak lowers the cadence: an all-good window skips reflection', async () => {
    const { rt, stores } = createTestRuntime();
    ratedAs(rt, 'accepted');
    const engine = new EvolutionEngine(rt, stores.history, { lifetimeEvolutionInterval: 100 });

    const turns = [makeTurn({ turnId: 's1' }), makeTurn({ turnId: 's2' }), makeTurn({ turnId: 's3' })];

    for (const t of turns) await engine.reviewTurn(t, 'perfect, moving on to the next piece of work');

    await engine.onSessionComplete(session(turns));
    expect(listLessons(rt.storage.sql, rt.actor, { source: 'session_reflection' })).toHaveLength(0);
  });

  test('an errored window still reflects, but the self-scored lesson stays provisional', async () => {
    const { rt, stores } = createTestRuntime();
    const engine = new EvolutionEngine(rt, stores.history, { lifetimeEvolutionInterval: 100 });
    recordLesson(rt.storage.sql, rt.actor, {
      turnIds: ['seed'], text: 'Previous lesson content',
      source: 'turn_reflection', status: 'corroborated',
    });

    await engine.onSessionComplete(session([
      makeTurn({ turnId: 'e1', hadError: true }), makeTurn({ turnId: 'e2' }), makeTurn({ turnId: 'e3' }),
    ]));

    // The self-scored reflection stays provisional until the user's own negative corroborates it.
    expect(await rt.memory.read('memory/MEMORY.md')).toBeNull();
    const provisional = listLessons(rt.storage.sql, rt.actor, { status: 'provisional' });
    expect(provisional.some(l => l.source === 'session_reflection' && l.turnIds.includes('e1'))).toBe(true);
  });

  test('the lifetime cadence counts closed windows durably — a new engine resumes it', async () => {
    const { rt, stores } = createTestRuntime();
    initSearchTables(rt.storage.execRaw);
    initScaffoldTables(rt.storage.execRaw);
    const window = session([makeTurn(), makeTurn(), makeTurn()]);

    // Five windows, each closed by a different engine instance.
    const events: EvolutionEvent[] = [];

    for (let i = 0; i < 5; i++) {
      const engine = new EvolutionEngine(rt, stores.history, { lifetimeEvolutionInterval: 5 });
      engine.onEvent(e => events.push(e));
      await engine.onSessionComplete(window);
    }

    // The 5th window is the interval; an instance-local counter never gets here.
    expect(events.filter(e => e.type === 'consolidation')).toHaveLength(1);
  });
});

describe('EvolutionEngine — Lifetime-level', () => {
  test('runs CraftStore consolidation', async () => {
    const { rt, stores } = createTestRuntime();
    initSearchTables(rt.storage.execRaw);
    initScaffoldTables(rt.storage.execRaw);

    const engine = new EvolutionEngine(rt, stores.history);

    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    await engine.onLifetimeEvolution();

    expect(events.some(e => e.type === 'consolidation')).toBe(true);
  });
});

describe('the turn-reflection prompt', () => {
  /** Read through the call because the builder is module-private; proves the
     *  prompt's stated bound and the enforced bound are one number. */
  async function reflect(answer: string) {
    const { rt, stores } = createTestRuntime({ llmResponses: { 'In one sentence': answer } });
    ratedAs(rt, 'corrected');

    const prompts: string[] = [];
    const complete = rt.llm.complete.bind(rt.llm);
    rt.llm.complete = async (prompt: string) => {
      prompts.push(prompt);

      return complete(prompt);
    };

    const engine = new EvolutionEngine(rt, stores.history);
    await engine.reviewTurn(
      makeTurn({ steps: 41, durationMs: 372_000 }),
      'No — that rotates production keys. I said STAGING.',
    );

    return {
      prompt: prompts.find((text) => text.includes('In one sentence')) ?? '',
      lesson: listLessons(rt.storage.sql, rt.actor, { status: 'corroborated' })[0]?.text ?? '',
      view: renderRecentLessons(rt.storage.sql, rt.actor),
    };
  }

  test('states a length bound as a number, and the code cuts the answer to that same number', async () => {
    // The answer reaches every later turn, so the prompt states the cap and the parse
    // enforces it. Read from the prompt so the two cannot drift.
    const { prompt, lesson, view } = await reflect('y'.repeat(2_000));
    const stated = Number(/at most (\d+) characters/.exec(prompt)?.[1]);
    expect(stated).toBe(240);
    expect(lesson).toBe('y'.repeat(stated));
    expect(view).toContain('y'.repeat(stated));
    expect(view).not.toContain('y'.repeat(stated + 1));
  });

  test('asks for a trigger and an action by contrast, because the reader has no evidence', async () => {
    const { prompt } = await reflect('re-run the command before reporting done');
    expect(prompt).toContain('read by later turns that have none of the evidence above');
    expect(prompt).toContain('name the trigger and the action, not the incident');
    expect(prompt).toContain('Good: "When a run result\'s text begins `Error (exit N)`');
    expect(prompt).toContain('Bad: "Should have been more careful here."');
  });
});
