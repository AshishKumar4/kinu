// Inbox: every signal reaches an agent at its next step; an idle agent gets a turn started.
import { describe, test, expect } from 'bun:test';
import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import { Inbox } from '../src/orchestrator/inbox';
import type { BackendHost, BroadcastEvent, ProgrammaticTurn } from '../src/types/backend-host';
import type { AgentSignal, SignalCardEvent } from '../src/types/signals';
import { JsonObjectSchema } from '../src/utils/json';
import { WORKSPACE_CREATED_EVENT, workspaceGenesisSignal } from '../src/identity/soul';
import { present } from '@kinu.run/test-utils';

const user = (text: string): ModelMessage => ({ role: 'user', content: text });

const assistant = (text: string): ModelMessage => ({ role: 'assistant', content: text });

const texts = (messages: ReadonlyArray<ModelMessage>) => messages.map((m) => m.content);

const SignalCardEventSchema: v.GenericSchema<SignalCardEvent> = v.variant('state', [
  v.object({
    type: v.literal('signal_card'),
    id: v.string(),
    state: v.literal('pending'),
    metadata: JsonObjectSchema,
    text: v.string(),
  }),
  v.object({
    type: v.literal('signal_card'),
    id: v.string(),
    state: v.picklist(['shown', 'undelivered']),
  }),
]);

function setup(opts: {
  turnInFlight?: boolean;
  enqueue?: 'queued' | 'skipped' | 'throw';
  /** Emulates an operator message admitted before the turn took its slot. */
  messageAdmitted?: boolean;
  /** Holds each enqueue open: the admission-to-opening window a real host has. */
  holdEnqueue?: boolean;
} = {}) {
  const queued: ProgrammaticTurn[] = [];
  const activity: Array<{ event: string; detail?: string }> = [];
  const cards: SignalCardEvent[] = [];
  const held: Array<() => void> = [];

  const host: BackendHost = {
    broadcast: (event: BroadcastEvent) => { cards.push(v.parse(SignalCardEventSchema, event)); },
    enqueueTurn: async (turn) => {
      queued.push(turn);

      if (opts.holdEnqueue === true) await new Promise<void>((resolve) => { held.push(resolve); });

      if (opts.enqueue === 'throw') throw new Error('queue unavailable');

      if (opts.enqueue === 'skipped') return { status: 'skipped' };

      if (opts.messageAdmitted === true && turn.yieldsToUserMessage === true) {
        return { status: 'yielded' };
      }

      return { status: 'queued' };
    },
    turnInFlight: () => opts.turnInFlight === true,
    setTimer: () => {},
  };

  const inbox = new Inbox(host, (event, detail) => activity.push({ event, detail }));

  return { inbox, queued, activity, cards, release: () => { for (const resolve of held.splice(0)) resolve(); } };
}

const lifecycle = (cards: readonly SignalCardEvent[]) => cards.map((c) => c.state);

const carriedSignalId = (turn: ProgrammaticTurn) => {
  const parsed = v.safeParse(v.string(), turn.metadata?.signalId);

  return parsed.success ? parsed.output : undefined;
};

const wake = (text: string, over: Partial<AgentSignal> = {}): AgentSignal => {
  const signal: AgentSignal = { kind: 'event_drain', text };

  return Object.assign(signal, over);
};

const nudge = (text: string): AgentSignal => ({ kind: 'turn_steering', text });

