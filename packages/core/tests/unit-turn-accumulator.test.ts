// TurnAccumulator — the per-turn accounting hoisted out of the cf-backend hooks
// (re-arch P2). Verifies the logic the DO used to own inline is preserved.
import { describe, test, expect } from 'bun:test';
import { TurnAccumulator } from '../src/orchestrator/turn-accumulator.js';

describe('TurnAccumulator', () => {
  test('reset clears all accounting + stamps startedAt', () => {
    const a = new TurnAccumulator();
    a.recordStep({ usage: { inputTokens: 5, outputTokens: 3 } });
    a.recordToolCall({ toolName: 'run', success: true, output: 'ok' });
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

  test('works with no sinks (pure consumer)', () => {
    const a = new TurnAccumulator();
    a.onFirstChunk();
    a.recordToolCall({ toolName: 'x', success: true, output: 1 });
    a.recordStep({ usage: { inputTokens: 1, outputTokens: 1 } });
    expect(a.toolCalls).toHaveLength(1);
    expect(a.stepCount).toBe(1);
  });
});
