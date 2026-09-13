import { expect, test } from 'bun:test';
import type { RunEvent } from '../../packages/core/src/index';
import { firstRunTurnSettlement } from './turn-settlement';

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