describe('Inbox — one delivery time: the next step', () => {
  test('a wake rides the live turn when one is running', async () => {
    const { inbox, queued, activity } = setup({ turnInFlight: true });
    expect(await inbox.send(wake('mail from bob', { stepText: 'mid-turn: mail' }))).toBe('mid-turn');
    expect(queued).toEqual([]);
    expect(activity).toEqual([{ event: 'signal_injected', detail: 'event_drain → live turn' }]);
    const step = present(await inbox.prepareStep({ stepNumber: 1, messages: [user('q'), assistant('a1')] }), 'the prepared step');
    expect(texts(step)).toEqual(['q', 'a1', 'mid-turn: mail']);
  });

  test('the SAME wake starts a turn when the agent is idle — one call site, both backends', async () => {
    const { inbox, queued, cards } = setup({ turnInFlight: false });
    expect(await inbox.send(wake('mail from bob', { stepText: 'mid-turn: mail' }))).toBe('queued');
    expect(await inbox.prepareStep({ stepNumber: 1, messages: [user('q')] })).toBeUndefined();
    expect(queued).toEqual([{
      text: 'mail from bob',
      idempotencyKey: cards[0].id,
      metadata: { kinuEvent: 'event_drain', kinuAuthor: 'harness', signalId: cards[0].id },
    }]);
  });

  test('a settled background job reaches the live turn instead of waiting for a new one', async () => {
    // A job queued behind its backgrounding turn would deliver a whole turn late.
    const busy = setup({ turnInFlight: true });
    expect(await busy.inbox.send({
      kind: 'background_job', text: 'job done',
      metadata: { jobId: 'bgjob-1', status: 'completed' },
    })).toBe('mid-turn');
    expect(busy.queued).toEqual([]);
    expect(texts(present(await busy.inbox.prepareStep({ stepNumber: 1, messages: [user('q')] }), 'the prepared step')))
      .toEqual(['q', 'job done']);

    const idle = setup({ turnInFlight: false });
    expect(await idle.inbox.send({
      kind: 'background_job', text: 'job done',
      metadata: { jobId: 'bgjob-1', status: 'completed' },
    })).toBe('queued');
    expect(idle.queued[0].metadata).toEqual({
      kinuEvent: 'background_job', kinuAuthor: 'harness', jobId: 'bgjob-1', status: 'completed',
      signalId: idle.cards[0].id,
    });
  });
  test('a producer cannot move its turn under another provenance or rebind its reply', async () => {
    // Producer metadata must not supply kinuEvent or drainTurnId, or it mislabels the turn or steals a reply.
    const idle = setup({ turnInFlight: false });
    expect(await idle.inbox.send({
      kind: 'background_job', text: 'job done', replyTurnId: 'real-turn',
      metadata: { kinuEvent: 'event_drain', drainTurnId: 'other-turn', jobId: 'bgjob-1' },
    })).toBe('queued');
    expect(idle.queued[0].metadata).toEqual({
      kinuEvent: 'background_job', drainTurnId: 'real-turn', kinuAuthor: 'harness',
      jobId: 'bgjob-1', signalId: idle.cards[0].id,
    });
  });

  test('a mode-bound signal rides the live turn whatever mode it runs under; the mode is a fact on the card', async () => {
    const { inbox, queued, cards } = setup({ turnInFlight: true });
    expect(await inbox.send(wake('plan result', { metadata: { kinuMode: 'plan' } }))).toBe('mid-turn');
    expect(await inbox.send(wake('other mission', { metadata: { missionLabels: ['gamma'] } }))).toBe('mid-turn');
    expect(queued).toEqual([]);
    expect(cards.map((card) => card.state === 'pending' ? card.metadata : card.state)).toEqual([
      { kinuEvent: 'event_drain', kinuAuthor: 'harness', kinuMode: 'plan' },
      { kinuEvent: 'event_drain', kinuAuthor: 'harness', missionLabels: ['gamma'] },
    ]);
    expect(texts(present(await inbox.prepareStep({ stepNumber: 1, messages: [user('q')] }), 'the prepared step')))
      .toEqual(['q', 'plan result\n\nother mission']);
  });

  test('sends that arrive while the turn the inbox started is still opening ride its first step', async () => {
    // Three sends at an idle agent are one turn; the rest wait for its first step.
    const { inbox, queued, release } = setup({ turnInFlight: false, holdEnqueue: true });
    const first = inbox.send(wake('first', { metadata: { jobId: 'a' } }));
    expect(await inbox.send(wake('second'))).toBe('mid-turn');
    expect(await inbox.send(wake('third'))).toBe('mid-turn');
    expect(queued.map((turn) => turn.text)).toEqual(['first']);

    inbox.beginTurn(false);
    expect(texts(present(await inbox.prepareStep({ stepNumber: 0, messages: [user('first')] }), 'the prepared step')))
      .toEqual(['first', 'second\n\nthird']);
    release();
    expect(await first).toBe('queued');
    expect(queued).toHaveLength(1);
  });

  test('a turn the host never opened does not strand what waited for it', async () => {
    // A refused start leaves no turn coming, so the queued sends are redelivered.
    const { inbox, queued, release } = setup({ turnInFlight: false, holdEnqueue: true, enqueue: 'skipped' });
    const first = inbox.send(wake('first'));
    expect(await inbox.send(wake('second'))).toBe('mid-turn');
    release();
    expect(await first).toBe('undelivered');
    await Promise.resolve();
    expect(queued.map((turn) => turn.text)).toEqual(['first', 'second']);
  });

  test("the step's own steering is handed to the step, never delivered", async () => {
    // The delegation nudge is decided inside the step pipeline and is never a wake.
    const { inbox, queued, activity } = setup({ turnInFlight: false });
    expect(texts(present(await inbox.prepareStep({ stepNumber: 0, messages: [user('q')] }, [nudge('fork now')]), 'the prepared step')))
      .toEqual(['q', 'fork now']);
    expect(queued).toEqual([]);
    expect(activity).toEqual([]);
  });

  test('the reply turn id crosses whichever mechanism won', async () => {
    const mid = setup({ turnInFlight: true });
    await mid.inbox.send(wake('drain', { replyTurnId: 'evt-1' }));
    await mid.inbox.prepareStep({ stepNumber: 0, messages: [user('q')] });
    expect(mid.inbox.settle({ completed: true }).absorbed.map((s) => s.replyTurnId)).toEqual(['evt-1']);

    const queuedPath = setup({ turnInFlight: false });
    await queuedPath.inbox.send(wake('drain', { replyTurnId: 'evt-1' }));
    expect(queuedPath.queued[0].metadata).toEqual({
      kinuEvent: 'event_drain', kinuAuthor: 'harness', drainTurnId: 'evt-1', signalId: queuedPath.cards[0].id,
    });
  });
});

