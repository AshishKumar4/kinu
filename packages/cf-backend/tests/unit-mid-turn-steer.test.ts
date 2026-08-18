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
  enqueued: Array<{ text: string; metadata?: unknown }>;
  /** Declare a turn in flight, the way beforeTurn does. */
  startTurn(): void;
}

function steerHarness(): SteerHarness {
  const { agent } = orchestratorHarness();
  const frames: string[] = [];
  const appended: UIMessage[][] = [];
  const enqueued: Array<{ text: string; metadata?: unknown }> = [];
  let inFlight = false;
  Reflect.set(agent, 'broadcast', (payload: string) => { frames.push(payload); });
  // `addMessages` is Think's "append to history WITHOUT starting a turn" API and
  // needs a live Session; the harness has none, so the observation is that the
  // actor asked for the right rows.
  Reflect.set(agent, 'addMessages', async (messages: UIMessage[]) => { appended.push(messages); });
  Reflect.set(agent, '_host', {
    broadcast: (event: { type: string }) => { frames.push(JSON.stringify(event)); },
    enqueueTurn: async (turn: { text: string; metadata?: unknown }) => {
      enqueued.push(turn);
      return { status: 'queued' as const };
    },
    turnInFlight: () => inFlight,
    setTimer: () => {},
    headRuntime: undefined,
  });
  return {
    agent, frames, appended, enqueued,
    startTurn: () => { inFlight = true; Reflect.set(agent, '_inFlight', true); },
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
function stepMessages(
  agent: HarnessOrchestratorAgent, stepNumber: number, messages: ModelMessage[],
): ModelMessage[] {
  // The Think hook streamText calls, with this actor's real registered
  // extensions.
  const config = agent.beforeStep(prepareStepContext(stepNumber, messages));
  const rewritten = v.safeParse(v.object({ messages: v.array(v.custom<ModelMessage>(() => true)) }), config);
  const carried = rewritten.success ? rewritten.output.messages : messages;
  return carried.filter((m) => !v.is(DynamicContextSchema, m));
}


describe('a message typed while the agent is working', () => {
  test('is refused when no turn is running, so the surface sends it as a normal turn', async () => {
    const { agent } = steerHarness();
    // 'idle' is the whole point of the return value: the caller still owns the
    // text. A boolean here is what made the composer either drop input or
    // double-send it.
    expect(await agent.steerTurn('nothing is running')).toEqual({ landed: 'idle' });
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
    expect(stepMessages(h.agent, 0, HISTORY)).toEqual([
      ...HISTORY,
      { role: 'user', content: 'also check staging' },
    ]);

    const landed = steerFrames(h.frames);
    expect(landed.map((f) => f.status)).toEqual(['queued', 'landed']);
    // Same id through both announcements, so a surface tracking one steer never
    // renders it twice under two names.
    expect(landed[1]!.steerId).toBe(landed[0]!.steerId);
  });

  test('persists as a VERBATIM user row carrying the id the surface already has', async () => {
    const h = steerHarness();
    h.startTurn();
    await h.agent.steerTurn('also check staging');
    stepMessages(h.agent, 0, HISTORY);

    // A user row, not a card and not a rewritten summary: the walk-back fork
    // cuts the conversation at a user message, so a steer the model acted on
    // has to be one of those or the fork cannot reach it.
    expect(h.appended).toEqual([[{
      id: steerFrames(h.frames)[0]!.steerId,
      role: 'user',
      parts: [{ type: 'text', text: 'also check staging' }],
      metadata: { proteusSteer: true },
    }]]);
  });

  test('two steers merge into one user message but persist as two rows', async () => {
    const h = steerHarness();
    h.startTurn();
    await h.agent.steerTurn('also check staging');
    await h.agent.steerTurn('and the logs');

    expect(stepMessages(h.agent, 0, HISTORY)).toEqual([
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
    expect(stepMessages(h.agent, 1, HISTORY)).toEqual(HISTORY);
    expect(h.appended).toEqual([]);
  });

  test('leaves a steer the model already read alone — an interrupt cannot un-send it', async () => {
    const h = steerHarness();
    h.startTurn();
    await h.agent.steerTurn('also check staging');
    stepMessages(h.agent, 0, HISTORY);

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

    expect(h.enqueued).toEqual([{ text: 'one more thing' }]);
    // NO proteusEvent metadata: every provenance decision downstream reads this
    // as the user's own next message, which is what it is. Stamping an event
    // here would make it a programmatic turn — one-shot surface, no outcome
    // review, a card instead of a bubble.
    expect(h.enqueued[0]).not.toHaveProperty('metadata');
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
