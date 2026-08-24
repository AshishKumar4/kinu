// Shared turn-lifecycle spine (orchestrator/turn-lifecycle.ts) — the run-event
// bracket, the CompletedTurn snapshot, the measured compaction trigger, and the
// applied overflow-recovery policy. Both backends delegate here, so these
// payload shapes ARE the cross-backend contract.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  initRunEventTables, RunEventRecorder,
  openTurnRun, closeTurnRun, snapshotCompletedTurn,
  persistMeasuredPromptTokens, applyOverflowRecovery, creditedTurnId,
  TurnAccumulator, TurnSteering, CraftCycle, TurnEscalationLedger,
  OVERFLOW_RETRY_EVENT, OVERFLOW_RETRY_TEXT,
  SPILL_DIRS,
  type AgentSignal, type CompactionTriggerState,
} from '../src/index';
import { makeSql, makeExecRaw } from './helpers';
import type { TurnRunRecorder } from '../src/orchestrator/turn-lifecycle';

function recorder(): RunEventRecorder {
  const db = new Database(':memory:');
  initRunEventTables(makeExecRaw(db));
  return new RunEventRecorder(makeSql(db));
}

function recordingState(): CompactionTriggerState & {
  saved: Array<[key: string, tokens: number, length: number]>;
  armed: string[];
} {
  const saved: Array<[key: string, tokens: number, length: number]> = [];
  const armed: string[] = [];
  return {
    saved, armed,
    savePromptTokens: (key, tokens, len) => { saved.push([key, tokens, len]); },
    armForceCompaction: (key) => { armed.push(key); },
  };
}

