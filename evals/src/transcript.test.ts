import { describe, expect, test } from 'bun:test';
import { encodeModelMessageValues, type RunEvent } from '@kinu.run/core';
import { cutButCompleted, measure, toTranscript } from './transcript';

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

describe('the transcript', () => {
  // The ledger's own row digests a large argument, and a large argument is the code the agent wrote.
  test('a tool call carries its whole arguments, as the model sent them, not the ledger row\'s digest', () => {
    const source = `export class Slate {\n${'  async book() { return this.storage.get("book"); }\n'.repeat(40)}}\n`;
    const input = { op: 'write', path: '/slates/exchange/server.ts', content: source };
    const base = { runId: 'run-1', timestamp: '2026-09-26T00:00:00.000Z' };

    const events: RunEvent[] = [
      { ...base, eventIndex: 1, type: 'run_start', agentId: 'root', userMessage: 'Build it.' },
      // As the ledger stores a large argument: its first 800 characters (`digestJsonValue`, core utils/json.ts).
      { ...base, eventIndex: 2, type: 'tool_call_end', name: 'file', toolCallId: 'call-1', args: `${JSON.stringify(input).slice(0, 800)}…`, result: { ok: true } },
      {
        ...base, eventIndex: 3, type: 'step_finish', stepIndex: 1, reason: 'tool-calls',
        messages: encodeModelMessageValues([{
          role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'file', input }],
        }]),
      },
    ];

    expect(toTranscript(events).find((event) => event.type === 'tool_call')).toMatchObject({ name: 'file', arguments: input });
  });
});

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

// A provider silent from its start is declared a `stall` wait at each retry (core `rate-limit-retry.ts`, 3817d2ca9): the
// provider failing, not the eval account's rate limit that the report's 429 waits measure.
test("a provider's declared stall is not a 429 wait", () => {
  const wait = (source: 'backoff' | 'stall', waitMs: number): RunEvent => ({ type: 'provider_wait', runId: 'run', eventIndex: 1,
    timestamp: '2026-10-01T16:00:00.000Z', provider: 'opencode-go', waitMs, attempt: 1, source });

  expect(measure([wait('backoff', 30_000), wait('stall', 2_000)])).toMatchObject({ providerWaits: 1, providerWaitMs: 30_000 });
});
