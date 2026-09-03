// Mechanical turn steering (orchestrator/turn-steering.ts) — the harness
// saying, in the turn, the one thing it can see about the turn that the model
// cannot: it is repeating itself, it is stuck on one approach, or it is
// spending without moving. Prose alone moved the model 0 times in 10 bench tasks.
//
// These are behaviour tests through the public seams: the orchestrator's turn
// extension both backends register (the steer is delivered as a turn-local
// signal through the one delivery seam, like every other async producer), and —
// for the fidelity that matters most — a full runChat turn where the steer has
// to actually reach the model's next request.
import { describe, expect, test } from 'bun:test';
import { stepCountIs, tool, type ModelMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { createTestRuntime } from '@kinu.run/test-utils';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { z } from 'zod';
import {
  AgentOrchestrator, TurnSteering, isFailingToolResult, runChat,
  IDENTICAL_CALLS_BEFORE_STEER, CONSECUTIVE_FAILURES_BEFORE_STEER,
  STEPS_WITHOUT_PROGRESS_BEFORE_STEER,
  TURN_STEERING_HEADER, ExtensionHost, EvolutionEngine, EventLog, initEventsHubTables,
  type BackendHost,
} from '../src/index';
import type { JsonObject } from '../src/utils/json';
import { makeSqlExec } from './helpers';

const user = (text: string): ModelMessage => ({ role: 'user', content: text });
/** The session's first ask — a fresh multi-part request, the shape that used
 *  to draw a delegation hint and now must draw nothing. */
const fresh = 'add caching to the api and update the docs';
const assistant = (text: string): ModelMessage => ({ role: 'assistant', content: text });

/** A FOLLOW-UP turn's opening context: an ask with this agent's own work behind
 *  it. The generic fixture for every trigger test below. */
const followUp = (text: string): ModelMessage[] => [user('earlier'), assistant('handled'), user(text)];

/** The turn's steering rows, and the last of them: the one reactive steer on
 *  every turn where one fired. */
const rows = (orch: AgentOrchestrator) => orch.steering.snapshot();
const lastSteer = (orch: AgentOrchestrator) => orch.steering.snapshot().at(-1) ?? null;

/** The loop steers never name the delegation ladder: no `agents`, no swarm,
 *  no delegation. A steer that did would reintroduce the nudge this cutover
 *  removed, through prose rather than a trigger. */
function expectNoDelegationNudge(text: string): void {
  expect(text).not.toContain('agents');
  expect(text).not.toContain('swarm');
  expect(text).not.toMatch(/delegat/i);
  expect(text).not.toContain('search');
}

/** Steering as production wires it: the orchestrator's turn extension on a
 *  backend that never queues, so a steer that fired is a steer the model saw. */
function newTurn(): AgentOrchestrator {
  const host: BackendHost = {
    broadcast: () => {},
    enqueueTurn: async () => { throw new Error('a turn-local steer must never queue'); },
    turnInFlight: () => false,
    setTimer: () => {},
  };
  const { rt } = createTestRuntime();
  const sql = makeSqlExec(new Database(':memory:'));
  initEventsHubTables(sql);
  return new AgentOrchestrator({ host, engine: new EvolutionEngine(rt, { enabled: false }), eventLog: new EventLog(sql) });
}

/** The step the model would see: whatever the turn extension hands back (or the
 *  unchanged input when nothing was injected). */
function step(orch: AgentOrchestrator, stepNumber: number, messages: ModelMessage[]): ModelMessage[] {
  const prepareStep = orch.turnExtension.prepareStep;
  if (!prepareStep) throw new Error('Expected turn steering prepareStep extension');
  const prepared = prepareStep({ stepNumber, messages });
  if (prepared instanceof Promise) throw new Error('Turn steering prepareStep must remain synchronous');
  return prepared ?? messages;
}

function injected(messages: readonly ModelMessage[]): string[] {
  return messages
    .map((message) => {
      const content = v.safeParse(v.string(), message.content);
      return content.success ? content.output : '';
    })
    .filter((text) => text.startsWith(TURN_STEERING_HEADER));
}

/** Distinct failures of one tool: a different call, answered differently, every
 *  time — so this exercises the failure streak and never the repeat detector. */
let attempt = 0;
async function fail(orch: AgentOrchestrator, toolName: string, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    attempt += 1;
    await orch.turnExtension.onToolResult!({
      toolName, args: { attempt }, result: `boom ${attempt}`, success: false,
    });
  }
}

