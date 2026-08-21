// runHeadInference — the backend-agnostic head loop (re-arch P6b). Drives the
// real generateText loop with a fake v2 model so the status/summary/usage/steps
// assembly that used to live inside the cf Facet is locked behind a test both
// backends rely on.
import { describe, test, expect } from 'bun:test';
import { scriptedTurnModel, toolExecute } from '@kinu.run/test-utils';
import type { LanguageModel } from 'ai';
import {
  runHeadInference, HeadCapture, buildHeadAccumulatorTools,
  buildHeadSystemPrompt, buildHeadMessages, type HeadInferenceDeps,
} from '../src/heads/head-inference';
import type { Decision, Evidence, HeadInput, SerializedMessage } from '../src/heads/types';
import {
  inheritedContextFromHistory, inheritedContextFromRows, inheritedContextOmissionNote,
} from '../src/orchestrator/heads-support';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../src/prompts/evidence-window';

/** A generateText-driving stub. Returns `answer` as one text step + usage;
 *  finishReason 'stop' so the head ends in a single step (no tool calls). */
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
    budget: { maxDepth: 2, maxWallClockMs: 60_000, spawnedAt: 2_000_000_000_000 },
    mergeStrategy: 'synthesize',
    ...overrides,
  };
}

const deps = (
  model: LanguageModel,
  over?: Partial<HeadInferenceDeps>,
): HeadInferenceDeps => ({
  model, tools: {}, capture: new HeadCapture(), isAborted: () => false, ...over,
  workspaceLayout: over?.workspaceLayout ?? 'shared-workspace',
});

describe('runHeadInference — report assembly', () => {
  test('a completed head: final text → summary, usage summed, steps captured', async () => {
    const report = await runHeadInference(headInput(), deps(fakeHeadModel('The lexer handles UTF-8 correctly.')));
    expect(report.status).toBe('completed');
    expect(report.summary).toBe('The lexer handles UTF-8 correctly.');
    expect(report.usage).toEqual({ input: 10, output: 20 });
    expect(report.stepCount).toBeGreaterThanOrEqual(1);
    expect(report.id).toBe('h1');
  });

  test('budget already exhausted → status budget_exceeded', async () => {
    const input = headInput({ budget: { maxDepth: 2, maxWallClockMs: 1, spawnedAt: 1 } });
    const report = await runHeadInference(input, deps(fakeHeadModel('partial')));
    expect(report.status).toBe('budget_exceeded');
  });

  test('aborted → status aborted + errorMessage from abortReason', async () => {
    const report = await runHeadInference(
      headInput(),
      deps(fakeHeadModel('text'), { isAborted: () => true, abortReason: () => 'operator cancelled' }),
    );
    expect(report.status).toBe('aborted');
    expect(report.errorMessage).toBe('operator cancelled');
  });

  test('model throw → status errored, no steps, message preserved', async () => {
    const report = await runHeadInference(headInput(), deps(fakeHeadModel('', { throwError: 'model exploded' })));
    expect(report.status).toBe('errored');
    expect(report.errorMessage).toContain('model exploded');
    expect(report.stepCount).toBe(0);
  });

  test('no prose + recorded evidence → summary synthesized from findings', async () => {
    const capture = new HeadCapture();
    capture.recordEvidence({ id: 'e1', kind: 'fact', body: 'Postgres has mature JSONB' });
    capture.recordDecision({ question: 'Which DB?', choice: 'Postgres', rationale: 'JSONB' });
    const report = await runHeadInference(headInput(), deps(fakeHeadModel(''), { capture }));
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
    const recordEvidence = toolExecute<Omit<Evidence, 'id'>, string>(tools.record_evidence!);
    const recordDecision = toolExecute<Decision, string>(tools.record_decision!);
    await recordEvidence({ kind: 'fact', body: 'X holds' });
    await recordDecision({ question: 'q', choice: 'c', rationale: 'r' });
    expect(capture.evidence[0]!.body).toBe('X holds');
    expect(capture.evidence[0]!.id).toMatch(/^ev-/);
    expect(capture.decisions[0]!.choice).toBe('c');
    // Each tool also logs a tool call for telemetry.
    expect(capture.toolCalls.map((t) => t.name)).toEqual(['record_evidence', 'record_decision']);
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
    // A head's inheritance is STRUCTURAL: one message per inherited message,
    // then the task. Not one flattened prose blob.
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

    // The assistant turn arrives AS an assistant message — not folded into a
    // user message's prose, which is what made a fork unwatchable.
    expect(msgs[1]).toEqual({ role: 'assistant', content: 'the lexer looks fine so far' });

    // The task is the LAST message, so it is the live instruction.
    expect(msgs.at(-1)).toEqual({
      role: 'user',
      content: 'Now focus on your assigned task: analyze the parser',
    });

    // Structurally, nothing is flattened: no single message carries more than
    // its own body, so every inherited turn stays individually addressable.
    for (const [i, inherited] of multiTurn.entries()) {
      expect(msgs[i]!.content).toBe(inherited.content);
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

    const report = await runHeadInference(headInput({ inheritedContext: [...multiTurn] }), deps(model));

    expect(report.status).toBe('completed');
    expect(prompts).toHaveLength(1);
    // system prompt, then the inherited turns with their roles intact, then the task.
    expect(prompts[0]!.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'user']);
  });

  test("an inherited 'tool' result never reaches the SDK as role:'tool', and keeps its tool identity", () => {
    // role:'tool' needs a matching preceding assistant tool-call part with the
    // same toolCallId; a SerializedMessage has no id to match, so emitting one
    // would make every head request malformed at the provider.
    const msgs = buildHeadMessages(headInput({
      inheritedContext: [{ id: 't1', role: 'tool', content: 'exit status 0', createdAt: 1, toolName: 'run' }],
    }));

    expect(msgs.map((m) => m.role)).toEqual(['user', 'user']);
    expect(msgs[0]!.content).toBe('[inherited tool result from run]\nexit status 0');
  });

  test("an inherited 'system' entry does not become a second system prompt", () => {
    const msgs = buildHeadMessages(headInput({
      inheritedContext: [...inheritedContextOmissionNote(12, 2)],
    }));

    expect(msgs.some((m) => m.role === 'system')).toBe(false);
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[0]!.content).toContain('10 earlier messages omitted');
  });

  test('an empty inheritance is just the task', () => {
    expect(buildHeadMessages(headInput({ inheritedContext: [] }))).toEqual([
      { role: 'user', content: 'Now focus on your assigned task: analyze the parser' },
    ]);
  });
});

