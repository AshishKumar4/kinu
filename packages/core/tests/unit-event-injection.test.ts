// EventInjectionBuffer — the live-turn half of the reactor's delivery: buffered
// drain batches splice into the next agentic step as ONE synthetic user
// message (stable at its entry index across steps), absorbed batch ids feed
// reply-channel dispatch at turn end, and batches that never saw a boundary
// come back as leftover for the standard enqueue path.
import { describe, test, expect } from 'bun:test';
import type { ModelMessage } from 'ai';
import { EventInjectionBuffer } from '../src/orchestrator/event-injection.js';
import type { MidTurnEventBatch } from '../src/types/backend-host.js';

const user = (text: string): ModelMessage => ({ role: 'user', content: text });
const assistant = (text: string): ModelMessage => ({ role: 'assistant', content: text });
const texts = (messages: ReadonlyArray<ModelMessage>) => messages.map((m) => m.content);
const batch = (turnId: string, brief: string): MidTurnEventBatch => ({
  turnId, stepText: `mid-turn: ${brief}`, turnText: `new-turn: ${brief}`,
});

describe('EventInjectionBuffer', () => {
  test('empty buffer → prepareStep changes nothing, settle reports nothing', () => {
    const buf = new EventInjectionBuffer();
    expect(buf.prepareStep({ stepNumber: 0, messages: [user('q')] })).toBeUndefined();
    expect(buf.settle()).toEqual({ absorbed: [], leftover: [] });
  });

  test('a buffered batch splices at the next step tail and stays at its entry index across steps', () => {
    const buf = new EventInjectionBuffer();
    const mail = batch('evt-1', 'mail from bob');
    buf.prepareStep({ stepNumber: 0, messages: [user('q')] });
    buf.push(mail);
    const step1 = buf.prepareStep({ stepNumber: 1, messages: [user('q'), assistant('a1')] });
    expect(texts(step1!)).toEqual(['q', 'a1', 'mid-turn: mail from bob']);
    // Later steps rebuild from scratch — the injection re-applies at the same
    // base-coordinate position, keeping the cached prefix stable.
    const step2 = buf.prepareStep({ stepNumber: 2, messages: [user('q'), assistant('a1'), assistant('a2')] });
    expect(texts(step2!)).toEqual(['q', 'a1', 'mid-turn: mail from bob', 'a2']);
    expect(buf.settle()).toEqual({ absorbed: [mail], leftover: [] });
  });

  test('batches buffered together merge into ONE user message; all count as absorbed', () => {
    const buf = new EventInjectionBuffer();
    buf.push(batch('evt-1', 'first'));
    buf.push(batch('evt-2', 'second'));
    const step0 = buf.prepareStep({ stepNumber: 0, messages: [user('q')] });
    expect(texts(step0!)).toEqual(['q', 'mid-turn: first\n\nmid-turn: second']);
    expect(buf.settle().absorbed.map((b) => b.turnId)).toEqual(['evt-1', 'evt-2']);
  });

  test('a batch that never saw a step boundary settles as leftover, not absorbed', () => {
    const buf = new EventInjectionBuffer();
    buf.prepareStep({ stepNumber: 0, messages: [user('q')] });
    const late = batch('evt-late', 'arrived at the final step');
    buf.push(late);
    expect(buf.settle()).toEqual({ absorbed: [], leftover: [late] });
    // Settle reset the state — the next turn starts clean.
    expect(buf.prepareStep({ stepNumber: 0, messages: [user('next')] })).toBeUndefined();
  });

  test('beginTurn drops splice state a dead turn leaked but keeps waiting batches for the new turn', () => {
    const buf = new EventInjectionBuffer();
    // Turn A absorbs one batch, then dies without settle (no response hook).
    buf.push(batch('evt-dead', 'seen by the dead turn'));
    buf.prepareStep({ stepNumber: 0, messages: [user('q'), user('pad'), user('pad2')] });
    // One more arrives after the crash, before the next turn.
    const waiting = batch('evt-waiting', 'still pending');
    buf.push(waiting);

    buf.beginTurn(false);
    const step0 = buf.prepareStep({ stepNumber: 0, messages: [user('q2')] });
    // Only the waiting batch injects — the dead turn's entry (recorded at
    // index 3, past this turn's array) is gone, and its absorbed id with it.
    expect(texts(step0!)).toEqual(['q2', 'mid-turn: still pending']);
    expect(buf.settle()).toEqual({ absorbed: [waiting], leftover: [] });
  });

  test('a CONTINUATION turn re-absorbs the just-settled batches (parity with the durable drain message)', () => {
    const buf = new EventInjectionBuffer();
    const mail = batch('evt-1', 'mail from bob');
    buf.push(mail);
    buf.prepareStep({ stepNumber: 0, messages: [user('q')] });
    expect(buf.settle().absorbed).toEqual([mail]);

    // Auto-continue / recovery: the batch rides into the continuation — the
    // model re-sees the event text and the fuller answer re-dispatches (a
    // settled reply channel no-ops, so this is idempotent).
    buf.beginTurn(true);
    const step0 = buf.prepareStep({ stepNumber: 0, messages: [user('q'), assistant('partial')] });
    expect(texts(step0!)).toEqual(['q', 'partial', 'mid-turn: mail from bob']);
    expect(buf.settle().absorbed).toEqual([mail]);

    // A REGULAR next turn drops the settled batches — their turn answered.
    buf.beginTurn(false);
    expect(buf.prepareStep({ stepNumber: 0, messages: [user('q2')] })).toBeUndefined();
    expect(buf.settle()).toEqual({ absorbed: [], leftover: [] });
  });
});
