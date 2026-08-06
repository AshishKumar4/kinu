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
  TurnAccumulator,
  OVERFLOW_RETRY_EVENT, OVERFLOW_RETRY_TEXT,
  type CompactionTriggerState, type ProgrammaticTurn,
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

describe('applyOverflowRecovery', () => {
  test('a context overflow arms force-compaction and enqueues exactly one retry', async () => {
    const state = recordingState();
    const enqueued: ProgrammaticTurn[] = [];
    const decision = applyOverflowRecovery({
      error: 'prompt is too long: 210000 tokens > 200000 maximum',
      lastPromptTokens: 0, contextWindow: 200_000, turnWasOverflowRetry: false,
      state, sessionKey: 'k',
      enqueueTurn: async (t) => { enqueued.push(t); return { status: 'queued' }; },
    });
    expect(decision.forceCompaction).toBe(true);
    expect(state.armed).toEqual(['k']);
    await Promise.resolve();
    expect(enqueued).toEqual([{ text: OVERFLOW_RETRY_TEXT, metadata: { proteusEvent: OVERFLOW_RETRY_EVENT } }]);
  });

  test('a failed retry never enqueues another; unrelated failures never arm', () => {
    const state = recordingState();
    const enqueued: ProgrammaticTurn[] = [];
    const enqueueTurn = async (t: ProgrammaticTurn) => { enqueued.push(t); return { status: 'queued' as const }; };
    const retryFailure = applyOverflowRecovery({
      error: 'prompt is too long', lastPromptTokens: 0, contextWindow: 200_000,
      turnWasOverflowRetry: true, state, sessionKey: 'k', enqueueTurn,
    });
    expect(retryFailure.forceCompaction).toBe(true);
    expect(retryFailure.enqueueRetry).toBe(false);
    const rateLimit = applyOverflowRecovery({
      error: 'Error 429: too many requests', lastPromptTokens: 0, contextWindow: 200_000,
      turnWasOverflowRetry: false, state, sessionKey: 'k', enqueueTurn,
    });
    expect(rateLimit.forceCompaction).toBe(false);
    expect(enqueued).toEqual([]);
    expect(state.armed).toEqual(['k']); // only the genuine overflow armed
  });
});
