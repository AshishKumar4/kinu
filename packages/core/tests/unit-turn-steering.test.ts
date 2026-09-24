// Mechanical turn steering (orchestrator/turn-steering.ts) through the turn extension and a full runChat turn.
import { describe, expect, test } from 'bun:test';
import { stepCountIs, tool, type ModelMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { createTestRuntime, present, unobservedSpend } from '@kinu.run/test-utils';
import * as v from 'valibot';
import { z } from 'zod';
import {
  AgentOrchestrator, TurnSteering, isFailingToolResult, runChat,
  IDENTICAL_CALLS_BEFORE_STEER, CONSECUTIVE_FAILURES_BEFORE_STEER,
  STEPS_WITHOUT_PROGRESS_BEFORE_STEER,
  TURN_STEERING_HEADER, ExtensionHost, EvolutionEngine, EventLog, initEventsHubTables,
  type BackendHost, type ToolCallContext, type ToolResultContext,
} from '../src/index';
import type { JsonObject } from '../src/utils/json';
import { makeSqlExec } from './helpers';

const user = (text: string): ModelMessage => ({ role: 'user', content: text });

/** A fresh multi-part first ask: must draw nothing. */
const fresh = 'add caching to the api and update the docs';

const assistant = (text: string): ModelMessage => ({ role: 'assistant', content: text });

/** A follow-up turn's opening context, with this agent's own work behind it. */
const followUp = (text: string): ModelMessage[] => [user('earlier'), assistant('handled'), user(text)];

const rows = (orch: AgentOrchestrator) => orch.steering.snapshot();

const lastSteer = (orch: AgentOrchestrator) => orch.steering.snapshot().at(-1) ?? null;

/** Loop steers never name delegation (`agents`, swarm): that would be a prose nudge, not a trigger. */
function expectNoDelegationNudge(text: string): void {
  expect(text).not.toContain('agents');
  expect(text).not.toContain('swarm');
  expect(text).not.toMatch(/delegat/i);
  expect(text).not.toContain('search');
}

/** On a backend that never queues, a steer that fired is one the model saw. */
function newTurn(): AgentOrchestrator {
  const host: BackendHost = {
    broadcast: () => {},
    enqueueTurn: async () => { throw new Error('a turn-local steer must never queue'); },
    turnInFlight: () => false,
    setTimer: () => {},
  };

  const { rt, testSql, stores } = createTestRuntime();
  // Same database and actor as the runtime, or the inbox is never written.
  const sql = makeSqlExec(testSql.db);
  initEventsHubTables(sql);

  return new AgentOrchestrator({
    host, engine: new EvolutionEngine(rt, stores.history, { reportModelCall: unobservedSpend, enabled: false }),
    eventLog: new EventLog(sql, rt.actor),
  });
}

async function step(orch: AgentOrchestrator, stepNumber: number, messages: ModelMessage[]): Promise<ModelMessage[]> {
  const extension = orch.turnExtension;

  if (!extension.prepareStep) throw new Error('Expected turn steering prepareStep extension');

  return await extension.prepareStep({ stepNumber, messages }) ?? messages;
}

/** An extension registered without the hook fails here rather than passing quietly. */
async function toolCall(orch: AgentOrchestrator, ctx: ToolCallContext): Promise<void> {
  const extension = orch.turnExtension;

  if (!extension.onToolCall) throw new Error('Expected turn steering onToolCall extension');

  await extension.onToolCall(ctx);
}

async function toolResult(orch: AgentOrchestrator, ctx: ToolResultContext): Promise<void> {
  const extension = orch.turnExtension;

  if (!extension.onToolResult) throw new Error('Expected turn steering onToolResult extension');

  await extension.onToolResult(ctx);
}

function injected(messages: readonly ModelMessage[]): string[] {
  return messages
    .map((message) => {
      const content = v.safeParse(v.string(), message.content);

      return content.success ? content.output : '';
    })
    .filter((text) => text.startsWith(TURN_STEERING_HEADER));
}

/** Distinct failures of one tool: exercises the failure streak, never the repeat detector. */
let attempt = 0;

async function fail(orch: AgentOrchestrator, toolName: string, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    attempt += 1;
    await toolResult(orch, {
      toolName, args: { attempt }, result: 'boom ' + attempt, success: false, reason: null,
    });
  }
}

