/**
 * Typing while the agent works, on the hosted backend — driven through the REAL
 * entry points: the `steerTurn` RPC and `beforeStep`, the Think hook the shared
 * step pipeline hangs off.
 *
 * The capability existed on the CLI and was reachable from no cloud surface at
 * all: there was no `steerTurn` callable, no drain registered on the actor's
 * ExtensionHost, and the composer's Enter called a send that early-returned
 * while streaming. So this file is about EXPOSURE, and every assertion here
 * fails against a body without it — not because a helper is missing, but
 * because pressing Enter mid-turn genuinely did nothing.
 *
 * What the harness cannot do is run a model turn (Think's loop needs workerd),
 * so `beforeStep` is called directly with the messages a step would carry. That
 * is the same function streamText calls, with the same registered extensions.
 */

import { describe, expect, test } from 'bun:test';
import { TURN_AUTHOR_METADATA_KEY } from '@kinu.run/core';
import type { ModelMessage } from 'ai';
import type { UIMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import * as v from 'valibot';
import type { PrepareStepContext } from '@cloudflare/think';
import { orchestratorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';

const SteerFrameSchema = v.object({
  type: v.literal('steer_status'),
  status: v.picklist(['queued', 'landed', 'returned']),
  steerId: v.string(),
  text: v.string(),
  atStep: v.optional(v.number()),
});

/** The `steer_status` frames the actor fanned out, in order. */
function steerFrames(frames: readonly string[]) {
  return frames.flatMap((frame) => {
    const parsed = v.safeParse(SteerFrameSchema, JSON.parse(frame));
    return parsed.success ? [parsed.output] : [];
  });
}

interface SteerHarness {
  agent: HarnessOrchestratorAgent;
  frames: string[];
  /** Durable rows the actor appended without starting a turn. */
  appended: UIMessage[][];
  /** Programmatic turns the actor enqueued (the leftover rerun path). */
  enqueued: Array<{ text: string; metadata?: unknown; idempotencyKey?: string }>;
  /** Declare a turn in flight, the way beforeTurn does. */
  startTurn(): void;
}

function steerHarness(): SteerHarness {
  const { agent } = orchestratorHarness();
  const frames: string[] = [];
  const appended: UIMessage[][] = [];
  const enqueued: Array<{ text: string; metadata?: unknown; idempotencyKey?: string }> = [];
  let inFlight = false;
  Reflect.set(agent, 'broadcast', (payload: string) => { frames.push(payload); });
  // `addMessages` is Think's "append to history WITHOUT starting a turn" API and
  // needs a live Session; the harness has none, so the observation is that the
  // actor asked for the right rows.
  Reflect.set(agent, 'addMessages', async (messages: UIMessage[]) => { appended.push(messages); });
  Reflect.set(agent, '_host', {
    broadcast: (event: { type: string }) => { frames.push(JSON.stringify(event)); },
    enqueueTurn: async (turn: { text: string; metadata?: unknown; idempotencyKey?: string }) => {
      enqueued.push(turn);
      return { status: 'queued' as const };
    },
    turnInFlight: () => inFlight,
    setTimer: () => {},
    headRuntime: undefined,
  });
  return {
    agent, frames, appended, enqueued,
    startTurn: () => {
      inFlight = true;
      Reflect.set(agent, '_inFlight', true);
      // Production stamps the durable turn identity in the same slice that
      // opens the turn; a mid-turn steer is REFUSED without it, because the SQL
      // reservation must name the turn an eviction would hand it back to. Driven
      // through the harness seam rather than by reflecting a private field, so
      // the steer queue this turn opens is opened too.
      agent.harnessBeginTurn(`turn-${crypto.randomUUID()}`);
    },
  };
}

const HISTORY: ModelMessage[] = [
  { role: 'user', content: 'deploy the api' },
  { role: 'assistant', content: 'starting' },
];

/** The turn-local context block the runtime weaves into every step. Not
 *  conversation, and asserted by the step-pipeline suite — filtered here so a
 *  steer assertion reads as the messages a user would recognise. */
const DynamicContextSchema = v.object({
  role: v.literal('user'),
  content: v.pipe(v.string(), v.includes('<dynamic_context')),
});

/** A step context carrying what the pipeline reads. The provider handle a live
 *  streamText would also pass is never touched by `beforeStep` (it forwards only
 *  stepNumber and messages to composePrepareStep), so it is supplied as the
 *  model a step would carry rather than asserted away. */
const HARNESS_MODEL = new MockLanguageModelV3();

function prepareStepContext(stepNumber: number, messages: ModelMessage[]): PrepareStepContext {
  return { stepNumber, messages, steps: [], model: HARNESS_MODEL, experimental_context: undefined };
}

/** The messages the step actually carries, minus that block. */
async function stepMessages(
  agent: HarnessOrchestratorAgent, stepNumber: number, messages: ModelMessage[],
): Promise<ModelMessage[]> {
  // The Think hook streamText calls, with this actor's real registered
  // extensions.
  const prepared = agent.beforeStep(prepareStepContext(stepNumber, messages));
  const config = prepared instanceof Promise ? await prepared : prepared;
  const rewritten = v.safeParse(v.object({ messages: v.array(v.custom<ModelMessage>(() => true)) }), config);
  const carried = rewritten.success ? rewritten.output.messages : messages;
  return carried.filter((m) => !v.is(DynamicContextSchema, m));
}


describe('a message typed while the agent is working', () => {
  test('recovers the active durable turn id after a reset before a device sweep', () => {
    const h = steerHarness();
    h.agent.harnessPersistActiveTurn('turn-before-reset');
    h.agent.harnessClearTurnCheckpoint();

    expect(h.agent.harnessDurableTurnId()).toBe('turn-before-reset');
  });

  test('is queued as the next ordinary turn when no turn is running', async () => {
    const h = steerHarness();
    // The actor commits the text to its own turn queue in the same slice as
    // the idle decision — the caller never re-sends, so another turn starting
    // first can no longer push these words to a later, unpredictable slot
    // (KINU-N026). The row carries the operator's authorship and the turn mode,
    // exactly as the ordinary send path would have written them.
    expect(await h.agent.steerTurn('nothing is running')).toEqual({ landed: 'queued' });
    expect(h.enqueued).toEqual([{
      text: 'nothing is running',
      metadata: { [TURN_AUTHOR_METADATA_KEY]: 'operator', kinuMode: 'build' },
    }]);
    // Nothing was buffered for a step boundary: the next turn's steps carry no splice.
    expect(await stepMessages(h.agent, 0, HISTORY)).toEqual(HISTORY);
  });

  test('a plan-mode steer that missed its turn queues a plan turn, not a build one', async () => {
    const h = steerHarness();
    await h.agent.steerTurn('tighten the rollout plan first', 'plan');
    expect(h.enqueued[0]?.metadata).toEqual({ [TURN_AUTHOR_METADATA_KEY]: 'operator', kinuMode: 'plan' });
  });

  test('a refused enqueue rejects rather than reporting the words placed', async () => {
    const h = steerHarness();
    Reflect.set(h.agent, '_host', {
      broadcast: () => {},
      enqueueTurn: async () => ({ status: 'skipped' as const }),
      turnInFlight: () => false,
      setTimer: () => {},
      headRuntime: undefined,
    });
    // The composer's rejection path returns the draft to the user — an answer
    // claiming placement here would be the silent text loss this closes.
    await expect(h.agent.steerTurn('nothing is running')).rejects.toThrow(/could not be queued/);
  });

  test('is taken mid-turn, announced as queued, and reaches the model at the next step', async () => {
    const h = steerHarness();
    h.startTurn();

    expect(await h.agent.steerTurn('also check staging')).toEqual({ landed: 'mid-turn' });

    // Announced BEFORE the model has it — "we took your words" is a different
    // fact from "the model is reading them", and the composer needs the first
    // one immediately.
    expect(steerFrames(h.frames)).toEqual([
      { type: 'steer_status', status: 'queued', steerId: expect.any(String), text: 'also check staging' },
    ]);
    expect(h.appended).toEqual([]);

    // The step the model runs next carries it verbatim, at the tail — after the
    // latest results, which is what keeps role alternation provider-safe.
    expect(await stepMessages(h.agent, 0, HISTORY)).toEqual([
      ...HISTORY,
      { role: 'user', content: 'also check staging' },
    ]);

    const landed = steerFrames(h.frames);
    expect(landed.map((f) => f.status)).toEqual(['queued', 'landed']);
    // Same id through both announcements, so a surface tracking one steer never
    // renders it twice under two names.
    expect(landed[1]!.steerId).toBe(landed[0]!.steerId);
  });

  test('restores a reset-lost steer from SQL before the resumed turn reaches its next step', async () => {
    const h = steerHarness();
    h.startTurn();
    const turnId = h.agent.harnessDurableTurnId();
    if (turnId === null) throw new Error('expected the harness turn to be durable');
    await h.agent.steerTurn('recover this after reset');

    h.agent.harnessRestorePendingSteers(turnId);

    expect(await stepMessages(h.agent, 3, HISTORY)).toEqual([
      ...HISTORY,
      { role: 'user', content: 'recover this after reset' },
    ]);
  });

  test('persists as a VERBATIM user row carrying the id and the step it landed in', async () => {
    const h = steerHarness();
    h.startTurn();
    await h.agent.steerTurn('also check staging');
    await stepMessages(h.agent, 4, HISTORY);

    // A user row, not a card and not a rewritten summary: the walk-back fork
    // cuts the conversation at a user message, so a steer the model acted on
    // has to be one of those or the fork cannot reach it.
    //
    // And it records WHICH step. A turn is one assistant message, so without
    // the index a reader can only be told the steer happened somewhere in it —
    // which is how the operator's words ended up drawn under twenty steps of
    // work that preceded them.
    expect(h.appended).toEqual([[{
      id: steerFrames(h.frames)[0]!.steerId,
      role: 'user',
      parts: [{ type: 'text', text: 'also check staging' }],
      metadata: { kinuSteer: true, kinuSteerAtStep: 4 },
    }]]);
    // The live broadcast states the same position, so a surface watching the
    // turn puts the bubble where the reload will.
    expect(steerFrames(h.frames)[1]).toMatchObject({ status: 'landed', atStep: 4 });
  });

  test('two steers merge into one user message but persist as two rows', async () => {
    const h = steerHarness();
    h.startTurn();
    await h.agent.steerTurn('also check staging');
    await h.agent.steerTurn('and the logs');

    expect(await stepMessages(h.agent, 0, HISTORY)).toEqual([
      ...HISTORY,
      { role: 'user', content: 'also check staging\n\nand the logs' },
    ]);
    // One message to the model (role alternation), two rows in history (the
    // fork pivot matches an individual user message).
    expect(h.appended[0]?.map((m) => m.parts)).toEqual([
      [{ type: 'text', text: 'also check staging' }],
      [{ type: 'text', text: 'and the logs' }],
    ]);
  });

  test('an empty steer is refused outright rather than sent as a blank turn', async () => {
    const h = steerHarness();
    h.startTurn();
    await expect(h.agent.steerTurn('   ')).rejects.toThrow(/requires the message text/);
  });
});

describe('stopping a turn with a steer still pending', () => {
  test('hands the text back to the caller instead of eating it', async () => {
    const h = steerHarness();
    h.startTurn();
    await h.agent.steerTurn('change of plans');

    const outcome = await h.agent.cancelCurrentWork();

    // Stop means stop — it does not mean "stop and then do what I typed". But
    // the chat already rendered it as sent, so losing it silently is the one
    // outcome that cannot be explained to the person who typed it.
    expect(outcome.returnedSteers).toEqual(['change of plans']);
    // Every other open tab learns the same thing from the broadcast.
    expect(steerFrames(h.frames).map((f) => f.status)).toEqual(['queued', 'returned']);
    // And it was DROPPED: a later step must not splice a steer the user took back.
    expect(await stepMessages(h.agent, 1, HISTORY)).toEqual(HISTORY);
    expect(h.appended).toEqual([]);
  });

  test('leaves a steer the model already read alone — an interrupt cannot un-send it', async () => {
    const h = steerHarness();
    h.startTurn();
    await h.agent.steerTurn('also check staging');
    await stepMessages(h.agent, 0, HISTORY);

    expect((await h.agent.cancelCurrentWork()).returnedSteers).toEqual([]);
    expect(h.appended).toHaveLength(1);
  });
});

describe('a steer that never saw a step boundary', () => {
  test('reruns as a USER-origin turn, not as a programmatic one', async () => {
    const h = steerHarness();
    h.startTurn();
    // Typed while the model was already writing its final answer: there is no
    // further step for it to land on.
    await h.agent.steerTurn('one more thing');

    await h.agent.onChatResponse({
      status: 'completed',
      requestId: 'req-1',
      continuation: false,
      message: { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: 'deployed' }] },
    });

    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]).toMatchObject({
      text: 'one more thing',
      metadata: { kinuAuthor: 'operator', kinuMode: 'build' },
      idempotencyKey: expect.stringMatching(/^steer-rerun:turn-.*:build:steer-/),
    });
    // NO kinuEvent: every provenance decision downstream reads this as the
    // user's own next message, which is what it is. Stamping an event here
    // would make it a programmatic turn — one-shot surface, no outcome review,
    // a card instead of a bubble.
    expect(h.enqueued[0]).not.toHaveProperty('metadata.kinuEvent');
    // And it must SAY it is the operator's, because the enqueue seam gives
    // every row it writes the `programmatic:` id prefix. Left silent, the
    // provenance fallback reads that prefix and files the owner's own sentence
    // as the harness's.
  });

  test('keeps noncontiguous mode groups distinct while preserving each group across duplicate terminal callbacks', async () => {
    const h = steerHarness();
    h.startTurn();
    await h.agent.steerTurn('first build', 'build');
    await h.agent.steerTurn('plan next', 'plan');
    await h.agent.steerTurn('second build', 'build');
    const settled = {
      status: 'completed' as const,
      continuation: false,
      message: { id: 'assistant-groups', role: 'assistant' as const, parts: [{ type: 'text' as const, text: 'ok' }] },
    };

    await h.agent.onChatResponse({ ...settled, requestId: 'req-groups' });
    await h.agent.onChatResponse({ ...settled, requestId: 'req-groups-duplicate' });

    expect(h.enqueued).toHaveLength(3);
    expect(h.enqueued.map((turn) => turn.text)).toEqual(['first build', 'plan next', 'second build']);
    // SAFETY: every steer this test enqueued carries { kinuMode } metadata —
    // the three steerTurn calls above wrote it — and the harness stores turn
    // metadata as opaque JSON, so the read side re-narrows what this file put in.
    expect(h.enqueued.map((turn) => (turn.metadata as { kinuMode: string }).kinuMode)).toEqual(['build', 'plan', 'build']);
    expect(new Set(h.enqueued.map((turn) => turn.idempotencyKey)).size).toBe(3);
  });

  test('is not rerun twice — the turn that takes it drains it', async () => {
    const h = steerHarness();
    h.startTurn();
    await h.agent.steerTurn('one more thing');
    const settled = {
      status: 'completed' as const,
      continuation: false,
      message: { id: 'assistant-1', role: 'assistant' as const, parts: [{ type: 'text' as const, text: 'ok' }] },
    };
    await h.agent.onChatResponse({ ...settled, requestId: 'req-1' });
    await h.agent.onChatResponse({ ...settled, requestId: 'req-2' });
    expect(h.enqueued).toHaveLength(1);
  });
});
