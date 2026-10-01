import { expect, test } from 'bun:test';
import type { JsonValue, RunEvent } from '../../packages/core/src/index';
import {
  delivered, deliveredInLedger, finalAnswer, observeDelegationRetirement, observeDurableHire, taskHires,
} from './delegation-observation';

function call(runId: string, eventIndex: number, args: JsonValue, result: JsonValue): Extract<RunEvent, { type: 'tool_call_end' }> {
  return {
    type: 'tool_call_end', name: 'agents', runId, eventIndex,
    timestamp: '2026-09-19T08:10:51.999Z', toolCallId: `${runId}-${String(eventIndex)}`,
    durationMs: 1, args, result, outcome: { success: true },
  };
}

/** One finished step, as `[runId, eventIndex, timestamp, reason]`, ending on `text`. */
function finished([runId, eventIndex, timestamp, reason]: readonly [string, number, string, string], text: string): RunEvent {
  return {
    type: 'step_finish', runId, eventIndex, timestamp, stepIndex: eventIndex, reason,
    messages: [{ role: 'assistant', content: [{ type: 'text', text }] }],
  };
}

const MISSION = 'Reply with exactly the word bramblelight and nothing else.';

const ASK = 'Hire one helper to say the word.';

// The shape a task hire answers in since cafab2bfc: at once, its helper still at work.
const taskHire = call('task', 4, { action: 'hire', lifetime: 'task', role: 'task', mission: MISSION }, {
  status: 'working', agent: 'ask-task-ymhu3n', lifetime: 'task', role: 'task', answer: 'Working.',
});

const durableHire = call('roster', 4, { action: 'hire' }, { name: 'task-9j4odl' });

const roster = call('roster', 10, { action: 'list' }, { subordinates: [{ name: 'task-9j4odl' }] });

test('a task hire is read by the helper it named and the mission it gave', () => {
  expect(taskHires([durableHire, taskHire]).map((hire) => [hire.agent, hire.mission])).toEqual([['ask-task-ymhu3n', MISSION]]);
});

test('refused, errored and malformed hires are not task hires', () => {
  for (const hire of [
    { ...taskHire, error: 'transport failed' },
    { ...taskHire, outcome: { success: false, reason: 'bad_input' } },
    call('task', 1, { action: 'hire', lifetime: 'task', mission: MISSION }, { status: 'working', lifetime: 'task' }),
    call('task', 1, { action: 'hire', mission: MISSION }, { status: 'working', agent: 'durable', lifetime: 'task' }),
  ] satisfies RunEvent[]) {
    expect(taskHires([hire])).toEqual([]);
  }
});

test('an answer is delivered by the first message after the ask that names its helper, and the reply that follows it', () => {
  const report = '1 event arrived while you were idle.\n- report from ask-task-ymhu3n: bramblelight';

  expect(delivered([
    { role: 'user', text: ASK },
    { role: 'assistant', text: 'WAITING' },
    { role: 'user', text: report },
    { role: 'assistant', text: 'HIRED bramblelight' },
  ], ASK, 'ask-task-ymhu3n')).toEqual({ text: report, reply: 'HIRED bramblelight' });
});

test('no message names the helper after the ask: nothing was delivered', () => {
  expect(delivered([
    { role: 'user', text: 'an earlier mention of ask-task-ymhu3n' },
    { role: 'user', text: ASK },
    { role: 'assistant', text: 'ask-task-ymhu3n is working' },
    { role: 'user', text: 'an unrelated message' },
  ], ASK, 'ask-task-ymhu3n')).toBeNull();

  expect(delivered([{ role: 'user', text: 'ask-task-ymhu3n answered' }], ASK, 'ask-task-ymhu3n')).toBeNull();
});

test("a ledger holds a delivery when a turn of its own opened on a message naming the helper", () => {
  const opened = (text: string): RunEvent => ({
    type: 'run_start', runId: 'r2', eventIndex: 0, timestamp: '2026-10-01T03:12:34.536Z', agentId: 'relay',
    turn: { turnId: 'programmatic:evt-1', messageId: 'm', kind: 'programmatic', text },
  });

  expect(deliveredInLedger([opened('- report from ask-task-deep01: emberfall')], 'ask-task-deep01')).toBe(true);
  expect(deliveredInLedger([opened('- report from ask-task-other: emberfall')], 'ask-task-deep01')).toBe(false);
});

test("an actor's final answer is its last finished turn's text, not a tool step's", () => {
  expect(finalAnswer([
    finished(['r1', 2, '2026-10-01T03:12:30.000Z', 'stop'], 'WAITING'),
    finished(['r2', 3, '2026-10-01T03:12:34.900Z', 'tool-calls'], 'Calling agents.'),
    finished(['r2', 5, '2026-10-01T03:12:34.950Z', 'stop'], 'emberfall'),
    finished(['r1', 1, '2026-10-01T03:12:29.000Z', 'tool-calls'], 'Calling agents.'),
  ])).toBe('emberfall');

  expect(finalAnswer([])).toBe('');
});

test('the roster must contain the exact subordinate name, not a peer or substring', () => {
  expect(observeDurableHire([durableHire, roster])).toEqual({ durableName: 'task-9j4odl', shown: true });

  const results: JsonValue[] = [
    { subordinates: [], peers: [{ name: 'task-9j4odl' }] },
    { subordinates: [{ name: 'task-9j4odl-extra' }] },
    { error: 'task-9j4odl' },
  ];

  for (const result of results) {
    expect(observeDurableHire([durableHire, call('roster', 10, { action: 'list' }, result)]).shown).toBe(false);
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
