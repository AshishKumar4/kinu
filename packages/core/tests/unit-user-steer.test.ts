/**
 * The user kind of signal — a message the user typed while a turn runs —
 * delivered through the ONE seam (SignalDelivery) like everything else
 * asynchronous, but kept under its own three load-bearing semantics: it
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
import { SignalDelivery } from '../src/orchestrator/signals';
import type { UserSteer } from '../src/orchestrator/user-steer';
import type {
  BackendHost, BroadcastEvent, ProgrammaticTurn, PromptFile,
} from '../src/types/backend-host';
import type { AgentSignal, SignalCardEvent, UserSignalIdentity } from '../src/types/signals';
import { JsonObjectSchema } from '../src/utils/json';
import type { WorkMode } from '../src/types/turn';

/** The user kind's wire name — pinned literally so a rename cannot slip by. */
const USER_MESSAGE_KIND = 'user_message';

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
    status: v.picklist(['queued', 'landed', 'returned']),
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
  activeMode?: WorkMode;
  activeMissions?: readonly string[];
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

  const signals = new SignalDelivery(
    host,
    undefined,
    () => ({ mode: opts.activeMode ?? 'build', missions: opts.activeMissions ?? [] }),
    {
      onDrain: (steers, atStep) => {
        drained.push({ steers: [...steers], atStep });

        return opts.onDrain?.(steers, atStep);
      },
      turnId: () => opts.turnId ?? null,
    },
  );

  return { signals, queued, broadcasts, raw, drained };
}

describe('SignalDelivery — the user kind, accepted', () => {
  test('a steer refused when no turn is running is enqueued as its own user-origin turn', async () => {
    const { signals, queued, broadcasts } = setup({ turnInFlight: false });

    expect(await signals.deliver(steer('s1', 'nothing is running'))).toBe('queued');
    expect(queued).toEqual([{
      text: 'nothing is running',
      origin: 'user',
      steerIds: ['s1'],
      metadata: { kinuAuthor: 'operator', kinuMode: 'build' },
    }]);
    // The idle path matches a steer the caller sends itself: NO idempotency
    // key, and nothing is claimed mid-turn, so no steer_status is owed.
    expect(queued[0]!.idempotencyKey).toBeUndefined();
    expect(broadcasts).toEqual([]);
  });

  test('a steer is accepted mid-turn and reported as mid-turn, with a queued steer_status', async () => {
    const { signals, queued, broadcasts, raw } = setup({ turnInFlight: true });

    expect(await signals.deliver(steer('s1', 'also check staging'))).toBe('mid-turn');
    expect(queued).toEqual([]);
    expect(broadcasts).toEqual([
      { type: 'steer_status', status: 'queued', steerId: 's1', text: 'also check staging' },
    ]);
    // The wire shape a surface parses: the event's own key order, not the
    // schema's.
    expect(Object.keys(raw[0]!)).toEqual(['type', 'status', 'steerId', 'text']);
  });

  test('durable reset state replaces the process-local user queue in its stored order', async () => {
    const { signals, drained } = setup({ turnInFlight: true });
    signals.beginTurn(false);
    // An event still pending keeps its place rather than being dropped by the
    // restore — the restored users land AHEAD of it.
    await signals.deliver(event('still pending'));
    signals.restorePending([
      { id: 's1', text: 'first' },
      { id: 's2', text: 'second' },
    ]);

    const rewritten = await signals.prepareStep(step(0, HISTORY));

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
    const { signals } = setup({ turnInFlight: true });
    signals.beginTurn(false);
    await signals.deliver(steer('s1', 'first'));
    await signals.prepareStep(step(0, HISTORY));

    expect(() => signals.restorePending([{ id: 's2', text: 'late restore' }]))
      .toThrow('cannot restore pending steers after this turn started draining');
  });
});