describe('Inbox — the user\'s card', () => {
  test('a spliced signal opens a card when it ARRIVES and flips when the step takes it', async () => {
    const { inbox, cards } = setup({ turnInFlight: true });
    await inbox.send(wake('turn text', { stepText: 'mid-turn: mail from bob' }));

    expect(cards).toHaveLength(1);
    const opened = cards[0];
    expect(opened).toMatchObject({
      type: 'signal_card', state: 'pending',
      metadata: { kinuEvent: 'event_drain', kinuAuthor: 'harness' },
      text: 'mid-turn: mail from bob',
    });
    expect(opened.id.length).toBeGreaterThan(0);

    await inbox.prepareStep({ stepNumber: 0, messages: [user('q')] });
    expect(lifecycle(cards)).toEqual(['pending', 'shown']);
    expect(cards[1]).toEqual({ type: 'signal_card', id: opened.id, state: 'shown' });
    await inbox.prepareStep({ stepNumber: 1, messages: [user('q'), assistant('a')] });
    expect(lifecycle(cards)).toEqual(['pending', 'shown']);
  });

  test('a queued signal opens the same card, and the turn it starts flips it', async () => {
    const { inbox, queued, cards } = setup({ turnInFlight: false });
    await inbox.send(wake('1 event arrived while you were idle'));

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ state: 'pending', text: '1 event arrived while you were idle' });

    const carried = carriedSignalId(queued[0]);
    expect(carried).toBe(cards[0].id);
    inbox.beginTurn(false, carried);
    expect(lifecycle(cards)).toEqual(['pending', 'shown']);
    expect(cards[1]).toEqual({ type: 'signal_card', id: cards[0].id, state: 'shown' });
  });

  test('a turn nothing delivered flips no card', async () => {
    const { inbox, cards } = setup({ turnInFlight: false });
    inbox.beginTurn(false, undefined);
    expect(cards).toEqual([]);
  });

  test('the turn\'s own steering never gets a card — nothing arrived', async () => {
    const { inbox, cards } = setup({ turnInFlight: true });
    await inbox.prepareStep({ stepNumber: 0, messages: [user('q')] }, [nudge('fork now')]);
    expect(cards).toEqual([]);
  });

  test('a signal that never landed takes its card away', async () => {
    const { inbox, cards } = setup({ turnInFlight: false, enqueue: 'skipped' });
    expect(await inbox.send(wake('drain'))).toBe('undelivered');
    expect(lifecycle(cards)).toEqual(['pending', 'undelivered']);
    expect(cards[1].id).toBe(cards[0].id);
  });

  test('a re-delivered signal keeps its card and returns it to pending', async () => {
    const { inbox, cards } = setup({ turnInFlight: true });
    await inbox.send(wake('seen but unanswered'));
    await inbox.prepareStep({ stepNumber: 0, messages: [user('q')] });
    inbox.settle({ completed: false });
    await Promise.resolve();
    expect(lifecycle(cards)).toEqual(['pending', 'shown', 'pending']);
    expect(new Set(cards.map((c) => c.id)).size).toBe(1);
  });

  test('one card per signal, whatever else shares the step', async () => {
    const { inbox, cards } = setup({ turnInFlight: true });
    await inbox.send(wake('t1', { stepText: 'first' }));
    await inbox.send({ kind: 'background_job', text: 't2', metadata: { status: 'completed' } });
    await inbox.prepareStep({ stepNumber: 0, messages: [user('q')] }, [nudge('fork now')]);
    expect(lifecycle(cards)).toEqual(['pending', 'pending', 'shown', 'shown']);
    expect(cards.map((c) => c.id)).toEqual([cards[0].id, cards[1].id, cards[0].id, cards[1].id]);
  });
});