describe('inherited context is windowed at READ time, exactly once (C4)', () => {
  const cap = EVIDENCE_BUDGETS.inheritedMessage;
  // A stored assistant body is allowed to run to storedAssistantResponse
  // (16,000 chars); windowing it only at render time meant every spawned head
  // held a full-size copy across the facet RPC boundary first.
  const stored = `HEAD-MARK${'x'.repeat(EVIDENCE_BUDGETS.storedAssistantResponse)}TAIL-MARK`;
  // evidenceWindow keeps both ends and names the gap, so the bound is the
  // budget plus that single disclosure line — never the stored body.
  const bound = cap + 80;

  test('inheritedContextFromRows caps each stored body as it builds the digest', () => {
    const ctx = inheritedContextFromRows([{ id: 'r1', role: 'assistant', content: stored, createdAt: 1 }], 1);

    expect(ctx).toHaveLength(1);
    expect(ctx[0]!.content.length).toBeLessThanOrEqual(bound);
    expect(ctx[0]!.content.length).toBeLessThan(stored.length / 8);
    // Head AND tail survive — the window is a window, not a head truncation.
    expect(ctx[0]!.content.startsWith('HEAD-MARK')).toBe(true);
    expect(ctx[0]!.content.endsWith('TAIL-MARK')).toBe(true);
  });

  test('a body within budget passes through byte-identical', () => {
    const ctx = inheritedContextFromRows([{ id: 'r1', role: 'user', content: 'short body', createdAt: 1 }], 1);
    expect(ctx[0]!.content).toBe('short body');
  });

  test('inheritedContextFromHistory caps each live-history body the same way', () => {
    const ctx = inheritedContextFromHistory([{ role: 'assistant', content: stored }], 50);

    expect(ctx).toHaveLength(1);
    expect(ctx[0]!.content.length).toBeLessThanOrEqual(bound);
    expect(ctx[0]!.content.startsWith('HEAD-MARK')).toBe(true);
    expect(ctx[0]!.content.endsWith('TAIL-MARK')).toBe(true);
  });

  test('buildHeadMessages neither expands nor re-windows what the read already capped', () => {
    const inheritedContext = inheritedContextFromRows(
      [{ id: 'r1', role: 'assistant', content: stored, createdAt: 1 }], 1);
    const windowed = inheritedContext[0]!.content;

    // A second window IS observable on already-windowed text, so the
    // byte-identity assertion below genuinely detects double application.
    expect(evidenceWindow(windowed, cap)).not.toBe(windowed);

    const msgs = buildHeadMessages(headInput({ inheritedContext }));
    expect(msgs[0]).toEqual({ role: 'assistant', content: windowed });
  });
});
