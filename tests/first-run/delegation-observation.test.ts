import { expect, test } from 'bun:test';
import type { JsonValue, RunEvent } from '../../packages/core/src/index';
import { observeDelegationHires, observeDelegationRetirement } from './delegation-observation';

function call(runId: string, eventIndex: number, args: JsonValue, result: JsonValue): Extract<RunEvent, { type: 'tool_call_end' }> {
  return {
    type: 'tool_call_end', name: 'agents', runId, eventIndex,
    timestamp: '2026-09-19T08:10:51.999Z', toolCallId: `${runId}-${String(eventIndex)}`,
    durationMs: 1, args, result, outcome: { success: true },
  };
}

const taskHire = call('genesis', 20, { action: 'hire', lifetime: 'task' }, {
  status: 'completed', agent: 'ask-task-bfq4w0', lifetime: 'task', answer: 'bramblelight',
});

const durableHire = call('roster', 4, { action: 'hire' }, { name: 'task-9j4odl' });

const roster = call('roster', 10, { action: 'list' }, { subordinates: [{ name: 'task-9j4odl' }] });

test('the retained delegation sequence selects the task answer and the later durable hire', () => {
  const observed = observeDelegationHires({
    taskEvents: [call('genesis', 12, { action: 'hire' }, { name: 'roster-probe' }), taskHire],
    rosterEvents: [durableHire, roster], reply: 'HIRED bramblelight', word: 'bramblelight',
  });

  expect(observed.taskHire?.toolCallId).toBe(taskHire.toolCallId);
  expect(observed.durableName).toBe('task-9j4odl');
  expect(observed.wordReported).toBe(true);
  expect(observed.shown).toBe(true);
});

test('a later task answer and names in unrelated result fields cannot satisfy the task', () => {
  const observed = observeDelegationHires({
    taskEvents: [], rosterEvents: [taskHire, durableHire, roster], reply: 'bramblelight', word: 'bramblelight',
  });

  expect(observed.taskHire).toBeUndefined();
  expect(observed.wordReported).toBe(false);

  const unrelated = observeDelegationHires({
    taskEvents: [call('task', 1, { action: 'hire', lifetime: 'task' }, {
      status: 'completed', agent: 'bramblelight', lifetime: 'task', answer: 'wrong',
    })], rosterEvents: [], reply: 'bramblelight', word: 'bramblelight',
  });

  expect(unrelated.wordReported).toBe(false);
});

test('the roster must contain the exact subordinate name, not a peer or substring', () => {
  const results: JsonValue[] = [
    { subordinates: [], peers: [{ name: 'task-9j4odl' }] },
    { subordinates: [{ name: 'task-9j4odl-extra' }] },
    { error: 'task-9j4odl' },
  ];

  for (const result of results) {
    expect(observeDelegationHires({
      taskEvents: [taskHire], rosterEvents: [durableHire, call('roster', 10, { action: 'list' }, result)],
      reply: 'HIRED bramblelight', word: 'bramblelight',
    }).shown).toBe(false);
  }
});

test('refused, errored and malformed hires do not satisfy either lifetime', () => {
  const hires: RunEvent[] = [
    { ...taskHire, error: 'transport failed' },
    { ...taskHire, outcome: { success: false, reason: 'bad_input' } },
    call('task', 1, { action: 'hire', lifetime: 'task' }, { agent: 'missing-answer' }),
  ];

  for (const hire of hires) {
    expect(observeDelegationHires({
      taskEvents: [hire], rosterEvents: [hire], reply: 'bramblelight', word: 'bramblelight',
    })).toEqual({ taskHire: undefined, durableName: null, wordReported: false, shown: false });
  }
});

test('retirement needs that subordinate dismissed and a valid later roster in the same run', () => {
  const dismiss = call('retire', 4, { action: 'dismiss', agent: 'task-9j4odl' }, { ok: true });
  const empty = call('retire', 6, { action: 'list' }, { subordinates: [] });

  expect(observeDelegationRetirement([dismiss, empty], 'task-9j4odl').retired).toBe(true);

  for (const events of [
    [call('retire', 4, { action: 'dismiss', agent: 'someone-else' }, { ok: true }), empty],
    [dismiss, call('earlier', 99, { action: 'list' }, { subordinates: [] })],
    [dismiss, call('retire', 2, { action: 'list' }, { subordinates: [] })],
    [dismiss, call('retire', 6, { action: 'list' }, { error: 'unavailable' })],
    [dismiss, call('retire', 6, { action: 'list' }, { subordinates: [{ name: 'task-9j4odl' }] })],
  ]) expect(observeDelegationRetirement(events, 'task-9j4odl').retired).toBe(false);
});
