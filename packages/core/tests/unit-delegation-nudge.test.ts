// Mechanical delegation steering (orchestrator/delegation-nudge.ts) — the
// harness nudging toward the delegation ladder at the two moments the doctrine
// names, because prose alone moved the model 0 times in 10 bench tasks.
//
// These are behaviour tests through the public seams: the ProteusExtension
// hooks both backends fire, and — for the fidelity that matters most — a full
// runChat turn where the nudge has to actually reach the model's next request.
import { describe, expect, test } from 'bun:test';
import { tool, type LanguageModelV2StreamPart, type ModelMessage } from 'ai';
import { z } from 'zod';
import {
  DelegationNudge, isFailingToolResult, runChat,
  CONSECUTIVE_FAILURES_BEFORE_NUDGE, LONG_TURN_STEPS_BEFORE_NUDGE, DELEGATION_NUDGE_HEADER,
  ExtensionHost,
} from '../src/index.js';

const user = (text: string): ModelMessage => ({ role: 'user', content: text });

/** The step the model would see: whatever prepareStep hands back (or the
 *  unchanged input when nothing was injected). */
function step(nudge: DelegationNudge, stepNumber: number, messages: ModelMessage[]): ModelMessage[] {
  return nudge.prepareStep({ stepNumber, messages }) ?? messages;
}

function injected(messages: readonly ModelMessage[]): string[] {
  return messages
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter((text) => text.startsWith(DELEGATION_NUDGE_HEADER));
}

function fail(nudge: DelegationNudge, toolName: string, times = 1): void {
  for (let i = 0; i < times; i++) nudge.onToolResult({ toolName, result: 'boom', success: false });
}

describe('isFailingToolResult', () => {
  test('the harness discriminator', () => {
    expect(isFailingToolResult({ toolName: 'run', result: 'boom', success: false })).toBe(true);
    expect(isFailingToolResult({ toolName: 'run', result: 'ok', success: true })).toBe(false);
  });

  test('a non-zero exit the run tool RETURNS as a normal result is still a failure', () => {
    // The case that motivated the mechanism: `run` catches the exit code and
    // hands back a success-shaped result whose text is the error.
    expect(isFailingToolResult({
      toolName: 'run', success: true,
      result: 'Error (exit 2): make: *** [Makefile:12: all] Error 2',
    })).toBe(true);
    expect(isFailingToolResult({
      toolName: 'run', success: true, result: 'Error: no workspace shell available in this runtime.',
    })).toBe(true);
  });

  test('a structured runtime error counts; output that merely mentions an error does not', () => {
    expect(isFailingToolResult({
      toolName: 'run', success: true,
      result: '{"error":"runtime_not_provisioned","runtime":"sandbox"}',
    })).toBe(true);
    expect(isFailingToolResult({
      toolName: 'run', success: true, result: '3 tests passed, 0 errors\nError rate: 0%',
    })).toBe(false);
    expect(isFailingToolResult({ toolName: 'run', success: true, result: '{"ok":true}' })).toBe(false);
    expect(isFailingToolResult({ toolName: 'run', success: true, result: '{not json' })).toBe(false);
  });
});

