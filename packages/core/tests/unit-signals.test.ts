// SignalDelivery — the ONE way anything asynchronous reaches a running agent,
// at the ONE time anything reaches it: its next step. A producer states intent
// and nothing else; starting a turn is what "next step" means to an idle
// agent. Verified through the public seam (deliver / prepareStep / settle /
// beginTurn) against a fake BackendHost.
import { describe, test, expect } from 'bun:test';
import type { ModelMessage } from 'ai';
import { SignalDelivery } from '../src/orchestrator/signals.js';
import type { BackendHost, ProgrammaticTurn } from '../src/types/backend-host.js';
import type { AgentSignal } from '../src/types/signals.js';

const user = (text: string): ModelMessage => ({ role: 'user', content: text });
const assistant = (text: string): ModelMessage => ({ role: 'assistant', content: text });
const texts = (messages: ReadonlyArray<ModelMessage>) => messages.map((m) => m.content);

function setup(opts: { turnInFlight?: boolean; enqueue?: 'queued' | 'skipped' | 'throw' } = {}) {
  const queued: ProgrammaticTurn[] = [];
  const activity: Array<{ event: string; detail?: string }> = [];
  const host: BackendHost = {
    broadcast: () => {},
    enqueueTurn: async (turn) => {
      queued.push(turn);
      if (opts.enqueue === 'throw') throw new Error('queue unavailable');
      return { status: opts.enqueue === 'skipped' ? 'skipped' : 'queued' };
    },
    turnInFlight: () => opts.turnInFlight === true,
    setTimer: () => {},
  };
  const signals = new SignalDelivery(host, (event, detail) => activity.push({ event, detail }));
  return { signals, queued, activity };
}

const wake = (text: string, over: Partial<AgentSignal> = {}): AgentSignal =>
  ({ kind: 'event_drain', text, ...over });

const nudge = (text: string): AgentSignal => ({ kind: 'delegation_nudge', text });

describe('SignalDelivery — one delivery time: the next step', () => {
  test('a wake rides the live turn when one is running', async () => {
    const { signals, queued, activity } = setup({ turnInFlight: true });
    expect(await signals.deliver(wake('mail from bob', { stepText: 'mid-turn: mail' }))).toBe('mid-turn');
    expect(queued).toEqual([]);
    expect(activity).toEqual([{ event: 'signal_injected', detail: 'event_drain → live turn' }]);
    const step = signals.prepareStep({ stepNumber: 1, messages: [user('q'), assistant('a1')] });
    expect(texts(step!)).toEqual(['q', 'a1', 'mid-turn: mail']);
  });

  test('the SAME wake starts a turn when the agent is idle — one call site, both backends', async () => {
    const { signals, queued } = setup({ turnInFlight: false });
    expect(await signals.deliver(wake('mail from bob', { stepText: 'mid-turn: mail' }))).toBe('queued');
    expect(signals.prepareStep({ stepNumber: 1, messages: [user('q')] })).toBeUndefined();
    expect(queued).toEqual([{ text: 'mail from bob', metadata: { proteusEvent: 'event_drain' } }]);
  });

  test('a settled background job reaches the live turn instead of waiting for a new one', async () => {
    // The regression this collapse fixes: the job used to queue behind the
    // turn that backgrounded it, so its result arrived a whole turn late.
    const busy = setup({ turnInFlight: true });
    expect(await busy.signals.deliver({
      kind: 'background_job', text: 'job done',
      metadata: { jobId: 'bgjob-1', status: 'completed' },
    })).toBe('mid-turn');
    expect(busy.queued).toEqual([]);
    expect(texts(busy.signals.prepareStep({ stepNumber: 1, messages: [user('q')] })!))
      .toEqual(['q', 'job done']);

    // Idle: no next step exists, so delivery makes one. Metadata rides it.
    const idle = setup({ turnInFlight: false });
    expect(await idle.signals.deliver({
      kind: 'background_job', text: 'job done',
      metadata: { jobId: 'bgjob-1', status: 'completed' },
    })).toBe('queued');
    expect(idle.queued[0]!.metadata).toEqual({
      proteusEvent: 'background_job', jobId: 'bgjob-1', status: 'completed',
    });
  });

  test("the step's own steering is handed to the step, never delivered", async () => {
    // The delegation nudge is decided INSIDE the step pipeline, so it rides
    // that step even on a backend where nothing is in flight to ask about, and
    // it is not a wake — no activity line, no queue, ever.
    const { signals, queued, activity } = setup({ turnInFlight: false });
    expect(texts(signals.prepareStep({ stepNumber: 0, messages: [user('q')] }, [nudge('fork now')])!))
      .toEqual(['q', 'fork now']);
    expect(queued).toEqual([]);
    expect(activity).toEqual([]);
  });

  test('the reply turn id crosses whichever mechanism won', async () => {
    const mid = setup({ turnInFlight: true });
    await mid.signals.deliver(wake('drain', { replyTurnId: 'evt-1' }));
    mid.signals.prepareStep({ stepNumber: 0, messages: [user('q')] });
    expect(mid.signals.settle({ completed: true }).absorbed.map((s) => s.replyTurnId)).toEqual(['evt-1']);

    const queuedPath = setup({ turnInFlight: false });
    await queuedPath.signals.deliver(wake('drain', { replyTurnId: 'evt-1' }));
    expect(queuedPath.queued[0]!.metadata).toEqual({ proteusEvent: 'event_drain', drainTurnId: 'evt-1' });
  });
});

