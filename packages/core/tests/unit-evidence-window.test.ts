// The evolution loop's evidence budget: one policy, applied at every reader.
//
// The behaviour under test is not "text gets shorter" — it is that the END of a
// long turn reaches the judge. Every one of these readers used to keep only the
// first n characters, which made a win that lands at step 9 of 12 invisible to
// the thing that is supposed to select for it.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MockLanguageModelV3 } from 'ai/test';
import * as v from 'valibot';
import {
  EVIDENCE_BUDGETS, evidenceWindow,
  initScaffoldTables, initShadowTables, runAutoShadowEval, queueTurnShadowTrial,
  runQueuedShadowTrials, type JudgeOutput, type ScaffoldControl,
} from '../src/index.js';
import { renderReflectionPrompt } from '../src/evolution/gepa/mutate.js';
import type { GepaCandidate } from '../src/evolution/gepa/types.js';
import { initReplayTables, runReplayEval } from '../src/evolution/replay.js';
import { buildOutcomeClassifierPrompt, initTurnOutcomeTables, recordTurnOutcome } from '../src/evolution/outcomes.js';
import { createTestRuntime, makeExecRaw, makeSql } from './helpers.js';

/** A seed candidate carrying `source` — the only field these prompts read. */
function candidate(source: string): GepaCandidate {
  return {
    id: 'p', parentId: null, source, scores: new Map(), feedback: new Map(),
    aggregateScore: 0.5, createdAt: 0,
  };
}

/** A trajectory whose decisive material is at the very end — the shape the old
 *  head-only slices could not see. */
function trajectory(chars: number, ending: string): string {
  return 'step boilerplate. '.repeat(Math.ceil(chars / 18)).slice(0, chars) + ending;
}

describe('evidenceWindow', () => {
  test('text within budget passes through byte-identical', () => {
    const short = 'a conclusive answer';
    expect(evidenceWindow(short, 100)).toBe(short);
    expect(evidenceWindow('x'.repeat(100), 100)).toBe('x'.repeat(100));
  });

  test('keeps both ends and says how much it dropped', () => {
    const text = `OPENING${'-'.repeat(1000)}CLOSING`;
    const windowed = evidenceWindow(text, 100);
    expect(windowed.startsWith('OPENING')).toBe(true);
    expect(windowed.endsWith('CLOSING')).toBe(true);
    expect(windowed).toContain(`${text.length - 100} chars omitted from the middle`);
  });

  test('the split is even, so the tail is not a token gesture', () => {
    const text = `${'a'.repeat(500)}${'b'.repeat(500)}`;
    const windowed = evidenceWindow(text, 100);
    expect(windowed.startsWith('a'.repeat(50))).toBe(true);
    expect(windowed.endsWith('b'.repeat(50))).toBe(true);
  });

  test('a non-positive budget is a bug, not a silently empty window', () => {
    expect(() => evidenceWindow('x', 0)).toThrow(/evidence budget must be positive/);
  });
});

describe('the budgets are ordered — a reader never asks for more than was stored', () => {
  test('every ledger reader fits inside the ledger row it reads', () => {
    const stored = EVIDENCE_BUDGETS;
    expect(stored.replayTask).toBeLessThanOrEqual(stored.storedUserMessage);
    expect(stored.replayReferenceResponse).toBeLessThanOrEqual(stored.storedAssistantResponse);
    expect(stored.replayFailedResponse).toBeLessThanOrEqual(stored.storedAssistantResponse);
    expect(stored.replayCorrection).toBeLessThanOrEqual(stored.storedFollowup);
    expect(stored.gepaInstanceInput).toBeLessThanOrEqual(stored.storedUserMessage);
    expect(stored.outcomeAssistantResponse).toBeLessThanOrEqual(stored.storedAssistantResponse);
  });
});