async function repeat(orch: AgentOrchestrator, toolName: string, args: JsonObject, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await toolCall(orch, { toolName, args });
    await toolResult(orch, { toolName, args, result: 'the same output', success: true });
  }
}

describe('isFailingToolResult — invocation outcome is independent of rendering', () => {
  test('a recorded failure stays failed even when the display is truncated', () => {
    expect(isFailingToolResult({ toolName: 'shell', args: {}, result: '{"error":"cut', success: false, reason: 'io', execution: { exitCode: 2 } })).toBe(true);
    expect(isFailingToolResult({ toolName: 'eval', args: {}, result: '', success: false, reason: null })).toBe(true);
  });

  test('successful error-shaped JSON and error-prefixed text remain data', () => {
    expect(isFailingToolResult({ toolName: 'shell', args: {}, result: '{"reason":"denied","error":"history"}', success: true })).toBe(false);
    expect(isFailingToolResult({ toolName: 'shell', args: {}, result: 'Error report: zero failures', success: true })).toBe(false);
    expect(isFailingToolResult({ toolName: 'eval', args: {}, result: '{"error":"cut', success: true })).toBe(false);
  });

  test('a failure with unknown classification still fails', () => {
    expect(isFailingToolResult({ toolName: 'shell', args: {}, result: 'boom', success: false, reason: null })).toBe(true);
  });
});

describe('repeated-failure trigger', () => {
  test('three failures on one tool inject exactly one nudge, at the next step boundary', async () => {
    const orch = newTurn();
    const base = followUp('build it');
    expect(await step(orch, 0, base)).toEqual(base);
    await fail(orch, 'shell', CONSECUTIVE_FAILURES_BEFORE_STEER - 1);
    expect(injected(await step(orch, 1, base))).toEqual([]);
    expect(lastSteer(orch)).toBeNull();

    await fail(orch, 'shell');
    const nudged = await step(orch, 2, base);
    expect(injected(nudged)).toHaveLength(1);
    const text = injected(nudged)[0];
    expect(text).toContain('`shell` has failed 3 times in a row');
    expect(text).toContain('read the failure text for the actual cause');
    expect(text).toContain('a different command, a different file');
    expectNoDelegationNudge(text);
    expect(text).toContain('hint, not an instruction');
    expect(lastSteer(orch)).toEqual({ trigger: 'repeated_failure', step: 2, tool: 'shell', converted: false });
  });

  test('the nudge holds its entry index across later steps and never repeats', async () => {
    const orch = newTurn();
    const base = followUp('q');
    await step(orch, 0, base);
    await fail(orch, 'shell', CONSECUTIVE_FAILURES_BEFORE_STEER);
    const at1 = await step(orch, 1, [...base, user('a1')]);
    expect(at1.slice(0, 4).map((message) => message.content)).toEqual(['earlier', 'handled', 'q', 'a1']);
    expect(at1[4]?.content).toContain(TURN_STEERING_HEADER);
    // Later steps re-apply the nudge at its original position (cache-prefix stability).
    await fail(orch, 'shell', 5);
    const at2 = await step(orch, 2, [...base, user('a1'), user('a2')]);
    expect(injected(at2)).toHaveLength(1);
    expect(at2[4].content).toContain(TURN_STEERING_HEADER);
    expect(lastSteer(orch)?.step).toBe(1);
  });

  test('a success on that tool clears its streak; failures of other tools do not', async () => {
    const orch = newTurn();
    await fail(orch, 'shell', 2);
    await toolResult(orch, { toolName: 'shell', args: {}, result: 'ok', success: true });
    await fail(orch, 'shell', 2);
    await fail(orch, 'web_fetch', 2);
    expect(injected(await step(orch, 1, [user('q')]))).toEqual([]);
    // A success on another tool must not reset the failing tool's streak.
    await toolResult(orch, { toolName: 'web_fetch', args: {}, result: 'page', success: true });
    await fail(orch, 'shell');
    expect(injected(await step(orch, 2, [user('q')]))).toHaveLength(1);
    expect(lastSteer(orch)?.tool).toBe('shell');
  });
});

