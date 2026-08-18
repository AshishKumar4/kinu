import { describe, expect, test } from 'bun:test';
import {
  delegationFeatures, renderDelegationFeatures, executionPathSignals,
} from '../src/evolution/delegation-features.js';
import type { ToolCallRecord } from '../src/evolution/types.js';
import type { JsonObject } from '../src/utils/json.js';

const call = (name: string, args: JsonObject = {}): ToolCallRecord =>
  ({ name, args, result: null });

const write = (path: string): ToolCallRecord =>
  call('execute_tools', { code: `await workspace.writeFile("${path}", body);` });

describe('delegationFeatures', () => {
  test('counts agents actions — and legacy tool AND action names — from a completed turn record', () => {
    // Live turns call the unified `agents` tool; stored turns from before the
    // unification carry think/team/peers, and turns stored before 2026-08-17
    // carry `staff` where `hire` is now written. All of them count into the same
    // buckets, because this reader runs over history it did not write.
    const toolCalls: ToolCallRecord[] = [
      call('execute_tools', { code: 'a()' }),
      call('agents', { action: 'hire', role: 'r' }),
      call('agents', { action: 'staff', role: 'r' }),
      call('agents', { action: 'fork', task: 't' }),
      call('team', { action: 'status' }),
      call('agents', { action: 'ask', agent: 'a' }),
      call('run', { command: 'ls' }),
    ];

    expect(delegationFeatures({ toolCalls, steps: 41, durationMs: 372_000 })).toEqual({
      stepCount: 41,
      teamCalls: 3,
      thinkCalls: 1,
      peerCalls: 1,
      executeToolsCalls: 1,
      wallClockMs: 372_000,
      loopedCalls: 0,
      redundantCalls: 0,
      backtrackCalls: 0,
    });
  });

  test('renders one compact evidence line', () => {
    const line = renderDelegationFeatures(delegationFeatures({
      toolCalls: [], steps: 41, durationMs: 372_000,
    }));
    expect(line).toBe(
      'Turn process: 41 sequential steps, 0 hiring, 0 fork, 0 messaging, 0 execute_tools, 6.2min wall clock',
    );
  });

  test('appends a wasted-motion clause only when there is wasted motion', () => {
    const toolCalls = [
      call('web_search', { query: 'wilson interval' }),
      call('web_search', { query: 'wilson interval' }),
      write('/notes.md'),
      call('run', { command: 'cat /notes.md' }),
    ];
    const line = renderDelegationFeatures(delegationFeatures({ toolCalls, steps: 4, durationMs: 8_000 }));
    expect(line).toContain('8.0s wall clock. Wasted motion: 1 looped, 1 redundant, 1 backtracking tool calls');
  });
});

describe('executionPathSignals — loops', () => {
  test('the same call repeated back to back is a loop', () => {
    const repeated = call('run', { command: 'bun test' });
    expect(executionPathSignals([repeated, repeated, repeated, repeated])).toMatchObject({
      loopedCalls: 3, redundantCalls: 3,
    });
  });

  test('an alternating two-call cycle is a loop', () => {
    const a = call('run', { command: 'bun test' });
    const b = call('execute_tools', { code: 'fix()' });
    expect(executionPathSignals([a, b, a, b, a, b])).toMatchObject({
      loopedCalls: 4, redundantCalls: 4,
    });
  });

  test('revisiting an earlier call later is redundant but not a loop', () => {
    const a = call('run', { command: 'bun test' });
    const trace = [a, call('run', { command: 'ls' }), call('run', { command: 'pwd' }), a];
    expect(executionPathSignals(trace)).toMatchObject({ loopedCalls: 0, redundantCalls: 1 });
  });

  test('a clean trace triggers nothing', () => {
    const trace = [
      call('memory', { action: 'search', query: 'auth' }),
      write('/src/auth.ts'),
      call('run', { command: 'bun test packages/core' }),
      call('report', { status: 'completed', content: 'done' }),
    ];
    expect(executionPathSignals(trace)).toEqual({ loopedCalls: 0, redundantCalls: 0, backtrackCalls: 0 });
  });
});