describe('Inbox — the mid-turn splice', () => {
  test('a spliced signal stays at its entry index across steps', async () => {
    const { inbox } = setup({ turnInFlight: true });
    await inbox.prepareStep({ stepNumber: 0, messages: [user('q')] });
    await inbox.send(wake('turn text', { stepText: 'mid-turn: mail from bob' }));
    const step1 = present(await inbox.prepareStep({ stepNumber: 1, messages: [user('q'), assistant('a1')] }), 'the prepared step');
    expect(texts(step1)).toEqual(['q', 'a1', 'mid-turn: mail from bob']);

    // Re-applies at the same base-coordinate position, keeping the cached prefix stable.
    const step2 = present(await inbox.prepareStep({
      stepNumber: 2, messages: [user('q'), assistant('a1'), assistant('a2')],
    }), 'the prepared step');

    expect(texts(step2)).toEqual(['q', 'a1', 'mid-turn: mail from bob', 'a2']);
  });

  test('signals buffered together merge into ONE user message; all count as absorbed', async () => {
    const { inbox } = setup({ turnInFlight: true });
    await inbox.send(wake('t1', { stepText: 'first', replyTurnId: 'evt-1' }));
    await inbox.send(wake('t2', { stepText: 'second', replyTurnId: 'evt-2' }));
    const step0 = present(await inbox.prepareStep({ stepNumber: 0, messages: [user('q')] }, [nudge('fork now')]), 'the prepared step');
    expect(texts(step0)).toEqual(['q', 'first\n\nsecond\n\nfork now']);
    expect(inbox.settle({ completed: true }).absorbed.map((s) => s.text))
      .toEqual(['t1', 't2']);
  });

  test('a signal with no stepText splices its turn text', async () => {
    const { inbox } = setup({ turnInFlight: true });
    await inbox.send(wake('only one rendering'));
    expect(texts(present(await inbox.prepareStep({ stepNumber: 0, messages: [user('q')] }), 'the prepared step')))
      .toEqual(['q', 'only one rendering']);
  });
});