describe('repeated-call trigger', () => {
  test('three identical calls answered identically are named as a loop', async () => {
    const orch = newTurn();
    await repeat(orch, 'shell', { command: 'make' }, IDENTICAL_CALLS_BEFORE_STEER - 1);
    expect(injected(await step(orch, 1, [user('build it')]))).toEqual([]);

    await repeat(orch, 'shell', { command: 'make' });
    const steered = await step(orch, 2, [user('build it')]);
    expect(injected(steered)).toHaveLength(1);
    const text = injected(steered)[0];
    expect(text).toContain('`shell` has run 3 times with the same arguments');
    expect(text).toContain('make');
    expect(text).toContain('change the approach');
    expectNoDelegationNudge(text);
    expect(text).toContain('hint, not an instruction');
    expect(lastSteer(orch)).toEqual({
      trigger: 'repeated_call', step: 2, tool: 'shell', converted: false,
    });
  });

  test('a repeat whose OUTPUT changed is not a repeat — the model learned something', async () => {
    const orch = newTurn();

    for (let i = 0; i < 6; i++) {
      await toolResult(orch, {
        toolName: 'shell', args: { command: 'make' }, result: `progress ${i}`, success: true,
      });
    }

    expect(injected(await step(orch, 3, [user('q')]))).toEqual([]);
    expect(lastSteer(orch)).toBeNull();
  });

  test('two runs that differ only past a long shared preamble are not a repeat', async () => {
    // Identical long prefixes (pytest banner, cargo preamble) with a differing tail.
    const orch = newTurn();
    const banner = 'platform linux -- pytest 8.2.0\n'.repeat(200);

    for (let i = 0; i < IDENTICAL_CALLS_BEFORE_STEER + 2; i++) {
      await toolResult(orch, {
        toolName: 'shell', args: { command: 'pytest' }, result: `${banner}${i} failed`, success: true,
      });
    }

    expect(injected(await step(orch, 3, [user('q')]))).toEqual([]);
    expect(lastSteer(orch)).toBeNull();
  });

  test('argument order is not an approach: {a,b} and {b,a} are one call', async () => {
    const orch = newTurn();
    await repeat(orch, 'shell', { command: 'make', runtime: 'device' });
    await repeat(orch, 'shell', { runtime: 'device', command: 'make' });
    await repeat(orch, 'shell', { command: 'make', runtime: 'device' });
    expect(injected(await step(orch, 1, [user('q')]))).toHaveLength(1);
    expect(lastSteer(orch)?.trigger).toBe('repeated_call');
  });

  test('different arguments are different work, however many calls', async () => {
    const orch = newTurn();

    for (const command of ['ls', 'pwd', 'cat a', 'cat b', 'grep x']) {
      await repeat(orch, 'shell', { command });
    }

    expect(injected(await step(orch, 1, [user('q')]))).toEqual([]);
  });

  test('a succeeding read re-run identically still counts — thrash is not only failure', async () => {
    const orch = newTurn();
    await repeat(orch, 'shell', { command: 'cat gates.txt' }, IDENTICAL_CALLS_BEFORE_STEER);
    expect(injected(await step(orch, 1, [user('q')]))).toHaveLength(1);
    expect(lastSteer(orch)?.trigger).toBe('repeated_call');
  });

  test('it outranks the failure streak, because it can name what is repeating', async () => {
    const orch = newTurn();

    for (let i = 0; i < CONSECUTIVE_FAILURES_BEFORE_STEER; i++) {
      await toolResult(orch, {
        toolName: 'shell', args: { command: 'make' }, result: 'Error (exit 2): boom', success: true,
      });
    }

    expect(injected(await step(orch, 1, [user('q')]))).toHaveLength(1);
    expect(lastSteer(orch)?.trigger).toBe('repeated_call');
  });

  test('converted means the model did something ELSE, not that it delegated', async () => {
    const orch = newTurn();
    await repeat(orch, 'shell', { command: 'make' }, IDENTICAL_CALLS_BEFORE_STEER);
    await step(orch, 1, [user('q')]);
    expect(lastSteer(orch)?.converted).toBe(false);

    await toolCall(orch, { toolName: 'shell', args: { command: 'make' } });
    expect(lastSteer(orch)?.converted).toBe(false);

    await toolCall(orch, { toolName: 'shell', args: { command: 'cat config.log' } });
    expect(lastSteer(orch)?.converted).toBe(true);
  });

  test('the previous turn\'s repeats do not carry into the next one', async () => {
    const orch = newTurn();
    await repeat(orch, 'shell', { command: 'make' }, IDENTICAL_CALLS_BEFORE_STEER);
    await step(orch, 1, [user('q')]);
    orch.beginTurn(Date.now());
    expect(lastSteer(orch)).toBeNull();
    expect(injected(await step(orch, 0, followUp('next')))).toEqual([]);
  });
});

