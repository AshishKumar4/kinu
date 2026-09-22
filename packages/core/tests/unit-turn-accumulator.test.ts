// TurnAccumulator: per-turn accounting behind `AgentOrchestrator.acc`.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { TurnAccumulator } from '../src/orchestrator/turn-accumulator';
import { MissionGovernor } from '../src/mission-budget';
import type { Usage } from '../src/usage';
import { makeSql, makeExecRaw } from './helpers';
import { createTestActors } from '@kinu.run/test-utils';
import { FAILURE_WITHOUT_ERROR } from '../src/events/types';
import { classifyToolFailure } from '../src/read-models/tool-failures';
import { createCompletedTurnStore, initCompletedTurnTable } from '../src/evolution/session-window';

describe('TurnAccumulator', () => {
  test('reset clears all accounting + stamps startedAt', () => {
    const a = new TurnAccumulator();
    a.recordStep({ usage: { input: 5, output: 3 } });
    a.recordToolCall({ toolCallId: 'fixture-1', toolName: 'shell', success: true, output: 'ok' });
    // A failed call first, so a reset that forgot hadError leaks it.
    a.recordToolCall({ toolCallId: 'fixture-2', toolName: 'shell', success: false, reason: null, error: 'boom' });
    a.onFirstChunk();
    expect(a.hadError).toBe(true);
    a.reset(1000);
    expect(a.toolCalls).toEqual([]);
    expect(a.stepCount).toBe(0);
    expect(a.usage).toEqual({});
    expect(a.hadError).toBe(false);
    expect(a.firstChunkSeen).toBe(false);
    expect(a.startedAt).toBe(1000);
  });

  test('onFirstChunk fires its sink exactly once', () => {
    const events: string[] = [];
    const a = new TurnAccumulator({ logActivity: (e) => events.push(e) });
    a.onFirstChunk();
    a.onFirstChunk();
    expect(events).toEqual(['first_chunk']);
    expect(a.firstChunkSeen).toBe(true);
  });

  test('recordToolCall — success records the output as the core ToolCallRecord', () => {
    const toolEvents: Array<{ name: string; toolCallId: string; args?: unknown }> = [];
    const a = new TurnAccumulator({ onToolCallEvent: (e) => toolEvents.push(e) });
    a.recordToolCall({ toolCallId: 'fixture-3', toolName: 'eval', input: { code: '1+1' }, success: true, output: { result: 2 }, durationMs: 12 });
    expect(a.toolCalls).toEqual([{ toolCallId: 'fixture-3', name: 'eval', args: { code: '1+1' }, result: { result: 2 }, outcome: { success: true } }]);
    expect(a.hadError).toBe(false);
    expect(toolEvents[0]).toMatchObject({ name: 'eval', toolCallId: 'fixture-3' });
  });

  test('recordToolCall — the durable event carries WHAT the call was asked to do', () => {
    // Without the action, dispatcher-tool failures are indistinguishable.
    const toolEvents: Array<{ args?: unknown }> = [];
    const a = new TurnAccumulator({ onToolCallEvent: (e) => toolEvents.push(e) });
    a.recordToolCall({ toolCallId: 'fixture-4', toolName: 'file', input: { action: 'edit', path: 'src/a.ts' }, success: true, output: { ok: true } });
    expect(toolEvents[0].args).toEqual({ action: 'edit', path: 'src/a.ts' });
  });

  test('recordToolCall — a big argument is DIGESTED, not stored whole', () => {
    // A `write` body must not be stored twice.
    const toolEvents: Array<{ args?: unknown }> = [];
    const a = new TurnAccumulator({ onToolCallEvent: (e) => toolEvents.push(e) });
    a.recordToolCall({ toolCallId: 'fixture-5', toolName: 'file', input: { action: 'write', content: 'x'.repeat(5000) }, success: true, output: { ok: true } });
    const args = toolEvents[0].args;
    expect(args).toBeTypeOf('string');
    expect(String(args).length).toBeLessThan(1000);
    expect(String(args).endsWith('…')).toBe(true);
    expect(String(args)).toContain('"action":"write"');
  });

  test('recordToolCall — failure records {error}, flips hadError, passes error to the sink', () => {
    const toolEvents: Array<{ error?: string }> = [];
    const a = new TurnAccumulator({ onToolCallEvent: (e) => toolEvents.push(e) });
    a.recordToolCall({ toolCallId: 'fixture-6', toolName: 'shell', success: false, reason: null, error: new Error('boom') });
    // One failure description in both ledgers.
    expect(a.toolCalls[0]).toEqual({ toolCallId: 'fixture-6', name: 'shell', args: {}, result: { error: 'boom' }, outcome: { success: false, reason: null } });
    expect(a.hadError).toBe(true);
    expect(toolEvents[0].error).toBe('boom');
  });

  test('recordToolCall — a failure with NO error is never recorded as clean', () => {
    // `String(undefined)`/`String(null)` fabricate text; `error: ''` reads as success.
    for (const error of [undefined, null, '']) {
      const toolEvents: Array<{ error?: string }> = [];
      const a = new TurnAccumulator({ onToolCallEvent: (e) => toolEvents.push(e) });
      a.recordToolCall({ toolCallId: 'fixture-7', toolName: 'eval', success: false, reason: null, error });
      expect(a.hadError).toBe(true);
      expect(toolEvents[0].error).toBe(FAILURE_WITHOUT_ERROR);
      expect(a.toolCalls[0]).toEqual({
        toolCallId: 'fixture-7',
        name: 'eval', args: {}, result: { error: FAILURE_WITHOUT_ERROR }, outcome: { success: false, reason: null },
      });
      expect(classifyToolFailure({
        type: 'tool_call_end', eventIndex: 0, runId: 'r', timestamp: new Date().toISOString(),
        name: 'eval', toolCallId: 'tc-1', error: toolEvents[0].error,
      })).toMatchObject({ reason: 'failed_without_error' });
    }
  });

  test('recordStep sums the turn field by field, leaving unreported fields absent', () => {
    const steps: number[] = [];
    const a = new TurnAccumulator({ onStepEvent: (e) => steps.push(e.stepIndex) });
    a.recordStep({ usage: { input: 100, output: 40, cacheRead: 10 }, finishReason: 'tool-calls', toolCalls: [{ toolName: 'shell' }] });
    a.recordStep({ usage: { input: 50, output: 20, cacheWrite: 30 }, finishReason: 'stop' });
    expect(a.stepCount).toBe(2);
    // Unreported stays absent, not zero.
    expect(a.usage).toEqual({ input: 150, output: 60, cacheRead: 10, cacheWrite: 30 });
    expect('reasoning' in a.usage).toBe(false);
    expect(steps).toEqual([1, 2]);
  });

  test('reportedUsage is the turn usage, or undefined when nothing was reported', () => {
    const a = new TurnAccumulator();
    a.recordStep({ finishReason: 'stop' });
    expect(a.reportedUsage()).toBeUndefined();
    a.recordStep({ usage: { input: 12, output: 4, cacheRead: 8 } });
    expect(a.reportedUsage()).toEqual({ input: 12, output: 4, cacheRead: 8 });
    a.reset(0);
    expect(a.reportedUsage()).toBeUndefined();
  });

  test('lastPromptTokens tracks the newest reporting step and survives usage-less steps', () => {
    const a = new TurnAccumulator();
    // Never reported is not reported zero.
    expect(a.lastPromptTokens).toBeUndefined();
    a.recordStep({ usage: { input: 1_000, output: 40 } });
    a.recordStep({ usage: { input: 1_450, output: 20 } });
    a.recordStep({});
    expect(a.lastPromptTokens).toBe(1_450);
    a.recordStep({ usage: { input: 0, output: 4 } });
    expect(a.lastPromptTokens).toBe(0);
    a.reset(1);
    expect(a.lastPromptTokens).toBeUndefined();
  });

  test('each completed tool call retains its supplied invocation identity', () => {
    const ids: string[] = [];
    const a = new TurnAccumulator({ onToolCallEvent: (e) => ids.push(e.toolCallId) });
    a.recordToolCall({ toolCallId: 'provider-B', toolName: 'read', success: true, output: 1 });
    a.recordToolCall({ toolCallId: 'provider-A', toolName: 'read', success: true, output: 2 });
    a.recordToolCall({ toolCallId: 'provider-C', toolName: 'write', success: true, output: 3 });
    expect(ids).toEqual(['provider-B', 'provider-A', 'provider-C']);
    expect(a.toolCalls.map((call) => call.toolCallId)).toEqual(ids);
    expect(new Set(ids).size).toBe(3);
  });

  test('the completed-turn store retains invocation identity across serialization', () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    const execRaw = makeExecRaw(db);
    const actor = createTestActors(sql, execRaw).main;
    initCompletedTurnTable(execRaw);
    const turns = createCompletedTurnStore(sql, actor);
    turns.append({
      userMessage: 'read', assistantResponse: 'done', steps: 1, durationMs: 1, feedback: null, hadError: false,
      toolCalls: [{ toolCallId: 'sdk-call', name: 'file', args: { path: 'same.txt' }, result: 'same result', outcome: { success: true } }],
    }, { awaitsFollowup: true });
    expect(turns.claim()?.turns[0]?.toolCalls[0]?.toolCallId).toBe('sdk-call');
    db.close();
  });

  test('a 0ms duration is a real measurement, not an absent one', () => {
    // Not a truthiness check: sub-millisecond timings count.
    const details: Array<string | undefined> = [];
    const durations: Array<number | undefined> = [];

    const a = new TurnAccumulator({
      logActivity: (_e, d) => details.push(d),
      onToolCallEvent: (e) => durations.push(e.durationMs),
    });

    a.recordToolCall({ toolCallId: 'fixture-8', toolName: 'fast', success: true, output: 1, durationMs: 0 });
    a.recordToolCall({ toolCallId: 'fixture-9', toolName: 'untimed', success: true, output: 1 });
    expect(details).toEqual(['fast (0ms)', 'untimed']);
    expect(durations).toEqual([0, undefined]);
  });

  test('recordStep names tool calls from either SDK shape (toolName or name)', () => {
    const details: Array<string | undefined> = [];
    const a = new TurnAccumulator({ logActivity: (_e, d) => details.push(d) });
    a.recordStep({ toolCalls: [{ toolName: 'by-toolname' }, { name: 'by-name' }, {}] });
    expect(details[0]).toContain('tools=3[by-toolname,by-name,?]');
  });

  test('a non-string finishReason reaches the step sink as undefined, not as "undefined"', () => {
    const reasons: Array<string | undefined> = [];
    const a = new TurnAccumulator({ onStepEvent: (e) => reasons.push(e.reason) });
    a.recordStep({ finishReason: 'stop' });
    a.recordStep({});
    a.recordStep({ finishReason: { type: 'stop' } });
    expect(reasons).toEqual(['stop', undefined, undefined]);
  });

  test("the step event carries the provider's own report, priced and attributed as siblings", () => {
    const events: Array<{ usage?: Usage; usd?: number; modelId?: string }> = [];
    const a = new TurnAccumulator({ onStepEvent: (e) => events.push(e) });
    a.recordStep({
      usage: { input: 900, output: 40, cacheRead: 700, reasoning: 12 },
      response: { modelId: 'claude-sonnet-4.5' },
    });
    expect(events[0]?.usage).toEqual({ input: 900, output: 40, cacheRead: 700, reasoning: 12 });
    expect(events[0]?.modelId).toBe('claude-sonnet-4.5');
  });

  test('a step the provider reported nothing for carries no usage rather than zeros', () => {
    const events: Array<{ usage?: unknown }> = [];
    const a = new TurnAccumulator({ onStepEvent: (e) => events.push(e) });
    a.recordStep({ finishReason: 'stop' });
    expect(events[0]?.usage).toBeUndefined();
  });

  test('an unpriced model yields a step with no usd, never a blended guess', () => {
    const events: Array<{ usage?: Usage; usd?: number }> = [];
    const a = new TurnAccumulator({ onStepEvent: (e) => events.push(e) });
    a.recordStep({ usage: { input: 100, output: 10 } });
    expect(events[0]?.usage).toEqual({ input: 100, output: 10 });
    expect(events[0]?.usd).toBeUndefined();
  });

  test('the step event carries the measurement of the request that produced it', () => {
    const events: Array<{ context?: { measuredChars: number } }> = [];
    const a = new TurnAccumulator({ onStepEvent: (e) => events.push(e) });
    a.composition.openTurn({ system: 'soul' });
    a.composition.measure([{ role: 'user', content: 'hello' }]);
    a.recordStep({ usage: { input: 10, output: 1 } });
    // Drained: nothing re-reports the previous composition.
    a.recordStep({ usage: { input: 10, output: 1 } });
    expect(events[0]?.context?.measuredChars).toBe('soul'.length + 'hello'.length);
    expect(events[1]?.context).toBeUndefined();
  });

  test('reset clears the composition meter with the rest of the turn', () => {
    const events: Array<{ context?: unknown }> = [];
    const a = new TurnAccumulator({ onStepEvent: (e) => events.push(e) });
    a.composition.openTurn({ system: 'soul' });
    a.composition.measure([{ role: 'user', content: 'hello' }]);
    a.reset(0);
    a.recordStep({ usage: { input: 10, output: 1 } });
    expect(events[0]?.context).toBeUndefined();
  });

  test('works with no sinks (pure consumer)', () => {
    const a = new TurnAccumulator();
    a.onFirstChunk();
    a.recordToolCall({ toolCallId: 'fixture-10', toolName: 'x', success: true, output: 1 });
    a.recordStep({ usage: { input: 1, output: 1 } });
    expect(a.toolCalls).toHaveLength(1);
    expect(a.stepCount).toBe(1);
  });

  test('a reported zero is a report; a step with no report meters nothing', () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    const execRaw = makeExecRaw(db);

    const governor = new MissionGovernor({
      storage: { sql, execRaw }, actor: createTestActors(sql, execRaw).main,
    });

    governor.declare('nightly', {});
    governor.activate(['nightly']);
    const events: Array<{ usage?: Usage }> = [];
    const a = new TurnAccumulator({ onStepEvent: (e) => events.push(e) }, governor);

    // A zero answer is a measurement, not silence.
    a.recordStep({ usage: { input: 0, output: 0 } });
    expect(events[0]?.usage).toEqual({ input: 0, output: 0 });
    expect(a.reportedUsage()).toEqual({ input: 0, output: 0 });
    expect(governor.snapshot('nightly')[0]?.calls).toBe(1);

    a.recordStep({ finishReason: 'stop' });
    expect(events[1]?.usage).toBeUndefined();
    expect(governor.snapshot('nightly')[0]?.calls).toBe(1);
    expect(governor.snapshot('nightly')[0]?.spent.tokens).toBe(0);
  });
});