describe('executionPathSignals — redundancy', () => {
  test('argument key order does not change a call\'s identity', () => {
    const trace = [
      call('fact', { action: 'remember', key: 'tz', value: 'UTC' }),
      call('fact', { value: 'UTC', key: 'tz', action: 'remember' }),
    ];
    expect(executionPathSignals(trace).redundantCalls).toBe(1);
  });

  test('same tool with different arguments is real work, not a repeat', () => {
    const trace = [
      call('web_search', { query: 'wilson interval' }),
      call('web_search', { query: 'clopper pearson' }),
      call('web_search', { query: 'agresti coull' }),
    ];
    expect(executionPathSignals(trace).redundantCalls).toBe(0);
  });

  // A call with no arguments has no payload identity, so repeats of it are not
  // evidence of repeated work. This also keeps the run-events reconstruction
  // (which records names without arguments) from manufacturing signal.
  test('argument-less calls are never counted as repeats', () => {
    const bare = call('execute_tools');
    expect(executionPathSignals([bare, bare, bare, bare])).toEqual({
      loopedCalls: 0, redundantCalls: 0, backtrackCalls: 0,
    });
  });
});

describe('executionPathSignals — backtracking', () => {
  test('re-reading a file the turn just wrote via code-mode', () => {
    const trace = [
      write('/src/auth.ts'),
      call('execute_tools', { code: 'const prev = await workspace.readFile("/src/auth.ts");' }),
    ];
    expect(executionPathSignals(trace).backtrackCalls).toBe(1);
  });

  test('undoing a shell-written file counts, in either direction of the vocabulary', () => {
    expect(executionPathSignals([
      call('run', { command: 'echo hi > /tmp/out.txt' }),
      call('run', { command: 'rm -f /tmp/out.txt' }),
    ]).backtrackCalls).toBe(1);

    expect(executionPathSignals([
      write('/src/main.ts'),
      call('run', { command: 'git checkout -- /src/main.ts' }),
    ]).backtrackCalls).toBe(1);
  });

  test('reading a file the turn never wrote is ordinary work', () => {
    const trace = [
      write('/src/auth.ts'),
      call('run', { command: 'cat /src/other.ts' }),
    ];
    expect(executionPathSignals(trace).backtrackCalls).toBe(0);
  });

  test('order matters: reading before writing is not backtracking', () => {
    const trace = [
      call('execute_tools', { code: 'await workspace.readFile("/src/auth.ts");' }),
      write('/src/auth.ts'),
    ];
    expect(executionPathSignals(trace).backtrackCalls).toBe(0);
  });

  test('a call cannot backtrack over its own write', () => {
    const trace = [
      call('execute_tools', {
        code: 'await workspace.writeFile("/a.ts", x); await workspace.readFile("/a.ts");',
      }),
    ];
    expect(executionPathSignals(trace).backtrackCalls).toBe(0);
  });

  // Precision over recall: the vocabularies run over free-form code and shell
  // text, so only path-shaped tokens count. A bare word is skipped rather than
  // risk a `>` comparison or an English phrase inventing a backtrack.
  test('tokens that do not look like paths are ignored on both sides', () => {
    const trace = [
      call('run', { command: 'echo done > marker' }),
      call('run', { command: 'cat marker' }),
    ];
    expect(executionPathSignals(trace).backtrackCalls).toBe(0);
  });

  test('paths are found in nested argument values, not just top-level strings', () => {
    const trace = [
      call('team', { action: 'spawn', task: { brief: 'run: echo x > /work/plan.md' } }),
      call('team', { action: 'spawn', task: { brief: 'run: rm /work/plan.md' } }),
    ];
    expect(executionPathSignals(trace).backtrackCalls).toBe(1);
  });
});