describe('Inbox — settlement', () => {
  test('an ordinary requeue uses the original server card as its durable identity', async () => {
    const { inbox, queued, cards } = setup({ turnInFlight: true });
    await inbox.send(wake('late ordinary signal'));
    inbox.settle({ completed: true });
    await Promise.resolve();

    expect(queued[0]?.idempotencyKey).toBe(cards[0]?.id);
    expect(queued[0]?.metadata?.signalId).toBe(cards[0]?.id);
  });

  test('a signal that never reached a step boundary re-delivers as a queued turn', async () => {
    const { inbox, queued, cards } = setup({ turnInFlight: true });
    await inbox.prepareStep({ stepNumber: 0, messages: [user('q')] });
    await inbox.send(wake('arrived at the final step', { replyTurnId: 'evt-late' }));
    expect(inbox.settle({ completed: true }).absorbed).toEqual([]);
    await Promise.resolve();
    expect(queued).toEqual([{
      text: 'arrived at the final step',
      idempotencyKey: cards[0].id,
      metadata: { kinuEvent: 'event_drain', kinuAuthor: 'harness', drainTurnId: 'evt-late', signalId: cards[0].id },
    }]);
    expect(await inbox.prepareStep({ stepNumber: 0, messages: [user('next')] })).toBeUndefined();
  });

  test('a re-delivery that cannot queue compensates with the producer\'s own callback', async () => {
    const { inbox, queued } = setup({ turnInFlight: true, enqueue: 'skipped' });
    const reasons: string[] = [];
    await inbox.send(wake('never seen', { compensate: (r) => reasons.push(r) }));
    inbox.settle({ completed: true });
    await Promise.resolve();
    expect(queued).toHaveLength(1);
    expect(reasons).toEqual(['preempted']);
  });

  test('an ABORTED turn re-delivers what it had already absorbed — its answer is gone', async () => {
    const { inbox, queued } = setup({ turnInFlight: true });
    await inbox.send(wake('seen but unanswered'));
    await inbox.prepareStep({ stepNumber: 0, messages: [user('q')] });
    inbox.settle({ completed: false });
    await Promise.resolve();
    expect(queued.map((t) => t.text)).toEqual(['seen but unanswered']);
  });

  test('an ABORTED turn does not resurrect its own steering as a turn', async () => {
    const { inbox, queued } = setup({ turnInFlight: true });
    await inbox.prepareStep({ stepNumber: 0, messages: [user('q')] }, [nudge('fork now')]);
    inbox.settle({ completed: false });
    await Promise.resolve();
    expect(queued).toEqual([]);                    // a nudge at a dead turn is noise
  });

  test('an undeliverable queued signal compensates, once, with the reason', async () => {
    const preempted = setup({ turnInFlight: false, enqueue: 'skipped' });
    const reasons: string[] = [];
    expect(await preempted.inbox.send(wake('drain', { compensate: (r) => reasons.push(r) })))
      .toBe('undelivered');
    expect(reasons).toEqual(['preempted']);

    const failed = setup({ turnInFlight: false, enqueue: 'throw' });
    const failures: string[] = [];
    expect(await failed.inbox.send(wake('drain', { compensate: (r) => failures.push(r) })))
      .toBe('undelivered');
    expect(failures).toEqual(['failed']);
  });

  test('a compensation that itself fails surfaces, and is not re-entered as an enqueue failure', async () => {
    // A throwing compensation must reach the producer once, not trigger a second compensation.
    const { inbox } = setup({ turnInFlight: false, enqueue: 'skipped' });
    const reasons: string[] = [];

    const attempt = inbox.send(wake('drain', {
      compensate: (reason) => { reasons.push(reason); throw new Error('retry publish failed'); },
    }));

    await expect(attempt).rejects.toThrow('retry publish failed');
    expect(reasons).toEqual(['preempted']);
  });
});

