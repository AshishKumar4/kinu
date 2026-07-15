import { describe, expect, test } from 'bun:test';
import {
  delegationFeatures, renderDelegationFeatures,
} from '../src/evolution/delegation-features.js';
import type { ToolCallRecord } from '../src/evolution/types.js';

describe('delegationFeatures', () => {
  test('counts process tools from a completed turn record', () => {
    const toolCalls: ToolCallRecord[] = [
      { name: 'execute_tools', args: {}, result: 'done' },
      { name: 'team', args: { action: 'spawn' }, result: 'spawned' },
      { name: 'think', args: { strategy: 'heads' }, result: 'merged' },
      { name: 'team', args: { action: 'status' }, result: 'complete' },
      { name: 'peers', args: { action: 'ask' }, result: 'answer' },
      { name: 'run', args: {}, result: 'ok' },
    ];

    expect(delegationFeatures({ toolCalls, steps: 41, durationMs: 372_000 })).toEqual({
      stepCount: 41,
      teamCalls: 2,
      thinkCalls: 1,
      peerCalls: 1,
      executeToolsCalls: 1,
      wallClockMs: 372_000,
    });
  });

  test('renders one compact evidence line', () => {
    const line = renderDelegationFeatures(delegationFeatures({
      toolCalls: [], steps: 41, durationMs: 372_000,
    }));
    expect(line).toBe(
      'Turn process: 41 sequential steps, 0 team, 0 think, 0 peers, 0 execute_tools, 6.2min wall clock',
    );
  });
});