describe('SignalDelivery — the mid-turn splice', () => {
  test('a spliced signal stays at its entry index across steps', async () => {
    const { signals } = setup({ turnInFlight: true });
    signals.prepareStep({ stepNumber: 0, messages: [user('q')] });
    await signals.deliver(wake('turn text', { stepText: 'mid-turn: mail from bob' }));
    const step1 = signals.prepareStep({ stepNumber: 1, messages: [user('q'), assistant('a1')] });
    expect(texts(step1!)).toEqual(['q', 'a1', 'mid-turn: mail from bob']);
    // Later steps rebuild from scratch — the injection re-applies at the same
    // base-coordinate position, keeping the cached prefix stable.
    const step2 = signals.prepareStep({
      stepNumber: 2, messages: [user('q'), assistant('a1'), assistant('a2')],
    });
    expect(texts(step2!)).toEqual(['q', 'a1', 'mid-turn: mail from bob', 'a2']);
  });

  test('signals buffered together merge into ONE user message; all count as absorbed', async () => {
    const { signals } = setup({ turnInFlight: true });
    await signals.deliver(wake('t1', { stepText: 'first', replyTurnId: 'evt-1' }));
    await signals.deliver(wake('t2', { stepText: 'second', replyTurnId: 'evt-2' }));
    const step0 = signals.prepareStep({ stepNumber: 0, messages: [user('q')] }, [nudge('fork now')]);
    expect(texts(step0!)).toEqual(['q', 'first\n\nsecond\n\nfork now']);
    // Only what was DELIVERED settles — steering has no life past its step.
    expect(signals.settle({ completed: true }).absorbed.map((s) => s.text))
      .toEqual(['t1', 't2']);
  });

  test('a signal with no stepText splices its turn text', async () => {
    const { signals } = setup({ turnInFlight: true });
    await signals.deliver(wake('only one rendering'));
    expect(texts(signals.prepareStep({ stepNumber: 0, messages: [user('q')] })!))
      .toEqual(['q', 'only one rendering']);
  });
});

