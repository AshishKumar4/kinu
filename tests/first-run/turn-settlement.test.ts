import { expect, test } from 'bun:test';
import type { RunEvent } from '../../packages/core/src/index';
import { firstRunTurnEvents, firstRunTurnSettlement } from './turn-settlement';

const stamp = { timestamp: '2026-09-13T11:22:21.235Z', eventIndex: 0 };

const events: RunEvent[] = [
  { ...stamp, runId: 'genesis', type: 'run_start', agentId: 'root', userMessage: 'new workspace' },
  { ...stamp, runId: 'cr', type: 'run_start', agentId: 'root', userMessage: 'KINU-FIRST-RUN-CR reply with only OK' },
  { ...stamp, runId: 'genesis', type: 'run_end', reason: 'completed' },
  { ...stamp, runId: 'cr', type: 'run_end', reason: 'completed' },
  { ...stamp, runId: 'lf', type: 'run_start', agentId: 'root', userMessage: 'KINU-FIRST-RUN-LF reply with only OK' },
];

test('a prior completed run cannot settle the LF turn still running on production', () => {
  expect(firstRunTurnSettlement(events, 'KINU-FIRST-RUN-LF')).toBe('pending');
});

test('genesis tools do not count as tools called by the explicit listing ask', () => {
  const own: RunEvent[] = [
    { ...stamp, runId: 'genesis', type: 'tool_call_end', name: 'file', toolCallId: 'g', durationMs: 1 },
    { ...stamp, runId: 'list', type: 'run_start', agentId: 'root', userMessage: 'List every tool' },
  ];

  expect(firstRunTurnEvents(own, 'List every tool').filter((event) => event.type === 'tool_call_end')).toHaveLength(0);
  own.push({ ...stamp, runId: 'list', type: 'tool_call_end', name: 'file', toolCallId: 'l', durationMs: 1 });
  expect(firstRunTurnEvents(own, 'List every tool').filter((event) => event.type === 'tool_call_end')).toHaveLength(1);
});

test('an assistant from another run cannot answer the selected turn', () => {
  expect(firstRunTurnSettlement([
    ...events,
    { ...stamp, runId: 'cr', type: 'step_finish', stepIndex: 1, reason: 'stop', messages: [{ role: 'assistant', content: 'OK' }] },
    { ...stamp, runId: 'lf', type: 'run_end', reason: 'completed' },
  ], 'KINU-FIRST-RUN-LF')).toEqual({ ended: 'completed' });
});

test('the selected run must finish and carry its own text', () => {
  const response: RunEvent = { ...stamp, runId: 'lf', type: 'step_finish', stepIndex: 1, reason: 'stop', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'OK' }] }] };

  expect(firstRunTurnSettlement([...events, response], 'KINU-FIRST-RUN-LF')).toBe('pending');
  expect(firstRunTurnSettlement([
    ...events, response, { ...stamp, runId: 'lf', type: 'run_end', reason: 'completed' },
  ], 'KINU-FIRST-RUN-LF')).toBe('replied');
});

test('a prompt that landed mid-turn is answered by the run open at its landing', () => {
  // The absorb rule: the send landed while `genesis` was still open, so the
  // marker's events are genesis's — its tool calls count, and its run_end is
  // the marker's close. The marker never got a run_start of its own.
  const absorbed: RunEvent[] = [
    { ...stamp, runId: 'genesis', type: 'run_start', agentId: 'root', userMessage: 'new workspace' },
    { ...stamp, runId: 'genesis', type: 'tool_call_end', name: 'file', toolCallId: 'g1', durationMs: 1 },
  ];

  expect(firstRunTurnEvents(absorbed, 'KINU-FIRST-RUN-ABS').filter((event) => event.type === 'tool_call_end')).toHaveLength(1);
  expect(firstRunTurnSettlement(absorbed, 'KINU-FIRST-RUN-ABS')).toBe('pending');

  const closed: RunEvent[] = [
    ...absorbed,
    { ...stamp, runId: 'genesis', type: 'step_finish', stepIndex: 2, reason: 'stop', messages: [{ role: 'assistant', content: 'OK' }] },
    { ...stamp, runId: 'genesis', type: 'run_end', reason: 'completed' },
  ];

  expect(firstRunTurnSettlement(closed, 'KINU-FIRST-RUN-ABS')).toBe('replied');
});

test('a landing instant names the absorbing run when several runs share the log', () => {
  // Two runs, the marker's landing between the first's start and end: the
  // still-open run absorbs it — not the latest closed, not the latest started.
  const at = '2026-09-13T11:22:21.240Z';

  const shared: RunEvent[] = [
    { ...stamp, timestamp: '2026-09-13T11:22:20.000Z', runId: 'early', type: 'run_start', agentId: 'root', userMessage: 'new workspace' },
    { ...stamp, timestamp: '2026-09-13T11:22:21.238Z', runId: 'mid', type: 'run_start', agentId: 'root', userMessage: 'unrelated wake' },
    { ...stamp, timestamp: '2026-09-13T11:22:21.250Z', runId: 'early', type: 'run_end', reason: 'completed' },
    { ...stamp, timestamp: '2026-09-13T11:22:21.260Z', runId: 'mid', type: 'run_end', reason: 'completed' },
  ];

  // At `at` both runs are open; the latest-STARTED open run absorbs the landing.
  expect(firstRunTurnEvents(shared, 'MARKER', { landedAt: at }).every((event) => event.runId === 'mid')).toBe(true);
});
