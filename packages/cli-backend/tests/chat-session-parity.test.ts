/**
 * The ChatSession extraction changes no durable row — and, since the loop
 * learned to continue an interrupted turn, the one arm it changes is stated.
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
    expect(now.restartedCalls).toEqual(recorded.restartedCalls);
  });

  test('AN INTERRUPTED TURN CONTINUES: the restart re-opens the dead turn where it stopped', async () => {
    // The turn the dead process was inside — "four", cut at a tool call the
    // model had issued and the tool had answered — is not run again from its
    // words. The restarted process re-opens it under the same opening row and
    // re-enters what it had produced, so:
    const now = await runParityScenario();
    const rows = v.parse(v.array(v.object({ id: v.string(), parentId: v.nullable(v.string()), role: v.string(), content: v.string() })), now.end.actorMessages);
    const four = rows.filter((row) => row.role === 'user' && row.content === 'four');
    // …the opening row exists once, not once per process that ran it;
    expect(four).toHaveLength(1);
    // …the steer acknowledged before the death lands under that same row and
    //    the answer under the steer — one chain, one answer;
    const steer = rows.find((row) => row.content === 'four-steer');
    expect(steer?.parentId).toBe(four[0]?.id);
    expect(rows.find((row) => row.role === 'assistant' && row.parentId === steer?.id)?.content).toBe('answer four again');
    // …and the continuation's model call carries the dead process's tool call
    //    with the result the ledger holds, then the steer, and asks for
    //    exactly the remaining call: the tool is not run again and the
    //    process makes one call for the re-opened turn and one for "five".
    const calls = v.parse(v.array(v.array(v.looseObject({ role: v.string(), parts: v.optional(v.array(v.looseObject({ type: v.string() }))) }))), now.restartedCalls);
    expect(calls).toHaveLength(2);
    const continuation = calls[0] ?? [];
    const fourAt = continuation.findIndex((message) => message.role === 'user' && message.parts?.some((part) => v.is(v.object({ text: v.literal('four') }), part)));
    expect(fourAt).toBeGreaterThan(-1);
    expect(continuation[fourAt + 1]).toMatchObject({ role: 'assistant', parts: [{ type: 'tool-call', toolName: 'fact' }] });
    expect(continuation[fourAt + 2]).toMatchObject({ role: 'tool', parts: [{ type: 'tool-result' }] });
    expect(continuation.filter((message) => message.role === 'user' && message.parts?.some((part) => v.is(v.object({ text: v.literal('four') }), part)))).toHaveLength(1);
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
