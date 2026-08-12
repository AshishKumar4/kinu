// Mechanical turn steering (orchestrator/turn-steering.ts) — the harness
// saying, in the turn, the one thing it can see about the turn that the model
// cannot: it is repeating itself, it is stuck, or it is long and undelegated.
// Prose alone moved the model 0 times in 10 bench tasks.
//
// These are behaviour tests through the public seams: the orchestrator's turn
// extension both backends register (the steer is delivered as a turn-local
// signal through the one delivery seam, like every other async producer), and —
// for the fidelity that matters most — a full runChat turn where the steer has
// to actually reach the model's next request.
import { describe, expect, test } from 'bun:test';
import { tool, type ModelMessage } from 'ai';
import type { ModelStreamPart } from '@proteus/test-utils';
import { z } from 'zod';
import {
  AgentOrchestrator, isFailingToolResult, runChat,
  IDENTICAL_CALLS_BEFORE_STEER, CONSECUTIVE_FAILURES_BEFORE_STEER, LONG_TURN_STEPS_BEFORE_STEER,
  TURN_STEERING_HEADER, ExtensionHost, type BackendHost,
} from '../src/index.js';
import type { EventLog } from '../src/events/hub/log.js';
import type { EvolutionEngine } from '../src/evolution/engine.js';

const user = (text: string): ModelMessage => ({ role: 'user', content: text });

/** Steering as production wires it: the orchestrator's turn extension on a
 *  backend that never queues, so a steer that fired is a steer the model saw. */
function newTurn(): AgentOrchestrator {
  const host: BackendHost = {
    broadcast: () => {},
    enqueueTurn: async () => { throw new Error('a turn-local steer must never queue'); },
    turnInFlight: () => false,
    setTimer: () => {},
  };
  return new AgentOrchestrator({
    host, engine: {} as EvolutionEngine, eventLog: {} as EventLog,
  });
}

/** The step the model would see: whatever the turn extension hands back (or the
 *  unchanged input when nothing was injected). */
function step(orch: AgentOrchestrator, stepNumber: number, messages: ModelMessage[]): ModelMessage[] {
  return orch.turnExtension.prepareStep!({ stepNumber, messages }) ?? messages;
}

function injected(messages: readonly ModelMessage[]): string[] {
  return messages
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter((text) => text.startsWith(TURN_STEERING_HEADER));
}

/** Distinct failures of one tool: a different call, answered differently, every
 *  time — so this exercises the failure streak and never the repeat detector. */
let attempt = 0;
function fail(orch: AgentOrchestrator, toolName: string, times = 1): void {
  for (let i = 0; i < times; i++) {
    attempt += 1;
    orch.turnExtension.onToolResult!({
      toolName, args: { attempt }, result: `boom ${attempt}`, success: false,
    });
  }
}

/** The same call, answered the same way, `times` times. */
function repeat(orch: AgentOrchestrator, toolName: string, args: Record<string, unknown>, times = 1): void {
  for (let i = 0; i < times; i++) {
    orch.turnExtension.onToolCall!({ toolName, args });
    orch.turnExtension.onToolResult!({ toolName, args, result: 'the same output', success: true });
  }
}

describe('isFailingToolResult — a failure the seam had to truncate', () => {
  test('a bounded prefix of a failure payload still reads as a failure', () => {
    // chat.ts and the cf afterToolCall both cut the result at 1000 chars, so a
    // verbose failure arrives as JSON that cannot parse. Reading it as a
    // success is what silently disabled every consumer of this predicate.
    const truncated = `{"error":"${'x'.repeat(60)}`;
    expect(isFailingToolResult({ toolName: 'execute_tools', args: {}, result: truncated, success: true })).toBe(true);
  });

  test('a truncated SUCCESS payload is not turned into a failure', () => {
    const truncated = `{"result":"${'x'.repeat(60)}`;
    expect(isFailingToolResult({ toolName: 'execute_tools', args: {}, result: truncated, success: true })).toBe(false);
    expect(isFailingToolResult({ toolName: 'run', args: {}, result: 'plain text output', success: true })).toBe(false);
  });
});

