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
import { turnAuthor, type ProgrammaticTurn } from '@kinu.run/core';
import type { ModelMessage } from 'ai';
import type { SessionMessage } from 'agents/experimental/memory/session';
import * as v from 'valibot';
import { orchestratorHarness, reactivateOrchestratorHarness, chatSessionTurns, type HarnessOrchestratorAgent } from './helpers/actor-harness';

const SteerFrameSchema = v.object({
  type: v.literal('steer_status'),
  status: v.picklist(['queued', 'landed', 'returned', 'turn']),
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
  /** The steer rows the turn's drains committed at their step boundaries —
   *  durable user rows beside the turn's own, each carrying the step it
   *  landed in. Read fresh each time: the rows are the observation. */
  appended(): Promise<SessionMessage[]>;
  /** Programmatic turns the loop was asked to admit through the host (the
   *  leftover rerun path). The turn still runs; this is what the seam handed
   *  over. */
  enqueued: ProgrammaticTurn[];
  /** Prepare a real turn — admitted by the loop and parked at its first model
   *  call — so it is in flight on the loop's own terms: the durable turn
   *  identity a steer binds to, and the step snapshot it lands on. `liveTurnId`
   *  names the turn, which is what makes a resumed turn re-bind under it. */
  startTurn(liveTurnId?: string): Promise<void>;
}

function steerHarness(): SteerHarness {
  const { agent, db } = orchestratorHarness();
  const frames: string[] = [];
  Reflect.set(agent, 'broadcast', (payload: string) => { frames.push(payload); });

  return {
    agent, db, frames,
    enqueued: agent.harnessEnqueued,
    appended: async () => (await agent.harnessTranscript.history())
      .filter((message) => message.role === 'user' && v.is(v.object({ metadata: v.object({ kinuSteer: v.literal(true) }) }), message)),
    startTurn: async (liveTurnId) => {
      if (liveTurnId !== undefined) chatSessionTurns(agent).open(liveTurnId);
      await chatSessionTurns(agent).prepare({ messages: [...HISTORY] });
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

/** The messages the step actually carries, minus that block. */
async function stepMessages(
  agent: HarnessOrchestratorAgent, stepNumber: number, messages: readonly ModelMessage[],
): Promise<ModelMessage[]> {
  const carried = await chatSessionTurns(agent).step(stepNumber, messages);

  return carried.filter((m) => !v.is(DynamicContextSchema, m));
}


describe('a message typed while the agent is working', () => {
  test('recovers the active durable turn id after a reset before a device sweep', async () => {
    const h = steerHarness();
    await h.agent.harnessPersistActiveTurn('turn-before-reset');

    expect(h.agent.harnessDurableTurnId()).toBe('turn-before-reset');
  });

  test('is queued as the next ordinary turn when no turn is running', async () => {
    const h = steerHarness();
    // The actor commits the text to its own turn queue in the same slice as
    // the idle decision — the caller never re-sends, so another turn starting
    // first can no longer push these words to a later, unpredictable slot
    // (KINU-N026). The row carries the operator's authorship and the turn mode,
    // exactly as the ordinary send path would have written them.
    expect(await h.agent.harnessChatLoop.send('nothing is running')).toBe('turn');
    // The loop admitted it as a turn of its own, under the operator's
    // authorship and the turn mode: the user row it left, and the claim the
    // turn ran under, say so. The reservation was spent by that row.
    const admitted = (await h.agent.harnessTranscript.history()).filter((message) => message.role === 'user');
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.parts).toEqual([{ type: 'text', text: 'nothing is running' }]);
    expect(turnAuthor(admitted[0])).toBe('operator');
    expect(h.db.query('SELECT work_mode FROM actor_turn_claims WHERE turn_id = ?').get(admitted[0].id)).toEqual({ work_mode: 'build' });
    expect(h.db.query<{ c: number }, []>('SELECT count(*) AS c FROM pending_steers').get()!.c).toBe(0);

    // Nothing was buffered for a step boundary: the next turn's steps carry no
    // splice — the step hands the model exactly the conversation the turn was
    // admitted over. The prepared turn is the one production opens, so the
    // step reads its prepared snapshot.
    const turn = await chatSessionTurns(h.agent).prepare({ messages: [...HISTORY] });

    expect(await stepMessages(h.agent, 0, turn.messages)).toEqual([...turn.messages]);
  });

  test('a plan-mode steer that missed its turn queues a plan turn, not a build one', async () => {
    const h = steerHarness();
    await h.agent.harnessChatLoop.send('tighten the rollout plan first', { mode: 'plan' });
    const admitted = (await h.agent.harnessTranscript.history()).filter((message) => message.role === 'user');
    expect(turnAuthor(admitted[0])).toBe('operator');
    expect(h.db.query('SELECT work_mode FROM actor_turn_claims WHERE turn_id = ?').get(admitted[0].id)).toEqual({ work_mode: 'plan' });
  });

  test('a refused enqueue rejects rather than reporting the words placed', async () => {
    const h = steerHarness();
    // The one refusal the loop answers an idle send with: this process may
    // not drive. The composer's rejection path returns the draft to the user —
    // an answer claiming placement here would be the silent text loss this
    // closes — and the reservation is retired with it.
    h.agent.harnessRefuseDriving({ reason: 'unavailable', error: 'another session is driving this workspace' });
    await expect(h.agent.harnessChatLoop.send('nothing is running')).rejects.toThrow(/another session is driving/);
    expect(h.db.query<{ c: number }, []>('SELECT count(*) AS c FROM pending_steers').get()!.c).toBe(0);
  });

  test('is taken mid-turn, announced as queued, and reaches the model at the next step', async () => {
    const h = steerHarness();
    await h.startTurn();

    await h.agent.send('also check staging', 'steer-staging');

    // Announced BEFORE the model has it — "we took your words" is a different
    // fact from "the model is reading them", and the composer needs the first
    // one immediately.
    expect(steerFrames(h.frames)).toEqual([
      { type: 'steer_status', status: 'queued', steerId: expect.any(String), text: 'also check staging' },
    ]);
    expect((await h.appended())).toEqual([]);

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
    expect(landed[1].steerId).toBe(landed[0].steerId);
  });

  test('a steer that names a skill the turn does not carry brings its body to the next step', async () => {
    // Skills are resolved when the turn opens, from the opening message. A
    // send spliced mid-turn that names one — "build me a slate" typed while
    // the genesis turn runs — used to reach the model as bare words: the
    // first-run slate row on build cba44dcb9 read the ask at step 1 with no
    // slates body in the prompt, the model hunted skills/slates.md at five
    // paths, and wrote a server class with no fetch method.
    const h = steerHarness();
    await h.startTurn();

    await h.agent.send('now build a slate that answers GET /ping', 'steer-ping');

    const carried = await stepMessages(h.agent, 0, HISTORY);
    // The steer's words verbatim and durable, then the skill it activated as
    // this step's reference — after it, not merged into it.
    expect(carried[HISTORY.length]).toEqual({ role: 'user', content: 'now build a slate that answers GET /ping' });
    const reference = carried[HISTORY.length + 1];
    expect(reference?.role).toBe('user');
    expect(JSON.stringify(reference?.content)).toContain('### slates');
    expect(JSON.stringify(reference?.content)).toContain('fetch(request)');
    // Only the steer is a durable row; the reference rides the step.
    expect((await h.appended()).filter((row) => row.role === 'user')).toHaveLength(1);
  });

  test('restores a reset-lost steer from SQL before the resumed turn reaches its next step', async () => {
    const h = steerHarness();
    await h.startTurn();
    const turnId = h.agent.harnessDurableTurnId();

    if (turnId === null) throw new Error('expected the harness turn to be durable');
    await h.agent.send('recover this after reset', 'steer-recover');

    h.agent.harnessRestorePendingSteers(turnId);

    expect(await stepMessages(h.agent, 3, HISTORY)).toEqual([
      ...HISTORY,
      { role: 'user', content: 'recover this after reset' },
    ]);
  });

  test('persists as a VERBATIM user row carrying the id and the step it landed in', async () => {
    const h = steerHarness();
    await h.startTurn();
    await h.agent.send('also check staging', 'steer-1');
    await stepMessages(h.agent, 4, HISTORY);

    // A user row, not a card and not a rewritten summary: the walk-back fork
    // cuts the conversation at a user message, so a steer the model acted on
    // has to be one of those or the fork cannot reach it.
    //
    // And it records WHICH step. A turn is one assistant message, so without
    // the index a reader can only be told the steer happened somewhere in it —
    // which is how the operator's words ended up drawn under twenty steps of
    // work that preceded them.
    expect((await h.appended()).map((row) => JSON.parse(JSON.stringify(row)))).toEqual([{
      id: steerFrames(h.frames)[0].steerId,
      role: 'user',
      parts: [{ type: 'text', text: 'also check staging' }],
      metadata: { kinuSteer: true, kinuSteerAtStep: 4 },
    }]);
    // The live broadcast states the same position, so a surface watching the
    // turn puts the bubble where the reload will.
    expect(steerFrames(h.frames)[1]).toMatchObject({ status: 'landed', atStep: 4 });
  });

  test('two steers merge into one user message but persist as two rows', async () => {
    const h = steerHarness();
    await h.startTurn();
    await h.agent.send('also check staging', 'steer-2');
    await h.agent.send('and the logs', 'steer-3');

    expect(await stepMessages(h.agent, 0, HISTORY)).toEqual([
      ...HISTORY,
      { role: 'user', content: 'also check staging\n\nand the logs' },
    ]);
    // One message to the model (role alternation), two rows in history (the
    // fork pivot matches an individual user message).
    expect((await h.appended()).map((m) => m.parts)).toEqual([
      [{ type: 'text', text: 'also check staging' }],
      [{ type: 'text', text: 'and the logs' }],
    ]);
  });

  test('an empty steer is refused outright rather than sent as a blank turn', async () => {
    const h = steerHarness();
    await h.startTurn();
    await expect(h.agent.send('   ', 'steer-blank')).rejects.toThrow(/requires the message text/);
  });

  test('a pending steer with an attachment survives a reset intact — the rerun carries real file data', async () => {
    const h = steerHarness();
    const actorId = h.agent.observeRuntime().actor.actorId;

    // A dead turn's steer + its attachment, written through SQL the way an
    // eviction leaves them — rows the activation that never reached a settle
    // left behind. The next activation's loop is the restore/sweep entry
    // point: built under the wake, it sweeps them into one user-origin rerun.
    h.db.query(
      `INSERT INTO pending_steers (actor_id, id, turn_id, mode, text)
       VALUES (?, 'steer-dead-file', 'turn-dead', 'build', 'attach this too')`,
    ).run(actorId);
    h.db.query(
      `INSERT INTO pending_steer_files (actor_id, steer_id, filename, media_type, url)
       VALUES (?, 'steer-dead-file', 'chart.png', 'image/png', 'data:image/png;base64,AAAA')`,
    ).run(actorId);

    const restarted = await reactivateOrchestratorHarness(h.db);
    const rerun = await chatSessionTurns(restarted.agent).resume();

    // The orphan reruns as a user-origin turn — and its file rides with real
    // fields, not the field-less `[{}]` a shadowed file read produced: the
    // model is asked with the attachment beside the words.
    expect(rerun.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'file', data: 'data:image/png;base64,AAAA', mediaType: 'image/png', filename: 'chart.png' },
        { type: 'text', text: 'attach this too' },
      ],
    });
    await chatSessionTurns(restarted.agent).settle({ messageId: 'a-rerun-file', text: 'attached' });
    expect(restarted.db.query<{ c: number }, []>('SELECT count(*) AS c FROM pending_steers').get()!.c).toBe(0);
  });
});

