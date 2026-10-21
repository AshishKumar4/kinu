/** EvolutionEngine: turn-level evolution rated from the user's next message. */

import { compactToolCall } from '../src/evolution/tool-call-record';
import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import { createTestRuntime } from './helpers';
import { seedTranscriptEntry, createTestActors } from '@kinu.run/test-utils';
import { EvolutionEngine } from '../src/evolution/engine';
import type { EvolutionEvent, CompletedTurn, CompletedSession } from '../src/evolution/types';
import { listLessons } from '../src/evolution/lessons';
import { listTurnRatings, recordTurnRating } from '../src/evolution/ratings';
import type { DecisionPort } from '../src/providers/decision-model';
import type { AgentRuntime } from '../src/types/agent-runtime';
import { initSearchTables } from '../src/mcts/schemas';
import { initScaffoldTables } from '../src/scaffold/schemas';
import { historyTurnPairs } from '../src/identity/conversation-store';
import { createCompletedTurnStore } from '../src/evolution/session-window';
import { craftPreferences } from '../src/craft/preference';

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

    return { answers: {
      satisfaction: { type: 'score', score: answer.score },
      corrected: { type: 'noul', noul: answer.corrected },
      wrong: { type: 'choice', choice: answer.wrong },
    }, usage: { input: 400, output: 0 } };
  };

  rt.decide = decide;

  return { calls: () => calls };
}