/** The same call, answered the same way, `times` times. */
async function repeat(orch: AgentOrchestrator, toolName: string, args: JsonObject, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await orch.turnExtension.onToolCall!({ toolName, args });
    await orch.turnExtension.onToolResult!({ toolName, args, result: 'the same output', success: true });
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

  test('a bounded prefix of a REASON-FIRST refusal still reads as a failure', () => {
    // A refusal leads with its classification, where no clamp can reach it
    // (obs/error.ts `Refusal`). Reading only `error` at the head meant a clamped
    // refusal was indistinguishable from a clamped success — the same defect one
    // discriminator over.
    const truncated = `{"reason":"unavailable","error":"${'x'.repeat(60)}`;
    expect(isFailingToolResult({ toolName: 'run', args: {}, result: truncated, success: true })).toBe(true);
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
  test('three failures on one tool inject exactly one nudge, at the next step boundary', async () => {
    const orch = newTurn();
    const base = followUp('build it');
    expect(step(orch, 0, base)).toEqual(base);
    await fail(orch, 'run', CONSECUTIVE_FAILURES_BEFORE_STEER - 1);
    // Two failures is a correction, not a pattern — nothing yet.
    expect(injected(step(orch, 1, base))).toEqual([]);
    expect(lastSteer(orch)).toBeNull();

    await fail(orch, 'run');
    const nudged = step(orch, 2, base);
    expect(injected(nudged)).toHaveLength(1);
    const text = injected(nudged)[0]!;
    expect(text).toContain('`run` has failed 3 times in a row');
    expect(text).toContain('read the failure text for the actual cause');
    expect(text).toContain('a different command, a different file');
    expectNoDelegationNudge(text);
    expect(text).toContain('hint, not an instruction');
    expect(lastSteer(orch)).toEqual({ trigger: 'repeated_failure', step: 2, tool: 'run', converted: false });
  });

  test('the nudge holds its entry index across later steps and never repeats', async () => {
    const orch = newTurn();
    const base = followUp('q');
    step(orch, 0, base);
    await fail(orch, 'run', CONSECUTIVE_FAILURES_BEFORE_STEER);
    const at1 = step(orch, 1, [...base, user('a1')]);
    expect(at1.slice(0, 4).map((message) => message.content)).toEqual(['earlier', 'handled', 'q', 'a1']);
    expect(at1[4]?.content).toContain(TURN_STEERING_HEADER);
    // Later steps rebuild from scratch: the nudge re-applies at its original
    // position (cache-prefix stability) and is not re-issued.
    await fail(orch, 'run', 5);
    const at2 = step(orch, 2, [...base, user('a1'), user('a2')]);
    expect(injected(at2)).toHaveLength(1);
    expect(at2[4]!.content).toContain(TURN_STEERING_HEADER);
    expect(lastSteer(orch)?.step).toBe(1);
  });

  test('a success on that tool clears its streak; failures of other tools do not', async () => {
    const orch = newTurn();
    await fail(orch, 'run', 2);
    await orch.turnExtension.onToolResult!({ toolName: 'run', args: {}, result: 'ok', success: true });
    await fail(orch, 'run', 2);
    // Two since the success — and a different tool's failures are its own
    // streak, not this one's.
    await fail(orch, 'web_fetch', 2);
    expect(injected(step(orch, 1, [user('q')]))).toEqual([]);
    // …while a success on ANOTHER tool leaves the failing tool's streak alone:
    // interleaved reads must not launder a stuck approach.
    await orch.turnExtension.onToolResult!({ toolName: 'web_fetch', args: {}, result: 'page', success: true });
    await fail(orch, 'run');
    expect(injected(step(orch, 2, [user('q')]))).toHaveLength(1);
    expect(lastSteer(orch)?.tool).toBe('run');
  });
});

describe('repeated-call trigger', () => {
  test('three identical calls answered identically are named as a loop', async () => {
    const orch = newTurn();
    await repeat(orch, 'run', { command: 'make' }, IDENTICAL_CALLS_BEFORE_STEER - 1);
    // Two is a retry — the harness stays quiet.
    expect(injected(step(orch, 1, [user('build it')]))).toEqual([]);

    await repeat(orch, 'run', { command: 'make' });
    const steered = step(orch, 2, [user('build it')]);
    expect(injected(steered)).toHaveLength(1);
    const text = injected(steered)[0]!;
    expect(text).toContain('`run` has run 3 times with the same arguments');
    expect(text).toContain('make');
    expect(text).toContain('change the approach');
    expectNoDelegationNudge(text);
    expect(text).toContain('hint, not an instruction');
    expect(lastSteer(orch)).toEqual({
      trigger: 'repeated_call', step: 2, tool: 'run', converted: false,
    });
  });

  test('a repeat whose OUTPUT changed is not a repeat — the model learned something', async () => {
    const orch = newTurn();
    for (let i = 0; i < 6; i++) {
      await orch.turnExtension.onToolResult!({
        toolName: 'run', args: { command: 'make' }, result: `progress ${i}`, success: true,
      });
    }
    expect(injected(step(orch, 3, [user('q')]))).toEqual([]);
    expect(lastSteer(orch)).toBeNull();
  });

  test('two runs that differ only past a long shared preamble are not a repeat', async () => {
    // A pytest banner, a cargo preamble: identical for thousands of characters,
    // then the part that matters. Identity is the whole result, so the harness
    // must not claim these taught the model nothing.
    const orch = newTurn();
    const banner = 'platform linux -- pytest 8.2.0\n'.repeat(200);
    for (let i = 0; i < IDENTICAL_CALLS_BEFORE_STEER + 2; i++) {
      await orch.turnExtension.onToolResult!({
        toolName: 'run', args: { command: 'pytest' }, result: `${banner}${i} failed`, success: true,
      });
    }
    expect(injected(step(orch, 3, [user('q')]))).toEqual([]);
    expect(lastSteer(orch)).toBeNull();
  });

  test('argument order is not an approach: {a,b} and {b,a} are one call', async () => {
    const orch = newTurn();
    await repeat(orch, 'run', { command: 'make', runtime: 'laptop' });
    await repeat(orch, 'run', { runtime: 'laptop', command: 'make' });
    await repeat(orch, 'run', { command: 'make', runtime: 'laptop' });
    expect(injected(step(orch, 1, [user('q')]))).toHaveLength(1);
    expect(lastSteer(orch)?.trigger).toBe('repeated_call');
  });

  test('different arguments are different work, however many calls', async () => {
    const orch = newTurn();
    for (const command of ['ls', 'pwd', 'cat a', 'cat b', 'grep x']) {
      await repeat(orch, 'run', { command });
    }
    expect(injected(step(orch, 1, [user('q')]))).toEqual([]);
  });

  test('a succeeding read re-run identically still counts — thrash is not only failure', async () => {
    const orch = newTurn();
    await repeat(orch, 'run', { command: 'cat gates.txt' }, IDENTICAL_CALLS_BEFORE_STEER);
    expect(injected(step(orch, 1, [user('q')]))).toHaveLength(1);
    expect(lastSteer(orch)?.trigger).toBe('repeated_call');
  });

  test('it outranks the failure streak, because it can name what is repeating', async () => {
    const orch = newTurn();
    for (let i = 0; i < CONSECUTIVE_FAILURES_BEFORE_STEER; i++) {
      await orch.turnExtension.onToolResult!({
        toolName: 'run', args: { command: 'make' }, result: 'Error (exit 2): boom', success: true,
      });
    }
    expect(injected(step(orch, 1, [user('q')]))).toHaveLength(1);
    expect(lastSteer(orch)?.trigger).toBe('repeated_call');
  });

  test('converted means the model did something ELSE, not that it delegated', async () => {
    const orch = newTurn();
    await repeat(orch, 'run', { command: 'make' }, IDENTICAL_CALLS_BEFORE_STEER);
    step(orch, 1, [user('q')]);
    expect(lastSteer(orch)?.converted).toBe(false);

    // Repeating it once more is not a conversion.
    await orch.turnExtension.onToolCall!({ toolName: 'run', args: { command: 'make' } });
    expect(lastSteer(orch)?.converted).toBe(false);

    await orch.turnExtension.onToolCall!({ toolName: 'run', args: { command: 'cat config.log' } });
    expect(lastSteer(orch)?.converted).toBe(true);
  });

  test('the previous turn\'s repeats do not carry into the next one', async () => {
    const orch = newTurn();
    await repeat(orch, 'run', { command: 'make' }, IDENTICAL_CALLS_BEFORE_STEER);
    step(orch, 1, [user('q')]);
    orch.beginTurn(Date.now());
    expect(lastSteer(orch)).toBeNull();
    expect(injected(step(orch, 0, followUp('next')))).toEqual([]);
  });
});

// A stalled step is the SAME call answered DIFFERENTLY every time — a
// `git status`, a `curl /health`, a `make` whose only change is a timestamp.
// The identical-output detector cannot see any of those, which is exactly why
// this trigger exists.
describe('no-progress trigger', () => {
  test('a turn that keeps succeeding and getting nowhere is told so', async () => {
    const orch = newTurn();
    // The first call is new ground; from then on the frontier never moves.
    await orch.turnExtension.onToolResult!({
      toolName: 'run', args: { command: 'git status' }, result: 'clean 0', success: true,
    });
    let steered: string[] = [];
    for (let s = 1; s <= STEPS_WITHOUT_PROGRESS_BEFORE_STEER; s++) {
      steered = injected(step(orch, s, [user('ship it')]));
      // Nothing new happens between boundaries: the same command, a different
      // answer each time (so the repeat detector stays silent).
      await orch.turnExtension.onToolResult!({
        toolName: 'run', args: { command: 'git status' }, result: `clean ${s}`, success: true,
      });
      if (s < STEPS_WITHOUT_PROGRESS_BEFORE_STEER) expect(steered).toEqual([]);
    }
    steered = injected(step(orch, STEPS_WITHOUT_PROGRESS_BEFORE_STEER + 1, [user('ship it')]));
    expect(steered).toHaveLength(1);
    expect(steered[0]).toContain('steps in a row with nothing new');
    expect(steered[0]).toContain('Steps that succeed are not the same as steps that get somewhere');
    expectNoDelegationNudge(steered[0]!);
    expect(steered[0]).toContain('hint, not an instruction');
    expect(lastSteer(orch)).toEqual({
      trigger: 'no_progress', step: STEPS_WITHOUT_PROGRESS_BEFORE_STEER + 1, converted: false,
    });
  });

  test('a turn making new calls is never steered by this trigger', async () => {
    // Information-gathering is work. A trigger that fired on a long read-only
    // investigation would be spam, and the owner's rule is no spam. A fresh
    // command every step keeps the frontier moving past the stall threshold.
    const orch = newTurn();
    for (let s = 1; s <= STEPS_WITHOUT_PROGRESS_BEFORE_STEER + 5; s++) {
      await orch.turnExtension.onToolResult!({
        toolName: 'run', args: { command: `grep pattern${s} src/` }, result: 'no match', success: true,
      });
      expect(injected(step(orch, s, [user('q')]))).toEqual([]);
    }
    expect(lastSteer(orch)).toBeNull();
  });

  test('a file touched for the first time is progress, and resets the stall', async () => {
    // The half no tool-call signature can show: an `execute_tools` program is
    // ONE call, and what it did is only visible in the shared file ledger.
    // Two near-threshold stalls with one new file between them: twice the
    // steps it takes to fire, and it does not, because the turn moved.
    const orch = newTurn();
    let boundary = 0;
    let answer = 0;
    const idle = async () => {
      await orch.turnExtension.onToolResult!({
        toolName: 'run', args: { command: 'ls' }, result: `listing ${++answer}`, success: true,
      });
    };
    const runStall = async () => {
      for (let i = 0; i < STEPS_WITHOUT_PROGRESS_BEFORE_STEER - 1; i++) {
        expect(injected(step(orch, ++boundary, [user('q')]))).toEqual([]);
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
    // `sed -i` exits 0 whether or not it matched — a failed edit is a step
    // that spent and moved nothing, and the ledger is what can tell.
    const orch = newTurn();
    const missed = newTurn();
    for (let s = 1; s <= STEPS_WITHOUT_PROGRESS_BEFORE_STEER + 1; s++) {
      for (const o of [orch, missed]) {
        await o.turnExtension.onToolResult!({
          toolName: 'execute_tools', args: { code: 'edit()' }, result: `attempt ${s}`, success: true,
        });
      }
      if (s === 3) {
        orch.acc.files.recordEdit('/a.ts', null);
        missed.acc.files.recordEdit('/a.ts', 'ambiguous');
      }
      injected(step(orch, s, [user('q')]));
      injected(step(missed, s, [user('q')]));
    }
    // Both turns re-issue an identical-looking call, so neither trips the
    // repeat detector on args alone; only the landed edit is progress.
    expect(lastSteer(orch)).toBeNull();
    expect(lastSteer(missed)?.trigger).toBe('no_progress');
  });

  test('the identical-call steer still outranks it — it can name what repeats', async () => {
    const orch = newTurn();
    await repeat(orch, 'run', { command: 'make' }, IDENTICAL_CALLS_BEFORE_STEER);
    for (let s = 1; s <= STEPS_WITHOUT_PROGRESS_BEFORE_STEER + 1; s++) step(orch, s, [user('q')]);
    expect(lastSteer(orch)?.trigger).toBe('repeated_call');
  });

  test('a long circling turn is steered for stalling, at the stall threshold', async () => {
    // A turn that re-covers the same ground for dozens of steps is told it is
    // spending and not moving — at the stall count, not after some length.
    const orch = newTurn();
    await orch.turnExtension.onToolResult!({
      toolName: 'run', args: { command: 'git status' }, result: 'clean', success: true,
    });
    let fired: string[] = [];
    for (let s = 1; s <= STEPS_WITHOUT_PROGRESS_BEFORE_STEER + 5 && fired.length === 0; s++) {
      fired = injected(step(orch, s, [user('q')]));
      await orch.turnExtension.onToolResult!({
        toolName: 'run', args: { command: 'git status' }, result: `clean ${s}`, success: true,
      });
    }
    expect(lastSteer(orch)?.trigger).toBe('no_progress');
    expect(lastSteer(orch)).toMatchObject({ step: STEPS_WITHOUT_PROGRESS_BEFORE_STEER + 1 });
  });

  test('converted means the turn went somewhere it had not been', async () => {
    const orch = newTurn();
    await orch.turnExtension.onToolResult!({
      toolName: 'run', args: { command: 'git status' }, result: 'clean', success: true,
    });
    for (let s = 1; s <= STEPS_WITHOUT_PROGRESS_BEFORE_STEER + 1; s++) {
      step(orch, s, [user('q')]);
      await orch.turnExtension.onToolResult!({
        toolName: 'run', args: { command: 'git status' }, result: `clean ${s}`, success: true,
      });
    }
    expect(lastSteer(orch)).toMatchObject({ trigger: 'no_progress', converted: false });

    // Re-covering the same ground is not a conversion…
    await orch.turnExtension.onToolCall!({ toolName: 'run', args: { command: 'git status' } });
    expect(lastSteer(orch)?.converted).toBe(false);

    // …reaching for something the turn has not done is.
    await orch.turnExtension.onToolCall!({ toolName: 'run', args: { command: 'git log -1' } });
    expect(lastSteer(orch)?.converted).toBe(true);
  });

  test('a new turn starts with a clean stall counter', async () => {
    const orch = newTurn();
    await orch.turnExtension.onToolResult!({
      toolName: 'run', args: { command: 'git status' }, result: 'clean', success: true,
    });
    for (let s = 1; s <= STEPS_WITHOUT_PROGRESS_BEFORE_STEER; s++) step(orch, s, [user('q')]);
    orch.beginTurn(Date.now());
    expect(lastSteer(orch)).toBeNull();
    for (let s = 0; s < STEPS_WITHOUT_PROGRESS_BEFORE_STEER; s++) {
      expect(injected(step(orch, s, followUp('next')))).toEqual([]);
    }
  });
});

// There is no turn-start steering and no length steering: step 0 carries no
// hint whatever the ask looks like, and a long turn that keeps moving draws
// nothing. What follows pins that absence — a steer that reappeared here
// would be the delegation nudge through prose rather than a trigger.
describe('no turn-start or length steering', () => {
  test('a fresh ask draws no steer at step 0', () => {
    const orch = newTurn();
    expect(injected(step(orch, 0, [user(fresh)]))).toEqual([]);
    expect(rows(orch)).toEqual([]);
    // …and none arrives on the steps after it either, without loop evidence.
    expect(injected(step(orch, 1, [user(fresh)]))).toEqual([]);
    expect(rows(orch)).toEqual([]);
  });

  test('a question, an exclamation and a follow-up draw nothing either', () => {
    const asked = newTurn();
    expect(injected(step(asked, 0, [user('where does the retry budget come from?')]))).toEqual([]);
    expect(rows(asked)).toEqual([]);

    const told = newTurn();
    expect(injected(step(told, 0, [user('revert that last change!')]))).toEqual([]);
    expect(rows(told)).toEqual([]);

    const orch = newTurn();
    expect(injected(step(orch, 0, followUp(fresh)))).toEqual([]);
    expect(rows(orch)).toEqual([]);
  });

  test('a long turn that keeps moving is never steered for length', async () => {
    // Twenty-five steps of new ground used to draw the long-turn hint. Now a
    // turn that keeps reaching new calls draws nothing at any step count.
    const orch = newTurn();
    for (let s = 0; s <= STEPS_WITHOUT_PROGRESS_BEFORE_STEER + 15; s++) {
      await orch.turnExtension.onToolResult!({
        toolName: 'run', args: { command: `grep pattern${s} src/` }, result: 'no match', success: true,
      });
      expect(injected(step(orch, s, [user('q')]))).toEqual([]);
    }
    expect(lastSteer(orch)).toBeNull();
  });

  test('one steer per turn, whichever loop trigger fires first', async () => {
    const orch = newTurn();
    await fail(orch, 'run', CONSECUTIVE_FAILURES_BEFORE_STEER);
    expect(injected(step(orch, 1, [user('q')]))).toHaveLength(1);
    // Still one line in the conversation however long the turn then runs.
    for (let s = 2; s < STEPS_WITHOUT_PROGRESS_BEFORE_STEER + 10; s++) {
      expect(injected(step(orch, s, [user('q')]))).toHaveLength(1);
    }
    expect(lastSteer(orch)?.trigger).toBe('repeated_failure');
  });

  test('a new turn starts with clean steering state', () => {
    const orch = newTurn();
    step(orch, 0, [user(fresh)]);
    orch.beginTurn(Date.now());
    expect(rows(orch)).toEqual([]);
    expect(injected(step(orch, 0, [user(fresh)]))).toEqual([]);
  });
});

describe('execution-recovery detection (the failure ledger\'s second reader)', () => {
  const failing = (s: TurnSteering, args: JsonObject) =>
    s.onToolResult({ toolName: 'run', args, result: 'Error: boom', success: false });
  const clean = (s: TurnSteering, args: JsonObject) =>
    s.onToolResult({ toolName: 'run', args, result: 'ok', success: true });

  test('a steer-worthy streak broken by a CHANGED call reports the recovery, echoes bounded', () => {
    const steering = new TurnSteering();
    const long = 'x'.repeat(500);
    for (let i = 0; i < CONSECUTIVE_FAILURES_BEFORE_STEER; i++) {
      expect(failing(steering, { command: `npm test ${long} ${i}` })).toBeNull();
    }
    const recovery = clean(steering, { command: 'bun test' })!;
    expect(recovery.tool).toBe('run');
    expect(recovery.failures).toBe(CONSECUTIVE_FAILURES_BEFORE_STEER);
    expect(recovery.failedArgs).toContain('npm test');
    expect(recovery.failedArgs.length).toBeLessThanOrEqual(201); // echo cap + ellipsis
    expect(recovery.succeededArgs).toContain('bun test');
    expect(recovery.failedSignature.startsWith('run')).toBe(true);
    // The streak is spent: the next clean call has nothing to recover from.
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
    await before.turnExtension.onToolCall!({ toolName: 'run', args: { command: 'make' } });
    await fail(before, 'run', CONSECUTIVE_FAILURES_BEFORE_STEER);
    step(before, 1, [user('q')]);
    expect(lastSteer(before)).toEqual({
      trigger: 'repeated_failure', step: 1, tool: 'run', converted: false,
    });

    await before.turnExtension.onToolCall!({ toolName: 'run', args: { command: 'cat config.log' } });
    expect(lastSteer(before)?.converted).toBe(true);
  });

  test('reset clears the streaks, the splice state and the record', async () => {
    const orch = newTurn();
    await fail(orch, 'run', CONSECUTIVE_FAILURES_BEFORE_STEER);
    step(orch, 1, [user('q')]);
    expect(lastSteer(orch)).not.toBeNull();

    orch.beginTurn(Date.now());
    expect(lastSteer(orch)).toBeNull();
    // The previous turn's failures do not carry into this one.
    expect(injected(step(orch, 0, followUp('next')))).toEqual([]);
    await fail(orch, 'run', CONSECUTIVE_FAILURES_BEFORE_STEER);
    expect(injected(step(orch, 1, followUp('next')))).toHaveLength(1);
  });
});

// ── the fidelity that matters: the model actually receives it ──────────────

/** A model that calls `flaky` on every step until it is told otherwise, so a
 *  turn accumulates failures. Records the prompt of every request. */
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
  let step = 0;
  return new MockLanguageModelV3({
    doStream: async (opts) => {
      prompts.push(parsePrompt({ value: opts.prompt }));
      step += 1;
      const done = step > 4;
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
              c.enqueue({ type: 'tool-call', toolCallId: `tc${step}`, toolName: 'flaky', input: '{}' });
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

/** Every text part of a request's prompt, whatever shape the SDK put it in. */
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
      model: grindingModel(prompts),
      system: 'sys',
      history: followUp('build caffe'),
      tools,
      stopWhen: stepCountIs(6),
      extensions: new ExtensionHost().register(orch.turnExtension),
    })) { /* drain */ }

    // Requests 1-3 issue the three failing calls; only after the third does
    // the harness speak, and it is in the request the model answers next.
    const seen = prompts.map((p) => promptText(p).includes(TURN_STEERING_HEADER));
    expect(seen.slice(0, 3)).toEqual([false, false, false]);
    expect(seen[3]).toBe(true);
    expect(promptText(prompts[3] ?? [])).toContain('`flaky` has failed 3 times in a row');
    // …and it says it exactly once, however many more steps the turn runs.
    for (const prompt of prompts.slice(3)) {
      expect(promptText(prompt).split(TURN_STEERING_HEADER)).toHaveLength(2);
    }
    expect(lastSteer(orch)).toEqual({
      trigger: 'repeated_failure', step: 3, tool: 'flaky', converted: false,
    });
  });

  test('a genuinely repeated command is detected through the real SDK — the call\'s args reach the result hook', async () => {
    // The fidelity that the unit tests cannot give: `args` on the tool-result
    // seam has to survive the provider round-trip, or the repeat detector is
    // comparing empty objects and every tool looks like one repeating call.
    const prompts: PromptMessage[][] = [];
    const orch = newTurn();
    const tools = {
      run: tool({
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
    expect(promptText(prompts[3] ?? [])).toContain('`run` has run 3 times with the same arguments');
    expect(promptText(prompts[3] ?? [])).toContain('make');
    expect(lastSteer(orch)).toEqual({
      trigger: 'repeated_call', step: 3, tool: 'run', converted: false,
    });
  });

  test('the same tool with DIFFERENT commands is never called a repeat, through the same path', async () => {
    const prompts: PromptMessage[][] = [];
    const orch = newTurn();
    const tools = {
      run: tool({
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
    // The inverse of the loop tests above: step 0 has no traffic to read, so
    // the harness stays quiet — and with no turn-start hint left, nothing
    // reaches the model until a loop detector has evidence.
    const prompts: PromptMessage[][] = [];
    const orch = newTurn();
    const tools = {
      run: tool({
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

/** Calls `run` on every step: with `command` fixed (a real repeat) or with a
 *  fresh command each step (different work). */
function repeatingModel(prompts: PromptMessage[][], command: string | null) {
  let step = 0;
  return new MockLanguageModelV3({
    doStream: async (opts) => {
      prompts.push(parsePrompt({ value: opts.prompt }));
      step += 1;
      const done = step > 4;
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
                type: 'tool-call', toolCallId: `tc${step}`, toolName: 'run',
                input: JSON.stringify({ command: command ?? `ls dir${step}` }),
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
