/**
 * Run Timeline projection — contract tests for the pure classifiers that map
 * the agent's event sources onto the unified TimelineSpan spine. These run
 * without booting the Durable Object (the projection lives in lib/timeline.ts).
 */
import { describe, test, expect } from 'bun:test';
import { runEventToSpan, classifyEvolutionType, toolKindFor, safeJsonParse } from '../src/lib/timeline.ts';
import type { RunEvent } from '@proteus/core';

function ev<T extends RunEvent['type']>(type: T, extra: Record<string, unknown>): RunEvent {
  return { type, eventIndex: 0, runId: 'r1', timestamp: '2026-06-01T00:00:00.000Z', ...extra } as RunEvent;
}

describe('toolKindFor', () => {
  test('maps tool names to runtime/mcts/skills/tool-call', () => {
    expect(toolKindFor('run')).toBe('runtime-exec');
    expect(toolKindFor('think')).toBe('mcts');
    expect(toolKindFor('skills')).toBe('skills');
    expect(toolKindFor('execute_tools')).toBe('tool-call');
    expect(toolKindFor('memory')).toBe('tool-call');
  });
});

describe('classifyEvolutionType', () => {
  test('maps evolution_events.type to a timeline kind', () => {
    expect(classifyEvolutionType('turn_complete')).toBe('llm-turn');
    expect(classifyEvolutionType('reflection')).toBe('reflection');
    expect(classifyEvolutionType('scaffold_proposed')).toBe('scaffold');
    expect(classifyEvolutionType('mcts_started')).toBe('mcts');
    expect(classifyEvolutionType('mcts_complete')).toBe('mcts');
    expect(classifyEvolutionType('consolidation')).toBe('craft');
    expect(classifyEvolutionType('craft_discovered')).toBe('craft');
    expect(classifyEvolutionType('fiber_recovered')).toBe('recovery');
    expect(classifyEvolutionType('gepa_run')).toBe('gepa');
    expect(classifyEvolutionType('curriculum_proposed')).toBe('curriculum');
    expect(classifyEvolutionType('something_else')).toBe('other');
  });
});

describe('runEventToSpan', () => {
  test('failure events get first-class failure kinds', () => {
    expect(runEventToSpan(ev('error', { message: 'boom' })).kind).toBe('error');
    expect(runEventToSpan(ev('run_end', { reason: 'aborted' })).kind).toBe('abort');
    expect(runEventToSpan(ev('fiber_recovered', { fiberName: 'mcts', fiberId: 'f1' })).kind).toBe('recovery');
  });

  test('head split/merge carry their structured payload + ref', () => {
    const split = runEventToSpan(ev('head_split', { rootId: 'root1', headIds: ['h1', 'h2'], rationale: 'why' }));
    expect(split.kind).toBe('head-split');
    expect(split.refId).toBe('root1');
    expect(split.data).toEqual({ rootId: 'root1', headIds: ['h1', 'h2'] });
    expect(runEventToSpan(ev('head_merge', { rootId: 'root1', headCount: 2, mergedNarrative: 'x' })).kind).toBe('head-merge');
  });

  test('tool calls map by tool name and carry latency on end', () => {
    expect(runEventToSpan(ev('tool_call_start', { name: 'run', args: {}, toolCallId: 'tc1' })).kind).toBe('runtime-exec');
    const end = runEventToSpan(ev('tool_call_end', { name: 'execute_tools', toolCallId: 'tc1', durationMs: 42 }));
    expect(end.kind).toBe('tool-call');
    expect(end.elapsedMs).toBe(42);
    expect(end.label).toBe('execute_tools');
    const failed = runEventToSpan(ev('tool_call_end', { name: 'run', toolCallId: 'tc2', error: 'nonzero exit' }));
    expect(failed.label).toBe('run failed');
    expect(failed.detail).toBe('nonzero exit');
  });

  test('scaffold promotion/rollback are scaffold spans with versions in label', () => {
    expect(runEventToSpan(ev('scaffold_promotion', { fromVersion: 2, toVersion: 3 })).label).toContain('v2 → v3');
    expect(runEventToSpan(ev('scaffold_rollback', { fromVersion: 3, toVersion: 2 })).kind).toBe('scaffold');
  });

  test('run_start is a trigger span carrying the user message', () => {
    const s = runEventToSpan(ev('run_start', { agentId: 'a1', userMessage: 'do the thing' }));
    expect(s.kind).toBe('trigger');
    expect(s.detail).toBe('do the thing');
  });

  test('timestamp parses to epoch ms', () => {
    expect(runEventToSpan(ev('turn_start', { turnIndex: 1 })).ts).toBe(Date.parse('2026-06-01T00:00:00.000Z'));
  });
});

describe('safeJsonParse', () => {
  test('parses JSON, returns raw string on failure', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
    expect(safeJsonParse('not json')).toBe('not json');
  });
});