async function expectNeverSteeredWhileMoving(firstStep: number, lastStep: number): Promise<void> {
  const orch = newTurn();

  for (let s = firstStep; s <= lastStep; s++) {
    await toolResult(orch, {
      toolName: 'shell', args: { command: `grep pattern${s} src/` }, result: 'no match', success: true,
    });
    expect(injected(await step(orch, s, [user('q')]))).toEqual([]);
  }

  expect(lastSteer(orch)).toBeNull();
}

// Stall: the same call answered differently each time, invisible to the repeat detector.
describe('no-progress trigger', () => {
  test('a turn that keeps succeeding and getting nowhere is told so', async () => {
    const orch = newTurn();
    await toolResult(orch, {
      toolName: 'shell', args: { command: 'git status' }, result: 'clean 0', success: true,
    });
    let steered: string[] = [];

    for (let s = 1; s <= STEPS_WITHOUT_PROGRESS_BEFORE_STEER; s++) {
      steered = injected(await step(orch, s, [user('ship it')]));
      await toolResult(orch, {
        toolName: 'shell', args: { command: 'git status' }, result: `clean ${s}`, success: true,
      });

      if (s < STEPS_WITHOUT_PROGRESS_BEFORE_STEER) expect(steered).toEqual([]);
    }

    steered = injected(await step(orch, STEPS_WITHOUT_PROGRESS_BEFORE_STEER + 1, [user('ship it')]));
    expect(steered).toHaveLength(1);
    expect(steered[0]).toContain('steps in a row with nothing new');
    expect(steered[0]).toContain('Steps that succeed are not the same as steps that get somewhere');
    expectNoDelegationNudge(steered[0]);
    expect(steered[0]).toContain('hint, not an instruction');
    expect(lastSteer(orch)).toEqual({
      trigger: 'no_progress', step: STEPS_WITHOUT_PROGRESS_BEFORE_STEER + 1, converted: false,
    });
  });

  test('a turn making new calls is never steered by this trigger', async () => {
    // A long read-only investigation with fresh commands must not fire.
    await expectNeverSteeredWhileMoving(1, STEPS_WITHOUT_PROGRESS_BEFORE_STEER + 5);
  });

  test('a file touched for the first time is progress, and resets the stall', async () => {
    // An `eval` call's progress is only visible in the file ledger.
    const orch = newTurn();
    let boundary = 0;
    let answer = 0;

    const idle = async () => {
      await toolResult(orch, {
        toolName: 'shell', args: { command: 'ls' }, result: `listing ${++answer}`, success: true,
      });
    };

    const runStall = async () => {
      for (let i = 0; i < STEPS_WITHOUT_PROGRESS_BEFORE_STEER - 1; i++) {
        expect(injected(await step(orch, ++boundary, [user('q')]))).toEqual([]);
        await idle();
      }
    };

    await idle();
    await runStall();
    orch.acc.files.observeWhole('/src/server.ts', 'export const x = 1;\n');
    await runStall();

    expect(boundary).toBeGreaterThan(STEPS_WITHOUT_PROGRESS_BEFORE_STEER);
    expect(lastSteer(orch)).toBeNull();
  });

  test('an edit that landed is progress; one that missed is not', async () => {
    // `sed -i` exits 0 even when it matched nothing; only the ledger shows no progress.
    const orch = newTurn();
    const missed = newTurn();

    for (let s = 1; s <= STEPS_WITHOUT_PROGRESS_BEFORE_STEER + 1; s++) {
      for (const o of [orch, missed]) {
        await toolResult(o, {
          toolName: 'eval', args: { code: 'edit()' }, result: `attempt ${s}`, success: true,
        });
      }

      if (s === 3) {
        orch.acc.files.recordEdit('/a.ts', null);
        missed.acc.files.recordEdit('/a.ts', 'ambiguous');
      }

      injected(await step(orch, s, [user('q')]));
      injected(await step(missed, s, [user('q')]));
    }

    expect(lastSteer(orch)).toBeNull();
    expect(lastSteer(missed)?.trigger).toBe('no_progress');
  });

  test('the identical-call steer still outranks it — it can name what repeats', async () => {
    const orch = newTurn();
    await repeat(orch, 'shell', { command: 'make' }, IDENTICAL_CALLS_BEFORE_STEER);

    for (let s = 1; s <= STEPS_WITHOUT_PROGRESS_BEFORE_STEER + 1; s++) await step(orch, s, [user('q')]);
    expect(lastSteer(orch)?.trigger).toBe('repeated_call');
  });

  test('a long circling turn is steered for stalling, at the stall threshold', async () => {
    const orch = newTurn();
    await toolResult(orch, {
      toolName: 'shell', args: { command: 'git status' }, result: 'clean', success: true,
    });
    let fired: string[] = [];

    for (let s = 1; s <= STEPS_WITHOUT_PROGRESS_BEFORE_STEER + 5 && fired.length === 0; s++) {
      fired = injected(await step(orch, s, [user('q')]));
      await toolResult(orch, {
        toolName: 'shell', args: { command: 'git status' }, result: `clean ${s}`, success: true,
      });
    }

    expect(lastSteer(orch)?.trigger).toBe('no_progress');
    expect(lastSteer(orch)).toMatchObject({ step: STEPS_WITHOUT_PROGRESS_BEFORE_STEER + 1 });
  });

  test('converted means the turn went somewhere it had not been', async () => {
    const orch = newTurn();
    await toolResult(orch, {
      toolName: 'shell', args: { command: 'git status' }, result: 'clean', success: true,
    });

    for (let s = 1; s <= STEPS_WITHOUT_PROGRESS_BEFORE_STEER + 1; s++) {
      await step(orch, s, [user('q')]);
      await toolResult(orch, {
        toolName: 'shell', args: { command: 'git status' }, result: `clean ${s}`, success: true,
      });
    }

    expect(lastSteer(orch)).toMatchObject({ trigger: 'no_progress', converted: false });

    await toolCall(orch, { toolName: 'shell', args: { command: 'git status' } });
    expect(lastSteer(orch)?.converted).toBe(false);

    await toolCall(orch, { toolName: 'shell', args: { command: 'git log -1' } });
    expect(lastSteer(orch)?.converted).toBe(true);
  });

  test('a new turn starts with a clean stall counter', async () => {
    const orch = newTurn();
    await toolResult(orch, {
      toolName: 'shell', args: { command: 'git status' }, result: 'clean', success: true,
    });

    for (let s = 1; s <= STEPS_WITHOUT_PROGRESS_BEFORE_STEER; s++) await step(orch, s, [user('q')]);
    orch.beginTurn(Date.now());
    expect(lastSteer(orch)).toBeNull();

    for (let s = 0; s < STEPS_WITHOUT_PROGRESS_BEFORE_STEER; s++) {
      expect(injected(await step(orch, s, followUp('next')))).toEqual([]);
    }
  });
});