describe('repeated-failure trigger', () => {
  test('three failures on one tool inject exactly one nudge, at the next step boundary', () => {
    const nudge = new DelegationNudge();
    expect(step(nudge, 0, [user('build it')])).toEqual([user('build it')]);
    fail(nudge, 'run', CONSECUTIVE_FAILURES_BEFORE_NUDGE - 1);
    // Two failures is a correction, not a pattern — nothing yet.
    expect(injected(step(nudge, 1, [user('build it')]))).toEqual([]);
    expect(nudge.snapshot()).toBeNull();

    fail(nudge, 'run');
    const nudged = step(nudge, 2, [user('build it')]);
    expect(injected(nudged)).toHaveLength(1);
    const text = injected(nudged)[0]!;
    expect(text).toContain('`run` has failed 3 times in a row');
    expect(text).toContain('agents` action=fork');
    expect(text).toContain('settle=mcts');
    expect(text).toContain('hint, not an instruction');
    expect(nudge.snapshot()).toEqual({ trigger: 'repeated_failure', step: 2, tool: 'run', converted: false });
  });

  test('the nudge holds its entry index across later steps and never repeats', () => {
    const nudge = new DelegationNudge();
    step(nudge, 0, [user('q')]);
    fail(nudge, 'run', CONSECUTIVE_FAILURES_BEFORE_NUDGE);
    const at1 = step(nudge, 1, [user('q'), user('a1')]);
    expect(at1.map((m) => m.content)).toEqual([
      'q', 'a1', expect.stringContaining(DELEGATION_NUDGE_HEADER) as unknown as string,
    ]);
    // Later steps rebuild from scratch: the nudge re-applies at its original
    // position (cache-prefix stability) and is not re-issued.
    fail(nudge, 'run', 5);
    const at2 = step(nudge, 2, [user('q'), user('a1'), user('a2')]);
    expect(injected(at2)).toHaveLength(1);
    expect(at2[2]!.content).toContain(DELEGATION_NUDGE_HEADER);
    expect(nudge.snapshot()?.step).toBe(1);
  });

  test('a success on that tool clears its streak; failures of other tools do not', () => {
    const nudge = new DelegationNudge();
    fail(nudge, 'run', 2);
    nudge.onToolResult({ toolName: 'run', result: 'ok', success: true });
    fail(nudge, 'run', 2);
    // Two since the success — and a different tool's failures are its own
    // streak, not this one's.
    fail(nudge, 'web_fetch', 2);
    expect(injected(step(nudge, 1, [user('q')]))).toEqual([]);
    // …while a success on ANOTHER tool leaves the failing tool's streak alone:
    // interleaved reads must not launder a stuck approach.
    nudge.onToolResult({ toolName: 'web_fetch', result: 'page', success: true });
    fail(nudge, 'run');
    expect(injected(step(nudge, 2, [user('q')]))).toHaveLength(1);
    expect(nudge.snapshot()?.tool).toBe('run');
  });
});

describe('long-turn trigger', () => {
  test('a long turn with no delegation is nudged once, naming fork', () => {
    const nudge = new DelegationNudge();
    expect(injected(step(nudge, LONG_TURN_STEPS_BEFORE_NUDGE - 1, [user('q')]))).toEqual([]);
    const nudged = step(nudge, LONG_TURN_STEPS_BEFORE_NUDGE, [user('q')]);
    expect(injected(nudged)).toHaveLength(1);
    expect(injected(nudged)[0]).toContain('25 steps into this turn with no delegation');
    expect(injected(nudged)[0]).toContain('agents` action=fork');
    expect(nudge.snapshot()).toEqual({
      trigger: 'long_turn_no_delegation', step: LONG_TURN_STEPS_BEFORE_NUDGE, converted: false,
    });
    // Every later step of a 130-step turn stays silent — a nudge that repeats
    // is spam.
    for (let s = LONG_TURN_STEPS_BEFORE_NUDGE + 1; s < LONG_TURN_STEPS_BEFORE_NUDGE + 10; s++) {
      expect(injected(step(nudge, s, [user('q')]))).toHaveLength(1);
    }
  });

  test('a turn that already delegated is never nudged for length', () => {
    const nudge = new DelegationNudge();
    nudge.onToolCall({ toolName: 'agents', args: { action: 'fork' } });
    expect(injected(step(nudge, LONG_TURN_STEPS_BEFORE_NUDGE + 5, [user('q')]))).toEqual([]);
    expect(nudge.snapshot()).toBeNull();
  });

  test('one nudge per turn, whichever trigger fires first', () => {
    const nudge = new DelegationNudge();
    fail(nudge, 'run', CONSECUTIVE_FAILURES_BEFORE_NUDGE);
    expect(injected(step(nudge, 1, [user('q')]))).toHaveLength(1);
    // Long and undelegated as well — still one line in the conversation.
    expect(injected(step(nudge, LONG_TURN_STEPS_BEFORE_NUDGE + 1, [user('q')]))).toHaveLength(1);
    expect(nudge.snapshot()?.trigger).toBe('repeated_failure');
  });
});