describe('isFailingToolResult', () => {
  test('the harness discriminator', () => {
    expect(isFailingToolResult({ toolName: 'run', args: {}, result: 'boom', success: false })).toBe(true);
    expect(isFailingToolResult({ toolName: 'run', args: {}, result: 'ok', success: true })).toBe(false);
  });

  test('a non-zero exit the run tool RETURNS as a normal result is still a failure', () => {
    // The case that motivated the mechanism: `run` catches the exit code and
    // hands back a success-shaped result whose text is the error.
    expect(isFailingToolResult({
      toolName: 'run', args: {}, success: true,
      result: 'Error (exit 2): make: *** [Makefile:12: all] Error 2',
    })).toBe(true);
    expect(isFailingToolResult({
      toolName: 'run', args: {}, success: true, result: 'Error: no workspace shell available in this runtime.',
    })).toBe(true);
  });

  test('a structured runtime error counts; output that merely mentions an error does not', () => {
    expect(isFailingToolResult({
      toolName: 'run', args: {}, success: true,
      result: '{"error":"runtime_not_provisioned","runtime":"sandbox"}',
    })).toBe(true);
    expect(isFailingToolResult({
      toolName: 'run', args: {}, success: true, result: '3 tests passed, 0 errors\nError rate: 0%',
    })).toBe(false);
    expect(isFailingToolResult({ toolName: 'run', args: {}, success: true, result: '{"ok":true}' })).toBe(false);
    expect(isFailingToolResult({ toolName: 'run', args: {}, success: true, result: '{not json' })).toBe(false);
  });

  test('a structured error longer than the old 1000-char clip still parses as a failure', () => {
    // The clip cut the JSON mid-object, so `JSON.parse` threw and every large
    // structured failure was scored a success.
    const payload = JSON.stringify({ error: 'runtime_not_provisioned', log: 'l'.repeat(4_000) });
    expect(payload.length).toBeGreaterThan(1_000);
    expect(isFailingToolResult({ toolName: 'run', args: {}, success: true, result: payload })).toBe(true);
  });
});

describe('repeated-failure trigger', () => {
  test('three failures on one tool inject exactly one nudge, at the next step boundary', () => {
    const orch = newTurn();
    expect(step(orch, 0, [user('build it')])).toEqual([user('build it')]);
    fail(orch, 'run', CONSECUTIVE_FAILURES_BEFORE_STEER - 1);
    // Two failures is a correction, not a pattern — nothing yet.
    expect(injected(step(orch, 1, [user('build it')]))).toEqual([]);
    expect(orch.steering.snapshot()).toBeNull();

    fail(orch, 'run');
    const nudged = step(orch, 2, [user('build it')]);
    expect(injected(nudged)).toHaveLength(1);
    const text = injected(nudged)[0]!;
    expect(text).toContain('`run` has failed 3 times in a row');
    expect(text).toContain('agents` action=fork');
    expect(text).toContain('settle=mcts');
    expect(text).toContain('hint, not an instruction');
    expect(orch.steering.snapshot()).toEqual({ trigger: 'repeated_failure', step: 2, tool: 'run', converted: false });
  });

  test('the nudge holds its entry index across later steps and never repeats', () => {
    const orch = newTurn();
    step(orch, 0, [user('q')]);
    fail(orch, 'run', CONSECUTIVE_FAILURES_BEFORE_STEER);
    const at1 = step(orch, 1, [user('q'), user('a1')]);
    expect(at1.map((m) => m.content)).toEqual([
      'q', 'a1', expect.stringContaining(TURN_STEERING_HEADER) as unknown as string,
    ]);
    // Later steps rebuild from scratch: the nudge re-applies at its original
    // position (cache-prefix stability) and is not re-issued.
    fail(orch, 'run', 5);
    const at2 = step(orch, 2, [user('q'), user('a1'), user('a2')]);
    expect(injected(at2)).toHaveLength(1);
    expect(at2[2]!.content).toContain(TURN_STEERING_HEADER);
    expect(orch.steering.snapshot()?.step).toBe(1);
  });

  test('a success on that tool clears its streak; failures of other tools do not', () => {
    const orch = newTurn();
    fail(orch, 'run', 2);
    orch.turnExtension.onToolResult!({ toolName: 'run', args: {}, result: 'ok', success: true });
    fail(orch, 'run', 2);
    // Two since the success — and a different tool's failures are its own
    // streak, not this one's.
    fail(orch, 'web_fetch', 2);
    expect(injected(step(orch, 1, [user('q')]))).toEqual([]);
    // …while a success on ANOTHER tool leaves the failing tool's streak alone:
    // interleaved reads must not launder a stuck approach.
    orch.turnExtension.onToolResult!({ toolName: 'web_fetch', args: {}, result: 'page', success: true });
    fail(orch, 'run');
    expect(injected(step(orch, 2, [user('q')]))).toHaveLength(1);
    expect(orch.steering.snapshot()?.tool).toBe('run');
  });
});

