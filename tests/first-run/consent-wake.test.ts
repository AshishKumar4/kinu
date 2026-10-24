// consentWakeEnded returns once the call an owner's consent answer let through has run, whichever turn ran it.
//
// The park-and-wake contract has two landings. Answered after the parked call's turn ended, the answer opens a wake
// run (`caused_by: device_consent`) that re-issues the call. Answered while that turn still runs, the wake is read by
// the running turn, which re-issues the call itself, and no wake run ever opens. machine-consent waited for the wake
// run alone: production promotions 2026-10-24 00:56Z, 03:54Z, 04:48Z and 13:20Z each spent the 300 s budget with the
// call already run in the parked turn (`[PARKED, ok]` in one run), against `[PARKED]` then a wake run `[ok]` in every
// passing run.
import { expect, test } from 'bun:test';
import type { RunEvent } from '../../packages/core/src/index';
import { consentWakeEnded } from './device-session';

const AT = '2026-10-24T13:20:41.000Z';

const HOSTNAME = { runtime: 'device', command: 'hostname', why: 'The owner asked for this command on that machine.' };

const PARKED = "device exec `hostname`: NOT RUN: using kinu-first-run-consent from this workspace waits on the owner's consent. You are woken when they answer; do not re-issue it before then.";

function opened(runId: string, causedBy: string): RunEvent {
  return { type: 'run_start', runId, eventIndex: 0, timestamp: AT, agentId: 'main', caused_by: causedBy };
}

function shell(runId: string, eventIndex: number, error?: string): RunEvent {
  const call = { runId, eventIndex, timestamp: AT, name: 'shell', toolCallId: `call-${String(eventIndex)}`, args: HOSTNAME };

  return error === undefined
    ? { type: 'tool_call_end', ...call, result: 'cwd: ~\nkinu-first-run-consent\n', outcome: { success: true } }
    : { type: 'tool_call_end', ...call, error };
}

function ended(runId: string, eventIndex: number): RunEvent {
  return { type: 'run_end', runId, eventIndex, timestamp: AT, reason: 'completed' };
}

/** A session whose ledger reads are `ledgers` in turn, the last one repeated; a run followed streams `rest`, and each
 *  follow is noted as `runId@cursor`. */
function session(ledgers: (readonly RunEvent[])[], rest: readonly RunEvent[] = []) {
  let read = 0;
  const followed: string[] = [];

  return {
    followed,
    runEvents: async (): Promise<readonly RunEvent[]> => ledgers[Math.min(read++, ledgers.length - 1)] ?? [],
    followRun: async function* (runId: string, since: number): AsyncGenerator<RunEvent> {
      followed.push(`${runId}@${String(since)}`);
      yield* rest;
    },
  };
}

/** A room that hears one more closed turn per ask, `closings` times, then ends (the budget, or the socket). */
function room(closings: number) {
  let left = closings;

  return { turnClosed: async (): Promise<boolean> => left-- > 0 };
}

test('an answer the parked turn read itself, re-issuing the call there, ends the wait with no wake run', async () => {
  const inTurn = [opened('run-2', 'chat'), shell('run-2', 5, PARKED), shell('run-2', 8), ended('run-2', 14)];

  // The room never hears another turn close: nothing else will run.
  expect(await consentWakeEnded(session([inTurn]), room(0), Promise.resolve(false))).toBe(true);
});

test('an answer after the parked turn ended is waited for until the wake run it opens has ended', async () => {
  const parked = [opened('run-2', 'chat'), shell('run-2', 5, PARKED), ended('run-2', 10)];
  const woken = [...parked, opened('run-3', 'device_consent'), shell('run-3', 4), ended('run-3', 9)];

  expect(await consentWakeEnded(session([parked, woken]), room(1), Promise.resolve(true))).toBe(true);
});

test('a wake run still open when found is followed from its last event to its end', async () => {
  const open = [opened('run-2', 'chat'), shell('run-2', 5, PARKED), ended('run-2', 10), opened('run-3', 'device_consent'), shell('run-3', 4)];
  const following = session([open], [ended('run-3', 9)]);

  expect({ ended: await consentWakeEnded(following, room(0), Promise.resolve(false)), followed: following.followed }).toEqual({ ended: true, followed: ['run-3@4'] });
});

test('the same call is the same arguments in any key order', async () => {
  const reordered = [opened('run-2', 'chat'), shell('run-2', 5, PARKED), { ...shell('run-2', 8), args: { why: HOSTNAME.why, command: 'hostname', runtime: 'device' } }, ended('run-2', 14)];

  expect(await consentWakeEnded(session([reordered]), room(0), Promise.resolve(false))).toBe(true);
});

test('a re-issue that parked again is not the answered call, and the room ending first is a false', async () => {
  const twice = [opened('run-2', 'chat'), shell('run-2', 5, PARKED), shell('run-2', 8, PARKED), ended('run-2', 12)];

  expect(await consentWakeEnded(session([twice]), room(0), Promise.resolve(false))).toBe(false);
});