describe('the readers can see the end of a long turn', () => {
  const ending = 'THE-DECISIVE-STEP';

  test('the shadow judge is shown, and the trial row records, how the live turn ended', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
    initShadowTables(rt.storage.execRaw);
    void rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
      VALUES (0, ${Date.now()}, 'initial', 'current')`;
    void rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
      VALUES (1, ${Date.now()}, 'alternative', 'pending')`;
    await rt.storage.vfs.writeFile('scaffold/agent.js.v1', 'async function* run() {}');

    const prompts: string[] = [];
    const judge = async (prompt: string): Promise<JudgeOutput> => {
      prompts.push(prompt);
      return { winner: 'tie', rationale: 'mock', scoreA: 0.5, scoreB: 0.5 };
    };

    const result = await runAutoShadowEval({
      rt,
      task: trajectory(20_000, `ASK-${ending}`),
      currentOutput: trajectory(40_000, `CURRENT-${ending}`),
      judge,
      llmStream: async function* () { yield ''; },
      random: () => 0,
    });

    expect(result.skipped).toBe(false);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).toContain(`ASK-${ending}`);
      expect(prompt).toContain(`CURRENT-${ending}`);
    }
    // One window, judged and recorded: the row is the evidence the verdict was
    // formed on, not a differently-truncated view of it.
    const row = rt.storage.sql<{ task: string; current_output: string }>`
      SELECT task, current_output FROM scaffold_evaluations LIMIT 1`[0]!;
    expect(row.task).toBe(evidenceWindow(trajectory(20_000, `ASK-${ending}`), EVIDENCE_BUDGETS.shadowTask));
    expect(row.current_output).toContain(`CURRENT-${ending}`);
  });

  // The budget is applied in ONE place. It used to be applied twice — the
  // orchestration clamped, then the judge clamped what was already clamped —
  // and windowing a window reports the SECOND pass's omission count, so the
  // number the judge was shown was wrong by four orders of magnitude.
  test('the orchestrated path windows once, so the omission count is the true one', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
    initShadowTables(rt.storage.execRaw);
    void rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
      VALUES (0, ${Date.now()}, 'initial', 'current')`;
    void rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
      VALUES (1, ${Date.now()}, 'alternative', 'pending')`;
    await rt.storage.vfs.writeFile('scaffold/agent.js.v1', 'async function* run() {}');

    const prompts: string[] = [];
    const currentOutput = trajectory(200_000, `CURRENT-${ending}`);
    const control: ScaffoldControl = {
      rt,
      sql: rt.storage.sql,
      config: {
        getShadowSampleRate: () => 1,
        getAutoPromoteScaffold: () => false,
        getGepaEvalBudget: () => 1,
      },
      surface: () => ({
        llmStream: async function* () { yield ''; },
        callTool: async () => ({}),
        history: async () => ({ total: 0, offset: 0, entries: [], clipped: false }),
        defaultInference: async function* () { yield { value: '' }; },
      }),
      model: () => new MockLanguageModelV3(),
      judge: async ({ prompt, schema }) => {
        prompts.push(prompt);
        return v.parse(schema, { winner: 'tie', rationale: 'm', scoreA: 0.5, scoreB: 0.5 });
      },
    };
    // The turn stores the live output WHOLE; the drain windows it once.
    expect(queueTurnShadowTrial(control, {
      task: 'short task', currentOutput, context: [{ role: 'user', content: 'short task' }],
    })).toBe('queued');
    await runQueuedShadowTrials(control);

    expect(prompts.length).toBeGreaterThan(0);
    const prompt = prompts[0];
    if (!prompt) throw new Error('expected shadow judge prompt');
    const omissions = [...prompt.matchAll(/(\d+) chars omitted from the middle/g)].map((match) => Number(match[1]));
    // One window over the live output, reporting what it really dropped.
    expect(omissions).toEqual([currentOutput.length - EVIDENCE_BUDGETS.shadowOutput]);
  });

  test('the outcome classifier sees how the response ended', () => {
    const prompt = buildOutcomeClassifierPrompt({
      userMessage: trajectory(20_000, `ASK-${ending}`),
      assistantResponse: trajectory(40_000, `ANSWER-${ending}`),
      followup: trajectory(20_000, `FOLLOWUP-${ending}`),
    });
    expect(prompt).toContain(`ASK-${ending}`);
    expect(prompt).toContain(`ANSWER-${ending}`);
    expect(prompt).toContain(`FOLLOWUP-${ending}`);
  });

  test('the replay judge sees the end of the response it is scoring against', async () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    initTurnOutcomeTables(makeExecRaw(db), sql);
    initReplayTables(makeExecRaw(db), sql);
    recordTurnOutcome(sql, {
      turnId: 'good', outcome: 'accepted', confidence: 1, source: 'classifier',
      userMessage: trajectory(20_000, `ASK-${ending}`),
      assistantResponse: trajectory(40_000, `REFERENCE-${ending}`),
      now: 100,
    });

    const prompts: string[] = [];
    await runReplayEval({
      sql,
      judge: {
        async *stream() { yield '{"score": 1.0, "note": "ok"}'; },
        complete: async (prompt: string) => { prompts.push(prompt); return '{"score": 1.0, "note": "ok"}'; },
      },
      runTask: async () => trajectory(40_000, `FRESH-${ending}`),
      sampleSize: 1,
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`ASK-${ending}`);
    expect(prompts[0]).toContain(`FRESH-${ending}`);
    expect(prompts[0]).toContain(`REFERENCE-${ending}`);
    db.close();
  });

  test('the GEPA reflector sees how each rollout ended', () => {
    const prompt = renderReflectionPrompt({
      parent: candidate('const x = 1;'),
      minibatch: [{ id: 'i1', input: trajectory(20_000, `INPUT-${ending}`), evidence: trajectory(20_000, `EVIDENCE-${ending}`) }],
      rollout: { outcomes: [{ instanceId: 'i1', outcome: { score: 0.1, feedback: trajectory(20_000, `FEEDBACK-${ending}`) } }], metricCalls: 1 },
    });
    expect(prompt).toContain(`INPUT-${ending}`);
    expect(prompt).toContain(`EVIDENCE-${ending}`);
    expect(prompt).toContain(`FEEDBACK-${ending}`);
  });

  test('a candidate source is head-truncated, never middle-elided — a rewrite of holed code comes back holed', () => {
    const source = `// header\n${'const filler = 1;\n'.repeat(2000)}// footer`;
    const prompt = renderReflectionPrompt({
      parent: candidate(source),
      minibatch: [], rollout: { outcomes: [], metricCalls: 0 },
    });
    expect(prompt).toContain('// header');
    expect(prompt).toContain('... [truncated]');
    expect(prompt).not.toContain('chars omitted from the middle');
  });
});
