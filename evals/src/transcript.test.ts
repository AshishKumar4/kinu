import { describe, expect, test } from 'bun:test';
import type { RunEvent } from '@kinu.run/core';
import type { ModelMessage } from 'ai';
import { callInputs, cutButCompleted, measure, toolFailures, toTranscript, type StepMessages } from './transcript';

let index = 0;

const output = new Map<Extract<RunEvent, { type: 'step_finish' }>, readonly ModelMessage[]>();

/** One ledger row of `runId`, stamped as the route serves it. */
function row(runId: string, body: { type: 'step_finish'; reason: string; parts: [] } | { type: 'run_end'; reason: string } | { type: 'run_start' }): RunEvent {
  index += 1;
  const base = { runId, eventIndex: index, timestamp: '2026-09-24T00:00:00.000Z' };

  if (body.type === 'run_start') return { ...base, type: 'run_start', agentId: 'root' };

  return body.type === 'step_finish' ? { ...base, type: 'step_finish', parts: [], stepIndex: index, reason: body.reason } : { ...base, type: 'run_end', reason: body.reason };
}

/** A run of `steps` steps, the last finishing with `lastReason`, ended `ended`. */
function run(runId: string, steps: number, lastReason: string, ended: string): RunEvent[] {
  return [
    row(runId, { type: 'run_start' }),
    ...Array.from({ length: steps - 1 }, () => row(runId, { type: 'step_finish', parts: [], reason: 'tool-calls' })),
    row(runId, { type: 'step_finish', parts: [], reason: lastReason }),
    row(runId, { type: 'run_end', reason: ended }),
  ];
}

describe('the transcript', () => {
  test('reused provider ids retain the input of their own run and step, even with interleaved runs', () => {
    const timestamp = '2026-10-09T20:00:00.000Z';
    const first = { op: 'read', path: '/home/main/first.txt' };
    const other = { op: 'read', path: '/home/main/other.txt' };
    const later = { op: 'read', path: '/home/main/later.txt' };

    const call = (runId: string, eventIndex: number): Extract<RunEvent, { type: 'tool_call_end' }> => ({
      runId, eventIndex, timestamp, type: 'tool_call_end', name: 'file', toolCallId: 'reused', args: { op: 'digest' }, result: 'read',
    });

    const step = (runId: string, eventIndex: number, input: typeof first): RunEvent => {
      const event: Extract<RunEvent, { type: 'step_finish' }> = {
        runId, eventIndex, timestamp, type: 'step_finish', stepIndex: eventIndex, parts: [{ messageId: `${runId}-${String(eventIndex)}`, partNo: 0 }],
      };

      output.set(event, [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'reused', toolName: 'file', input }] }]);

      return event;
    };

    const a = call('a', 0), b = call('b', 0), next = call('a', 2);
    const events = [a, b, step('a', 1, first), next, step('b', 1, other), step('a', 3, later)];
    const associated = callInputs(events, output);

    expect([associated.get(a), associated.get(b), associated.get(next)]).toEqual([first, other, later]);
    expect(toTranscript(events, output).filter((event) => event.type === 'tool_call').map((event) => event.arguments))
      .toEqual([first, other, later]);
  });

  // The ledger's own row digests a large argument, and a large argument is the code the agent wrote.
  test('a tool call carries its whole arguments, as the model sent them, not the ledger row\'s digest', () => {
    const source = `export class Slate {\n${'  async book() { return this.storage.get("book"); }\n'.repeat(40)}}\n`;
    const input = { op: 'write', path: '/slates/exchange/server.ts', content: source };
    const base = { runId: 'run-1', timestamp: '2026-09-26T00:00:00.000Z' };

    const finished: Extract<RunEvent, { type: 'step_finish' }> = {
      ...base, eventIndex: 3, type: 'step_finish', stepIndex: 1, reason: 'tool-calls', parts: [{ messageId: 'full-input', partNo: 0 }],
    };

    const canonical: StepMessages = new Map([[finished, [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'file', input }] }]]]);

    const events: RunEvent[] = [
      { ...base, eventIndex: 1, type: 'run_start', agentId: 'root', userMessage: 'Build it.' },
      // As the ledger stores a large argument: its first 800 characters (`digestJsonValue`, core utils/json.ts).
      { ...base, eventIndex: 2, type: 'tool_call_end', name: 'file', toolCallId: 'call-1', args: `${JSON.stringify(input).slice(0, 800)}…`, result: { ok: true } },
      finished,
    ];

    expect(toTranscript(events, canonical).find((event) => event.type === 'tool_call')).toMatchObject({ name: 'file', arguments: input });
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

// A tool description that misleads moves these two before the pass rate: calls the tool refused as bad input, and calls
// to a tool the product never offered.
test('of the failed calls, those refused as bad input and those to an invented tool are counted apart', () => {
  const call = (name: string, outcome: Extract<RunEvent, { type: 'tool_call_end' }>['outcome']): RunEvent => ({
    type: 'tool_call_end', runId: 'run', eventIndex: 1, timestamp: '2026-10-07T00:00:00.000Z', name, toolCallId: name, outcome,
  });

  expect(measure([
    call('file', { success: false, reason: 'bad_input' }),
    call('shell', { success: false, reason: 'unavailable' }),
    call('read_file', { success: false, reason: null }),
    call('file', { success: true }),
  ])).toMatchObject({ toolCalls: 4, toolErrors: 3, badInputCalls: 1, unknownToolCalls: 1 });
});

// The run report's failed calls: by the tool, and by why it failed, a binding a program called under its own name.
test('a failed call counts under its tool and the code it was refused with, an invented name and a bare throw apart', () => {
  const call = (name: string, outcome: Extract<RunEvent, { type: 'tool_call_end' }>['outcome'], error?: string): RunEvent => ({
    type: 'tool_call_end', runId: 'run', eventIndex: 1, timestamp: '2026-10-08T00:00:00.000Z', name, toolCallId: name, outcome,
    ...error !== undefined && { error },
  });

  expect(toolFailures([
    call('file', { success: false, reason: 'bad_input' }, 'no such path'),
    call('file', { success: false, reason: 'bad_input' }, 'no such path'),
    call('read_file', { success: false, reason: null }, 'no tool'),
    call('shell', { success: true }, 'it threw'),
    call('eval', { success: true, failures: [{ success: false, reason: 'denied', error: 'not yours', tool: 'workspace.writeFile', op: null }] }),
    call('file', { success: true }),
  ])).toEqual([
    { tool: 'file', cause: 'bad_input', count: 2 },
    { tool: 'read_file', cause: 'unknown_tool', count: 1 },
    { tool: 'shell', cause: 'error', count: 1 },
    { tool: 'workspace.writeFile', cause: 'denied', count: 1 },
  ]);
});