describe('openTurnRun / closeTurnRun', () => {
  test('the bracket emits run_start+turn_start … turn_end+run_end with the shared payload shapes', () => {
    const rec = recorder();
    openTurnRun(rec, 'run-1', { agentId: 'ws', causedBy: 'chat', userMessage: 'X'.repeat(600), turnIndex: 3 });
    closeTurnRun(rec, 'run-1', {
      turnIndex: 3,
      usage: { input: 10, output: 5, cacheRead: 2 },
      reason: 'error',
      error: 'boom',
    });
    const events = rec.read('run-1');
    expect(events.map((e) => e.type)).toEqual(['run_start', 'turn_start', 'turn_end', 'run_end']);
    const start = events[0];
    if (start?.type !== 'run_start') throw new Error('Expected run_start as the first event');
    expect(start.agentId).toBe('ws');
    expect(start.caused_by).toBe('chat');
    expect(start.userMessage?.length).toBe(500); // bounded at the spine, not per backend
    const turnEnd = events[2];
    if (turnEnd?.type !== 'turn_end') throw new Error('Expected turn_end as the third event');
    expect(turnEnd.usage).toEqual({ input: 10, output: 5, cacheRead: 2 });
    const runEnd = events[3];
    if (runEnd?.type !== 'run_end') throw new Error('Expected run_end as the fourth event');
    expect(runEnd.reason).toBe('error');
    expect(runEnd.error).toBe('boom');
  });

  test('the turn writes its context-budget ledger row before the seal — the M1 counters', () => {
    const rec = recorder();
    const acc = new TurnAccumulator();
    acc.reset(Date.now());
    acc.context.admit(41_000);
    acc.context.recordSpill({ producer: 'run', omitted: 160_000, referenced: true });
    acc.recordToolCall({
      toolName: 'execute_tools',
      input: { code: `await workspace.readFile('/${SPILL_DIRS.toolOutput}/abc.log')` },
      success: true,
      output: 'ok',
    });

    openTurnRun(rec, 'run-2', { agentId: 'ws', causedBy: 'chat', userMessage: 'm', turnIndex: 0 });
    closeTurnRun(rec, 'run-2', {
      turnIndex: 0, usage: { input: 1, output: 1 }, reason: 'completed', context: acc.context,
    });

    const events = rec.read('run-2');
    expect(events.map((e) => e.type)).toEqual(['run_start', 'turn_start', 'context_budget', 'turn_end', 'run_end']);
    const row = events[2];
    if (row?.type !== 'context_budget') throw new Error('Expected context_budget before turn_end');
    expect(row.admittedChars).toBe(41_000);
    expect(row.omittedChars).toBe(160_000);
    expect(row.trips).toEqual({ run: 1 });
    expect(row.referenced).toBe(1);
    expect(row.followUps).toBe(1);
  });

  test('a turn that never touched bulk writes no ledger row — turn_end is the denominator', () => {
    const rec = recorder();
    const acc = new TurnAccumulator();
    acc.reset(Date.now());
    closeTurnRun(rec, 'run-3', {
      turnIndex: 0, usage: { input: 1, output: 1 }, reason: 'completed', context: acc.context,
    });
    expect(rec.read('run-3').map((e) => e.type)).toEqual(['turn_end', 'run_end']);
  });

  test('a steered turn writes its turn_steering row; an unsteered one writes none', () => {
    const rec = recorder();
    const steering = new TurnSteering();
    // Three DIFFERENT failures of one tool — the failure streak, not a repeat.
    for (const boom of ['boom a', 'boom b', 'boom c']) {
      steering.onToolResult({ toolName: 'run', args: { command: boom }, result: `Error (exit 2): ${boom}`, success: true });
    }
    steering.steerFor({ stepNumber: 4, messages: [] });
    steering.onToolCall({ toolName: 'agents', args: { action: 'fork' } });

    closeTurnRun(rec, 'run-n', {
      turnIndex: 0, usage: { input: 1, output: 1 }, reason: 'completed',
      steering: steering.snapshot(),
    });
    const events = rec.read('run-n');
    expect(events.map((e) => e.type)).toEqual(['turn_steering', 'turn_end', 'run_end']);
    const row = events[0];
    if (row?.type !== 'turn_steering') throw new Error('Expected turn_steering before turn_end');
    expect(row.trigger).toBe('repeated_failure');
    expect(row.tool).toBe('run');
    expect(row.step).toBe(4);
    // The conversion numerator: the model reached for the ladder afterwards.
    expect(row.converted).toBe(true);

    closeTurnRun(rec, 'run-quiet', {
      turnIndex: 0, usage: { input: 1, output: 1 }, reason: 'completed',
      steering: new TurnSteering().snapshot(),
    });
    expect(rec.read('run-quiet').map((e) => e.type)).toEqual(['turn_end', 'run_end']);
  });

  test('delegation opportunities ride the settle spine after the steering rows', () => {
    const rec = recorder();
    closeTurnRun(rec, 'run-dop', {
      turnIndex: 0, reason: 'completed',
      steering: [{ trigger: 'turn_start_no_delegation', step: 0, converted: false }],
      delegation: [
        {
          opportunityId: 'dop-a', surface: 'hint',
          hintId: 'turn_start_no_delegation:abcd1234', trigger: 'turn_start_no_delegation',
          step: 0, roles: ['general'], converted: true,
        },
        { opportunityId: 'dop-b', surface: 'unprompted', step: 3, roles: [], converted: true },
      ],
    });
    const events = rec.read('run-dop');
    // Delivery order in the raw log: the steer first, then the opportunity it
    // produced — one delivery, two rows, readable in sequence.
    expect(events.map((e) => e.type)).toEqual([
      'turn_steering', 'delegation_opportunity', 'delegation_opportunity', 'turn_end', 'run_end',
    ]);
    const row = events[1];
    if (row?.type !== 'delegation_opportunity') throw new Error('Expected delegation_opportunity');
    expect(row.opportunityId).toBe('dop-a');
    expect(row.roles).toEqual(['general']);

    // A turn with neither arm writes no rows — each denominator stays its own.
    closeTurnRun(rec, 'run-plain', { turnIndex: 1, reason: 'completed' });
    expect(rec.read('run-plain').map((e) => e.type)).toEqual(['turn_end', 'run_end']);
  });

  test('an in-episode craft loop writes its craft_cycle row; an idle turn writes none', () => {
    const rec = recorder();
    const observed: string[][] = [];
    const crafted: string[] = [];
    const acc = new TurnAccumulator();
    const cycle = new CraftCycle({
      names: () => crafted,
      observe: (names) => { observed.push([...names]); return []; },
    }, acc);
    cycle.reset(true);

    // The episode: craft in one call, reach for it in the next.
    crafted.push('sum');
    cycle.onToolResult({
      toolName: 'execute_tools', args: { code: 'await workspace.createTool("sum","d","async()=>1")' },
      result: 'ok', success: true,
    });
    cycle.onToolResult({
      toolName: 'execute_tools', args: { code: 'return await tools.sum(1)' },
      result: '1', success: true,
    });

    closeTurnRun(rec, 'run-c', {
      turnIndex: 0, usage: { input: 1, output: 1 }, reason: 'completed',
      craft: cycle.snapshot(),
    });
    const events = rec.read('run-c');
    expect(events.map((e) => e.type)).toEqual(['craft_cycle', 'turn_end', 'run_end']);
    const row = events[0];
    if (row?.type !== 'craft_cycle') throw new Error('Expected craft_cycle before turn_end');
    expect(row.crafted).toEqual(['sum']);
    expect(row.reused).toEqual(['sum']);
    expect(row.returned).toBe(1);
    expect(observed).toEqual([['sum']]);
    // The same clock is what the graded turn reports as crafted-tool use.
    expect(snapshotCompletedTurn(acc, {
      userMessage: 'u', assistantResponse: 'a', sessionId: 'default', origin: 'user',
    }).craftedToolsUsed).toEqual(['sum']);

    const idle = new CraftCycle({ names: () => [], observe: () => [] }, new TurnAccumulator());
    idle.reset(true);
    closeTurnRun(rec, 'run-idle', {
      turnIndex: 0, usage: { input: 1, output: 1 }, reason: 'completed',
      craft: idle.snapshot(),
    });
    expect(rec.read('run-idle').map((e) => e.type)).toEqual(['turn_end', 'run_end']);
  });

  test('a recorder failure never throws into the turn', () => {
    const broken: TurnRunRecorder = { emit: () => { throw new Error('db locked'); } };
    expect(() => openTurnRun(broken, 'r', { agentId: 'a', causedBy: 'chat', userMessage: 'm', turnIndex: 0 })).not.toThrow();
    expect(() => closeTurnRun(broken, 'r', { turnIndex: 0, reason: 'completed' })).not.toThrow();
  });
});

