// TurnAccumulator — the per-turn accounting hoisted out of the cf-backend hooks
// (re-arch P2). Verifies the logic the DO used to own inline is preserved.
import { describe, test, expect } from 'bun:test';
import { TurnAccumulator } from '../src/orchestrator/turn-accumulator.js';
import type { StepUsage } from '../src/events/types.js';

describe('TurnAccumulator', () => {
  test('reset clears all accounting + stamps startedAt', () => {
    const a = new TurnAccumulator();
    a.recordStep({ usage: { inputTokens: 5, outputTokens: 3 } });
    a.recordToolCall({ toolName: 'run', success: true, output: 'ok' });
    // A failed call first, so the hadError assertion below is not vacuous —
    // a reset that forgot the flag would leak the previous turn's failure.
    a.recordToolCall({ toolName: 'run', success: false, error: 'boom' });
    a.onFirstChunk();
    expect(a.hadError).toBe(true);
    a.reset(1000);
    expect(a.toolCalls).toEqual([]);
    expect(a.stepCount).toBe(0);
    expect(a.usage).toEqual({ input: 0, output: 0, cached: 0 });
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

  test('recordStep accumulates usage across steps incl. anthropic cache-read', () => {
    const steps: number[] = [];
    const a = new TurnAccumulator({ onStepEvent: (e) => steps.push(e.stepIndex) });
    a.recordStep({ usage: { inputTokens: 100, outputTokens: 40, cachedInputTokens: 10 }, finishReason: 'tool-calls', toolCalls: [{ toolName: 'run' }] });
    a.recordStep({ usage: { inputTokens: 50, outputTokens: 20 }, providerMetadata: { anthropic: { cacheReadInputTokens: 30 } }, finishReason: 'stop' });
    expect(a.stepCount).toBe(2);
    expect(a.usage).toEqual({ input: 150, output: 60, cached: 40 });
    expect(steps).toEqual([1, 2]);
  });

  test('reportedUsage is the turn usage, or undefined when nothing was reported', () => {
    const a = new TurnAccumulator();
    // A provider that reports no usage must not be recorded as having spent
    // zero — a cost consumer has to be able to tell the two apart.
    a.recordStep({ finishReason: 'stop' });
    expect(a.reportedUsage()).toBeUndefined();
    a.recordStep({ usage: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 8 } });
    expect(a.reportedUsage()).toEqual({ input: 12, output: 4, cached: 8 });
    a.reset(0);
    expect(a.reportedUsage()).toBeUndefined();
  });

  test('lastPromptTokens tracks the newest reporting step and survives usage-less steps', () => {
    const a = new TurnAccumulator();
    expect(a.lastPromptTokens).toBe(0);
    a.recordStep({ usage: { inputTokens: 1_000, outputTokens: 40 } });
    a.recordStep({ usage: { inputTokens: 1_450, outputTokens: 20 } });
    a.recordStep({}); // a step whose provider reported nothing
    expect(a.lastPromptTokens).toBe(1_450);
    a.reset(1);
    expect(a.lastPromptTokens).toBe(0);
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

  test('the step event carries the provider\'s own usage, cache read included', () => {
    const events: Array<{ usage?: StepUsage }> = [];
    const a = new TurnAccumulator({ onStepEvent: (e) => events.push(e) });
    a.recordStep({
      usage: { inputTokens: 900, outputTokens: 40, cachedInputTokens: 0, reasoningTokens: 12 },
      providerMetadata: { anthropic: { cacheReadInputTokens: 700 } },
      response: { modelId: 'claude-sonnet-4.5' },
    });
    // Anthropic reports the cache read in providerMetadata, others on usage —
    // the step row carries one reconciled `cached` either way.
    expect(events[0]?.usage).toEqual({ input: 900, cached: 700, output: 40, reasoning: 12, modelId: 'claude-sonnet-4.5' });
  });

  test('a step the provider reported nothing for carries no usage rather than zeros', () => {
    const events: Array<{ usage?: unknown }> = [];
    const a = new TurnAccumulator({ onStepEvent: (e) => events.push(e) });
    a.recordStep({ finishReason: 'stop' });
    expect(events[0]?.usage).toBeUndefined();
  });

  test('an unpriced model yields a step with no usd, never a blended guess', () => {
    const events: Array<{ usage?: { usd?: number } }> = [];
    const a = new TurnAccumulator({ onStepEvent: (e) => events.push(e) });
    a.recordStep({ usage: { inputTokens: 100, outputTokens: 10 } });
    expect(events[0]?.usage).toBeDefined();
    expect(events[0]?.usage?.usd).toBeUndefined();
  });

  test('the step event carries the measurement of the request that produced it', () => {
    const events: Array<{ context?: { measuredChars: number } }> = [];
    const a = new TurnAccumulator({ onStepEvent: (e) => events.push(e) });
    a.composition.openTurn({ system: 'soul' });
    a.composition.measure([{ role: 'user', content: 'hello' }]);
    a.recordStep({ usage: { inputTokens: 10, outputTokens: 1 } });
    // Drained: the next step measured nothing, so it reports nothing rather
    // than re-reporting the previous request's composition.
    a.recordStep({ usage: { inputTokens: 10, outputTokens: 1 } });
    expect(events[0]?.context?.measuredChars).toBe('soul'.length + 'hello'.length);
    expect(events[1]?.context).toBeUndefined();
  });

  test('reset clears the composition meter with the rest of the turn', () => {
    const events: Array<{ context?: unknown }> = [];
    const a = new TurnAccumulator({ onStepEvent: (e) => events.push(e) });
    a.composition.openTurn({ system: 'soul' });
    a.composition.measure([{ role: 'user', content: 'hello' }]);
    a.reset(0);
    a.recordStep({ usage: { inputTokens: 10, outputTokens: 1 } });
    expect(events[0]?.context).toBeUndefined();
  });

  test('works with no sinks (pure consumer)', () => {
    const a = new TurnAccumulator();
    a.onFirstChunk();
    a.recordToolCall({ toolName: 'x', success: true, output: 1 });
    a.recordStep({ usage: { inputTokens: 1, outputTokens: 1 } });
    expect(a.toolCalls).toHaveLength(1);
    expect(a.stepCount).toBe(1);
  });
});
