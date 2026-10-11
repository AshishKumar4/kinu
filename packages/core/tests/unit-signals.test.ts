// Inbox: a delivery reaches a running turn at its next step; with none running the Inbox opens no turn for it, its chat
// queues it as a turn of its own (design v2 §1). What a turn leaves unread re-delivers as a turn of its own.
import { describe, test, expect } from 'bun:test';
import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import { Inbox } from '../src/orchestrator/inbox';
import type { BackendHost, BroadcastEvent, ProgrammaticTurn } from '../src/types/backend-host';
import { USER_MESSAGE_SIGNAL_KIND, type AgentSignal, type SignalCardEvent } from '../src/types/signals';
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
    state: v.literal('shown'),
    atStep: v.optional(v.number()),
  }),
  v.object({
    type: v.literal('signal_card'),
    id: v.string(),
    state: v.picklist(['seen', 'undelivered']),
  }),
]);

function setup(opts: {
  turnInFlight?: boolean;
  enqueue?: 'queued' | 'skipped' | 'failed' | 'throw';
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
    // A person's words move no card: only cards are recorded.
    broadcast: (event: BroadcastEvent) => { if (event.type === 'signal_card') cards.push(v.parse(SignalCardEventSchema, event)); },
    enqueueTurn: async (turn) => {
      queued.push(turn);

      if (opts.holdEnqueue === true) await new Promise<void>((resolve) => { held.push(resolve); });

      if (opts.enqueue === 'throw') throw new Error('queue unavailable');

      if (opts.enqueue === 'skipped') return { status: 'skipped' };

      if (opts.enqueue === 'failed') return { status: 'failed', reason: 'the provider refused the request (HTTP 429)' };

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

const wake = (text: string, over: Partial<AgentSignal> = {}): AgentSignal => {
  const signal: AgentSignal = { kind: 'event_drain', text };

  return Object.assign(signal, over);
};

const nudge = (text: string): AgentSignal => ({ kind: 'turn_steering', text });

const words = (id: string, text: string) => ({ kind: USER_MESSAGE_SIGNAL_KIND, text, user: { id, mode: 'build' as const } });

/** A turn that read nothing ends: what it left unread re-delivers. */
async function settledUnread(inbox: Inbox): Promise<void> {
  inbox.settle({ completed: true });
  await Promise.resolve();
  await Promise.resolve();
}

describe('Inbox — one delivery time: the next step', () => {
  test('a wake rides the live turn when one is running', async () => {
    const { inbox, queued, activity } = setup({ turnInFlight: true });
    expect(inbox.landMidTurn(wake('mail from bob', { stepText: 'mid-turn: mail' }))).toBe(true);
    expect(queued).toEqual([]);
    expect(activity).toEqual([{ event: 'signal_injected', detail: 'event_drain -> live turn' }]);
    const step = present(await inbox.prepareStep({ stepNumber: 1, messages: [user('q'), assistant('a1')] }), 'the prepared step');
    expect(texts(step)).toEqual(['q', 'a1', 'mid-turn: mail']);
  });

  test('the SAME wake at an idle agent is its chat\'s to queue: the inbox opens no turn and holds nothing', async () => {
    const { inbox, queued, cards } = setup({ turnInFlight: false });
    expect(inbox.landMidTurn(wake('mail from bob', { stepText: 'mid-turn: mail' }))).toBe(false);
    expect(await inbox.prepareStep({ stepNumber: 1, messages: [user('q')] })).toBeUndefined();
    expect(queued).toEqual([]);
    expect(cards).toEqual([]);
  });

  test('a settled background job reaches the live turn instead of waiting for a new one', async () => {
    // A job queued behind its backgrounding turn would deliver a whole turn late.
    const busy = setup({ turnInFlight: true });
    expect(busy.inbox.landMidTurn({
      kind: 'background_job', text: 'job done',
      metadata: { jobId: 'bgjob-1', status: 'completed' },
    })).toBe(true);
    expect(busy.queued).toEqual([]);
    expect(texts(present(await busy.inbox.prepareStep({ stepNumber: 1, messages: [user('q')] }), 'the prepared step')))
      .toEqual(['q', 'job done']);
  });

  test('a producer cannot move its turn under another provenance or rebind its reply', async () => {
    // Producer metadata must not supply kinuEvent or drainTurnId, or it mislabels the turn or steals a reply: what a turn
    // left unread re-delivers under its own.
    const busy = setup({ turnInFlight: true });
    busy.inbox.landMidTurn({
      kind: 'background_job', text: 'job done', replyTurnId: 'real-turn',
      metadata: { kinuEvent: 'event_drain', drainTurnId: 'other-turn', jobId: 'bgjob-1' },
    });
    await settledUnread(busy.inbox);
    expect(busy.queued[0].metadata).toEqual({
      kinuEvent: 'background_job', drainTurnId: 'real-turn', kinuAuthor: 'harness',
      jobId: 'bgjob-1', signalId: busy.cards[0].id,
    });
  });

  test('a mode-bound signal rides the live turn whatever mode it runs under; the mode is a fact on the card', async () => {
    const { inbox, queued, cards } = setup({ turnInFlight: true });
    expect(inbox.landMidTurn(wake('plan result', { metadata: { kinuMode: 'plan' } }))).toBe(true);
    expect(inbox.landMidTurn(wake('other mission', { metadata: { missionLabels: ['gamma'] } }))).toBe(true);
    expect(queued).toEqual([]);
    expect(cards.map((card) => card.state === 'pending' ? card.metadata : card.state)).toEqual([
      { kinuEvent: 'event_drain', kinuAuthor: 'harness', kinuMode: 'plan' },
      { kinuEvent: 'event_drain', kinuAuthor: 'harness', missionLabels: ['gamma'] },
    ]);
    expect(texts(present(await inbox.prepareStep({ stepNumber: 1, messages: [user('q')] }), 'the prepared step')))
      .toEqual(['q', 'plan result\n\nother mission']);
  });

  test('deliveries that arrive while the turn the inbox started is still opening ride its first step', async () => {
    // A person's words at an idle agent open its turn; what arrives as it opens waits for its first step.
    const { inbox, queued, release } = setup({ turnInFlight: false, holdEnqueue: true });
    const first = inbox.send(words('w-1', 'first'));
    expect(inbox.landMidTurn(wake('second'))).toBe(true);
    expect(inbox.landMidTurn(wake('third'))).toBe(true);
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
    const first = inbox.send(words('w-1', 'first'));
    expect(inbox.landMidTurn(wake('second'))).toBe(true);
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

  test('the reply turn id rides what the turn absorbed', async () => {
    const mid = setup({ turnInFlight: true });
    mid.inbox.landMidTurn(wake('drain', { replyTurnId: 'evt-1' }));
    await mid.inbox.prepareStep({ stepNumber: 0, messages: [user('q')] });
    expect(mid.inbox.settle({ completed: true }).absorbed.map((s) => s.replyTurnId)).toEqual(['evt-1']);
  });
});

describe('Inbox — the user\'s card', () => {
  test('a spliced signal opens a card when it ARRIVES and flips when the step takes it', async () => {
    const { inbox, cards } = setup({ turnInFlight: true });
    inbox.landMidTurn(wake('turn text', { stepText: 'mid-turn: mail from bob' }));

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
    // The step that took it in: where the chat draws it inside the answer.
    expect(cards[1]).toEqual({ type: 'signal_card', id: opened.id, state: 'shown', atStep: 0 });
    await inbox.prepareStep({ stepNumber: 1, messages: [user('q'), assistant('a')] });
    expect(lifecycle(cards)).toEqual(['pending', 'shown']);
  });

  test('the turn a delivery opens flips the card its delivery opened', async () => {
    const { inbox, cards } = setup({ turnInFlight: false });
    inbox.beginTurn(false, 'sig:drain-1');
    expect(cards).toEqual([{ type: 'signal_card', id: 'sig:drain-1', state: 'shown' }]);
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

  test('a re-delivery that never landed takes its card away', async () => {
    const { inbox, cards } = setup({ turnInFlight: true, enqueue: 'skipped' });
    inbox.landMidTurn(wake('drain'));
    await settledUnread(inbox);
    expect(lifecycle(cards)).toEqual(['pending', 'pending', 'undelivered']);
    expect(new Set(cards.map((c) => c.id)).size).toBe(1);
  });

  test('a re-delivered signal keeps its card and returns it to pending', async () => {
    const { inbox, cards } = setup({ turnInFlight: true });
    inbox.landMidTurn(wake('seen but unanswered'));
    await inbox.prepareStep({ stepNumber: 0, messages: [user('q')] });
    inbox.settle({ completed: false });
    await Promise.resolve();
    expect(lifecycle(cards)).toEqual(['pending', 'shown', 'pending']);
    expect(new Set(cards.map((c) => c.id)).size).toBe(1);
  });

  test('one card per signal, whatever else shares the step', async () => {
    const { inbox, cards } = setup({ turnInFlight: true });
    inbox.landMidTurn(wake('t1', { stepText: 'first' }));
    inbox.landMidTurn({ kind: 'background_job', text: 't2', metadata: { status: 'completed' } });
    await inbox.prepareStep({ stepNumber: 0, messages: [user('q')] }, [nudge('fork now')]);
    expect(lifecycle(cards)).toEqual(['pending', 'pending', 'shown', 'shown']);
    expect(cards.map((c) => c.id)).toEqual([cards[0].id, cards[1].id, cards[0].id, cards[1].id]);
  });
});

describe('Inbox — what the agent has seen', () => {
  test('the step that took a splice ends: its card is seen, and the answer keeps it where it was read', async () => {
    const { inbox, cards } = setup({ turnInFlight: true });
    inbox.beginTurn(false, undefined);
    await inbox.prepareStep({ stepNumber: 0, messages: [user('q')] });
    inbox.landMidTurn(wake('turn text', { stepText: 'mid-turn: mail from bob' }));
    await inbox.prepareStep({ stepNumber: 1, messages: [user('q'), assistant('a')] });

    expect(lifecycle(cards)).toEqual(['pending', 'shown']);
    inbox.stepEnded(0);
    expect(lifecycle(cards)).toEqual(['pending', 'shown']);
    inbox.stepEnded(1);

    expect(lifecycle(cards)).toEqual(['pending', 'shown', 'seen']);
    expect(inbox.seenSplices()).toEqual([{
      id: cards[0]?.id, atStep: 1, text: 'mid-turn: mail from bob', metadata: expect.objectContaining({ kinuEvent: 'event_drain' }),
    }]);
  });

  test('a step that never ended leaves its card being shown, and the answer keeps none', async () => {
    const { inbox, cards } = setup({ turnInFlight: true });
    inbox.beginTurn(false, undefined);
    inbox.landMidTurn(wake('turn text', { stepText: 'mid-turn: mail from bob' }));
    await inbox.prepareStep({ stepNumber: 0, messages: [user('q')] });
    inbox.settle({ completed: false });
    inbox.stepEnded(0);

    expect(lifecycle(cards)).not.toContain('seen');
    expect(inbox.seenSplices()).toEqual([]);
  });

  test('the delivery that opens a turn is seen once the first step ends, and keeps its own row', async () => {
    const { inbox, cards } = setup({ turnInFlight: false });
    inbox.beginTurn(false, 'sig:drain-1');
    inbox.stepEnded(0);

    expect(lifecycle(cards)).toEqual(['shown', 'seen']);
    expect(inbox.seenSplices()).toEqual([]);
  });
});

describe('Inbox — the mid-turn splice', () => {
  test('a spliced signal stays at its entry index across steps', async () => {
    const { inbox } = setup({ turnInFlight: true });
    await inbox.prepareStep({ stepNumber: 0, messages: [user('q')] });
    inbox.landMidTurn(wake('turn text', { stepText: 'mid-turn: mail from bob' }));
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
    inbox.landMidTurn(wake('t1', { stepText: 'first', replyTurnId: 'evt-1' }));
    inbox.landMidTurn(wake('t2', { stepText: 'second', replyTurnId: 'evt-2' }));
    const step0 = present(await inbox.prepareStep({ stepNumber: 0, messages: [user('q')] }, [nudge('fork now')]), 'the prepared step');
    expect(texts(step0)).toEqual(['q', 'first\n\nsecond\n\nfork now']);
    expect(inbox.settle({ completed: true }).absorbed.map((s) => s.text))
      .toEqual(['t1', 't2']);
  });

  test('a signal with no stepText splices its turn text', async () => {
    const { inbox } = setup({ turnInFlight: true });
    inbox.landMidTurn(wake('only one rendering'));
    expect(texts(present(await inbox.prepareStep({ stepNumber: 0, messages: [user('q')] }), 'the prepared step')))
      .toEqual(['q', 'only one rendering']);
  });
});

describe('Inbox — settlement', () => {
  test('an ordinary requeue uses the original server card as its durable identity', async () => {
    const { inbox, queued, cards } = setup({ turnInFlight: true });
    inbox.landMidTurn(wake('late ordinary signal'));
    inbox.settle({ completed: true });
    await Promise.resolve();

    expect(queued[0]?.idempotencyKey).toBe(cards[0]?.id);
    expect(queued[0]?.metadata?.signalId).toBe(cards[0]?.id);
  });

  test('a signal that never reached a step boundary re-delivers as a queued turn', async () => {
    const { inbox, queued, cards } = setup({ turnInFlight: true });
    await inbox.prepareStep({ stepNumber: 0, messages: [user('q')] });
    inbox.landMidTurn(wake('arrived at the final step', { replyTurnId: 'evt-late' }));
    expect(inbox.settle({ completed: true }).absorbed).toEqual([]);
    await Promise.resolve();
    expect(queued).toEqual([{
      text: 'arrived at the final step',
      idempotencyKey: cards[0].id,
      metadata: { kinuEvent: 'event_drain', kinuAuthor: 'harness', drainTurnId: 'evt-late', signalId: cards[0].id },
    }]);
    expect(await inbox.prepareStep({ stepNumber: 0, messages: [user('next')] })).toBeUndefined();
  });

  test('an ABORTED turn re-delivers what it had already absorbed — its answer is gone', async () => {
    const { inbox, queued } = setup({ turnInFlight: true });
    inbox.landMidTurn(wake('seen but unanswered'));
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

});

describe('Inbox — turn boundaries', () => {
  test('beginTurn drops splice state a dead turn leaked but keeps waiting signals', async () => {
    const { inbox } = setup({ turnInFlight: true });
    inbox.landMidTurn(wake('t-dead', { stepText: 'seen by the dead turn' }));
    await inbox.prepareStep({ stepNumber: 0, messages: [user('q'), user('pad'), user('pad2')] });
    inbox.landMidTurn(wake('t-waiting', { stepText: 'still pending' }));

    inbox.beginTurn(false);
    const step0 = present(await inbox.prepareStep({ stepNumber: 0, messages: [user('q2')] }), 'the prepared step');
    expect(texts(step0)).toEqual(['q2', 'still pending']);
    expect(inbox.settle({ completed: true }).absorbed.map((s) => s.text)).toEqual(['t-waiting']);
  });

  test('a CONTINUATION turn re-absorbs the just-settled signals; a regular turn drops them', async () => {
    const { inbox } = setup({ turnInFlight: true });
    inbox.landMidTurn(wake('t1', { stepText: 'mail from bob' }));
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
    inbox.landMidTurn(wake('t-aborted', { stepText: 'mail from bob' }));
    await inbox.prepareStep({ stepNumber: 0, messages: [user('q')] });
    expect(inbox.settle({ completed: false }).absorbed.map((s) => s.text)).toEqual(['t-aborted']);

    inbox.beginTurn(true);
    expect(await inbox.prepareStep({ stepNumber: 0, messages: [user('continued')] })).toBeUndefined();
  });
});

describe('the workspace genesis signal', () => {
  // Re-delivered as the offer it was: a turn of its own that yields to an operator message admitted before its slot.
  test('the genesis offer yields to an operator message admitted before its slot', async () => {
    const { inbox, queued, cards } = setup({ turnInFlight: true, messageAdmitted: true });
    const genesis = present(workspaceGenesisSignal('Audit the OAuth callback flow.'), 'the workspace genesis signal');

    inbox.landMidTurn(genesis);
    await settledUnread(inbox);
    expect(queued).toHaveLength(1);
    expect(queued[0].yieldsToUserMessage).toBe(true);
    expect(queued[0].metadata?.kinuEvent).toBe(WORKSPACE_CREATED_EVENT);
    expect(queued[0].idempotencyKey).toBeUndefined();
    expect(lifecycle(cards)).toEqual(['pending', 'pending', 'undelivered']);
  });

  test('an admitted message does not consume a turn that was never offered', async () => {
    const { inbox, queued } = setup({ turnInFlight: true, messageAdmitted: true });

    inbox.landMidTurn(wake('mail from bob'));
    await settledUnread(inbox);
    expect(queued[0].yieldsToUserMessage).toBeUndefined();
  });

  test('the genesis offer with nobody speaking still takes its own turn', async () => {
    const { inbox, queued } = setup({ turnInFlight: true });
    const genesis = present(workspaceGenesisSignal('Audit the OAuth callback flow.'), 'the workspace genesis signal');

    inbox.landMidTurn(genesis);
    await settledUnread(inbox);
    expect(queued[0].yieldsToUserMessage).toBe(true);
    expect(queued[0].metadata?.kinuEvent).toBe(WORKSPACE_CREATED_EVENT);
  });

  test('a workspace created with no mission has no first turn to take', () => {
    expect(workspaceGenesisSignal('Help the user with the work they assign.')).toBeNull();
    expect(workspaceGenesisSignal('')).toBeNull();
    expect(workspaceGenesisSignal(null)).toBeNull();
  });
});
