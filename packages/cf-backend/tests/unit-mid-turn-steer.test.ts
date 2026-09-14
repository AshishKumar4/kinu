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
import type { Database } from 'bun:sqlite';
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
  /** The harness's own SQLite — pending_steers is SQL authority, so the dead
   *  turn's rows and the admission delete are asserted here, not in RAM. */
  db: Database;
  frames: string[];
  /** Durable rows the actor appended without starting a turn. */
  appended: UIMessage[][];
  /** Programmatic turns the actor enqueued (the leftover rerun path). */
  enqueued: Array<{
    text: string; metadata?: unknown; idempotencyKey?: string;
    origin?: 'user'; steerIds?: readonly string[];
  }>;
  /** Prepare a real turn: beforeTurn sets the in-flight flag, the durable
   *  turn identity and the step snapshot a steer must land on. */
  startTurn(): Promise<void>;
}

function steerHarness(): SteerHarness {
  const { agent, db } = orchestratorHarness();
  const frames: string[] = [];
  const appended: UIMessage[][] = [];
  const enqueued: SteerHarness['enqueued'] = [];
  let inFlight = false;
  Reflect.set(agent, 'broadcast', (payload: string) => { frames.push(payload); });
  // `addMessages` is Think's "append to history WITHOUT starting a turn" API and
  // needs a live Session; the harness has none, so the observation is that the
  // actor asked for the right rows.
  Reflect.set(agent, 'addMessages', async (messages: UIMessage[]) => { appended.push(messages); });
  Reflect.set(agent, '_host', {
    broadcast: (event: { type: string }) => { frames.push(JSON.stringify(event)); },
    enqueueTurn: async (turn: SteerHarness['enqueued'][number]) => {
      enqueued.push(turn);
      // Admission deletes the acknowledged rows — the real host's enqueueTurn
      // does this inside the same call, so a suite reading the table afterwards
      // sees what production would leave.

      for (const id of turn.steerIds ?? []) {
        db.query('DELETE FROM pending_steers WHERE id = ?').run(id);
      }

      return { status: 'queued' as const };
    },
    turnInFlight: () => inFlight,
    setTimer: () => {},
    headRuntime: undefined,
  });
  // The harness builds `orch` during onStart — with the REAL host captured —
  // before this swap can run. The signal seam holds that capture, so rebuild
  // it: the next `this.orch` read materializes over the fake host, and the
  // pending queue it would have held was empty anyway.
  Reflect.set(agent, '_orch', null);

  return {
    agent, db, frames, appended, enqueued,
    startTurn: async () => {
      // Production opens a turn through beforeTurn; driving the same entry
      // point gives beforeStep the prepared snapshot it refuses without, and
      // writes the durable turn identity a mid-turn steer binds to.
      await agent.beforeTurn({
        system: 'sys', messages: [...HISTORY], tools: {}, model: HARNESS_MODEL,
        continuation: false, body: {},
      });

      inFlight = true;
      Reflect.set(agent, '_inFlight', true);
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
    expect(await h.agent.send('nothing is running')).toEqual({ landed: 'turn' });
    expect(h.enqueued).toEqual([{
      text: 'nothing is running',
      metadata: { [TURN_AUTHOR_METADATA_KEY]: 'operator', kinuMode: 'build' },
      origin: 'user',
      steerIds: [expect.stringMatching(/^steer-/)],
    }]);

    // Nothing was buffered for a step boundary: the next turn's steps carry no
    // splice. beforeTurn opens that turn the way production does, so beforeStep
    // reads its prepared snapshot.
    const turn = await h.agent.beforeTurn({
      system: 'sys', messages: [...HISTORY], tools: {}, model: HARNESS_MODEL,
      continuation: false, body: {},
    });

    expect(await stepMessages(h.agent, 0, turn?.messages ?? HISTORY)).toEqual(HISTORY);
  });

  test('a plan-mode steer that missed its turn queues a plan turn, not a build one', async () => {
    const h = steerHarness();
    await h.agent.send('tighten the rollout plan first', [], 'plan');
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
    await expect(h.agent.send('nothing is running')).rejects.toThrow(/could not be queued/);
  });

  test('is taken mid-turn, announced as queued, and reaches the model at the next step', async () => {
    const h = steerHarness();
    await h.startTurn();

    expect(await h.agent.send('also check staging')).toEqual({ landed: 'mid-turn' });

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
    await h.startTurn();
    const turnId = h.agent.harnessDurableTurnId();

    if (turnId === null) throw new Error('expected the harness turn to be durable');
    await h.agent.send('recover this after reset');

    h.agent.harnessRestorePendingSteers(turnId);

    expect(await stepMessages(h.agent, 3, HISTORY)).toEqual([
      ...HISTORY,
      { role: 'user', content: 'recover this after reset' },
    ]);
  });

  test('persists as a VERBATIM user row carrying the id and the step it landed in', async () => {
    const h = steerHarness();
    await h.startTurn();
    await h.agent.send('also check staging');
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
    await h.startTurn();
    await h.agent.send('also check staging');
    await h.agent.send('and the logs');

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
    await h.startTurn();
    await expect(h.agent.send('   ')).rejects.toThrow(/requires the message text/);
  });
});