describe('SignalDelivery — settlement', () => {
  test('a signal that never reached a step boundary re-delivers as a queued turn', async () => {
    const { signals, queued } = setup({ turnInFlight: true });
    signals.prepareStep({ stepNumber: 0, messages: [user('q')] });
    await signals.deliver(wake('arrived at the final step', { replyTurnId: 'evt-late' }));
    expect(signals.settle({ completed: true }).absorbed).toEqual([]);
    await Promise.resolve();
    expect(queued).toEqual([{
      text: 'arrived at the final step',
      metadata: { proteusEvent: 'event_drain', drainTurnId: 'evt-late' },
    }]);
    // Settle reset the state — the next turn starts clean.
    expect(signals.prepareStep({ stepNumber: 0, messages: [user('next')] })).toBeUndefined();
  });

  test('a re-delivery that cannot queue compensates with the producer\'s own callback', async () => {
    // The leftover path carries the signal whole, so the compensation the
    // producer attached at deliver() time still runs a turn later.
    const { signals, queued } = setup({ turnInFlight: true, enqueue: 'skipped' });
    const reasons: string[] = [];
    await signals.deliver(wake('never seen', { compensate: (r) => reasons.push(r) }));
    signals.settle({ completed: true });
    await Promise.resolve();
    expect(queued).toHaveLength(1);
    expect(reasons).toEqual(['preempted']);
  });

  test('an ABORTED turn re-delivers what it had already absorbed — its answer is gone', async () => {
    const { signals, queued } = setup({ turnInFlight: true });
    await signals.deliver(wake('seen but unanswered'));
    signals.prepareStep({ stepNumber: 0, messages: [user('q')] });
    signals.settle({ completed: false });
    await Promise.resolve();
    expect(queued.map((t) => t.text)).toEqual(['seen but unanswered']);
  });

  test('an ABORTED turn does not resurrect its own steering as a turn', async () => {
    const { signals, queued } = setup({ turnInFlight: true });
    signals.prepareStep({ stepNumber: 0, messages: [user('q')] }, [nudge('fork now')]);
    signals.settle({ completed: false });
    await Promise.resolve();
    expect(queued).toEqual([]);                    // a nudge at a dead turn is noise
  });

  test('an undeliverable queued signal compensates, once, with the reason', async () => {
    const preempted = setup({ turnInFlight: false, enqueue: 'skipped' });
    const reasons: string[] = [];
    expect(await preempted.signals.deliver(wake('drain', { compensate: (r) => reasons.push(r) })))
      .toBe('undelivered');
    expect(reasons).toEqual(['preempted']);

    const failed = setup({ turnInFlight: false, enqueue: 'throw' });
    const failures: string[] = [];
    expect(await failed.signals.deliver(wake('drain', { compensate: (r) => failures.push(r) })))
      .toBe('undelivered');
    expect(failures).toEqual(['failed']);
  });

  test('a compensation that itself fails surfaces, and is not re-entered as an enqueue failure', async () => {
    // The background-job wake compensates by publishing a durable retry event
    // and reports a failed publish by throwing. That must reach the producer
    // once — not be swallowed into a second 'failed' compensation.
    const { signals } = setup({ turnInFlight: false, enqueue: 'skipped' });
    const reasons: string[] = [];
    const attempt = signals.deliver(wake('drain', {
      compensate: (reason) => { reasons.push(reason); throw new Error('retry publish failed'); },
    }));
    await expect(attempt).rejects.toThrow('retry publish failed');
    expect(reasons).toEqual(['preempted']);
  });
});

describe('SignalDelivery — turn boundaries', () => {
  test('beginTurn drops splice state a dead turn leaked but keeps waiting signals', async () => {
    const { signals } = setup({ turnInFlight: true });
    // Turn A absorbs one signal, then dies without settle (no response hook).
    await signals.deliver(wake('t-dead', { stepText: 'seen by the dead turn' }));
    signals.prepareStep({ stepNumber: 0, messages: [user('q'), user('pad'), user('pad2')] });
    // One more arrives after the crash, before the next turn.
    await signals.deliver(wake('t-waiting', { stepText: 'still pending' }));

    signals.beginTurn(false);
    const step0 = signals.prepareStep({ stepNumber: 0, messages: [user('q2')] });
    // Only the waiting signal injects — the dead turn's entry (recorded at
    // index 3, past this turn's array) is gone, and its absorbed record with it.
    expect(texts(step0!)).toEqual(['q2', 'still pending']);
    expect(signals.settle({ completed: true }).absorbed.map((s) => s.text)).toEqual(['t-waiting']);
  });

  test('a CONTINUATION turn re-absorbs the just-settled signals; a regular turn drops them', async () => {
    const { signals } = setup({ turnInFlight: true });
    await signals.deliver(wake('t1', { stepText: 'mail from bob' }));
    signals.prepareStep({ stepNumber: 0, messages: [user('q')] });
    expect(signals.settle({ completed: true }).absorbed.map((s) => s.text)).toEqual(['t1']);

    // Auto-continue / recovery: the signal rides into the continuation — the
    // model re-sees the text and the fuller answer re-dispatches (a settled
    // reply channel no-ops, so this is idempotent).
    signals.beginTurn(true);
    const step0 = signals.prepareStep({ stepNumber: 0, messages: [user('q'), assistant('partial')] });
    expect(texts(step0!)).toEqual(['q', 'partial', 'mail from bob']);
    expect(signals.settle({ completed: true }).absorbed.map((s) => s.text)).toEqual(['t1']);

    // A REGULAR next turn drops the settled signals — their turn answered.
    signals.beginTurn(false);
    expect(signals.prepareStep({ stepNumber: 0, messages: [user('q2')] })).toBeUndefined();
    expect(signals.settle({ completed: true }).absorbed).toEqual([]);
  });

  test('a non-completed turn retains nothing for a continuation', async () => {
    const { signals } = setup({ turnInFlight: true });
    await signals.deliver(wake('t-aborted', { stepText: 'mail from bob' }));
    signals.prepareStep({ stepNumber: 0, messages: [user('q')] });
    expect(signals.settle({ completed: false }).absorbed.map((s) => s.text)).toEqual(['t-aborted']);

    signals.beginTurn(true);
    expect(signals.prepareStep({ stepNumber: 0, messages: [user('continued')] })).toBeUndefined();
  });
});