// No turn-start or length steering: step 0 and long moving turns draw nothing.
describe('no turn-start or length steering', () => {
  test('a fresh ask draws no steer at step 0', async () => {
    const orch = newTurn();
    expect(injected(await step(orch, 0, [user(fresh)]))).toEqual([]);
    expect(rows(orch)).toEqual([]);
    expect(injected(await step(orch, 1, [user(fresh)]))).toEqual([]);
    expect(rows(orch)).toEqual([]);
  });

  test('a question, an exclamation and a follow-up draw nothing either', async () => {
    const asked = newTurn();
    expect(injected(await step(asked, 0, [user('where does the retry budget come from?')]))).toEqual([]);
    expect(rows(asked)).toEqual([]);

    const told = newTurn();
    expect(injected(await step(told, 0, [user('revert that last change!')]))).toEqual([]);
    expect(rows(told)).toEqual([]);

    const orch = newTurn();
    expect(injected(await step(orch, 0, followUp(fresh)))).toEqual([]);
    expect(rows(orch)).toEqual([]);
  });

  test('a long turn that keeps moving is never steered for length', async () => {
    await expectNeverSteeredWhileMoving(0, STEPS_WITHOUT_PROGRESS_BEFORE_STEER + 15);
  });

  test('one steer per turn, whichever loop trigger fires first', async () => {
    const orch = newTurn();
    await fail(orch, 'shell', CONSECUTIVE_FAILURES_BEFORE_STEER);
    expect(injected(await step(orch, 1, [user('q')]))).toHaveLength(1);

    for (let s = 2; s < STEPS_WITHOUT_PROGRESS_BEFORE_STEER + 10; s++) {
      expect(injected(await step(orch, s, [user('q')]))).toHaveLength(1);
    }

    expect(lastSteer(orch)?.trigger).toBe('repeated_failure');
  });

  test('a new turn starts with clean steering state', async () => {
    const orch = newTurn();
    await step(orch, 0, [user(fresh)]);
    orch.beginTurn(Date.now());
    expect(rows(orch)).toEqual([]);
    expect(injected(await step(orch, 0, [user(fresh)]))).toEqual([]);
  });
});

