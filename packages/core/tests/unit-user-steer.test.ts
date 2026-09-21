/**
 * The user kind of signal — the user's own message — sent through the ONE
 * inbox like everything else, but kept under its own three load-bearing
 * semantics: it
 * persists as a verbatim user row (so the walk-back fork can cut at it), an
 * interrupt HANDS IT BACK rather than eating it, and a leftover reruns as a
 * user-origin turn. Those were properties of `LocalAgentSession.pendingSteers`
 * and existed nowhere the cloud backend could reach; they are pinned here
 * against the shared seam rather than only against the CLI that happened to
 * own them.
 */

import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import { Inbox } from '../src/orchestrator/inbox';
import type { UserSteer } from '../src/orchestrator/inbox';
import type {
  BackendHost, BroadcastEvent, ProgrammaticTurn, PromptFile,
} from '../src/types/backend-host';
import type { AgentSignal, SignalCardEvent, UserSignalIdentity } from '../src/types/signals';
// The user kind's wire name — the production constant, so a rename breaks the
// import instead of quietly leaving this file asserting the old one.
import { USER_MESSAGE_SIGNAL_KIND as USER_MESSAGE_KIND } from '../src/types/signals';
import { JsonObjectSchema } from '../src/utils/json';
import type { WorkMode } from '../src/types/turn';

/** A prepareStep context: what the step pipeline hands an extension. */
function step(stepNumber: number, messages: ModelMessage[]) {
  return { stepNumber, messages };
}

const HISTORY: ModelMessage[] = [
  { role: 'user', content: 'deploy the api' },
  { role: 'assistant', content: 'starting' },
];

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

/** Every wire event the seam can emit here: signal cards and steer statuses. */
const BroadcastSchema = v.union([
  SignalCardEventSchema,
  v.object({
    type: v.literal('steer_status'),
    status: v.picklist(['queued', 'landed', 'returned', 'turn']),
    steerId: v.string(),
    text: v.string(),
    atStep: v.optional(v.number()),
  }),
]);

type Broadcast = v.InferOutput<typeof BroadcastSchema>;

const steerStatuses = (broadcasts: readonly Broadcast[]) =>
  broadcasts.filter((broadcast) => broadcast.type === 'steer_status');

/** A signal of the user kind: the steer the composer typed, under its id. */
const steer = (
  id: string,
  text: string,
  over: { mode?: WorkMode; files?: readonly PromptFile[]; metadata?: AgentSignal['metadata'] } = {},
): AgentSignal => {
  const user: UserSignalIdentity = {
    id, mode: over.mode ?? 'build',
    ...(over.files !== undefined && { files: over.files }),
  };

  return {
    kind: USER_MESSAGE_KIND, text, user,
    ...(over.metadata !== undefined && { metadata: over.metadata }),
  };
};

/** An event-kind signal — everything the seam handles that is not the user. */
const event = (text: string, over: Partial<AgentSignal> = {}): AgentSignal => {
  const signal: AgentSignal = { kind: 'event_drain', text };

  return Object.assign(signal, over);
};

function setup(opts: {
  turnInFlight?: boolean;
  onDrain?: (steers: readonly UserSteer[], atStep: number) => void | Promise<void>;
  turnId?: string | null;
  enqueue?: 'queued' | 'skipped' | 'throw';
} = {}) {
  const queued: ProgrammaticTurn[] = [];
  const broadcasts: Broadcast[] = [];
  const raw: BroadcastEvent[] = [];
  const drained: Array<{ steers: UserSteer[]; atStep: number }> = [];

  const host: BackendHost = {
    broadcast: (event: BroadcastEvent) => {
      raw.push(event);
      broadcasts.push(v.parse(BroadcastSchema, event));
    },
    enqueueTurn: async (turn) => {
      queued.push(turn);

      if (opts.enqueue === 'throw') throw new Error('queue unavailable');

      if (opts.enqueue === 'skipped') return { status: 'skipped' };

      return { status: 'queued' };
    },
    turnInFlight: () => opts.turnInFlight === true,
    setTimer: () => {},
  };

  const accepted: string[] = [];

  const inbox = new Inbox(host, undefined, {
    onAccept: (steer) => { accepted.push(steer.id); },
    onDrain: (steers, atStep) => {
      drained.push({ steers: [...steers], atStep });

      return opts.onDrain?.(steers, atStep);
    },
    turnId: () => opts.turnId ?? null,
  });

  return { inbox, queued, broadcasts, raw, drained, accepted };
}

