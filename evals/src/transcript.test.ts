import { describe, expect, test } from 'bun:test';
import type { RunEvent } from '@kinu.run/core';
import { cutButCompleted } from './transcript';

let index = 0;

/** One ledger row of `runId`, stamped as the route serves it. */
function row(runId: string, body: { type: 'step_finish'; reason: string } | { type: 'run_end'; reason: string } | { type: 'run_start' }): RunEvent {
  index += 1;
  const base = { runId, eventIndex: index, timestamp: '2026-09-24T00:00:00.000Z' };

  if (body.type === 'run_start') return { ...base, type: 'run_start', agentId: 'root' };

  return body.type === 'step_finish' ? { ...base, type: 'step_finish', stepIndex: index, reason: body.reason } : { ...base, type: 'run_end', reason: body.reason };
}

/** A run of `steps` steps, the last finishing with `lastReason`, ended `ended`. */
function run(runId: string, steps: number, lastReason: string, ended: string): RunEvent[] {
  return [
    row(runId, { type: 'run_start' }),
    ...Array.from({ length: steps - 1 }, () => row(runId, { type: 'step_finish', reason: 'tool-calls' })),
    row(runId, { type: 'step_finish', reason: lastReason }),
    row(runId, { type: 'run_end', reason: ended }),
  ];
}

describe('the step-cap probe', () => {
  test('a run cut with tool calls pending and reported completed is found, with its step count', () => {
    expect(cutButCompleted(run('capped', 10, 'tool-calls', 'completed'), new Set())).toEqual([{ runId: 'capped', steps: 10 }]);
  });

  test('a run that finished on its own, or one the product sealed incomplete, is not', () => {
    const events = [...run('finished', 5, 'stop', 'completed'), ...run('sealed', 10, 'tool-calls', 'incomplete')];

    expect(cutButCompleted(events, new Set())).toEqual([]);
  });

  test('only the runs this turn opened count: an earlier turn\'s run is not this turn\'s finding', () => {
    expect(cutButCompleted(run('earlier', 10, 'tool-calls', 'completed'), new Set(['earlier']))).toEqual([]);
  });
});