describe('execution-recovery detection (the failure ledger\'s second reader)', () => {
  const failing = (s: TurnSteering, args: JsonObject) =>
    s.onToolResult({ toolName: 'shell', args, result: 'Error: boom', success: false, reason: null });

  const clean = (s: TurnSteering, args: JsonObject) =>
    s.onToolResult({ toolName: 'shell', args, result: 'ok', success: true });

  test('a steer-worthy streak broken by a CHANGED call reports the recovery, echoes bounded', () => {
    const steering = new TurnSteering();
    const long = 'x'.repeat(500);

    for (let i = 0; i < CONSECUTIVE_FAILURES_BEFORE_STEER; i++) {
      expect(failing(steering, { command: `npm test ${long} ${i}` })).toBeNull();
    }

    const recovery = present(clean(steering, { command: 'bun test' }), 'recovery finding');
    expect(recovery.tool).toBe('shell');
    expect(recovery.failures).toBe(CONSECUTIVE_FAILURES_BEFORE_STEER);
    expect(recovery.failedArgs).toContain('npm test');
    expect(recovery.failedArgs.length).toBeLessThanOrEqual(201);
    expect(recovery.succeededArgs).toContain('bun test');
    expect(recovery.failedSignature.startsWith('shell')).toBe(true);
    expect(clean(steering, { command: 'bun lint' })).toBeNull();
  });

  test('below the steer threshold there is nothing to write down', () => {
    const steering = new TurnSteering();
    failing(steering, { command: 'a' });
    failing(steering, { command: 'b' });
    expect(clean(steering, { command: 'c' })).toBeNull();
  });

  test('the SAME call finally working is a lucky retry, not a recovery', () => {
    const steering = new TurnSteering();

    for (let i = 0; i < CONSECUTIVE_FAILURES_BEFORE_STEER; i++) failing(steering, { command: 'make' });
    expect(clean(steering, { command: 'make' })).toBeNull();
  });

  test('another tool\'s success neither claims nor clears the streak', () => {
    const steering = new TurnSteering();

    for (let i = 0; i < CONSECUTIVE_FAILURES_BEFORE_STEER; i++) failing(steering, { command: `try ${i}` });
    expect(steering.onToolResult({ toolName: 'web_fetch', args: { url: 'x' }, result: 'page', success: true })).toBeNull();
    expect(clean(steering, { command: 'the fix' })).not.toBeNull();
  });

  test('reset drops a streak with the rest of the turn state', () => {
    const steering = new TurnSteering();

    for (let i = 0; i < CONSECUTIVE_FAILURES_BEFORE_STEER; i++) failing(steering, { command: `try ${i}` });
    steering.reset();
    expect(clean(steering, { command: 'unrelated' })).toBeNull();
  });
});