describe('snapshotCompletedTurn', () => {
  test('builds the graded turn from the accumulator; no reported usage means NO usage field', () => {
    const acc = new TurnAccumulator();
    acc.reset(Date.now() - 1_000);
    acc.recordToolCall({ toolName: 'run', input: { command: 'ls' }, success: true, output: 'ok' });
    acc.recordStep({});
    const turn = snapshotCompletedTurn(acc, {
      userMessage: 'do it', assistantResponse: 'done', turnId: 't1', sessionId: 'default', origin: 'user',
    });
    expect(turn.toolCalls.length).toBe(1);
    expect(turn.steps).toBe(1);
    expect(turn.hadError).toBe(false);
    expect(turn.durationMs).toBeGreaterThanOrEqual(1_000);
    expect(turn.turnId).toBe('t1');
    expect('usage' in turn).toBe(false);
  });

  test('a failed tool call flags the turn, and reported usage rides along', () => {
    const acc = new TurnAccumulator();
    acc.reset(Date.now());
    acc.recordToolCall({ toolName: 'run', success: false, error: 'exit 1' });
    acc.recordStep({ usage: { input: 7, output: 3 } });
    const turn = snapshotCompletedTurn(acc, {
      userMessage: 'u', assistantResponse: 'a', sessionId: 's', origin: 'programmatic',
    });
    expect(turn.hadError).toBe(true);
    expect(turn.origin).toBe('programmatic');
    expect(turn.usage).toEqual({ input: 7, output: 3 });
    expect('turnId' in turn).toBe(false);
  });
});