describe('repeated-call trigger', () => {
  test('three identical calls answered identically are named as a loop', () => {
    const orch = newTurn();
    repeat(orch, 'run', { command: 'make' }, IDENTICAL_CALLS_BEFORE_STEER - 1);
    // Two is a retry — the harness stays quiet.
    expect(injected(step(orch, 1, [user('build it')]))).toEqual([]);

    repeat(orch, 'run', { command: 'make' });
    const steered = step(orch, 2, [user('build it')]);
    expect(injected(steered)).toHaveLength(1);
    const text = injected(steered)[0]!;
    expect(text).toContain('`run` has run 3 times with the same arguments');
    expect(text).toContain('make');
    expect(text).toContain('change the approach');
    expect(text).toContain('hint, not an instruction');
    expect(orch.steering.snapshot()).toEqual({
      trigger: 'repeated_call', step: 2, tool: 'run', converted: false,
    });
  });

  test('a repeat whose OUTPUT changed is not a repeat — the model learned something', () => {
    const orch = newTurn();
    for (let i = 0; i < 6; i++) {
      orch.turnExtension.onToolResult!({
        toolName: 'run', args: { command: 'make' }, result: `progress ${i}`, success: true,
      });
    }
    expect(injected(step(orch, 3, [user('q')]))).toEqual([]);
    expect(orch.steering.snapshot()).toBeNull();
  });

  test('two runs that differ only past a long shared preamble are not a repeat', () => {
    // A pytest banner, a cargo preamble: identical for thousands of characters,
    // then the part that matters. Identity is the whole result, so the harness
    // must not claim these taught the model nothing.
    const orch = newTurn();
    const banner = 'platform linux -- pytest 8.2.0\n'.repeat(200);
    for (let i = 0; i < IDENTICAL_CALLS_BEFORE_STEER + 2; i++) {
      orch.turnExtension.onToolResult!({
        toolName: 'run', args: { command: 'pytest' }, result: `${banner}${i} failed`, success: true,
      });
    }
    expect(injected(step(orch, 3, [user('q')]))).toEqual([]);
    expect(orch.steering.snapshot()).toBeNull();
  });

  test('argument order is not an approach: {a,b} and {b,a} are one call', () => {
    const orch = newTurn();
    repeat(orch, 'run', { command: 'make', runtime: 'laptop' });
    repeat(orch, 'run', { runtime: 'laptop', command: 'make' });
    repeat(orch, 'run', { command: 'make', runtime: 'laptop' });
    expect(injected(step(orch, 1, [user('q')]))).toHaveLength(1);
    expect(orch.steering.snapshot()?.trigger).toBe('repeated_call');
  });

  test('different arguments are different work, however many calls', () => {
    const orch = newTurn();
    for (const command of ['ls', 'pwd', 'cat a', 'cat b', 'grep x']) {
      repeat(orch, 'run', { command });
    }
    expect(injected(step(orch, 1, [user('q')]))).toEqual([]);
  });

  test('a succeeding read re-run identically still counts — thrash is not only failure', () => {
    const orch = newTurn();
    repeat(orch, 'run', { command: 'cat gates.txt' }, IDENTICAL_CALLS_BEFORE_STEER);
    expect(injected(step(orch, 1, [user('q')]))).toHaveLength(1);
    expect(orch.steering.snapshot()?.trigger).toBe('repeated_call');
  });

  test('it outranks the failure streak, because it can name what is repeating', () => {
    const orch = newTurn();
    for (let i = 0; i < CONSECUTIVE_FAILURES_BEFORE_STEER; i++) {
      orch.turnExtension.onToolResult!({
        toolName: 'run', args: { command: 'make' }, result: 'Error (exit 2): boom', success: true,
      });
    }
    expect(injected(step(orch, 1, [user('q')]))).toHaveLength(1);
    expect(orch.steering.snapshot()?.trigger).toBe('repeated_call');
  });

  test('converted means the model did something ELSE, not that it forked', () => {
    const orch = newTurn();
    repeat(orch, 'run', { command: 'make' }, IDENTICAL_CALLS_BEFORE_STEER);
    step(orch, 1, [user('q')]);
    expect(orch.steering.snapshot()?.converted).toBe(false);

    // Repeating it once more is not a conversion.
    orch.turnExtension.onToolCall!({ toolName: 'run', args: { command: 'make' } });
    expect(orch.steering.snapshot()?.converted).toBe(false);

    orch.turnExtension.onToolCall!({ toolName: 'run', args: { command: 'cat config.log' } });
    expect(orch.steering.snapshot()?.converted).toBe(true);
  });

  test('the previous turn\'s repeats do not carry into the next one', () => {
    const orch = newTurn();
    repeat(orch, 'run', { command: 'make' }, IDENTICAL_CALLS_BEFORE_STEER);
    step(orch, 1, [user('q')]);
    orch.beginTurn(Date.now());
    expect(orch.steering.snapshot()).toBeNull();
    expect(injected(step(orch, 0, [user('next')]))).toEqual([]);
  });
});

