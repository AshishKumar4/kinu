/**
 * EvolutionEngine — outcome-driven evolution at 3 timescales.
 *
 * Turn-level evolution is graded by what the user did NEXT (reviewTurn):
 * the follow-up classifies the previous turn, populates turn.feedback,
 * moves craft EMA, gates reflection/extraction, and lands in turn_outcomes.
 */

import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import { createTestRuntime } from './helpers';
import { EvolutionEngine, type EvolutionEvent, type CompletedTurn, type CompletedSession } from '../src/evolution/index';
import { DELEGATION_RUBRIC } from '../src/evolution/delegation-features';
import {
  listTurnOutcomes, listLessons, recordLesson, renderRecentLessons,
} from '../src/evolution/outcomes';
import { alignmentConvergence } from '../src/evolution/alignment';
import { initSearchTables } from '../src/mcts/schemas';
import { initScaffoldTables } from '../src/scaffold/schemas';

const CLASSIFY = 'Classify what the follow-up reveals';

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

function classifierResponses(outcome: 'accepted' | 'corrected' | 'frustrated', extra: Record<string, string> = {}) {
  return {
    [CLASSIFY]: `{"outcome":"${outcome}","confidence":0.9,"evidence":"test"}`,
    ...extra,
  };
}

describe('EvolutionEngine.reviewTurn — the outcome signal', () => {
  test('corrected follow-up: records outcome, populates feedback, reflects into the corroborated ledger', async () => {
    const { rt } = createTestRuntime({ llmResponses: classifierResponses('corrected') });
    const prompts: string[] = [];
    const complete = rt.llm.complete.bind(rt.llm);
    rt.llm.complete = async (prompt: string) => {
      prompts.push(prompt);
      return complete(prompt);
    };
    const engine = new EvolutionEngine(rt);
    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    const turn = makeTurn({ steps: 41, durationMs: 372_000 });
    await engine.reviewTurn(turn, 'No — that rotates production keys. I said STAGING.');

    expect(turn.feedback).toBe('negative'); // the hardcoded null is dead
    const rows = listTurnOutcomes(rt.storage.sql);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('corrected');
    expect(rows[0].source).toBe('classifier');
    expect(rows[0].turnId).toBe('msg-1');
    expect(events.some(e => e.type === 'reflection')).toBe(true);
    // Real negative outcome ⇒ the lesson is corroborated and durable.
    expect(listLessons(rt.storage.sql, { status: 'corroborated' })).toHaveLength(1);
    // …and durable through the DERIVED view, not a MEMORY.md copy.
    expect(renderRecentLessons(rt.storage.sql)).not.toBe('');
    const reflectionPrompt = prompts.find((prompt) => prompt.includes('In one sentence')) ?? '';
    expect(reflectionPrompt).toContain(
      'Turn process: 41 sequential steps, 0 hiring, 0 exploration, 0 messaging, 0 execute_tools, 6.2min wall clock',
    );
    // One shared rubric string, in the vocabulary the evidence line above it
    // prints. The two inline copies had drifted into two vocabularies for one
    // ladder — "hire/search" here, "team/think/heads" in gepa/mutate.ts.
    expect(reflectionPrompt).toContain(DELEGATION_RUBRIC);
    expect(reflectionPrompt).toContain('is a lesson to decompose the work and delegate it');
    expect(reflectionPrompt).toContain('An accepted turn that hired or explored effectively earns credit');
    expect(reflectionPrompt).toContain('Spawns that contributed nothing are delegation overhead');
  });

  test('accepted follow-up: positive feedback, no reflection, extracts a pattern from tool use', async () => {
    const { rt } = createTestRuntime({
      llmResponses: classifierResponses('accepted', {
        'Extract a reusable pattern': '{"name":"compute_value","description":"Execute code and return result","params":{"type":"object","properties":{"code":{"type":"string"}},"required":["code"]},"code":"async (args) => { return args.code; }"}',
      }),
    });
    const engine = new EvolutionEngine(rt);
    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    const turn = makeTurn({
      toolCalls: [{ name: 'execute_tools', args: { code: 'return 42' }, result: 42 }],
    });
    await engine.reviewTurn(turn, 'great, now do the same for the prod cluster');

    expect(turn.feedback).toBe('positive');
    expect(events.filter(e => e.type === 'reflection')).toHaveLength(0);
    expect(events.some(e => e.type === 'craft_discovered')).toBe(true);
    expect(listTurnOutcomes(rt.storage.sql)[0].outcome).toBe('accepted');
  });

  test('craft EMA moves on outcomes: corrected pushes a tool score down, accepted up', async () => {
    const { rt } = createTestRuntime({ llmResponses: classifierResponses('corrected') });
    void rt.storage.sql`INSERT INTO crafted_tools (name, score, uses, last_used_at)
        VALUES ('my_crafted_tool', 0.5, 1, ${Date.now()})`;
    const engine = new EvolutionEngine(rt);

    const turn = makeTurn({
      toolCalls: [{ name: 'execute_tools', args: {}, result: 'x' }],
      craftedToolsUsed: ['my_crafted_tool'],
    });
    await engine.reviewTurn(turn, 'wrong again — that broke the deploy');
    const after = rt.storage.sql<{ score: number }>`
      SELECT score FROM crafted_tools WHERE name = 'my_crafted_tool'`[0];
    expect(after.score).toBeLessThan(0.5);

    const { rt: rt2 } = createTestRuntime({
      llmResponses: classifierResponses('accepted', { 'Extract a reusable pattern': 'not json' }),
    });
    void rt2.storage.sql`INSERT INTO crafted_tools (name, score, uses, last_used_at)
        VALUES ('my_crafted_tool', 0.5, 1, ${Date.now()})`;
    const engine2 = new EvolutionEngine(rt2);
    await engine2.reviewTurn(makeTurn({
      toolCalls: [{ name: 'execute_tools', args: {}, result: 'x' }],
      craftedToolsUsed: ['my_crafted_tool'],
    }), 'thanks, that worked — next please deploy it');
    const after2 = rt2.storage.sql<{ score: number }>`
      SELECT score FROM crafted_tools WHERE name = 'my_crafted_tool'`[0];
    expect(after2.score).toBeGreaterThan(0.5);
  });

  test('an MCP tool call is not a crafted-tool use and scores nothing', async () => {
    // The defect: the crafted set was "every tool name that is not built in",
    // which crafted tools are never in (they are codemode-only) — so the EMA
    // was written against MCP and extension tools exclusively.
    const { rt } = createTestRuntime({ llmResponses: classifierResponses('corrected') });
    const engine = new EvolutionEngine(rt);
    await engine.reviewTurn(makeTurn({
      toolCalls: [{ name: 'mcp__github__create_issue', args: {}, result: 'x' }],
      craftedToolsUsed: [],
    }), 'wrong again — that broke the deploy');
    expect(rt.storage.sql`SELECT name FROM crafted_tools WHERE uses > 0`).toEqual([]);
  });

  test('trivial turn (greeting): no LLM call, no outcome row, no events', async () => {
    let llmCalls = 0;
    const { rt } = createTestRuntime();
    const realComplete = rt.llm.complete.bind(rt.llm);
    rt.llm.complete = async (prompt: string) => { llmCalls++; return realComplete(prompt); };
    const engine = new EvolutionEngine(rt);
    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    await engine.reviewTurn(makeTurn({ userMessage: 'thanks!', assistantResponse: 'You are welcome!' }), 'now another thing');
    expect(llmCalls).toBe(0);
    expect(listTurnOutcomes(rt.storage.sql)).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  test('no follow-up: no outcome row at all — an absent verdict is not a neutral one', async () => {
    const { rt } = createTestRuntime();
    const engine = new EvolutionEngine(rt);
    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    const clean = makeTurn();
    await engine.reviewTurn(clean, null);
    expect(clean.feedback).toBeNull();
    // No follow-up AND no tool work: the user said nothing and the environment
    // ruled on nothing, so nothing is recorded on no evidence.
    expect(listTurnOutcomes(rt.storage.sql)).toHaveLength(0);
    expect(events.filter(e => e.type === 'reflection')).toHaveLength(0);
    // The ungraded turn is still VISIBLE — recorded as ungraded, not as a win.
    const complete = events.filter(e => e.type === 'turn_complete');
    expect(complete).toHaveLength(1);
    expect(complete[0]!.message).toContain('ungraded');
    const completionData = v.parse(v.object({ graded: v.boolean(), source: v.nullable(v.string()) }), complete[0]!.data);
    expect(completionData.graded).toBe(false);
    expect(completionData.source).toBeNull();
  });

  test('no follow-up but real tool work: the ENVIRONMENT grades it, and says so', async () => {
    const { rt } = createTestRuntime({ llmResponses: { 'Extract a reusable pattern': 'not json' } });
    const engine = new EvolutionEngine(rt);

    const turn = makeTurn({
      turnId: 'exec-1',
      toolCalls: [{ name: 'run', args: { command: 'bun test' }, result: 'ok' }],
    });
    await engine.reviewTurn(turn, null);

    const [row] = listTurnOutcomes(rt.storage.sql);
    expect(row!.outcome).toBe('accepted');
    expect(row!.source).toBe('execution');
    expect(row!.followup).toBeNull();
    // A headless turn can finally earn a positive — the asymmetry is gone.
    expect(turn.feedback).toBe('positive');
  });

  test('a headless turn that errored is graded corrected — but does NOT corroborate lessons', async () => {
    const { rt } = createTestRuntime();
    const engine = new EvolutionEngine(rt);
    recordLesson(rt.storage.sql, {
      turnIds: ['exec-2'], text: 'earlier provisional lesson',
      source: 'turn_reflection', status: 'provisional',
    });

    await engine.reviewTurn(makeTurn({
      turnId: 'exec-2', hadError: true,
      toolCalls: [{ name: 'run', args: { command: 'bun test' }, result: { error: 'exit 1' } }],
    }), null);

    const [row] = listTurnOutcomes(rt.storage.sql);
    expect(row!.outcome).toBe('corrected');
    expect(row!.source).toBe('execution');
    // The corroboration gate is a USER-verdict gate: a machine verdict still
    // earns a reflection, but nothing is promoted into the corroborated view
    // by it.
    const lessons = listLessons(rt.storage.sql);
    expect(lessons.every(l => l.status === 'provisional')).toBe(true);
    expect(renderRecentLessons(rt.storage.sql)).toBe('');
  });

  test('K_align stays a USER-correction rate — execution rows are counted apart', async () => {
    const { rt } = createTestRuntime();
    const engine = new EvolutionEngine(rt);
    await engine.reviewTurn(makeTurn({
      turnId: 'exec-3', hadError: true,
      toolCalls: [{ name: 'run', args: {}, result: { error: 'boom' } }],
    }), null);

    const k = alignmentConvergence(rt.storage.sql);
    expect(k.overall.turns).toBe(0);            // no user graded anything
    expect(k.overall.negatives).toBe(0);
    expect(k.overall.executionGraded).toBe(1);  // and the row is not lost either
  });
  test('ungraded turn with an error: reflects, but the lesson stays provisional and OUT of the derived view', async () => {
    const { rt } = createTestRuntime();
    const engine = new EvolutionEngine(rt);

    await engine.reviewTurn(makeTurn({ hadError: true, turnId: 'err-turn' }), null);
    const lessons = listLessons(rt.storage.sql);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].status).toBe('provisional');
    expect(renderRecentLessons(rt.storage.sql)).toBe('');
  });

  test('classifier failure records nothing rather than guessing', async () => {
    const { rt } = createTestRuntime({ llmResponses: { [CLASSIFY]: 'absolutely not json' } });
    const engine = new EvolutionEngine(rt);
    const turn = makeTurn();
    await engine.reviewTurn(turn, 'hmm, interesting');
    expect(turn.feedback).toBeNull();
    expect(listTurnOutcomes(rt.storage.sql)).toHaveLength(0);
  });

  test('explicit thumbs beat the classifier (no LLM call) and ride the same ledger', async () => {
    let llmCalls = 0;
    const { rt } = createTestRuntime();
    rt.llm.complete = async () => { llmCalls++; return 'unused'; };
    rt.storage.execRaw(`CREATE TABLE turn_feedback (
      message_id TEXT PRIMARY KEY, feedback TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    void rt.storage.sql`INSERT INTO turn_feedback (message_id, feedback, created_at) VALUES ('msg-1', 'positive', 1)`;
    const engine = new EvolutionEngine(rt);

    const turn = makeTurn();
    await engine.reviewTurn(turn, 'whatever text — the thumbs already decided');
    expect(turn.feedback).toBe('positive');
    const rows = listTurnOutcomes(rt.storage.sql);
    expect(rows[0].outcome).toBe('accepted');
    expect(rows[0].source).toBe('explicit');
    expect(llmCalls).toBe(0);
  });

  test('an Alternate Takes pick beats the classifier and its ledger row survives the review', async () => {
    let llmCalls = 0;
    const { rt } = createTestRuntime();
    const engine = new EvolutionEngine(rt);
    rt.llm.complete = async () => { llmCalls++; return 'unused'; };
    // recordTakePick already wrote the turn's explicit preference row.
    void rt.storage.sql`INSERT INTO turn_outcomes
        (id, turn_id, session_id, outcome, confidence, source, user_message, assistant_response, followup, created_at)
      VALUES ('outc-pick', 'msg-1', 'default', 'corrected', 1, 'take_pick', 'q', 'a', 'the chosen take', 1)`;

    const turn = makeTurn();
    await engine.reviewTurn(turn, 'follow-up that would have classified as accepted');
    expect(turn.feedback).toBe('negative');
    const rows = listTurnOutcomes(rt.storage.sql);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'outc-pick', source: 'take_pick', outcome: 'corrected' });
    expect(llmCalls).toBe(1); // the corrected outcome still warrants the reflection call
  });

  test('programmatic turn without errors: no outcome row, no evolution side effects', async () => {
    const { rt } = createTestRuntime();
    const engine = new EvolutionEngine(rt);
    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    await engine.reviewTurn(makeTurn({ origin: 'programmatic' }), null);
    expect(listTurnOutcomes(rt.storage.sql)).toHaveLength(0);
    expect(events.filter(e => e.type === 'reflection')).toHaveLength(0);
    expect(events.filter(e => e.type === 'turn_complete')).toHaveLength(1); // visibility only
  });

  test('a later negative outcome corroborates a provisional lesson into the derived view', async () => {
    const { rt } = createTestRuntime({ llmResponses: classifierResponses('frustrated') });
    const engine = new EvolutionEngine(rt);
    recordLesson(rt.storage.sql, {
      turnIds: ['msg-1'], text: 'verify cluster names before acting',
      source: 'turn_reflection', status: 'provisional',
    });

    await engine.reviewTurn(makeTurn(), 'this is useless, you keep breaking staging');
    expect(listLessons(rt.storage.sql, { status: 'provisional' })).toHaveLength(0);
    expect(listLessons(rt.storage.sql, { status: 'corroborated' })
      .some(l => l.text.includes('verify cluster names before acting'))).toBe(true);
    // The corroboration is a row-status change only: MEMORY.md is untouched.
    expect(await rt.memory.read('memory/MEMORY.md')).toBeNull();
    expect(renderRecentLessons(rt.storage.sql)).toContain('verify cluster names before acting');
  });
  test('applyExplicitFeedback (late thumbs) upserts the ledger and corroborates lessons', async () => {
    const { rt } = createTestRuntime();
    const engine = new EvolutionEngine(rt);
    void rt.storage.sql`INSERT INTO messages (id, session_id, role, content) VALUES ('u1', 'default', 'user', 'the task')`;
    void rt.storage.sql`INSERT INTO messages (id, session_id, parent_id, role, content) VALUES ('a1', 'default', 'u1', 'assistant', 'the answer')`;
    recordLesson(rt.storage.sql, {
      turnIds: ['a1'], text: 'late-corroborated lesson', source: 'turn_reflection', status: 'provisional',
    });

    await engine.applyExplicitFeedback('a1', 'negative');
    const rows = listTurnOutcomes(rt.storage.sql);
    expect(rows[0]).toMatchObject({ turnId: 'a1', outcome: 'corrected', source: 'explicit', userMessage: 'the task' });
    expect(listLessons(rt.storage.sql, { status: 'corroborated' })
      .some(l => l.text.includes('late-corroborated lesson'))).toBe(true);
    expect(await rt.memory.read('memory/MEMORY.md')).toBeNull();
    expect(renderRecentLessons(rt.storage.sql)).toContain('late-corroborated lesson');
  });
  test('respects enabled=false config', async () => {
    const { rt } = createTestRuntime();
    const engine = new EvolutionEngine(rt, { enabled: false });
    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    await engine.reviewTurn(makeTurn({ hadError: true }), 'this is broken');
    expect(events).toHaveLength(0);
    expect(listTurnOutcomes(rt.storage.sql)).toHaveLength(0);
  });
});

describe('EvolutionEngine — Session-level', () => {
  function session(turns: CompletedTurn[]): CompletedSession {
    return { sessionId: 'test', turns, startedAt: Date.now() - 60000, endedAt: Date.now() };
  }

  test('reflects on a ≥3-turn window carrying negative signal (a corroborated session lesson)', async () => {
    const { rt } = createTestRuntime({ llmResponses: classifierResponses('corrected') });
    const engine = new EvolutionEngine(rt, { lifetimeEvolutionInterval: 100 });
    recordLesson(rt.storage.sql, {
      turnIds: ['w1'], text: 'Previous lesson content',
      source: 'turn_reflection', status: 'corroborated',
    });

    // A corrected outcome lands on one window turn — real negative signal.
    const graded = makeTurn({ turnId: 'w2' });
    await engine.reviewTurn(graded, 'no — wrong cluster again');

    await engine.onSessionComplete(session([makeTurn({ turnId: 'w1' }), graded, makeTurn({ turnId: 'w3' })]));

    expect(listLessons(rt.storage.sql, { status: 'corroborated' })
      .some(l => l.source === 'session_reflection')).toBe(true);
    // Nothing was copied into MEMORY.md — the derived view carries it.
    expect(await rt.memory.read('memory/MEMORY.md')).toBeNull();
  });

  test('accepted streak lowers the cadence: an all-good window skips reflection', async () => {
    const { rt } = createTestRuntime({ llmResponses: classifierResponses('accepted') });
    const engine = new EvolutionEngine(rt, { lifetimeEvolutionInterval: 100 });

    const turns = [makeTurn({ turnId: 's1' }), makeTurn({ turnId: 's2' }), makeTurn({ turnId: 's3' })];
    for (const t of turns) await engine.reviewTurn(t, 'perfect, moving on to the next piece of work');

    await engine.onSessionComplete(session(turns));
    expect(listLessons(rt.storage.sql, { source: 'session_reflection' })).toHaveLength(0);
  });

  test('an errored window still reflects, but the self-scored lesson stays provisional', async () => {
    const { rt } = createTestRuntime();
    const engine = new EvolutionEngine(rt, { lifetimeEvolutionInterval: 100 });
    recordLesson(rt.storage.sql, {
      turnIds: ['seed'], text: 'Previous lesson content',
      source: 'turn_reflection', status: 'corroborated',
    });

    await engine.onSessionComplete(session([
      makeTurn({ turnId: 'e1', hadError: true }), makeTurn({ turnId: 'e2' }), makeTurn({ turnId: 'e3' }),
    ]));

    // The self-scored reflection never reaches MEMORY.md; it waits in the
    // ledger as provisional until a user verdict corroborates it.
    expect(await rt.memory.read('memory/MEMORY.md')).toBeNull();
    const provisional = listLessons(rt.storage.sql, { status: 'provisional' });
    expect(provisional.some(l => l.source === 'session_reflection' && l.turnIds.includes('e1'))).toBe(true);
  });

  test('the lifetime cadence counts closed windows durably — a new engine resumes it', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
    const window = session([makeTurn(), makeTurn(), makeTurn()]);

    // Five windows, each closed by a DIFFERENT engine instance — one per
    // `kinu exec` process, or one per Durable Object lifetime.
    const events: EvolutionEvent[] = [];
    for (let i = 0; i < 5; i++) {
      const engine = new EvolutionEngine(rt, { lifetimeEvolutionInterval: 5, lifetimeMCTSBudget: 1, lifetimeMCTSBranches: 1 });
      engine.onEvent(e => events.push(e));
      await engine.onSessionComplete(window);
    }
    // The 5th window is the interval — an instance-local counter never got here.
    expect(events.filter(e => e.type === 'mcts_started')).toHaveLength(1);
  });
});

describe('EvolutionEngine — Lifetime-level', () => {
  test('runs CraftStore consolidation', async () => {
    const { rt } = createTestRuntime();
    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);

    const engine = new EvolutionEngine(rt);

    const events: EvolutionEvent[] = [];
    engine.onEvent(e => events.push(e));

    await engine.onLifetimeEvolution();

    expect(events.some(e => e.type === 'consolidation')).toBe(true);
  });
});

describe('the turn-reflection prompt', () => {
  /** The prompt as the engine actually renders it, plus what the engine did with
   *  the answer. Read through the call rather than through an export: the builder
   *  is module-private, and this is the only surface that proves the prompt's
   *  stated bound and the code's enforced bound are one number. */
  async function reflect(answer: string) {
    const { rt } = createTestRuntime({
      llmResponses: { ...classifierResponses('corrected'), 'In one sentence': answer },
    });
    const prompts: string[] = [];
    const complete = rt.llm.complete.bind(rt.llm);
    rt.llm.complete = async (prompt: string) => {
      prompts.push(prompt);
      return complete(prompt);
    };
    const engine = new EvolutionEngine(rt);
    await engine.reviewTurn(
      makeTurn({ steps: 41, durationMs: 372_000 }),
      'No — that rotates production keys. I said STAGING.',
    );
    return {
      prompt: prompts.find((text) => text.includes('In one sentence')) ?? '',
      lesson: listLessons(rt.storage.sql, { status: 'corroborated' })[0]?.text ?? '',
      view: renderRecentLessons(rt.storage.sql),
    };
  }

  test('states a length bound as a number, and the code cuts the answer to that same number', async () => {
    // "In one sentence" is a request a model is free to interpret, and the answer
    // reaches every later turn through the corroborated derived view — where an
    // unbounded paragraph costs context permanently. The advisor note already
    // had this pairing (the prompt states the cap, the parse enforces it); the
    // reflection had neither half. Read from the prompt so the two cannot drift
    // apart silently.
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