describe('stopping a turn with a steer still pending', () => {
  test('keeps the text queued instead of handing it back', async () => {
    const h = steerHarness();
    await h.startTurn();
    await h.agent.send('change of plans');

    const outcome = await h.agent.cancelCurrentWork();

    // queued words stay queued: nothing returns to the composer, no `returned`
    // frame goes out, and a later step still splices the steer (it was kept,
    // not dropped).
    expect(outcome).not.toHaveProperty('returnedSteers');
    expect(steerFrames(h.frames).map((f) => f.status)).toEqual(['queued']);
    expect(await stepMessages(h.agent, 1, HISTORY)).toEqual([
      ...HISTORY,
      { role: 'user', content: 'change of plans' },
    ]);
  });

  test('leaves a steer the model already read alone', async () => {
    const h = steerHarness();
    await h.startTurn();
    await h.agent.send('also check staging');
    await stepMessages(h.agent, 0, HISTORY);

    expect(await h.agent.cancelCurrentWork()).not.toHaveProperty('returnedSteers');
    expect(h.appended).toHaveLength(1);
  });

  test('two queued steers become the next turn text in order once the abort settles', async () => {
    const h = steerHarness();
    await h.startTurn();
    await h.agent.send('first');
    await h.agent.send('second');
    await h.agent.cancelCurrentWork();

    await h.agent.onChatResponse({
      status: 'aborted',
      requestId: 'req-stop',
      continuation: false,
      message: { id: 'assistant-stop', role: 'assistant', parts: [{ type: 'text', text: 'partial' }] },
    });
    await h.agent.harnessJoinDetachedFibers();

    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]).toMatchObject({
      text: 'first\n\nsecond',
      metadata: { kinuAuthor: 'operator', kinuMode: 'build' },
    });
  });
});