describe('long-turn trigger', () => {
  test('a long turn with no delegation is nudged once, naming fork', () => {
    const orch = newTurn();
    expect(injected(step(orch, LONG_TURN_STEPS_BEFORE_STEER - 1, [user('q')]))).toEqual([]);
    const nudged = step(orch, LONG_TURN_STEPS_BEFORE_STEER, [user('q')]);
    expect(injected(nudged)).toHaveLength(1);
    expect(injected(nudged)[0]).toContain('25 steps into this turn with no delegation');
    expect(injected(nudged)[0]).toContain('agents` action=fork');
    expect(orch.steering.snapshot()).toEqual({
      trigger: 'long_turn_no_delegation', step: LONG_TURN_STEPS_BEFORE_STEER, converted: false,
    });
    // Every later step of a 130-step turn stays silent — a nudge that repeats
    // is spam.
    for (let s = LONG_TURN_STEPS_BEFORE_STEER + 1; s < LONG_TURN_STEPS_BEFORE_STEER + 10; s++) {
      expect(injected(step(orch, s, [user('q')]))).toHaveLength(1);
    }
  });

  test('a turn that already delegated is never nudged for length', () => {
    const orch = newTurn();
    orch.turnExtension.onToolCall!({ toolName: 'agents', args: { action: 'fork' } });
    expect(injected(step(orch, LONG_TURN_STEPS_BEFORE_STEER + 5, [user('q')]))).toEqual([]);
    expect(orch.steering.snapshot()).toBeNull();
  });

  test('one nudge per turn, whichever trigger fires first', () => {
    const orch = newTurn();
    fail(orch, 'run', CONSECUTIVE_FAILURES_BEFORE_STEER);
    expect(injected(step(orch, 1, [user('q')]))).toHaveLength(1);
    // Long and undelegated as well — still one line in the conversation.
    expect(injected(step(orch, LONG_TURN_STEPS_BEFORE_STEER + 1, [user('q')]))).toHaveLength(1);
    expect(orch.steering.snapshot()?.trigger).toBe('repeated_failure');
  });
});

