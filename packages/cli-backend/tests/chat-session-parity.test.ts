/**
 * The ChatSession extraction changes no durable row.
 *
 * `fixtures/chat-session-parity.json` is the record `chat-session-parity.ts`'s
 * scripted conversation left on the tree BEFORE the turn loop moved into core
 * (main at 9929af66e, recorded 2026-09-14): the transcript rows, the
 * pending-send ledger, the event log, the terminal ledger at three points of
 * the script, plus the event stream each session's frontend saw and what
 * every driver call answered. Every minted id and clock reading is normalized
 * by order of appearance, so the comparison is on what the script decides and
 * nothing else.
 *
 * Green means the loop over `ChatSession` leaves exactly the rows the loop
 * inside `LocalAgentSession` left. A red here names the row, the checkpoint
 * and the field that moved; the fixture is re-recorded only for a change that
 * MEANS to change the durable record, and the commit that does so says why.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { ParitySnapshotSchema, runParityScenario } from './chat-session-parity';

const FIXTURE = join(import.meta.dir, 'fixtures', 'chat-session-parity.json');

describe('ChatSession parity — the extraction changes no durable row', () => {
  test('the scripted conversation leaves the pre-extraction record, checkpoint by checkpoint', async () => {
    const recorded = v.parse(ParitySnapshotSchema, JSON.parse(readFileSync(FIXTURE, 'utf8')));
    const now = await runParityScenario();

    // Checkpoint by checkpoint rather than one deep equality on the whole
    // record, so a difference names where in the script it appeared.
    expect(now.landings).toEqual(recorded.landings);
    expect(now.afterTwo).toEqual(recorded.afterTwo);
    expect(now.beforeRestart).toEqual(recorded.beforeRestart);
    expect(now.end).toEqual(recorded.end);
    expect(now.events).toEqual(recorded.events);
  });

  test('the record is not vacuous: every arm of the script left rows', () => {
    // A fixture that recorded an empty conversation would compare equal to
    // any empty conversation. These floors pin what the script must have done:
    // a file-carrying steer restored across the restart, a reservation the
    // dead process left, and a terminal ledger for the answered turn.
    const recorded = v.parse(ParitySnapshotSchema, JSON.parse(readFileSync(FIXTURE, 'utf8')));

    expect(recorded.beforeRestart.pendingSteers).toHaveLength(2);
    expect(recorded.beforeRestart.pendingSteerFiles).toHaveLength(1);
    expect(recorded.end.pendingSteers).toHaveLength(0);
    expect(recorded.end.actorMessages.length).toBeGreaterThan(recorded.beforeRestart.actorMessages.length);
    expect(recorded.end.terminalEffects.length).toBeGreaterThan(0);
    expect(recorded.landings).toEqual({
      landingTwo: 'mid-turn', landingThree: 'mid-turn', returned: ['three-steer'],
      landingFour: 'mid-turn', landingFive: 'turn',
    });
  });
});