describe('Inbox — the user kind, accepted', () => {
  test('a steer refused when no turn is running is enqueued as its own user-origin turn', async () => {
    const { inbox, queued, broadcasts } = setup({ turnInFlight: false });

    expect(await inbox.send(steer('s1', 'nothing is running'))).toBe('queued');
    expect(queued).toEqual([{
      text: 'nothing is running',
      origin: 'user',
      steerIds: ['s1'],
      metadata: { kinuAuthor: 'operator', kinuMode: 'build' },
    }]);
    // The idle path matches a steer the caller sends itself: NO idempotency
    // key, and nothing was ever queued mid-turn. What IS owed is where the
    // words went — a turn of their own — because the surface that sent them
    // to a running turn learns their landing from this broadcast alone.
    expect(queued[0]!.idempotencyKey).toBeUndefined();
    expect(broadcasts).toEqual([
      { type: 'steer_status', status: 'turn', steerId: 's1', text: 'nothing is running' },
    ]);
  });

  test('a steer is accepted mid-turn and reported as mid-turn, with a queued steer_status', async () => {
    const { inbox, queued, broadcasts, raw } = setup({ turnInFlight: true });

    expect(await inbox.send(steer('s1', 'also check staging'))).toBe('mid-turn');
    expect(queued).toEqual([]);
    expect(broadcasts).toEqual([
      { type: 'steer_status', status: 'queued', steerId: 's1', text: 'also check staging' },
    ]);
    // The wire shape a surface parses: the event's own key order, not the
    // schema's.
    expect(Object.keys(raw[0]!)).toEqual(['type', 'status', 'steerId', 'text']);
  });

  test('durable reset state replaces the process-local user queue in its stored order', async () => {
    const { inbox, drained } = setup({ turnInFlight: true });
    inbox.beginTurn(false);
    // An event still pending keeps its place rather than being dropped by the
    // restore — the restored users land AHEAD of it.
    await inbox.send(event('still pending'));
    inbox.restorePending([
      { id: 's1', text: 'first' },
      { id: 's2', text: 'second' },
    ]);

    const rewritten = await inbox.prepareStep(step(0, HISTORY));

    expect(drained).toEqual([{
      steers: [{ id: 's1', text: 'first' }, { id: 's2', text: 'second' }],
      atStep: 0,
    }]);
    expect(rewritten).toEqual([
      ...HISTORY,
      { role: 'user', content: 'first\n\nsecond' },
      { role: 'user', content: 'still pending' },
    ]);
  });

  test('restorePending throws once this turn started draining — two authorities would duplicate', async () => {
    const { inbox } = setup({ turnInFlight: true });
    inbox.beginTurn(false);
    await inbox.send(steer('s1', 'first'));
    await inbox.prepareStep(step(0, HISTORY));

    expect(() => inbox.restorePending([{ id: 's2', text: 'late restore' }]))
      .toThrow('cannot restore pending steers after this turn started draining');
  });
});