describe('SignalDelivery — the user kind, landing in the step', () => {
  test('everything pending lands as ONE user message at the step tail', async () => {
    const { signals, drained, broadcasts } = setup({ turnInFlight: true });
    signals.beginTurn(false);
    await signals.deliver(steer('s1', 'also check staging'));
    await signals.deliver(steer('s2', 'and the logs'));

    const rewritten = await signals.prepareStep(step(0, HISTORY));

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
    const { signals, broadcasts, drained } = setup({ turnInFlight: true });
    signals.beginTurn(false);
    await signals.prepareStep(step(0, HISTORY));
    await signals.deliver(steer('s1', 'use the swarm for this'));
    await signals.prepareStep(step(7, HISTORY));

    expect(drained).toEqual([{
      steers: [{ id: 's1', text: 'use the swarm for this' }], atStep: 7,
    }]);
    expect(steerStatuses(broadcasts).at(-1)).toEqual({
      type: 'steer_status', status: 'landed', steerId: 's1', text: 'use the swarm for this', atStep: 7,
    });
  });

  test('a step with nothing pending re-applies earlier steers at the index the model first saw them', async () => {
    const { signals } = setup({ turnInFlight: true });
    signals.beginTurn(false);
    await signals.deliver(steer('s1', 'also check staging'));
    await signals.prepareStep(step(0, HISTORY));

    // streamText rebuilds each step's messages from scratch, so a steer that is
    // not re-applied simply vanishes from the conversation after one step.
    const laterStep = [...HISTORY, { role: 'assistant' as const, content: 'ran a tool' }];
    expect(await signals.prepareStep(step(1, laterStep))).toEqual([
      ...HISTORY,
      { role: 'user', content: 'also check staging' },
      { role: 'assistant', content: 'ran a tool' },
    ]);
  });

  test('a fresh turn resets splice coordinates but KEEPS a steer typed for it', async () => {
    const { signals } = setup({ turnInFlight: true });
    signals.beginTurn(false);
    await signals.deliver(steer('s1', 'first turn steer'));
    await signals.prepareStep(step(0, HISTORY));
    expect(signals.recordedMessages()).toEqual([{ role: 'user', content: 'first turn steer' }]);

    // Typed while the previous turn was finishing: it belongs to the turn that
    // is about to run, not to the one that just ended.
    await signals.deliver(steer('s2', 'typed as the turn ended'));
    signals.beginTurn(false);
    expect(signals.recordedMessages()).toEqual([]);
    expect(await signals.prepareStep(step(0, HISTORY))).toEqual([
      ...HISTORY,
      { role: 'user', content: 'typed as the turn ended' },
    ]);
  });

  test('the durable landing is awaited before provider-visible words return', async () => {
    const landing = Promise.withResolvers<void>();

    const { signals } = setup({
      turnInFlight: true,
      onDrain: () => landing.promise,
    });

    signals.beginTurn(false);
    await signals.deliver(steer('s1', 'wait for storage'));

    let returned = false;

    const preparing = signals.prepareStep(step(0, HISTORY)).then((messages) => {
      returned = true;

      return messages;
    });

    await Promise.resolve();

    expect(returned).toBe(false);
    expect(signals.recordedMessages()).toEqual([]);

    landing.resolve();
    expect(await preparing).toEqual([
      ...HISTORY,
      { role: 'user', content: 'wait for storage' },
    ]);
  });

  test('a failed durable landing restores the exact prefix before newer steers', async () => {
    let attempt = 0;

    const { signals } = setup({
      turnInFlight: true,
      onDrain: async () => {
        attempt += 1;

        if (attempt === 1) throw new Error('storage unavailable');
      },
    });

    signals.beginTurn(false);
    await signals.deliver(steer('s1', 'first'));

    await expect(signals.prepareStep(step(0, HISTORY))).rejects.toThrow('storage unavailable');
    await signals.deliver(steer('s2', 'second'));
    expect(signals.recordedMessages()).toEqual([]);

    expect(await signals.prepareStep(step(0, HISTORY))).toEqual([
      ...HISTORY,
      { role: 'user', content: 'first\n\nsecond' },
    ]);
  });

  test('attachments ride as file parts rather than being dropped from the text', async () => {
    const files = [{ filename: 'trace.png', mediaType: 'image/png', url: 'data:image/png;base64,AA' }];
    const { signals, drained } = setup({ turnInFlight: true });
    signals.beginTurn(false);
    await signals.deliver(steer('s1', 'look at this', { files }));

    expect(await signals.prepareStep(step(0, HISTORY))).toEqual([
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

describe('SignalDelivery — the user kind, the three load-bearing semantics', () => {
  test('drained steers are available VERBATIM for persistence, one row per steer', async () => {
    const { signals, drained } = setup({ turnInFlight: true });
    signals.beginTurn(false);
    await signals.deliver(steer('s1', 'also check staging'));
    await signals.prepareStep(step(0, HISTORY));
    await signals.deliver(steer('s2', 'and the logs'));
    await signals.prepareStep(step(1, HISTORY));

    // Per STEER, not per drain: the walk-back fork pivot matches an individual
    // user message, so a merged "staging\n\nlogs" row would make one of them
    // unforkable.
    expect(drained).toEqual([
      { steers: [{ id: 's1', text: 'also check staging' }], atStep: 0 },
      { steers: [{ id: 's2', text: 'and the logs' }], atStep: 1 },
    ]);
    expect(signals.recordedMessages()).toEqual([
      { role: 'user', content: 'also check staging' },
      { role: 'user', content: 'and the logs' },
    ]);
  });

  test('an interrupt returns what the model never saw, and drops it from the turn', async () => {
    const { signals, broadcasts } = setup({ turnInFlight: true });
    signals.beginTurn(false);
    await signals.deliver(steer('s1', 'change of plans'));

    // Returned, not swallowed: the surface already rendered it as sent, so it
    // goes back to the composer rather than vanishing.
    expect(signals.interrupt()).toEqual([{ id: 's1', text: 'change of plans' }]);
    expect(steerStatuses(broadcasts).at(-1)).toEqual({
      type: 'steer_status', status: 'returned', steerId: 's1', text: 'change of plans',
    });
    // And it must NOT then reappear in the next step.
    expect(await signals.prepareStep(step(1, HISTORY))).toBeUndefined();
  });

  test('an interrupt leaves a steer the model already read in the durable record', async () => {
    const { signals } = setup({ turnInFlight: true });
    signals.beginTurn(false);
    await signals.deliver(steer('s1', 'also check staging'));
    await signals.prepareStep(step(0, HISTORY));

    // Interrupting after the drain cannot un-send it: the model acted on it, so
    // it stays in the history the next turn inherits.
    expect(signals.interrupt()).toEqual([]);
    expect(signals.recordedMessages()).toEqual([{ role: 'user', content: 'also check staging' }]);
  });

  test('leftover users rerun as ONE user-origin turn, stamped operator under their mode', async () => {
    const { signals, queued } = setup({ turnInFlight: true, turnId: 'turn-9' });
    signals.beginTurn(false);
    await signals.prepareStep(step(0, HISTORY));
    // Typed while the model was writing its final answer — there is no further
    // step for them to land on.
    await signals.deliver(steer('s1', 'one more thing'));
    await signals.deliver(steer('s2', 'and this'));

    signals.settle({ completed: true });
    await Promise.resolve();

    expect(queued).toEqual([{
      text: 'one more thing\n\nand this',
      origin: 'user',
      steerIds: ['s1', 's2'],
      idempotencyKey: 'steer-rerun:turn-9:build:s1',
      metadata: { kinuAuthor: 'operator', kinuMode: 'build' },
    }]);
  });

  test('the spliced conversation replays into the turn response at the position the model saw it', async () => {
    const { signals } = setup({ turnInFlight: true });
    signals.beginTurn(false);
    await signals.deliver(steer('s1', 'also check staging'));
    await signals.prepareStep(step(0, HISTORY));

    // The durable-history merge: base coordinates are the step-0 count, so the
    // steer lands ahead of the assistant work that followed it.
    const response: ModelMessage[] = [
      { role: 'assistant', content: 'checked staging' },
    ];

    expect(signals.replayInto(response)).toEqual([
      { role: 'user', content: 'also check staging' },
      { role: 'assistant', content: 'checked staging' },
    ]);
  });
});

describe('SignalDelivery — the user kind beside the event kind', () => {
  test('a mixed step splices the user message then the event, and only the user message is durable', async () => {
    const { signals, broadcasts } = setup({ turnInFlight: true });
    signals.beginTurn(false);
    await signals.deliver(steer('s1', 'the user said this'));
    await signals.deliver(event('an event arrived'));

    const rewritten = await signals.prepareStep(step(0, HISTORY));

    expect(rewritten).toEqual([
      ...HISTORY,
      { role: 'user', content: 'the user said this' },
      { role: 'user', content: 'an event arrived' },
    ]);
    // The user message is durable history; the event is model-visible for the
    // turn and gone at replay, exactly like the dynamic-context block it
    // rides beside.
    expect(signals.replayInto([{ role: 'assistant', content: 'a1' }])).toEqual([
      { role: 'user', content: 'the user said this' },
      { role: 'assistant', content: 'a1' },
    ]);
    expect(signals.recordedMessages()).toEqual([{ role: 'user', content: 'the user said this' }]);
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

  test("a user steer's composer mode is never a reason to refuse the splice; an event's is", async () => {
    const { signals, queued } = setup({ turnInFlight: true, activeMode: 'build' });

    // The user typed it in plan mode — metadata.kinuMode and all — and it still
    // lands in the running build turn, because the user's words are not a
    // governing document. The mode rides the USER identity, not the signal's.
    expect(await signals.deliver(steer('s1', 'typed in plan mode', {
      mode: 'plan', metadata: { kinuMode: 'plan' },
    }))).toBe('mid-turn');

    // The SAME kinuMode on an event is governing metadata: it gets its own turn.
    expect(await signals.deliver(event('plan result', { metadata: { kinuMode: 'plan' } }))).toBe('queued');
    expect(queued[0]?.metadata?.kinuMode).toBe('plan');
  });

  test("an event's mission labels govern the splice; matching labels still ride the live turn", async () => {
    const { signals, queued } = setup({ turnInFlight: true, activeMissions: ['alpha', 'beta'] });

    expect(await signals.deliver(event('other mission', {
      metadata: { missionLabels: ['gamma'] },
    }))).toBe('queued');
    expect(queued[0]?.metadata?.missionLabels).toEqual(['gamma']);

    // Same labels, different order — the comparison is the sorted set.
    expect(await signals.deliver(event('same mission', {
      metadata: { missionLabels: ['beta', 'alpha'] },
    }))).toBe('mid-turn');
  });

  test('an aborted turn requeues pending users and absorbed events — never absorbed users', async () => {
    const { signals, queued } = setup({ turnInFlight: true });
    signals.beginTurn(false);
    await signals.deliver(steer('s1', 'the model saw me'));
    await signals.deliver(event('absorbed event'));
    await signals.prepareStep(step(0, HISTORY));
    await signals.deliver(steer('s2', 'typed too late'));
    await signals.deliver(event('leftover event'));

    signals.settle({ completed: false });
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
    const { signals, queued, broadcasts } = setup({ turnInFlight: true });
    signals.beginTurn(false);
    await signals.deliver(steer('s1', 'give it back'));
    await signals.deliver(event('still owed'));

    expect(signals.interrupt()).toEqual([{ id: 's1', text: 'give it back' }]);
    expect(broadcasts.map((b) => b.type === 'steer_status' ? b.status : b.state))
      .toEqual(['queued', 'pending', 'returned']);

    // The event was never returned — it settles as its own turn instead.
    signals.settle({ completed: false });
    await Promise.resolve();
    expect(queued.map((turn) => turn.text)).toEqual(['still owed']);
    expect(queued[0]!.origin).toBeUndefined();
  });

  test('a failed durable landing restores users AND events ahead of a steer delivered mid-await', async () => {
    const landing = Promise.withResolvers<void>();
    let calls = 0;

    const { signals, broadcasts } = setup({
      turnInFlight: true,
      onDrain: () => {
        calls += 1;

        return calls === 1 ? landing.promise : undefined;
      },
    });

    signals.beginTurn(false);
    await signals.deliver(steer('s1', 'first'));
    await signals.deliver(event('one event'));

    const preparing = signals.prepareStep(step(0, HISTORY));
    await Promise.resolve();
    // Delivered while the drain is in flight — it queues BEHIND the restored
    // prefix, not beside it.
    await signals.deliver(steer('s2', 'second'));

    landing.reject(new Error('storage unavailable'));
    await expect(preparing).rejects.toThrow('storage unavailable');

    // Nothing landed: no card moved, no steer announced as seen.
    expect(broadcasts.filter((b) => b.type === 'signal_card').map((card) => card.state)).toEqual(['pending']);
    expect(steerStatuses(broadcasts).map((status) => status.status)).toEqual(['queued', 'queued']);

    expect(await signals.prepareStep(step(0, HISTORY))).toEqual([
      ...HISTORY,
      { role: 'user', content: 'first\n\nsecond' },
      { role: 'user', content: 'one event' },
    ]);
  });

  test('pending users rerun as one turn per contiguous mode run, in arrival order', async () => {
    const { signals, queued } = setup({ turnInFlight: true });
    signals.beginTurn(false);
    await signals.deliver(steer('s1', 'build this', { mode: 'build' }));
    await signals.deliver(steer('s2', 'plan that', { mode: 'plan' }));
    await signals.deliver(steer('s3', 'build the other', { mode: 'build' }));

    signals.settle({ completed: true });
    await Promise.resolve();

    // build → plan → build is three runs: a group break anywhere splits the
    // turn, so each run keeps the mode its words were typed under.
    expect(queued.map((turn) => ({
      text: turn.text,
      kinuMode: turn.metadata?.kinuMode,
      steerIds: turn.steerIds,
      idempotencyKey: turn.idempotencyKey,
      origin: turn.origin,
    }))).toEqual([
      {
        text: 'build this', kinuMode: 'build', steerIds: ['s1'],
        idempotencyKey: 'steer-rerun:live:build:s1', origin: 'user',
      },
      {
        text: 'plan that', kinuMode: 'plan', steerIds: ['s2'],
        idempotencyKey: 'steer-rerun:live:plan:s2', origin: 'user',
      },
      {
        text: 'build the other', kinuMode: 'build', steerIds: ['s3'],
        idempotencyKey: 'steer-rerun:live:build:s3', origin: 'user',
      },
    ]);
  });
});