describe('Inbox — turn boundaries', () => {
  test('beginTurn drops splice state a dead turn leaked but keeps waiting signals', async () => {
    const { inbox } = setup({ turnInFlight: true });
    await inbox.send(wake('t-dead', { stepText: 'seen by the dead turn' }));
    await inbox.prepareStep({ stepNumber: 0, messages: [user('q'), user('pad'), user('pad2')] });
    await inbox.send(wake('t-waiting', { stepText: 'still pending' }));

    inbox.beginTurn(false);
    const step0 = present(await inbox.prepareStep({ stepNumber: 0, messages: [user('q2')] }), 'the prepared step');
    expect(texts(step0)).toEqual(['q2', 'still pending']);
    expect(inbox.settle({ completed: true }).absorbed.map((s) => s.text)).toEqual(['t-waiting']);
  });

  test('a CONTINUATION turn re-absorbs the just-settled signals; a regular turn drops them', async () => {
    const { inbox } = setup({ turnInFlight: true });
    await inbox.send(wake('t1', { stepText: 'mail from bob' }));
    await inbox.prepareStep({ stepNumber: 0, messages: [user('q')] });
    expect(inbox.settle({ completed: true }).absorbed.map((s) => s.text)).toEqual(['t1']);

    // A settled reply channel no-ops, so re-dispatch on continuation is idempotent.
    inbox.beginTurn(true);
    const step0 = present(await inbox.prepareStep({ stepNumber: 0, messages: [user('q'), assistant('partial')] }), 'the prepared step');
    expect(texts(step0)).toEqual(['q', 'partial', 'mail from bob']);
    expect(inbox.settle({ completed: true }).absorbed.map((s) => s.text)).toEqual(['t1']);

    inbox.beginTurn(false);
    expect(await inbox.prepareStep({ stepNumber: 0, messages: [user('q2')] })).toBeUndefined();
    expect(inbox.settle({ completed: true }).absorbed).toEqual([]);
  });

  test('a non-completed turn retains nothing for a continuation', async () => {
    const { inbox } = setup({ turnInFlight: true });
    await inbox.send(wake('t-aborted', { stepText: 'mail from bob' }));
    await inbox.prepareStep({ stepNumber: 0, messages: [user('q')] });
    expect(inbox.settle({ completed: false }).absorbed.map((s) => s.text)).toEqual(['t-aborted']);

    inbox.beginTurn(true);
    expect(await inbox.prepareStep({ stepNumber: 0, messages: [user('continued')] })).toBeUndefined();
  });
});

describe('the workspace genesis signal', () => {
  test('an idle new workspace turns it into its own turn', async () => {
    const { inbox, queued } = setup({ turnInFlight: false });
    const genesis = present(workspaceGenesisSignal('Audit the OAuth callback flow.'), 'the workspace genesis signal');

    expect(await inbox.send(genesis)).toBe('queued');
    expect(queued).toHaveLength(1);
    expect(queued[0].metadata?.kinuEvent).toBe(WORKSPACE_CREATED_EVENT);
  });

  test('when a turn raced it, it rides that turn\'s next step like any other message', async () => {
    const { inbox, queued } = setup({ turnInFlight: true });
    const genesis = present(workspaceGenesisSignal('Audit the OAuth callback flow.'), 'the workspace genesis signal');

    expect(await inbox.send(genesis)).toBe('mid-turn');
    expect(queued).toEqual([]);
    expect(texts(present(await inbox.prepareStep({ stepNumber: 0, messages: [user('the racing turn')] }), 'the prepared step')))
      .toEqual(['the racing turn', genesis.text]);
  });

  test('the genesis offer yields to an operator message admitted before its slot', async () => {
    const { inbox, queued, cards } = setup({ turnInFlight: false, messageAdmitted: true });
    const genesis = present(workspaceGenesisSignal('Audit the OAuth callback flow.'), 'the workspace genesis signal');

    expect(await inbox.send(genesis)).toBe('yielded');
    expect(queued).toHaveLength(1);
    expect(queued[0].yieldsToUserMessage).toBe(true);
    expect(queued[0].metadata?.kinuEvent).toBe(WORKSPACE_CREATED_EVENT);
    expect(queued[0].idempotencyKey).toBeUndefined();
    expect(lifecycle(cards)).toEqual(['pending', 'undelivered']);
  });

  test('an admitted message does not consume a turn that was never offered', async () => {
    const { inbox, queued } = setup({ turnInFlight: false, messageAdmitted: true });

    expect(await inbox.send(wake('mail from bob'))).toBe('queued');
    expect(queued[0].yieldsToUserMessage).toBeUndefined();
  });

  test('the genesis offer with nobody speaking still takes its own turn', async () => {
    const { inbox, queued } = setup({ turnInFlight: false });
    const genesis = present(workspaceGenesisSignal('Audit the OAuth callback flow.'), 'the workspace genesis signal');

    expect(await inbox.send(genesis)).toBe('queued');
    expect(queued[0].yieldsToUserMessage).toBe(true);
  });

  test('a workspace created with no mission has no first turn to take', () => {
    expect(workspaceGenesisSignal('Help the user with the work they assign.')).toBeNull();
    expect(workspaceGenesisSignal('')).toBeNull();
    expect(workspaceGenesisSignal(null)).toBeNull();
  });
});