describe('Inbox — the user kind, landing in the step', () => {
  test('everything pending lands as ONE user message at the step tail', async () => {
    const { inbox, drained, broadcasts } = setup({ turnInFlight: true });
    inbox.beginTurn(false);
    await inbox.send(steer('s1', 'also check staging'));
    await inbox.send(steer('s2', 'and the logs'));

    const rewritten = await inbox.prepareStep(step(0, HISTORY));

    // At the TAIL: after the latest tool results, which is what keeps role
    // alternation provider-safe.
    expect(rewritten).toEqual([
      ...HISTORY,
      { role: 'user', content: 'also check staging\n\nand the logs' },
    ]);
    // One drain, both steers verbatim — the durable rows a backend writes.
    expect(drained).toEqual([{
      steers: [{ id: 's1', text: 'also check staging' }, { id: 's2', text: 'and the logs' }],
      atStep: 0,
    }]);
    expect(steerStatuses(broadcasts)).toEqual([
      { type: 'steer_status', status: 'queued', steerId: 's1', text: 'also check staging' },
      { type: 'steer_status', status: 'queued', steerId: 's2', text: 'and the logs' },
      { type: 'steer_status', status: 'landed', steerId: 's1', text: 'also check staging', atStep: 0 },
      { type: 'steer_status', status: 'landed', steerId: 's2', text: 'and the logs', atStep: 0 },
    ]);
  });

  test('the landed broadcast reports WHICH step it landed in, not just that it landed', async () => {
    // A turn is one assistant message, so "it landed" places a steer before or
    // after the whole turn and nowhere else. The step index is the only thing
    // that can put the operator's words where the model actually read them.
    const { inbox, broadcasts, drained } = setup({ turnInFlight: true });
    inbox.beginTurn(false);
    await inbox.prepareStep(step(0, HISTORY));
    await inbox.send(steer('s1', 'use the swarm for this'));
    await inbox.prepareStep(step(7, HISTORY));

    expect(drained).toEqual([{
      steers: [{ id: 's1', text: 'use the swarm for this' }], atStep: 7,
    }]);
    expect(steerStatuses(broadcasts).at(-1)).toEqual({
      type: 'steer_status', status: 'landed', steerId: 's1', text: 'use the swarm for this', atStep: 7,
    });
  });

  test('a step with nothing pending re-applies earlier steers at the index the model first saw them', async () => {
    const { inbox } = setup({ turnInFlight: true });
    inbox.beginTurn(false);
    await inbox.send(steer('s1', 'also check staging'));
    await inbox.prepareStep(step(0, HISTORY));

    // streamText rebuilds each step's messages from scratch, so a steer that is
    // not re-applied simply vanishes from the conversation after one step.
    const laterStep = [...HISTORY, { role: 'assistant' as const, content: 'ran a tool' }];
    expect(await inbox.prepareStep(step(1, laterStep))).toEqual([
      ...HISTORY,
      { role: 'user', content: 'also check staging' },
      { role: 'assistant', content: 'ran a tool' },
    ]);
  });

  test('a fresh turn resets splice coordinates but KEEPS a steer typed for it', async () => {
    const { inbox } = setup({ turnInFlight: true });
    inbox.beginTurn(false);
    await inbox.send(steer('s1', 'first turn steer'));
    await inbox.prepareStep(step(0, HISTORY));
    expect(inbox.recordedMessages()).toEqual([{ role: 'user', content: 'first turn steer' }]);

    // Typed while the previous turn was finishing: it belongs to the turn that
    // is about to run, not to the one that just ended.
    await inbox.send(steer('s2', 'typed as the turn ended'));
    inbox.beginTurn(false);
    expect(inbox.recordedMessages()).toEqual([]);
    expect(await inbox.prepareStep(step(0, HISTORY))).toEqual([
      ...HISTORY,
      { role: 'user', content: 'typed as the turn ended' },
    ]);
  });

  test('the durable landing is awaited before provider-visible words return', async () => {
    const landing = Promise.withResolvers<void>();

    const { inbox } = setup({
      turnInFlight: true,
      onDrain: () => landing.promise,
    });

    inbox.beginTurn(false);
    await inbox.send(steer('s1', 'wait for storage'));

    let returned = false;

    const preparing = inbox.prepareStep(step(0, HISTORY)).then((messages) => {
      returned = true;

      return messages;
    });

    await Promise.resolve();

    expect(returned).toBe(false);
    expect(inbox.recordedMessages()).toEqual([]);

    landing.resolve();
    expect(await preparing).toEqual([
      ...HISTORY,
      { role: 'user', content: 'wait for storage' },
    ]);
  });

  test('a failed durable landing restores the exact prefix before newer steers', async () => {
    let attempt = 0;

    const { inbox } = setup({
      turnInFlight: true,
      onDrain: async () => {
        attempt += 1;

        if (attempt === 1) throw new Error('storage unavailable');
      },
    });

    inbox.beginTurn(false);
    await inbox.send(steer('s1', 'first'));

    await expect(inbox.prepareStep(step(0, HISTORY))).rejects.toThrow('storage unavailable');
    await inbox.send(steer('s2', 'second'));
    expect(inbox.recordedMessages()).toEqual([]);

    expect(await inbox.prepareStep(step(0, HISTORY))).toEqual([
      ...HISTORY,
      { role: 'user', content: 'first\n\nsecond' },
    ]);
  });

  test('attachments ride as file parts rather than being dropped from the text', async () => {
    const files = [{ filename: 'trace.png', mediaType: 'image/png', url: 'data:image/png;base64,AA' }];
    const { inbox, drained } = setup({ turnInFlight: true });
    inbox.beginTurn(false);
    await inbox.send(steer('s1', 'look at this', { files }));

    expect(await inbox.prepareStep(step(0, HISTORY))).toEqual([
      ...HISTORY,
      {
        role: 'user',
        content: [
          { type: 'file', data: 'data:image/png;base64,AA', mediaType: 'image/png', filename: 'trace.png' },
          { type: 'text', text: 'look at this' },
        ],
      },
    ]);
    expect(drained[0]!.steers[0]!.files).toEqual(files);
  });
});

