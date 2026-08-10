// Shared turn-lifecycle spine (orchestrator/turn-lifecycle.ts) — the run-event
// bracket, the CompletedTurn snapshot, the measured compaction trigger, and the
// applied overflow-recovery policy. Both backends delegate here, so these
// payload shapes ARE the cross-backend contract.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  initRunEventTables, RunEventRecorder,
  openTurnRun, closeTurnRun, snapshotCompletedTurn,
  persistMeasuredPromptTokens, applyOverflowRecovery,
  TurnAccumulator, DelegationNudge,
  OVERFLOW_RETRY_EVENT, OVERFLOW_RETRY_TEXT,
  SPILL_DIRS,
  type AgentSignal, type CompactionTriggerState,
} from '../src/index.js';
import { makeSql, makeExecRaw } from './helpers.js';

function recorder(): RunEventRecorder {
  const db = new Database(':memory:');
  initRunEventTables(makeExecRaw(db));
  return new RunEventRecorder(makeSql(db));
}

function recordingState(): CompactionTriggerState & { saved: unknown[]; armed: string[] } {
  const saved: unknown[] = [];
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
      usage: { input: 10, output: 5, cached: 2 },
      reason: 'error',
      error: 'boom',
    });
    const events = rec.read('run-1');
    expect(events.map((e) => e.type)).toEqual(['run_start', 'turn_start', 'turn_end', 'run_end']);
    const start = events[0] as Extract<typeof events[number], { type: 'run_start' }>;
    expect(start.agentId).toBe('ws');
    expect(start.caused_by).toBe('chat');
    expect(start.userMessage?.length).toBe(500); // bounded at the spine, not per backend
    const turnEnd = events[2] as Extract<typeof events[number], { type: 'turn_end' }>;
    expect(turnEnd.tokenUsage).toEqual({ input: 10, output: 5, cached: 2 });
    const runEnd = events[3] as Extract<typeof events[number], { type: 'run_end' }>;
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
      turnIndex: 0, usage: { input: 1, output: 1, cached: 0 }, reason: 'completed', context: acc.context,
    });

    const events = rec.read('run-2');
    expect(events.map((e) => e.type)).toEqual(['run_start', 'turn_start', 'context_budget', 'turn_end', 'run_end']);
    const row = events[2] as Extract<typeof events[number], { type: 'context_budget' }>;
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
      turnIndex: 0, usage: { input: 1, output: 1, cached: 0 }, reason: 'completed', context: acc.context,
    });
    expect(rec.read('run-3').map((e) => e.type)).toEqual(['turn_end', 'run_end']);
  });

  test('a nudged turn writes its delegation_nudge row; an unnudged one writes none', () => {
    const rec = recorder();
    const nudge = new DelegationNudge();
    nudge.onToolResult({ toolName: 'run', result: 'Error (exit 2): boom', success: true });
    nudge.onToolResult({ toolName: 'run', result: 'Error (exit 2): boom', success: true });
    nudge.onToolResult({ toolName: 'run', result: 'Error (exit 2): boom', success: true });
    nudge.nudgeFor(4);
    nudge.onToolCall({ toolName: 'agents', args: { action: 'fork' } });

    closeTurnRun(rec, 'run-n', {
      turnIndex: 0, usage: { input: 1, output: 1, cached: 0 }, reason: 'completed',
      nudge: nudge.snapshot(),
    });
    const events = rec.read('run-n');
    expect(events.map((e) => e.type)).toEqual(['delegation_nudge', 'turn_end', 'run_end']);
    const row = events[0] as Extract<typeof events[number], { type: 'delegation_nudge' }>;
    expect(row.trigger).toBe('repeated_failure');
    expect(row.tool).toBe('run');
    expect(row.step).toBe(4);
    // The conversion numerator: the model reached for the ladder afterwards.
    expect(row.converted).toBe(true);

    closeTurnRun(rec, 'run-quiet', {
      turnIndex: 0, usage: { input: 1, output: 1, cached: 0 }, reason: 'completed',
      nudge: new DelegationNudge().snapshot(),
    });
    expect(rec.read('run-quiet').map((e) => e.type)).toEqual(['turn_end', 'run_end']);
  });

  test('a recorder failure never throws into the turn', () => {
    const broken = { emit: () => { throw new Error('db locked'); } } as unknown as RunEventRecorder;
    expect(() => openTurnRun(broken, 'r', { agentId: 'a', causedBy: 'chat', userMessage: 'm', turnIndex: 0 })).not.toThrow();
    expect(() => closeTurnRun(broken, 'r', { turnIndex: 0, usage: { input: 0, output: 0, cached: 0 }, reason: 'completed' })).not.toThrow();
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
    acc.recordStep({ usage: { inputTokens: 7, outputTokens: 3 } });
    const turn = snapshotCompletedTurn(acc, {
      userMessage: 'u', assistantResponse: 'a', sessionId: 's', origin: 'programmatic',
    });
    expect(turn.hadError).toBe(true);
    expect(turn.origin).toBe('programmatic');
    expect(turn.usage).toEqual({ input: 7, output: 3, cached: 0 });
    expect('turnId' in turn).toBe(false);
  });
});

describe('persistMeasuredPromptTokens', () => {
  test('persists only a real measurement, bound to the durable length', () => {
    const state = recordingState();
    persistMeasuredPromptTokens(state, 'k', 0, 12);
    expect(state.saved).toEqual([]);
    persistMeasuredPromptTokens(state, 'k', 4321, 12);
    expect(state.saved).toEqual([['k', 4321, 12]]);
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