describe('EvolutionEngine.reviewTurn — the rating signal', () => {
  test('a correcting reply: rated low and feedback negative, and no lesson is invented from it', async () => {
    const { rt, stores } = createTestRuntime();
    ratedAs(rt, 'corrected');
    const prompts: string[] = [];
    const complete = rt.llm.complete.bind(rt.llm);
    rt.llm.complete = async (prompt: string) => {
      prompts.push(prompt);

      return complete(prompt);
    };

    const engine = new EvolutionEngine(rt, historyTurnPairs(stores.history));
    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    const turn = makeTurn({ steps: 41, durationMs: 372_000 });
    await engine.reviewTurn(turn, 'No — that rotates production keys. I said STAGING.');

    expect(turn.feedback).toBe('negative');
    const rows = listTurnRatings(rt.storage.sql, rt.actor);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ turnId: 'msg-1', source: 'model', score: 1.5, wrong: 'misunderstood' });
    // The dream learns from rated turns; a single low rating writes no lesson of its own.
    expect(events.some(e => e.type === 'reflection')).toBe(false);
    expect(listLessons(rt.storage.sql, rt.actor)).toEqual([]);
    expect(prompts).toEqual([]);
  });

  test('an accepting reply: positive feedback, no reflection, extracts a pattern from tool use', async () => {
    const { rt, stores } = createTestRuntime({
      llmResponses: {
        'Extract a reusable pattern': '{"name":"compute_value","description":"Execute code and return result","params":{"type":"object","properties":{"code":{"type":"string"}},"required":["code"]},"code":"async (args) => { return args.code; }"}',
      },
    });

    ratedAs(rt, 'accepted');

    const engine = new EvolutionEngine(rt, historyTurnPairs(stores.history));
    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    const turn = makeTurn({
      toolCalls: [compactToolCall({ name: 'eval', args: { code: 'return 42' }, result: 42 })],
    });

    await engine.reviewTurn(turn, 'great, now do the same for the prod cluster');

    expect(turn.feedback).toBe('positive');
    expect(events.filter(e => e.type === 'reflection')).toHaveLength(0);
    expect(events.some(e => e.type === 'craft_discovered')).toBe(true);
    expect(listTurnRatings(rt.storage.sql, rt.actor)[0]?.score).toBeCloseTo(4.6);
  });

  test('a rated turn keeps the skills it read, for dreams to read', async () => {
    const { rt, stores } = createTestRuntime();
    ratedAs(rt, 'accepted');
    const engine = new EvolutionEngine(rt, historyTurnPairs(stores.history));

    await engine.reviewTurn(makeTurn({
      toolCalls: [compactToolCall({ name: 'file', args: { op: 'read', path: '/skills/slates/SKILL.md' } })],
    }), 'great, now the next one');

    expect(listTurnRatings(rt.storage.sql, rt.actor)[0]?.picks).toEqual({ skills: ['slates'], tools: [] });
  });

  test('with crafting off the same accepted turn is rated, and no tool is extracted from it', async () => {
    const { rt, stores } = createTestRuntime({
      llmResponses: {
        'Extract a reusable pattern': '{"name":"compute_value","description":"Execute code and return result","params":{"type":"object","properties":{},"required":[]},"code":"async (args) => 42"}',
      },
    });

    ratedAs(rt, 'accepted');
    rt.actor.config.setCrafting(false);

    const engine = new EvolutionEngine(rt, historyTurnPairs(stores.history));
    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    await engine.reviewTurn(makeTurn({
      toolCalls: [compactToolCall({ name: 'eval', args: { code: 'return 42' }, result: 42 })],
    }), 'great, now do the same for the prod cluster');

    expect(listTurnRatings(rt.storage.sql, rt.actor)[0]?.score).toBeCloseTo(4.6);
    expect(events.some(e => e.type === 'craft_discovered')).toBe(false);
    expect(rt.craftStore.list()).toEqual([]);
  });

  test('a rated turn credits each crafted tool it chose with its rating, and only those it was offered', async () => {
    const { rt, stores } = createTestRuntime();
    ratedAs(rt, 'corrected');
    void rt.storage.sql`INSERT INTO crafted_tools (name) VALUES ('my_crafted_tool'), ('made_this_turn')`;
    const engine = new EvolutionEngine(rt, historyTurnPairs(stores.history));

    await engine.reviewTurn(makeTurn({
      toolCalls: [compactToolCall({ name: 'eval', args: {}, result: 'x' })],
      craftedOffered: ['my_crafted_tool'],
      craftedToolsUsed: ['my_crafted_tool', 'made_this_turn'],
    }), 'wrong again — that broke the deploy');

    const rows = craftPreferences(rt.storage.sql);
    expect(rows.get('my_crafted_tool')).toMatchObject({ rated: 1, rating_sum: 1.5 / 5 });
    // Made and called in the turn, not offered to it: not a choice, so not credited.
    expect(rows.get('made_this_turn')).toMatchObject({ rated: 0, rating_sum: 0 });
  });

  test('recording a turn counts its offers once, and a keyed replay counts nothing', () => {
    const { rt } = createTestRuntime();
    void rt.storage.sql`INSERT INTO crafted_tools (name) VALUES ('a'), ('b')`;
    const engine = new EvolutionEngine(rt, historyTurnPairs(createTestRuntime().stores.history));
    const turn = makeTurn({ craftedOffered: ['a', 'b'], craftedToolsUsed: ['a'] });

    for (let i = 0; i < 2; i++) engine.sessionWindow.append(turn, { awaitsFollowup: false, id: 'turn-1', recorded: () => { engine.countCraftOffers(turn); } });

    const rows = craftPreferences(rt.storage.sql);
    expect([rows.get('a'), rows.get('b')]).toMatchObject([{ offered: 1, chosen: 1 }, { offered: 1, chosen: 0 }]);
  });

  test('an MCP tool call is not a crafted-tool use and credits nothing', async () => {
    // Crafted tools are codemode-only, so a choice must come from the turn record.
    const { rt, stores } = createTestRuntime();
    ratedAs(rt, 'corrected');
    const engine = new EvolutionEngine(rt, historyTurnPairs(stores.history));
    await engine.reviewTurn(makeTurn({
      toolCalls: [compactToolCall({ name: 'mcp__github__create_issue', args: {}, result: 'x' })],
      craftedToolsUsed: [],
    }), 'wrong again — that broke the deploy');
    expect(rt.storage.sql`SELECT name FROM crafted_tools WHERE rated > 0`).toEqual([]);
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

    const engine = new EvolutionEngine(rt, historyTurnPairs(stores.history));
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
    const engine = new EvolutionEngine(rt, historyTurnPairs(stores.history));
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
      toolCalls: [compactToolCall({ name: 'shell', args: { command: 'bun test' }, result: 'ok', outcome: { success: true } })],
    };

    const headless = createTestRuntime({ llmResponses: { 'Extract a reusable pattern': pattern } });
    ratedAs(headless.rt, 'accepted');
    const turn = makeTurn({ turnId: 'exec-promote', ...acted });
    await new EvolutionEngine(headless.rt, historyTurnPairs(headless.stores.history)).reviewTurn(turn, null);
    expect(turn.feedback).toBeNull();
    expect(listTurnRatings(headless.rt.storage.sql, headless.rt.actor)).toEqual([]);
    expect(headless.rt.storage.sql<{ n: number }>`SELECT COUNT(*) AS n FROM crafted_tools`[0]?.n).toBe(0);
    expect(headless.rt.storage.sql<{ n: number }>`SELECT COUNT(*) AS n FROM prepared_outputs`[0]?.n).toBe(0);

    const asked = createTestRuntime({ llmResponses: { 'Extract a reusable pattern': pattern } });
    ratedAs(asked.rt, 'accepted');

    await new EvolutionEngine(asked.rt, historyTurnPairs(asked.stores.history)).reviewTurn(
      makeTurn({ turnId: 'graded-promote', ...acted }), 'perfect, thanks',
    );
    expect(asked.rt.storage.sql<{ name: string }>`SELECT name FROM crafted_tools`.map((r) => r.name))
      .toEqual(['rotate_deploy_keys']);
  });

  test('a turn that errored with no reply writes nothing: no rating, no lesson', async () => {
    const { rt, stores } = createTestRuntime();
    ratedAs(rt, 'corrected');
    const engine = new EvolutionEngine(rt, historyTurnPairs(stores.history));

    await engine.reviewTurn(makeTurn({
      turnId: 'exec-2', hadError: true,
      toolCalls: [compactToolCall({ name: 'shell', args: { command: 'bun test' }, result: { error: 'exit 1' } })],
    }), null);

    expect(listTurnRatings(rt.storage.sql, rt.actor)).toEqual([]);
    expect(listLessons(rt.storage.sql, rt.actor)).toEqual([]);
  });

  test('a decision model failure records nothing and fails the review, to be retried', async () => {
    const { rt, stores } = createTestRuntime();
    rt.decide = async () => ({ answers: { satisfaction: { type: 'score', score: 2 } }, usage: { input: 0, output: 0 } });
    const engine = new EvolutionEngine(rt, historyTurnPairs(stores.history));
    const turn = makeTurn();

    await expect(engine.reviewTurn(turn, 'hmm, interesting')).rejects.toThrow('left a rating question unanswered');
    expect(turn.feedback).toBeNull();
    expect(listTurnRatings(rt.storage.sql, rt.actor)).toHaveLength(0);
  });

  test("a thumb beats the decision model's reading, which the ledger keeps beneath it", async () => {
    let llmCalls = 0;
    const { rt, stores } = createTestRuntime();
    const rated = ratedAs(rt, 'corrected');
    rt.llm.complete = async () => {
      llmCalls++;

      return 'unused';
    };

    const engine = new EvolutionEngine(rt, historyTurnPairs(stores.history));
    await engine.applyExplicitFeedback('msg-1', 'positive');

    const turn = makeTurn();
    await engine.reviewTurn(turn, 'whatever text — the thumb already decided');
    expect(turn.feedback).toBe('positive');
    expect(listTurnRatings(rt.storage.sql, rt.actor)).toMatchObject([{ turnId: 'msg-1', score: 5, source: 'thumbs' }]);
    // The reply is read once; a thumbs-up warrants no reflection.
    expect({ reflections: llmCalls, readings: rated.calls() }).toEqual({ reflections: 0, readings: 1 });
    expect(rt.storage.sql<{ source: string }>`SELECT source FROM turn_ratings ORDER BY source`.map((r) => r.source))
      .toEqual(['model', 'thumbs']);
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
    await new EvolutionEngine(rt, historyTurnPairs(stores.history)).reviewTurn(turn, 'whatever text — the thumb already decided');

    // This actor's own rating decides.
    expect(turn.feedback).toBe('positive');
    expect(listTurnRatings(rt.storage.sql, rt.actor)).toMatchObject([{ score: 5, source: 'thumbs' }]);
    // A thumbs-up warrants no reflection; reading the sibling's row would trigger one.
    expect(llmCalls).toBe(0);
    expect(rated.calls()).toBe(1);
    // The sibling's row is untouched.
    expect(listTurnRatings(rt.storage.sql, sibling)).toMatchObject([{ score: 1 }]);
  });

  test("an Alternate Takes pick beats the decision model's reading and survives the review", async () => {
    let llmCalls = 0;
    const { rt, stores } = createTestRuntime();
    const rated = ratedAs(rt, 'accepted');
    const engine = new EvolutionEngine(rt, historyTurnPairs(stores.history));
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
    expect(rated.calls()).toBe(1);
    // A low rating asks for no lesson of its own: the dream learns from the rated turns.
    expect(llmCalls).toBe(0);
  });

  test('programmatic turn without errors: no rating, no evolution side effects', async () => {
    const { rt, stores } = createTestRuntime();
    const engine = new EvolutionEngine(rt, historyTurnPairs(stores.history));
    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    await engine.reviewTurn(makeTurn({ origin: 'programmatic' }), null);
    expect(listTurnRatings(rt.storage.sql, rt.actor)).toHaveLength(0);
    expect(events.filter(e => e.type === 'reflection')).toHaveLength(0);
    expect(events.filter(e => e.type === 'turn_complete')).toHaveLength(1); // visibility only
  });

  test('a late thumbs-down rates the turn', async () => {
    const { rt, stores } = createTestRuntime();
    const engine = new EvolutionEngine(rt, historyTurnPairs(stores.history));
    await seedTranscriptEntry(stores.history, 'default', { id: 'u1', message: { role: 'user', content: 'the task' }, origin: 'input' });
    await seedTranscriptEntry(stores.history, 'default', { id: 'a1', message: { role: 'assistant', content: 'the answer' }, origin: 'output' });

    await engine.applyExplicitFeedback('a1', 'negative');
    expect(listTurnRatings(rt.storage.sql, rt.actor))
      .toMatchObject([{ turnId: 'a1', score: 1, source: 'thumbs', request: 'the task', answer: 'the answer' }]);
  });

  test('a rating keeps the versions its turn ran with, from the review or from the turn still in the window', async () => {
    const { rt, stores } = createTestRuntime();
    ratedAs(rt, 'corrected');
    const engine = new EvolutionEngine(rt, historyTurnPairs(stores.history));
    const ran = ['section:guidance/operating@2', 'tool:shell.description@1'];

    // The review rates a turn that carries its versions, whatever scaffold is current when it runs.
    await engine.reviewTurn(makeTurn({ turnId: 'reviewed', artifacts: ran, scaffold: { version: 3 } }), 'No, I said staging.');
    // A thumb on a turn whose review has not run reads them from its record in the window.
    createCompletedTurnStore(rt.storage.sql, rt.actor).append(makeTurn({ turnId: 'parked', artifacts: ran, scaffold: { version: 2 } }), { awaitsFollowup: true });
    await engine.applyExplicitFeedback('parked', 'positive');
    // A turn recorded before turns carried versions has none to give.
    await engine.applyExplicitFeedback('older', 'negative');

    const versions = Object.fromEntries(listTurnRatings(rt.storage.sql, rt.actor).map((rating) => [rating.turnId, [rating.artifacts, rating.scaffoldVersion]]));
    expect(versions).toEqual({ reviewed: [ran, 3], parked: [ran, 2], older: [null, null] });
  });

  test('a thumb over a reviewed turn reads its versions through the review\'s row', async () => {
    const { rt } = createTestRuntime();
    const ran = ['section:guidance/operating@2'];

    recordTurnRating(rt.storage.sql, rt.actor, { turnId: 't', score: 2, corrected: 0.9, wrong: 'misunderstood', source: 'model', request: 'r', answer: 'a', artifacts: ran, now: 1 });
    recordTurnRating(rt.storage.sql, rt.actor, { turnId: 't', score: 5, corrected: 0, wrong: null, source: 'thumbs', request: 'r', answer: 'a', now: 2 });

    // The thumb is the effective rating; the versions are the turn's, whichever of its rows recorded them.
    expect(listTurnRatings(rt.storage.sql, rt.actor)).toMatchObject([{ turnId: 't', source: 'thumbs', score: 5, artifacts: ran }]);
  });

  test('respects enabled=false config', async () => {
    const { rt, stores } = createTestRuntime();
    const rated = ratedAs(rt, 'corrected');
    const engine = new EvolutionEngine(rt, historyTurnPairs(stores.history), { enabled: false });
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

  test('the lifetime cadence counts closed windows durably — a new engine resumes it', async () => {
    const { rt, stores } = createTestRuntime();
    initSearchTables(rt.storage.execRaw);
    initScaffoldTables(rt.storage.execRaw);
    const window = session([makeTurn(), makeTurn(), makeTurn()]);

    // Five windows, each closed by a different engine instance.
    const events: EvolutionEvent[] = [];

    for (let i = 0; i < 5; i++) {
      const engine = new EvolutionEngine(rt, historyTurnPairs(stores.history), { lifetimeEvolutionInterval: 5 });
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

    const engine = new EvolutionEngine(rt, historyTurnPairs(stores.history));

    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    await engine.onLifetimeEvolution();

    expect(events.some(e => e.type === 'consolidation')).toBe(true);
  });
});
