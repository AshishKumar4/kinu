/**
 * Run Timeline projection — contract tests for the pure classifiers that map
 * the agent's event sources onto the unified TimelineSpan spine. These run
 * without booting the Durable Object (the projection lives in core read-models).
 */
import { describe, test, expect } from 'bun:test';
import {
  runEventToSpan, classifyEvolutionType, toolKindFor, safeJsonParse,
  type RunEvent, type RunEventInput, type Usage,
} from '@kinu/core';

function ev(event: RunEventInput): RunEvent {
  return { eventIndex: 0, runId: 'r1', timestamp: '2026-06-01T00:00:00.000Z', ...event };
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
    expect(runEventToSpan(ev({ type: 'error', message: 'boom' })).kind).toBe('error');
    expect(runEventToSpan(ev({ type: 'run_end', reason: 'aborted' })).kind).toBe('abort');
    expect(runEventToSpan(ev({ type: 'fiber_recovered', fiberName: 'mcts', fiberId: 'f1' })).kind).toBe('recovery');
  });

  test('a finished turn prints only the token counts the provider reported', () => {
    const detail = (usage?: Usage) => {
      const turn: Extract<RunEventInput, { type: 'turn_end' }> = { type: 'turn_end', turnIndex: 0 };
      if (usage !== undefined) turn.usage = usage;
      return runEventToSpan(ev(turn)).detail;
    };

    expect(detail({ input: 120, output: 8 })).toBe('120 in + 8 out tok');
    // A reported zero is evidence and prints; an unreported side is left out
    // entirely rather than rendered as "undefined" or as a zero.
    expect(detail({ input: 0, output: 0 })).toBe('0 in + 0 out tok');
    expect(detail({ input: 120 })).toBe('120 in tok');
    expect(detail({ output: 8 })).toBe('8 out tok');
    // Nothing reported — no detail line at all, which is the pre-existing
    // behaviour for a turn_end carrying no usage.
    expect(detail({})).toBeUndefined();
    expect(detail()).toBeUndefined();
  });

  test('head split/merge carry their structured payload + ref', () => {
    const split = runEventToSpan(ev({ type: 'head_split', rootId: 'root1', headIds: ['h1', 'h2'], rationale: 'why' }));
    expect(split.kind).toBe('head-split');
    expect(split.refId).toBe('root1');
    expect(split.data).toEqual({ rootId: 'root1', headIds: ['h1', 'h2'] });
    expect(runEventToSpan(ev({
      type: 'head_merge', rootId: 'root1', headCount: 2, headsWithFindings: 2,
      totalTokens: 0, mergedNarrative: 'x', fileChanges: [], blindSpots: [],
    })).kind).toBe('head-merge');
  });

  test('tool calls map by tool name and carry latency on end', () => {
    expect(runEventToSpan(ev({ type: 'tool_call_end', name: 'run', args: { command: 'ls' }, toolCallId: 'tc0' })).kind).toBe('runtime-exec');
    const end = runEventToSpan(ev({ type: 'tool_call_end', name: 'execute_tools', toolCallId: 'tc1', durationMs: 42 }));
    expect(end.kind).toBe('tool-call');
    expect(end.elapsedMs).toBe(42);
    expect(end.label).toBe('execute_tools');
    const failed = runEventToSpan(ev({ type: 'tool_call_end', name: 'run', toolCallId: 'tc2', error: 'nonzero exit' }));
    expect(failed.label).toBe('run failed');
    expect(failed.detail).toBe('nonzero exit');
  });

  test('scaffold promotion/rollback are scaffold spans with versions in label', () => {
    expect(runEventToSpan(ev({ type: 'scaffold_promotion', fromVersion: 2, toVersion: 3 })).label).toContain('v2 → v3');
    expect(runEventToSpan(ev({ type: 'scaffold_rollback', fromVersion: 3, toVersion: 2 })).kind).toBe('scaffold');
  });

  test('run_start is a trigger span carrying the user message', () => {
    const s = runEventToSpan(ev({ type: 'run_start', agentId: 'a1', userMessage: 'do the thing' }));
    expect(s.kind).toBe('trigger');
    expect(s.detail).toBe('do the thing');
  });

  test('timestamp parses to epoch ms', () => {
    expect(runEventToSpan(ev({ type: 'turn_start', turnIndex: 1 })).ts).toBe(Date.parse('2026-06-01T00:00:00.000Z'));
  });
});

describe('safeJsonParse', () => {
  test('parses JSON, returns raw string on failure', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
    expect(safeJsonParse('not json')).toBe('not json');
  });
});