describe('Inbox — the user kind, the three load-bearing semantics', () => {
  test('drained steers are available VERBATIM for persistence, one row per steer', async () => {
    const { inbox, drained } = setup({ turnInFlight: true });
    inbox.beginTurn(false);
    await inbox.send(steer('s1', 'also check staging'));
    await inbox.prepareStep(step(0, HISTORY));
    await inbox.send(steer('s2', 'and the logs'));
    await inbox.prepareStep(step(1, HISTORY));

    // Per STEER, not per drain: the walk-back fork pivot matches an individual
    // user message, so a merged "staging\n\nlogs" row would make one of them
    // unforkable.
    expect(drained).toEqual([
      { steers: [{ id: 's1', text: 'also check staging' }], atStep: 0 },
      { steers: [{ id: 's2', text: 'and the logs' }], atStep: 1 },
    ]);
    expect(inbox.recordedMessages()).toEqual([
      { role: 'user', content: 'also check staging' },
      { role: 'user', content: 'and the logs' },
    ]);
  });

  test('an interrupt returns what the model never saw, and drops it from the turn', async () => {
    const { inbox, broadcasts } = setup({ turnInFlight: true });
    inbox.beginTurn(false);
    await inbox.send(steer('s1', 'change of plans'));

    // Returned, not swallowed: the surface already rendered it as sent, so it
    // goes back to the composer rather than vanishing.
    expect(inbox.interrupt()).toEqual([{ id: 's1', text: 'change of plans' }]);
    expect(steerStatuses(broadcasts).at(-1)).toEqual({
      type: 'steer_status', status: 'returned', steerId: 's1', text: 'change of plans',
    });
    // And it must NOT then reappear in the next step.
    expect(await inbox.prepareStep(step(1, HISTORY))).toBeUndefined();
  });

  test('an interrupt leaves a steer the model already read in the durable record', async () => {
    const { inbox } = setup({ turnInFlight: true });
    inbox.beginTurn(false);
    await inbox.send(steer('s1', 'also check staging'));
    await inbox.prepareStep(step(0, HISTORY));

    // Interrupting after the drain cannot un-send it: the model acted on it, so
    // it stays in the history the next turn inherits.
    expect(inbox.interrupt()).toEqual([]);
    expect(inbox.recordedMessages()).toEqual([{ role: 'user', content: 'also check staging' }]);
  });

  test('leftover users rerun as ONE user-origin turn, stamped operator under their mode', async () => {
    const { inbox, queued, broadcasts } = setup({ turnInFlight: true, turnId: 'turn-9' });
    inbox.beginTurn(false);
    await inbox.prepareStep(step(0, HISTORY));
    // Typed while the model was writing its final answer — there is no further
    // step for them to land on.
    await inbox.send(steer('s1', 'one more thing'));
    await inbox.send(steer('s2', 'and this'));

    inbox.settle({ completed: true });
    await Promise.resolve();

    expect(queued).toEqual([{
      text: 'one more thing\n\nand this',
      origin: 'user',
      steerIds: ['s1', 's2'],
      idempotencyKey: 'steer-rerun:turn-9:build:s1',
      metadata: { kinuAuthor: 'operator', kinuMode: 'build' },
    }]);
    // Each steer's landing is announced under its own id: it is a turn now,
    // not a bubble the running turn owes a step to. A surface that only
    // admitted the words — the composer's call answers admission, not the
    // landing — has no other way to learn which happened.
    expect(steerStatuses(broadcasts).map((status) => [status.status, status.steerId])).toEqual([
      ['queued', 's1'], ['queued', 's2'], ['turn', 's1'], ['turn', 's2'],
    ]);
  });

  test('the spliced conversation replays into the turn response at the position the model saw it', async () => {
    const { inbox } = setup({ turnInFlight: true });
    inbox.beginTurn(false);
    await inbox.send(steer('s1', 'also check staging'));
    await inbox.prepareStep(step(0, HISTORY));

    // The durable-history merge: base coordinates are the step-0 count, so the
    // steer lands ahead of the assistant work that followed it.
    const response: ModelMessage[] = [
      { role: 'assistant', content: 'checked staging' },
    ];

    expect(inbox.replayInto(response)).toEqual([
      { role: 'user', content: 'also check staging' },
      { role: 'assistant', content: 'checked staging' },
    ]);
  });
});