describe('conversion + turn boundaries', () => {
  test('converted counts a changed call AFTER the nudge, not before it', async () => {
    const before = newTurn();
    await toolCall(before, { toolName: 'shell', args: { command: 'make' } });
    await fail(before, 'shell', CONSECUTIVE_FAILURES_BEFORE_STEER);
    await step(before, 1, [user('q')]);
    expect(lastSteer(before)).toEqual({
      trigger: 'repeated_failure', step: 1, tool: 'shell', converted: false,
    });

    await toolCall(before, { toolName: 'shell', args: { command: 'cat config.log' } });
    expect(lastSteer(before)?.converted).toBe(true);
  });

  test('reset clears the streaks, the splice state and the record', async () => {
    const orch = newTurn();
    await fail(orch, 'shell', CONSECUTIVE_FAILURES_BEFORE_STEER);
    await step(orch, 1, [user('q')]);
    expect(lastSteer(orch)).not.toBeNull();

    orch.beginTurn(Date.now());
    expect(lastSteer(orch)).toBeNull();
    expect(injected(await step(orch, 0, followUp('next')))).toEqual([]);
    await fail(orch, 'shell', CONSECUTIVE_FAILURES_BEFORE_STEER);
    expect(injected(await step(orch, 1, followUp('next')))).toHaveLength(1);
  });
});

/** Calls `flaky` every step until told otherwise; records every request prompt. */
interface PromptMessage {
  content: string | Array<{ text?: string }>;
}

const PromptSchema = v.array(v.object({
  content: v.union([
    v.string(),
    v.array(v.object({ text: v.optional(v.string()) })),
  ]),
}));

function parsePrompt(input: { value: unknown }): PromptMessage[] {
  return v.parse(PromptSchema, input.value);
}

function grindingModel(prompts: PromptMessage[][]) {
  let stepsSeen = 0;

  return new MockLanguageModelV3({
    doStream: async (opts) => {
      prompts.push(parsePrompt({ value: opts.prompt }));
      stepsSeen += 1;
      const done = stepsSeen > 4;

      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });

            if (done) {
              c.enqueue({ type: 'text-start', id: 't' });
              c.enqueue({ type: 'text-delta', id: 't', delta: 'giving up' });
              c.enqueue({ type: 'text-end', id: 't' });
              c.enqueue({
                type: 'finish', finishReason: { unified: 'stop', raw: undefined },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                  outputTokens: { total: 1, text: 1, reasoning: undefined },
                },
              });
            } else {
              c.enqueue({ type: 'tool-call', toolCallId: `tc${stepsSeen}`, toolName: 'flaky', input: '{}' });
              c.enqueue({
                type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                  outputTokens: { total: 1, text: 1, reasoning: undefined },
                },
              });
            }

            c.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });
}

function promptText(messages: PromptMessage[]): string {
  return messages.map((message) => {
    const text = v.safeParse(v.string(), message.content);

    return text.success
      ? text.output
      : v.parse(v.array(v.object({ text: v.optional(v.string()) })), message.content)
        .map((part) => part.text ?? '').join(' ');
  }).join('\n');
}

