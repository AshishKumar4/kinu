// TurnAccumulator — the per-turn accounting hoisted out of the cf-backend hooks
// (re-arch P2). Verifies the logic the DO used to own inline is preserved.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { TurnAccumulator } from '../src/orchestrator/turn-accumulator.js';
import { MissionGovernor } from '../src/mission-budget.js';
import type { Usage } from '../src/usage.js';
import { makeSql, makeExecRaw } from './helpers.js';

describe('TurnAccumulator', () => {
  test('reset clears all accounting + stamps startedAt', () => {
    const a = new TurnAccumulator();
    a.recordStep({ usage: { input: 5, output: 3 } });
    a.recordToolCall({ toolName: 'run', success: true, output: 'ok' });
    // A failed call first, so the hadError assertion below is not vacuous —
    // a reset that forgot the flag would leak the previous turn's failure.
    a.recordToolCall({ toolName: 'run', success: false, error: 'boom' });
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
    const toolEvents: Array<{ name: string; toolCallId: string }> = [];
    const a = new TurnAccumulator({ onToolCallEvent: (e) => toolEvents.push(e) });
    a.recordToolCall({ toolName: 'execute_tools', input: { code: '1+1' }, success: true, output: { result: 2 }, durationMs: 12 });
    expect(a.toolCalls).toEqual([{ name: 'execute_tools', args: { code: '1+1' }, result: { result: 2 } }]);
    expect(a.hadError).toBe(false);
    expect(toolEvents[0]).toMatchObject({ name: 'execute_tools', toolCallId: 'tc-1' });
  });

  test('recordToolCall — failure records {error}, flips hadError, passes error to the sink', () => {
    const toolEvents: Array<{ error?: string }> = [];
    const a = new TurnAccumulator({ onToolCallEvent: (e) => toolEvents.push(e) });
    a.recordToolCall({ toolName: 'run', success: false, error: new Error('boom') });
    // recorded result uses .message; the run-event sink uses String(error) — both faithful to the DO.
    expect(a.toolCalls[0]).toEqual({ name: 'run', args: {}, result: { error: 'boom' } });
    expect(a.hadError).toBe(true);
    expect(toolEvents[0].error).toBe('Error: boom');
  });

  test('recordStep sums the turn field by field, leaving unreported fields absent', () => {
    const steps: number[] = [];
    const a = new TurnAccumulator({ onStepEvent: (e) => steps.push(e.stepIndex) });
    a.recordStep({ usage: { input: 100, output: 40, cacheRead: 10 }, finishReason: 'tool-calls', toolCalls: [{ toolName: 'run' }] });
    a.recordStep({ usage: { input: 50, output: 20, cacheWrite: 30 }, finishReason: 'stop' });
    expect(a.stepCount).toBe(2);
    // A field only ONE step reported carries that step's number; a field no step
    // reported stays absent, so "nobody mentioned reasoning" cannot be read as
    // "the model did no reasoning".
    expect(a.usage).toEqual({ input: 150, output: 60, cacheRead: 10, cacheWrite: 30 });
    expect('reasoning' in a.usage).toBe(false);
    expect(steps).toEqual([1, 2]);
  });

  test('reportedUsage is the turn usage, or undefined when nothing was reported', () => {
    const a = new TurnAccumulator();
    // A provider that reports no usage must not be recorded as having spent
    // zero — a cost consumer has to be able to tell the two apart.
    a.recordStep({ finishReason: 'stop' });
    expect(a.reportedUsage()).toBeUndefined();
    a.recordStep({ usage: { input: 12, output: 4, cacheRead: 8 } });
    expect(a.reportedUsage()).toEqual({ input: 12, output: 4, cacheRead: 8 });
    a.reset(0);
    expect(a.reportedUsage()).toBeUndefined();
  });

  test('lastPromptTokens tracks the newest reporting step and survives usage-less steps', () => {
    const a = new TurnAccumulator();
    // Never reported is not the same number as reported zero — the compaction
    // trigger has to be able to tell them apart.
    expect(a.lastPromptTokens).toBeUndefined();
    a.recordStep({ usage: { input: 1_000, output: 40 } });
    a.recordStep({ usage: { input: 1_450, output: 20 } });
    a.recordStep({}); // a step whose provider reported nothing
    expect(a.lastPromptTokens).toBe(1_450);
    // A reported 0 IS a measurement of the request, so it replaces the old one.
    a.recordStep({ usage: { input: 0, output: 4 } });
    expect(a.lastPromptTokens).toBe(0);
    a.reset(1);
    expect(a.lastPromptTokens).toBeUndefined();
  });

  test('each tool call gets its own id — the run-event log must not collapse them', () => {
    const ids: string[] = [];
    const a = new TurnAccumulator({ onToolCallEvent: (e) => ids.push(e.toolCallId) });
    a.recordToolCall({ toolName: 'read', success: true, output: 1 });
    a.recordToolCall({ toolName: 'read', success: true, output: 2 });
    a.recordToolCall({ toolName: 'write', success: true, output: 3 });
    expect(ids).toEqual(['tc-1', 'tc-2', 'tc-3']);
    expect(new Set(ids).size).toBe(3);
  });

  test('a 0ms duration is a real measurement, not an absent one', () => {
    // `durationMs != null` must not degrade into a truthiness check: a
    // sub-millisecond tool would silently lose its timing.
    const details: Array<string | undefined> = [];
    const durations: Array<number | undefined> = [];
    const a = new TurnAccumulator({
      logActivity: (_e, d) => details.push(d),
      onToolCallEvent: (e) => durations.push(e.durationMs),
    });
    a.recordToolCall({ toolName: 'fast', success: true, output: 1, durationMs: 0 });
    a.recordToolCall({ toolName: 'untimed', success: true, output: 1 });
    expect(details).toEqual(['fast (0ms)', 'untimed']);
    expect(durations).toEqual([0, undefined]);
  });

  test('recordStep names tool calls from either SDK shape (toolName or name)', () => {
    const details: Array<string | undefined> = [];
    const a = new TurnAccumulator({ logActivity: (_e, d) => details.push(d) });
    a.recordStep({ toolCalls: [{ toolName: 'current' }, { name: 'legacy' }, {}] });
    expect(details[0]).toContain('tools=3[current,legacy,?]');
  });

  test('a non-string finishReason reaches the step sink as undefined, not as "undefined"', () => {
    // The run-event log's `reason` is a nullable string column; stringifying an
    // absent finishReason would write the literal text into it.
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
    // `usage` is the provider's report verbatim; who served it and what it cost
    // are siblings on the row, never members of the report.
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
    expect(events[0]?.usage).toBeDefined();
    expect(events[0]?.usd).toBeUndefined();
  });

  test('the step event carries the measurement of the request that produced it', () => {
    const events: Array<{ context?: { measuredChars: number } }> = [];
    const a = new TurnAccumulator({ onStepEvent: (e) => events.push(e) });
    a.composition.openTurn({ system: 'soul' });
    a.composition.measure([{ role: 'user', content: 'hello' }]);
    a.recordStep({ usage: { input: 10, output: 1 } });
    // Drained: the next step measured nothing, so it reports nothing rather
    // than re-reporting the previous request's composition.
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
    a.recordToolCall({ toolName: 'x', success: true, output: 1 });
    a.recordStep({ usage: { input: 1, output: 1 } });
    expect(a.toolCalls).toHaveLength(1);
    expect(a.stepCount).toBe(1);
  });

  test('a reported zero is a report; a step with no report meters nothing', () => {
    const db = new Database(':memory:');
    const governor = new MissionGovernor({ storage: { sql: makeSql(db), execRaw: makeExecRaw(db) } });
    governor.declare('nightly', {});
    governor.activate(['nightly']);
    const events: Array<{ usage?: Usage }> = [];
    const a = new TurnAccumulator({ onStepEvent: (e) => events.push(e) }, governor);

    // A provider that answered "zero" HAS answered: the row is a measurement of
    // a request that cost nothing, and suppressing it would make that
    // indistinguishable from a provider that never reports usage at all.
    a.recordStep({ usage: { input: 0, output: 0 } });
    expect(events[0]?.usage).toEqual({ input: 0, output: 0 });
    expect(a.reportedUsage()).toEqual({ input: 0, output: 0 });
    expect(governor.snapshot('nightly')[0]?.calls).toBe(1);

    // A provider that said nothing: no usage row, and nothing metered at all —
    // not even the call, because there is no measured request behind it.
    a.recordStep({ finishReason: 'stop' });
    expect(events[1]?.usage).toBeUndefined();
    expect(governor.snapshot('nightly')[0]?.calls).toBe(1);
    expect(governor.snapshot('nightly')[0]?.spent.tokens).toBe(0);
  });
});