describe('persistMeasuredPromptTokens', () => {
  test('persists a measurement and only a measurement, bound to the durable length', () => {
    const state = recordingState();
    // No step reported a prompt size: there is nothing to persist, and the
    // stale trigger from an earlier turn must be left alone.
    persistMeasuredPromptTokens(state, 'k', undefined, 12);
    expect(state.saved).toEqual([]);
    // A provider-reported 0 IS a measurement — an empty request is a real
    // request, and it must overwrite whatever the last turn measured.
    persistMeasuredPromptTokens(state, 'k', 0, 12);
    persistMeasuredPromptTokens(state, 'k', 4321, 12);
    expect(state.saved).toEqual([['k', 0, 12], ['k', 4321, 12]]);
  });
});

/** Records what the recovery policy hands the one delivery seam. */
function recordingSignals() {
  const delivered: AgentSignal[] = [];
  return {
    delivered,
    deliver: async (signal: AgentSignal) => { delivered.push(signal); return 'queued' as const },
  };
}

describe('applyOverflowRecovery', () => {
  test('a context overflow arms force-compaction and delivers exactly one retry', async () => {
    const state = recordingState();
    const signals = recordingSignals();
    const decision = applyOverflowRecovery({
      error: 'prompt is too long: 210000 tokens > 200000 maximum',
      lastPromptTokens: 0, contextWindow: 200_000, turnWasOverflowRetry: false,
      state, sessionKey: 'k', signals,
    });
    expect(decision.forceCompaction).toBe(true);
    expect(state.armed).toEqual(['k']);
    await Promise.resolve();
    // The retry never steers a live turn: the turn that failed is over.
    expect(signals.delivered).toEqual([
      { kind: OVERFLOW_RETRY_EVENT, text: OVERFLOW_RETRY_TEXT },
    ]);
  });

  test('a failed retry never delivers another; unrelated failures never arm', () => {
    const state = recordingState();
    const signals = recordingSignals();
    const retryFailure = applyOverflowRecovery({
      error: 'prompt is too long', lastPromptTokens: 0, contextWindow: 200_000,
      turnWasOverflowRetry: true, state, sessionKey: 'k', signals,
    });
    expect(retryFailure.forceCompaction).toBe(true);
    expect(retryFailure.enqueueRetry).toBe(false);
    const rateLimit = applyOverflowRecovery({
      error: 'Error 429: too many requests', lastPromptTokens: 0, contextWindow: 200_000,
      turnWasOverflowRetry: false, state, sessionKey: 'k', signals,
    });
    expect(rateLimit.forceCompaction).toBe(false);
    expect(signals.delivered).toEqual([]);
    expect(state.armed).toEqual(['k']); // only the genuine overflow armed
  });
});

// The credit decision — which id the work captured INSIDE a turn is attributed
// to. Both backends attribute two capture kinds (alternate takes, steer
// branches) to the same answer, so this is the cross-backend contract for both.
describe('creditedTurnId', () => {
  test('a completed build turn credits its message id', () => {
    expect(creditedTurnId({ messageId: 'msg-1', completed: true, workMode: 'build' })).toBe('msg-1');
  });

  test('a turn that never reached its own end credits nothing', () => {
    expect(creditedTurnId({ messageId: 'msg-1', completed: false, workMode: 'build' })).toBeNull();
  });

  test('a completed turn with no durable message credits nothing', () => {
    expect(creditedTurnId({ messageId: null, completed: true, workMode: 'build' })).toBeNull();
  });

  test('a plan turn credits nothing — a plan is not an answer to have competed against', () => {
    expect(creditedTurnId({ messageId: 'msg-1', completed: true, workMode: 'plan' })).toBeNull();
  });

  // `hadError` is deliberately NOT an input: the accumulator raises it from the
  // transport discriminator on ANY failed tool result, and a turn that ran the
  // suite, saw it red, fixed it and answered has an answer. The CLI used to
  // read that flag here and dropped the captures of every such turn.
  test('a failed tool call inside a turn that still answered does not void the credit', () => {
    const acc = new TurnAccumulator();
    acc.reset(0);
    acc.recordToolCall({ toolName: 'run', input: {}, success: false, error: 'exit 1' });
    acc.recordToolCall({ toolName: 'run', input: {}, success: true, output: 'ok' });
    expect(acc.hadError).toBe(true);
    expect(creditedTurnId({ messageId: 'msg-1', completed: true, workMode: 'build' })).toBe('msg-1');
  });
});