describe('through a real runChat turn', () => {
  test('the nudge reaches the model\'s next request after the third failure', async () => {
    const prompts: PromptMessage[][] = [];
    let flakyCalls = 0;
    const orch = newTurn();

    const tools = {
      flaky: tool({
        description: 'raises a distinct failure on each invocation',
        inputSchema: z.object({}),
        execute: async (): Promise<string> => { throw new Error('build failed on attempt ' + (++flakyCalls)); },
      }),
    };

    for await (const _ of runChat({
      model: grindingModel(prompts),
      system: 'sys',
      history: followUp('build caffe'),
      tools,
      stopWhen: stepCountIs(6),
      extensions: new ExtensionHost().register(orch.turnExtension),
    })) { /* drain */ }

    const seen = prompts.map((p) => promptText(p).includes(TURN_STEERING_HEADER));
    expect(seen.slice(0, 3)).toEqual([false, false, false]);
    expect(seen[3]).toBe(true);
    expect(promptText(prompts[3] ?? [])).toContain('`flaky` has failed 3 times in a row');

    for (const prompt of prompts.slice(3)) {
      expect(promptText(prompt).split(TURN_STEERING_HEADER)).toHaveLength(2);
    }

    expect(lastSteer(orch)).toEqual({
      trigger: 'repeated_failure', step: 3, tool: 'flaky', converted: false,
    });
  });

  test('a genuinely repeated command is detected through the real SDK — the call\'s args reach the result hook', async () => {
    // `args` must survive the provider round-trip, or the repeat detector compares empty objects.
    const prompts: PromptMessage[][] = [];
    const orch = newTurn();

    const tools = {
      shell: tool({
        description: 'runs a command',
        inputSchema: z.object({ command: z.string() }),
        execute: async () => 'make: nothing to be done for `all`.',
      }),
    };

    for await (const _ of runChat({
      model: repeatingModel(prompts, 'make'),
      system: 'sys',
      history: followUp('build it'),
      tools,
      stopWhen: stepCountIs(6),
      extensions: new ExtensionHost().register(orch.turnExtension),
    })) { /* drain */ }

    const seen = prompts.map((p) => promptText(p).includes(TURN_STEERING_HEADER));
    expect(seen.slice(0, 3)).toEqual([false, false, false]);
    expect(seen[3]).toBe(true);
    expect(promptText(prompts[3] ?? [])).toContain('`shell` has run 3 times with the same arguments');
    expect(promptText(prompts[3] ?? [])).toContain('make');
    expect(lastSteer(orch)).toEqual({
      trigger: 'repeated_call', step: 3, tool: 'shell', converted: false,
    });
  });

  test('the same tool with DIFFERENT commands is never called a repeat, through the same path', async () => {
    const prompts: PromptMessage[][] = [];
    const orch = newTurn();

    const tools = {
      shell: tool({
        description: 'runs a command',
        inputSchema: z.object({ command: z.string() }),
        execute: async () => 'the same output every time',
      }),
    };

    for await (const _ of runChat({
      model: repeatingModel(prompts, null),
      system: 'sys',
      history: followUp('look around'),
      tools,
      stopWhen: stepCountIs(6),
      extensions: new ExtensionHost().register(orch.turnExtension),
    })) { /* drain */ }

    expect(prompts.some((p) => promptText(p).includes(TURN_STEERING_HEADER))).toBe(false);
    expect(lastSteer(orch)).toBeNull();
  });

  test('a fresh ask carries no steering in the FIRST request the model ever sees', async () => {
    const prompts: PromptMessage[][] = [];
    const orch = newTurn();

    const tools = {
      shell: tool({
        description: 'runs a command',
        inputSchema: z.object({ command: z.string() }),
        execute: async () => 'ok',
      }),
    };

    for await (const _ of runChat({
      model: repeatingModel(prompts, null),
      system: 'sys',
      history: [user('add caching to the api and update the docs')],
      tools,
      stopWhen: stepCountIs(4),
      extensions: new ExtensionHost().register(orch.turnExtension),
    })) { /* drain */ }

    for (const prompt of prompts) {
      expect(promptText(prompt)).not.toContain(TURN_STEERING_HEADER);
    }

    expect(rows(orch)).toEqual([]);
  });
});

/** Calls `shell` every step, with a fixed `command` (repeat) or a fresh one. */
function repeatingModel(prompts: PromptMessage[][], command: string | null) {
  let stepsSeen = 0;

  return new MockLanguageModelV3({
    doStream: async (opts) => {
      prompts.push(parsePrompt({ value: opts.prompt }));
      stepsSeen += 1;
      const done = stepsSeen > 4;

      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });

            if (done) {
              c.enqueue({ type: 'text-start', id: 't' });
              c.enqueue({ type: 'text-delta', id: 't', delta: 'giving up' });
              c.enqueue({ type: 'text-end', id: 't' });
              c.enqueue({
                type: 'finish', finishReason: { unified: 'stop', raw: undefined },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                  outputTokens: { total: 1, text: 1, reasoning: undefined },
                },
              });
            } else {
              c.enqueue({
                type: 'tool-call', toolCallId: `tc${stepsSeen}`, toolName: 'shell',
                input: JSON.stringify({ command: command ?? `ls dir${stepsSeen}` }),
              });
              c.enqueue({
                type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                  outputTokens: { total: 1, text: 1, reasoning: undefined },
                },
              });
            }

            c.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });
}