describe('conversion + turn boundaries', () => {
  test('converted counts delegation AFTER the nudge, not before it', () => {
    const before = new DelegationNudge();
    before.onToolCall({ toolName: 'agents', args: { action: 'fork' } });
    fail(before, 'run', CONSECUTIVE_FAILURES_BEFORE_NUDGE);
    step(before, 1, [user('q')]);
    expect(before.snapshot()).toEqual({
      trigger: 'repeated_failure', step: 1, tool: 'run', converted: false,
    });

    before.onToolCall({ toolName: 'agents', args: { action: 'fork' } });
    expect(before.snapshot()?.converted).toBe(true);
  });

  test('reset clears the streaks, the splice state and the record', () => {
    const nudge = new DelegationNudge();
    fail(nudge, 'run', CONSECUTIVE_FAILURES_BEFORE_NUDGE);
    step(nudge, 1, [user('q')]);
    expect(nudge.snapshot()).not.toBeNull();

    nudge.reset();
    expect(nudge.snapshot()).toBeNull();
    // The previous turn's failures do not carry into this one.
    expect(injected(step(nudge, 0, [user('next')]))).toEqual([]);
    fail(nudge, 'run', CONSECUTIVE_FAILURES_BEFORE_NUDGE);
    expect(injected(step(nudge, 1, [user('next')]))).toHaveLength(1);
  });
});

// ── the fidelity that matters: the model actually receives it ──────────────

/** A model that calls `flaky` on every step until it is told otherwise, so a
 *  turn accumulates failures. Records the prompt of every request. */
function grindingModel(prompts: ModelMessage[][]) {
  let step = 0;
  return {
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doStream: async (opts: { prompt: unknown }) => {
      prompts.push(opts.prompt as ModelMessage[]);
      step += 1;
      const done = step > 4;
      return {
        stream: new ReadableStream<LanguageModelV2StreamPart>({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            if (done) {
              c.enqueue({ type: 'text-start', id: 't' });
              c.enqueue({ type: 'text-delta', id: 't', delta: 'giving up' });
              c.enqueue({ type: 'text-end', id: 't' });
              c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
            } else {
              c.enqueue({ type: 'tool-call', toolCallId: `tc${step}`, toolName: 'flaky', input: '{}' });
              c.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
            }
            c.close();
          },
        }),
        response: { headers: {} },
      };
    },
  };
}

/** Every text part of a request's prompt, whatever shape the SDK put it in. */
function promptText(messages: ModelMessage[]): string {
  return messages.map((m) => (typeof m.content === 'string'
    ? m.content
    : (m.content as Array<{ text?: string }>).map((part) => part.text ?? '').join(' '))).join('\n');
}

describe('through a real runChat turn', () => {
  test('the nudge reaches the model\'s next request after the third failure', async () => {
    const prompts: ModelMessage[][] = [];
    const nudge = new DelegationNudge();
    const tools = {
      // The exit-code shape: the tool SUCCEEDS and returns the failure text.
      flaky: tool({
        description: 'fails by returning its failure',
        inputSchema: z.object({}),
        execute: async () => 'Error (exit 2): make: *** [all] Error 2',
      }),
    };
    for await (const _ of runChat({
      model: grindingModel(prompts) as never,
      system: 'sys',
      history: [user('build caffe')],
      tools: tools as never,
      maxSteps: 6,
      extensions: new ExtensionHost().register(nudge),
    })) { /* drain */ }

    // Requests 1-3 issue the three failing calls; only after the third does
    // the harness speak, and it is in the request the model answers next.
    const seen = prompts.map((p) => promptText(p).includes(DELEGATION_NUDGE_HEADER));
    expect(seen.slice(0, 3)).toEqual([false, false, false]);
    expect(seen[3]).toBe(true);
    expect(promptText(prompts[3]!)).toContain('`flaky` has failed 3 times in a row');
    // …and it says it exactly once, however many more steps the turn runs.
    for (const prompt of prompts.slice(3)) {
      expect(promptText(prompt).split(DELEGATION_NUDGE_HEADER)).toHaveLength(2);
    }
    expect(nudge.snapshot()).toEqual({
      trigger: 'repeated_failure', step: 3, tool: 'flaky', converted: false,
    });
  });
});