describe('Inbox — the user kind beside the event kind', () => {
  test('a mixed step splices the user message then the event, and only the user message is durable', async () => {
    const { inbox, broadcasts } = setup({ turnInFlight: true });
    inbox.beginTurn(false);
    await inbox.send(steer('s1', 'the user said this'));
    await inbox.send(event('an event arrived'));

    const rewritten = await inbox.prepareStep(step(0, HISTORY));

    expect(rewritten).toEqual([
      ...HISTORY,
      { role: 'user', content: 'the user said this' },
      { role: 'user', content: 'an event arrived' },
    ]);
    // The user message is durable history; the event is model-visible for the
    // turn and gone at replay, exactly like the dynamic-context block it
    // rides beside.
    expect(inbox.replayInto([{ role: 'assistant', content: 'a1' }])).toEqual([
      { role: 'user', content: 'the user said this' },
      { role: 'assistant', content: 'a1' },
    ]);
    expect(inbox.recordedMessages()).toEqual([{ role: 'user', content: 'the user said this' }]);
    expect(broadcasts).toEqual([
      { type: 'steer_status', status: 'queued', steerId: 's1', text: 'the user said this' },
      {
        type: 'signal_card', id: expect.any(String), state: 'pending',
        metadata: { kinuAuthor: 'harness', kinuEvent: 'event_drain' }, text: 'an event arrived',
      },
      // Cards move before steers announce: 'shown' first, then 'landed'.
      { type: 'signal_card', id: expect.any(String), state: 'shown' },
      { type: 'steer_status', status: 'landed', steerId: 's1', text: 'the user said this', atStep: 0 },
    ]);
  });

  test("neither a user steer's composer mode nor an event's is a reason to refuse the splice", async () => {
    const { inbox, queued } = setup({ turnInFlight: true });

    // The user typed it in plan mode — metadata.kinuMode and all — and it
    // lands in the running turn: the mode rides the USER identity, as a fact.
    expect(await inbox.send(steer('s1', 'typed in plan mode', {
      mode: 'plan', metadata: { kinuMode: 'plan' },
    }))).toBe('mid-turn');

    // The SAME kinuMode on an event is a fact too: where the result came from,
    // not a reason to open a second turn behind the one the user is watching.
    expect(await inbox.send(event('plan result', { metadata: { kinuMode: 'plan' } }))).toBe('mid-turn');
    expect(await inbox.send(event('other mission', { metadata: { missionLabels: ['gamma'] } }))).toBe('mid-turn');
    expect(queued).toEqual([]);
  });

  test('a user message is reserved with the backend before it is announced as queued', async () => {
    // The durable row exists before the client hears 'queued': the accept
    // hook runs in the same synchronous slice as the routing read, ahead of
    // the broadcast, and a hook that refuses buffers nothing.
    const { inbox, accepted, broadcasts } = setup({ turnInFlight: true });
    expect(await inbox.send(steer('s1', 'reserve me', { mode: 'plan' }))).toBe('mid-turn');
    expect(accepted).toEqual(['s1']);
    expect(broadcasts).toEqual([{ type: 'steer_status', status: 'queued', steerId: 's1', text: 'reserve me' }]);

    const refusing = new Inbox({
      broadcast: () => { throw new Error('nothing to announce'); },
      enqueueTurn: async () => { throw new Error('nothing to start'); },
      turnInFlight: () => true,
      setTimer: () => {},
    }, undefined, { onAccept: () => { throw new Error('storage refused the row'); } });

    expect(() => refusing.send(steer('s2', 'refused'))).toThrow('storage refused the row');
    expect(await refusing.prepareStep(step(0, HISTORY))).toBeUndefined();
  });

  test('an aborted turn requeues pending users and absorbed events — never absorbed users', async () => {
    const { inbox, queued } = setup({ turnInFlight: true });
    inbox.beginTurn(false);
    await inbox.send(steer('s1', 'the model saw me'));
    await inbox.send(event('absorbed event'));
    await inbox.prepareStep(step(0, HISTORY));
    await inbox.send(steer('s2', 'typed too late'));
    await inbox.send(event('leftover event'));

    inbox.settle({ completed: false });
    await Promise.resolve();

    // Users first: the pending steer reruns as a user-origin turn. The absorbed
    // user is never requeued — its durable row already exists. Then events:
    // the absorbed one the dead turn had already seen, then the leftover one.
    expect(queued.map((turn) => turn.text)).toEqual([
      'typed too late', 'absorbed event', 'leftover event',
    ]);
    expect(queued[0]).toMatchObject({
      origin: 'user', steerIds: ['s2'], metadata: { kinuAuthor: 'operator', kinuMode: 'build' },
    });
    expect(queued[0]!.idempotencyKey).toMatch(/^steer-rerun:.*:build:/);
  });

  test('an interrupt returns users only and leaves a pending event to requeue at settle', async () => {
    const { inbox, queued, broadcasts } = setup({ turnInFlight: true });
    inbox.beginTurn(false);
    await inbox.send(steer('s1', 'give it back'));
    await inbox.send(event('still owed'));

    expect(inbox.interrupt()).toEqual([{ id: 's1', text: 'give it back' }]);
    expect(broadcasts.map((b) => b.type === 'steer_status' ? b.status : b.state))
      .toEqual(['queued', 'pending', 'returned']);

    // The event was never returned — it settles as its own turn instead.
    inbox.settle({ completed: false });
    await Promise.resolve();
    expect(queued.map((turn) => turn.text)).toEqual(['still owed']);
    expect(queued[0]!.origin).toBeUndefined();
  });

  test('a failed durable landing restores users AND events ahead of a steer delivered mid-await', async () => {
    const landing = Promise.withResolvers<void>();
    let calls = 0;

    const { inbox, broadcasts } = setup({
      turnInFlight: true,
      onDrain: () => {
        calls += 1;

        return calls === 1 ? landing.promise : undefined;
      },
    });

    inbox.beginTurn(false);
    await inbox.send(steer('s1', 'first'));
    await inbox.send(event('one event'));

    const preparing = inbox.prepareStep(step(0, HISTORY));
    await Promise.resolve();
    // Delivered while the drain is in flight — it queues BEHIND the restored
    // prefix, not beside it.
    await inbox.send(steer('s2', 'second'));

    landing.reject(new Error('storage unavailable'));
    await expect(preparing).rejects.toThrow('storage unavailable');

    // Nothing landed: no card moved, no steer announced as seen.
    expect(broadcasts.filter((b) => b.type === 'signal_card').map((card) => card.state)).toEqual(['pending']);
    expect(steerStatuses(broadcasts).map((status) => status.status)).toEqual(['queued', 'queued']);

    expect(await inbox.prepareStep(step(0, HISTORY))).toEqual([
      ...HISTORY,
      { role: 'user', content: 'first\n\nsecond' },
      { role: 'user', content: 'one event' },
    ]);
  });

  test('pending users rerun as ONE turn in arrival order, under plan if any of them was plan', async () => {
    const { inbox, queued } = setup({ turnInFlight: true });
    inbox.beginTurn(false);
    await inbox.send(steer('s1', 'build this', { mode: 'build' }));
    await inbox.send(steer('s2', 'plan that', { mode: 'plan' }));
    await inbox.send(steer('s3', 'build the other', { mode: 'build' }));

    inbox.settle({ completed: true });
    await Promise.resolve();

    // One turn, the words in the order they were typed. Plan is the narrower
    // grant, so a plan-mode message anywhere in the group makes the turn plan:
    // merging never widens what a message was typed under.
    expect(queued.map((turn) => ({
      text: turn.text,
      kinuMode: turn.metadata?.kinuMode,
      steerIds: turn.steerIds,
      idempotencyKey: turn.idempotencyKey,
      origin: turn.origin,
    }))).toEqual([
      {
        text: 'build this\n\nplan that\n\nbuild the other', kinuMode: 'plan', steerIds: ['s1', 's2', 's3'],
        idempotencyKey: 'steer-rerun:live:plan:s1', origin: 'user',
      },
    ]);
  });

  test('three user messages at an idle agent are one turn whose first step sees all three', async () => {
    // The host's enqueue is held open — the window between a turn's
    // admission and its opening. The first message starts the turn; the other
    // two are buffered for its first step, never queued as turns behind it.
    let open: (() => void) | null = null;
    const queued: ProgrammaticTurn[] = [];
    let inFlight = false;

    const inbox = new Inbox({
      broadcast: () => {},
      enqueueTurn: async (turn) => {
        queued.push(turn);
        await new Promise<void>((resolve) => { open = resolve; });

        return { status: 'queued' };
      },
      turnInFlight: () => inFlight,
      setTimer: () => {},
    });

    const first = inbox.send(steer('s1', 'first'));
    expect(await inbox.send(steer('s2', 'second'))).toBe('mid-turn');
    expect(await inbox.send(steer('s3', 'third'))).toBe('mid-turn');
    expect(queued.map((turn) => ({ text: turn.text, steerIds: turn.steerIds, origin: turn.origin })))
      .toEqual([{ text: 'first', steerIds: ['s1'], origin: 'user' }]);

    // The turn opens on the first message; its first step carries the rest.
    inFlight = true;
    inbox.beginTurn(false);
    expect(await inbox.prepareStep(step(0, [...HISTORY, { role: 'user', content: 'first' }]))).toEqual([
      ...HISTORY,
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second\n\nthird' },
    ]);
    open!();
    expect(await first).toBe('queued');
    expect(queued).toHaveLength(1);
  });
});