// Escalation — a turn reaching past its own shell into a provisioned
// environment. The row exists so "did escalating help" is answerable from the
// durable log, so what matters is that the REASON and the OUTCOME survive
// storage, not merely that something was emitted.
//
// `recorder()` is a real RunEventRecorder over SQLite and `read()` parses back
// through `parseStoredRunEvent`, so every assertion here is a producer →
// storage → parser round trip. A payload the valibot variant rejected would
// fail these rather than being silently unreadable later.
describe('the escalation row', () => {
  test('a turn that escalated writes one row that survives storage; one that did not writes none', () => {
    const rec = recorder();
    const escalations = new TurnEscalationLedger();
    escalations.observe({ runtime: 'sandbox', reason: 'needs a long-running process', outcome: 'ok' });

    closeTurnRun(rec, 'run-e', { turnIndex: 0, reason: 'completed', escalations });
    closeTurnRun(rec, 'run-plain', {
      turnIndex: 0, reason: 'completed', escalations: new TurnEscalationLedger(),
    });

    expect(rec.read('run-plain').map((e) => e.type)).toEqual(['turn_end', 'run_end']);
    const rows = rec.read('run-e').filter((e) => e.type === 'execution_escalation');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'execution_escalation',
      escalations: [{
        runtime: 'sandbox', reason: 'needs a long-running process', outcome: 'ok', count: 1,
      }],
    });
  });

  test('a repeated decision is counted, not listed again', () => {
    // Thirty commands in one container is one decision thirty times over.
    const escalations = new TurnEscalationLedger();
    for (let i = 0; i < 30; i += 1) {
      escalations.observe({ runtime: 'sandbox', reason: 'inbound port', outcome: 'ok' });
    }
    expect(escalations.snapshot().escalations).toEqual([
      { runtime: 'sandbox', reason: 'inbound port', outcome: 'ok', count: 30 },
    ]);
  });

  test('an unstated reason is null, never invented from the runtime name', () => {
    // How often escalation happens unreasoned is the measurement a prompt change
    // would try to move; fabricating a reason would destroy it.
    const escalations = new TurnEscalationLedger();
    escalations.observe({ runtime: 'sandbox', reason: undefined, outcome: 'ok' });
    escalations.observe({ runtime: 'laptop', reason: '   ', outcome: 'ok' });
    expect(escalations.snapshot().escalations.map((e) => e.reason)).toEqual([null, null]);
  });

  test('refused and failed are distinct outcomes, and the same reason splits by them', () => {
    // "The runtime was never there" and "the command failed" are different
    // findings; a single failure count would merge them into "unreliable".
    const escalations = new TurnEscalationLedger();
    escalations.observe({ runtime: 'sandbox', reason: 'parallelism', outcome: 'refused' });
    escalations.observe({ runtime: 'sandbox', reason: 'parallelism', outcome: 'failed' });
    escalations.observe({ runtime: 'sandbox', reason: 'parallelism', outcome: 'failed' });
    expect(escalations.snapshot().escalations).toEqual([
      { runtime: 'sandbox', reason: 'parallelism', outcome: 'refused', count: 1 },
      { runtime: 'sandbox', reason: 'parallelism', outcome: 'failed', count: 2 },
    ]);
  });

  test('reset clears the turn, so a ledger is never carried into the next one', () => {
    const escalations = new TurnEscalationLedger();
    escalations.observe({ runtime: 'sandbox', reason: 'x', outcome: 'ok' });
    expect(escalations.active).toBe(true);
    escalations.reset();
    expect(escalations.active).toBe(false);
    expect(escalations.snapshot().escalations).toEqual([]);
  });
});