describe('conversion + turn boundaries', () => {
  test('converted counts delegation AFTER the nudge, not before it', () => {
    const before = newTurn();
    before.turnExtension.onToolCall!({ toolName: 'agents', args: { action: 'fork' } });
    fail(before, 'run', CONSECUTIVE_FAILURES_BEFORE_STEER);
    step(before, 1, [user('q')]);
    expect(before.steering.snapshot()).toEqual({
      trigger: 'repeated_failure', step: 1, tool: 'run', converted: false,
    });

    before.turnExtension.onToolCall!({ toolName: 'agents', args: { action: 'fork' } });
    expect(before.steering.snapshot()?.converted).toBe(true);
  });

  test('reset clears the streaks, the splice state and the record', () => {
    const orch = newTurn();
    fail(orch, 'run', CONSECUTIVE_FAILURES_BEFORE_STEER);
    step(orch, 1, [user('q')]);
    expect(orch.steering.snapshot()).not.toBeNull();

    orch.beginTurn(Date.now());
    expect(orch.steering.snapshot()).toBeNull();
    // The previous turn's failures do not carry into this one.
    expect(injected(step(orch, 0, [user('next')]))).toEqual([]);
    fail(orch, 'run', CONSECUTIVE_FAILURES_BEFORE_STEER);
    expect(injected(step(orch, 1, [user('next')]))).toHaveLength(1);
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
        stream: new ReadableStream<ModelStreamPart>({
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
    let flakyCalls = 0;
    const orch = newTurn();
    const tools = {
      // The exit-code shape: the tool SUCCEEDS and returns the failure text.
      // Each attempt fails DIFFERENTLY, so this exercises the failure streak
      // rather than the repeat detector (which owns identical answers).
      flaky: tool({
        description: 'fails by returning its failure',
        inputSchema: z.object({}),
        execute: async () => `Error (exit 2): make: *** [all] Error 2 (attempt ${++flakyCalls})`,
      }),
    };
    for await (const _ of runChat({
      model: grindingModel(prompts) as never,
      system: 'sys',
      history: [user('build caffe')],
      tools: tools as never,
      maxSteps: 6,
      extensions: new ExtensionHost().register(orch.turnExtension),
    })) { /* drain */ }

    // Requests 1-3 issue the three failing calls; only after the third does
    // the harness speak, and it is in the request the model answers next.
    const seen = prompts.map((p) => promptText(p).includes(TURN_STEERING_HEADER));
    expect(seen.slice(0, 3)).toEqual([false, false, false]);
    expect(seen[3]).toBe(true);
    expect(promptText(prompts[3]!)).toContain('`flaky` has failed 3 times in a row');
    // …and it says it exactly once, however many more steps the turn runs.
    for (const prompt of prompts.slice(3)) {
      expect(promptText(prompt).split(TURN_STEERING_HEADER)).toHaveLength(2);
    }
    expect(orch.steering.snapshot()).toEqual({
      trigger: 'repeated_failure', step: 3, tool: 'flaky', converted: false,
    });
  });

  test('a genuinely repeated command is detected through the real SDK — the call\'s args reach the result hook', async () => {
    // The fidelity that the unit tests cannot give: `args` on the tool-result
    // seam has to survive the provider round-trip, or the repeat detector is
    // comparing empty objects and every tool looks like one repeating call.
    const prompts: ModelMessage[][] = [];
    const orch = newTurn();
    const tools = {
      run: tool({
        description: 'runs a command',
        inputSchema: z.object({ command: z.string() }),
        execute: async () => 'make: nothing to be done for `all`.',
      }),
    };
    for await (const _ of runChat({
      model: repeatingModel(prompts, 'make') as never,
      system: 'sys',
      history: [user('build it')],
      tools: tools as never,
      maxSteps: 6,
      extensions: new ExtensionHost().register(orch.turnExtension),
    })) { /* drain */ }

    const seen = prompts.map((p) => promptText(p).includes(TURN_STEERING_HEADER));
    expect(seen.slice(0, 3)).toEqual([false, false, false]);
    expect(seen[3]).toBe(true);
    expect(promptText(prompts[3]!)).toContain('`run` has run 3 times with the same arguments');
    expect(promptText(prompts[3]!)).toContain('make');
    expect(orch.steering.snapshot()).toEqual({
      trigger: 'repeated_call', step: 3, tool: 'run', converted: false,
    });
  });

  test('the same tool with DIFFERENT commands is never called a repeat, through the same path', async () => {
    const prompts: ModelMessage[][] = [];
    const orch = newTurn();
    const tools = {
      run: tool({
        description: 'runs a command',
        inputSchema: z.object({ command: z.string() }),
        execute: async () => 'the same output every time',
      }),
    };
    for await (const _ of runChat({
      model: repeatingModel(prompts, null) as never,
      system: 'sys',
      history: [user('look around')],
      tools: tools as never,
      maxSteps: 6,
      extensions: new ExtensionHost().register(orch.turnExtension),
    })) { /* drain */ }

    expect(prompts.some((p) => promptText(p).includes(TURN_STEERING_HEADER))).toBe(false);
    expect(orch.steering.snapshot()).toBeNull();
  });
});

/** Calls `run` on every step: with `command` fixed (a real repeat) or with a
 *  fresh command each step (different work). */
function repeatingModel(prompts: ModelMessage[][], command: string | null) {
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
        stream: new ReadableStream<ModelStreamPart>({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            if (done) {
              c.enqueue({ type: 'text-start', id: 't' });
              c.enqueue({ type: 'text-delta', id: 't', delta: 'giving up' });
              c.enqueue({ type: 'text-end', id: 't' });
              c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
            } else {
              c.enqueue({
                type: 'tool-call', toolCallId: `tc${step}`, toolName: 'run',
                input: JSON.stringify({ command: command ?? `ls dir${step}` }),
              });
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