describe('stopping a turn with a steer still pending', () => {
  test('keeps the text queued instead of handing it back', async () => {
    const h = steerHarness();
    await h.startTurn();
    await h.agent.send('change of plans', 'steer-change');

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
    await h.agent.send('also check staging', 'steer-4');
    await stepMessages(h.agent, 0, HISTORY);

    expect(await h.agent.cancelCurrentWork()).not.toHaveProperty('returnedSteers');
    expect((await h.appended())).toHaveLength(1);
  });

  test('two queued steers become the next turn text in order once the abort settles', async () => {
    const h = steerHarness();
    await h.startTurn();
    await h.agent.send('first', 'steer-first');
    await h.agent.send('second', 'steer-second');
    await h.agent.cancelCurrentWork();

    await chatSessionTurns(h.agent).settle({ messageId: 'assistant-stop', text: 'partial', requestId: 'req-stop', status: 'aborted' });
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
    await h.agent.send('one more thing', 'steer-5');
    const settled = await chatSessionTurns(h.agent).settle({ messageId: 'assistant-1', text: 'deployed', requestId: 'req-1' });

    expect(h.enqueued).toHaveLength(1);
    // The rerun key names the turn it interrupts and the steer it re-runs,
    // exactly — never a private id or a shape a same-form key could fake.
    const steerId = steerFrames(h.frames).find((frame) => frame.status === 'queued')?.steerId;
    expect(steerId).toBeDefined();
    expect(h.enqueued[0]).toMatchObject({
      text: 'one more thing',
      origin: 'user',
      metadata: { kinuAuthor: 'operator', kinuMode: 'build' },
      idempotencyKey: `steer-rerun:${settled.turnId}:build:${steerId}`,
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

  test('answers its sender with the rerun, never with a guess at admission', async () => {
    const h = steerHarness();
    await h.startTurn();
    // The first-run row `every-tool` sent its prompt while the genesis turn
    // was writing its only answer. The loop said `mid-turn` at admission, the
    // harness counted the reply under the genesis run, and the tool list the
    // rerun then produced was never read. What the send resolves with is the
    // rows durable at that moment: the answer of the turn that ran the words.

    const atLanding = h.agent.harnessChatLoop.send('one more thing').then(async (landed) => ({
      landed,
      answers: (await h.agent.harnessTranscript.history()).filter((message) => message.role === 'assistant').map((message) => message.id),
    }));

    await chatSessionTurns(h.agent).settle({ messageId: 'assistant-1', text: 'deployed', requestId: 'req-1' });
    const landing = await atLanding;

    expect(landing.landed).toBe('turn');
    // The live turn's answer AND the rerun's were on disk before the sender
    // heard anything; a verdict at admission would have seen neither.
    expect(landing.answers).toHaveLength(2);
    // The rerun opened under the steer's own id, and every open surface heard
    // the words became a turn — the fact a composer that only admitted them
    // reads its landing from.
    const steerId = steerFrames(h.frames).find((frame) => frame.status === 'queued')?.steerId;
    expect(steerFrames(h.frames).map((frame) => frame.status)).toEqual(['queued', 'turn']);
    expect((await h.agent.harnessTranscript.history()).filter((message) => message.role === 'user').at(-1)?.id).toBe(steerId);
  });

  test('leftovers of mixed modes rerun as ONE plan turn, once, across duplicate terminal callbacks', async () => {
    const h = steerHarness();
    await h.startTurn();
    await h.agent.send('first build', 'steer-b1', [], 'build');
    await h.agent.send('plan next', 'steer-p', [], 'plan');
    await h.agent.send('second build', 'steer-b2', [], 'build');

    await chatSessionTurns(h.agent).settle({ messageId: 'assistant-groups', text: 'ok', requestId: 'req-groups' });
    await chatSessionTurns(h.agent).settle({ messageId: 'assistant-groups', text: 'ok', requestId: 'req-groups-duplicate' });

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
    await h.agent.send('one more thing', 'steer-6');

    await chatSessionTurns(h.agent).settle({ messageId: 'assistant-1', text: 'ok', requestId: 'req-1' });
    await chatSessionTurns(h.agent).settle({ messageId: 'assistant-1', text: 'ok', requestId: 'req-2' });
    expect(h.enqueued).toHaveLength(1);
  });
});

describe('an eviction with acknowledged steers', () => {
  test('restores only the live turn\'s rows and sweeps a dead turn\'s as one user-origin turn', async () => {
    const h = steerHarness();
    const actorId = h.agent.observeRuntime().actor.actorId;

    // A real activation drives this turn under the id of its driving user
    // message; naming that id is what makes the resume re-bind under it.
    await h.startTurn('u-live');
    await h.agent.send('the live turn keeps me', 'steer-live');

    // A second, DEAD turn's reservation: the activation that owned it never
    // reached its settle. Written through SQL, because the point is that SQL —
    // not RAM — is the authority an eviction tests.
    h.db.query(
      `INSERT INTO pending_steers (actor_id, id, turn_id, mode, text)
       VALUES (?, 'steer-dead-1', 'turn-dead', 'plan', 'orphaned by an eviction')`,
    ).run(actorId);
    h.db.query(
      `INSERT INTO pending_steers (actor_id, id, turn_id, mode, text)
       VALUES (?, 'steer-dead-2', 'turn-dead', 'plan', 'also orphaned')`,
    ).run(actorId);

    // The reset: the isolate dies with the live turn in flight; the run ledger
    // holds that turn open, and the SQL rows survive. The next activation's
    // loop re-opens the live turn from its ledger, restores ITS rows for the
    // continuation's first step, and sweeps the dead turn's.
    const restarted = await reactivateOrchestratorHarness(h.db);
    const resumed = await chatSessionTurns(restarted.agent).resume();
    expect(resumed.identity.turnId).toBe('u-live');

    // The live turn's next step splices ITS words only — the dead turn's stay
    // out of a conversation they were never typed for: what the continuation
    // asked the model is the conversation it was admitted against, then its
    // own steer, at the tail.
    expect(resumed.prompt.filter((message) => !v.is(DynamicContextSchema, message))).toEqual([
      { role: 'user', content: 'deploy the api' },
      { role: 'user', content: 'the live turn keeps me' },
    ]);
    await chatSessionTurns(restarted.agent).settle({ messageId: 'a-live-again', text: 'kept' });

    // The dead turn's rows rerun as ONE user-origin turn, the words in typed
    // order, mode-stamped by their narrower grant: plan.
    const rerun = (await restarted.agent.harnessTranscript.history()).filter((message) => message.role === 'user').at(-1);
    expect(rerun?.parts).toEqual([{ type: 'text', text: 'orphaned by an eviction\n\nalso orphaned' }]);
    expect(turnAuthor(rerun!)).toBe('operator');
    expect(restarted.db.query('SELECT work_mode FROM actor_turn_claims WHERE turn_id = ?').get(rerun!.id)).toEqual({ work_mode: 'plan' });

    // Admission deleted them, and the live row's step drain deleted it too:
    // nothing is left to sweep twice.
    expect(restarted.db.query<{ c: number }, []>('SELECT count(*) AS c FROM pending_steers').get()!.c).toBe(0);
  });
});