describe('a steer that never saw a step boundary', () => {
  test('reruns as a USER-origin turn, not as a programmatic one', async () => {
    const h = steerHarness();
    await h.startTurn();
    // Typed while the model was already writing its final answer: there is no
    // further step for it to land on.
    await h.agent.send('one more thing');
    await h.agent.onChatResponse({
      status: 'completed',
      requestId: 'req-1',
      continuation: false,
      message: { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: 'deployed' }] },
    });

    expect(h.enqueued).toHaveLength(1);
    // The rerun key names the turn it interrupts and the steer it re-runs,
    // exactly — never a private id or a shape a same-form key could fake.
    const runs = await h.agent.listRuns({ limit: 1 });
    expect(runs.items).toHaveLength(1);
    const runId = runs.items[0]!.runId;
    const steerId = steerFrames(h.frames).find((frame) => frame.status === 'queued')?.steerId;
    expect(steerId).toBeDefined();
    expect(h.enqueued[0]).toMatchObject({
      text: 'one more thing',
      origin: 'user',
      metadata: { kinuAuthor: 'operator', kinuMode: 'build' },
      idempotencyKey: `steer-rerun:${runId}:build:${steerId}`,
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

  test('leftovers of mixed modes rerun as ONE plan turn, once, across duplicate terminal callbacks', async () => {
    const h = steerHarness();
    await h.startTurn();
    await h.agent.send('first build', [], 'build');
    await h.agent.send('plan next', [], 'plan');
    await h.agent.send('second build', [], 'build');

    const settled = {
      status: 'completed' as const,
      continuation: false,
      message: { id: 'assistant-groups', role: 'assistant' as const, parts: [{ type: 'text' as const, text: 'ok' }] },
    };

    await h.agent.onChatResponse({ ...settled, requestId: 'req-groups' });
    await h.agent.onChatResponse({ ...settled, requestId: 'req-groups-duplicate' });

    // One turn, the words in typed order. Plan is the narrower grant, so one
    // plan-mode message makes the whole rerun plan: merging never widens what
    // a message was typed under. The duplicate callback reruns nothing more.
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]).toMatchObject({
      text: 'first build\n\nplan next\n\nsecond build',
      metadata: { kinuMode: 'plan' },
      origin: 'user',
      idempotencyKey: expect.stringMatching(/^steer-rerun:.*:plan:steer-/),
    });
  });

  test('is not rerun twice — the turn that takes it drains it', async () => {
    const h = steerHarness();
    await h.startTurn();
    await h.agent.send('one more thing');

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

describe('an eviction with acknowledged steers', () => {
  test('restores only the live turn\'s rows and sweeps a dead turn\'s as one user-origin turn', async () => {
    const h = steerHarness();
    await h.startTurn();
    const liveTurnId = h.agent.harnessDurableTurnId();

    if (liveTurnId === null) throw new Error('expected the harness turn to be durable');
    await h.agent.send('the live turn keeps me');

    // A second, DEAD turn's reservation: the activation that owned it never
    // reached its settle. Written through SQL, because the point is that SQL —
    // not RAM — is the authority an eviction tests.
    const actorRow = h.db.query<{ actor_id: string }, [string]>(
      'SELECT actor_id FROM pending_steers WHERE turn_id = ?',
    ).get(liveTurnId);

    if (!actorRow) throw new Error('the live steer left no pending_steers row');
    h.db.query(
      `INSERT INTO pending_steers (actor_id, id, turn_id, mode, text)
       VALUES (?, 'steer-dead-1', 'turn-dead', 'plan', 'orphaned by an eviction')`,
    ).run(actorRow.actor_id);
    h.db.query(
      `INSERT INTO pending_steers (actor_id, id, turn_id, mode, text)
       VALUES (?, 'steer-dead-2', 'turn-dead', 'plan', 'also orphaned')`,
    ).run(actorRow.actor_id);

    h.agent.harnessRestorePendingSteers(liveTurnId);
    await h.agent.harnessJoinDetachedFibers();

    // The live turn's next step splices ITS words only — the dead turn's stay
    // out of a conversation they were never typed for.
    expect(await stepMessages(h.agent, 0, HISTORY)).toEqual([
      ...HISTORY,
      { role: 'user', content: 'the live turn keeps me' },
    ]);

    // The dead turn's rows rerun as ONE user-origin turn, mode-stamped by their
    // own rows and keyed by the turn they belonged to.
    expect(h.enqueued).toEqual([{
      text: 'orphaned by an eviction\n\nalso orphaned',
      origin: 'user',
      steerIds: ['steer-dead-1', 'steer-dead-2'],
      idempotencyKey: 'steer-rerun:turn-dead:plan:steer-dead-1',
      metadata: { kinuAuthor: 'operator', kinuMode: 'plan' },
    }]);

    // Admission deleted them, and the live row's step drain deleted it too:
    // nothing is left to sweep twice.
    expect(h.db.query<{ c: number }, []>('SELECT count(*) AS c FROM pending_steers').get()!.c).toBe(0);
  });
});
