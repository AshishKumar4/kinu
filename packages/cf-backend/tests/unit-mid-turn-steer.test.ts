/**
 * Mid-turn steering on the hosted backend through the real `steerTurn` RPC and `beforeStep` hook.
 * Defends: Enter mid-turn doing nothing on cloud surfaces. `beforeStep` is called directly because Think's loop needs workerd.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { turnAuthor, type ProgrammaticTurn } from '@kinu.run/core';
import type { ModelMessage } from 'ai';
import type { SessionMessage } from 'agents/experimental/memory/session';
import * as v from 'valibot';
import { orchestratorHarness, reactivateOrchestratorHarness, chatSessionTurns, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import { present } from '@kinu.run/test-utils';

const SteerFrameSchema = v.object({
  type: v.literal('steer_status'),
  status: v.picklist(['queued', 'landed', 'returned', 'turn']),
  steerId: v.string(),
  text: v.string(),
  atStep: v.optional(v.number()),
});

function steerFrames(frames: readonly string[]) {
  return frames.flatMap((frame) => {
    const parsed = v.safeParse(SteerFrameSchema, JSON.parse(frame));

    return parsed.success ? [parsed.output] : [];
  });
}

interface SteerHarness {
  agent: HarnessOrchestratorAgent;
  /** pending_steers is SQL authority, so dead-turn rows and admission deletes are asserted here, not in RAM. */
  db: Database;
  frames: string[];
  appended(): Promise<SessionMessage[]>;
  enqueued: ProgrammaticTurn[];
  /** `liveTurnId` names the turn, which is what makes a resumed turn re-bind under it. */
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

/** Asserted by the step-pipeline suite; filtered here so steer assertions read as user-visible messages. */
const DynamicContextSchema = v.object({
  role: v.literal('user'),
  content: v.pipe(v.string(), v.includes('<dynamic_context')),
});

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
    // Committed to the turn queue in the same slice as the idle decision, so no later turn can reorder these words (KINU-N026).
    expect(await h.agent.harnessChatLoop.send('nothing is running')).toBe('turn');
    const admitted = (await h.agent.harnessTranscript.history()).filter((message) => message.role === 'user');
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.parts).toEqual([{ type: 'text', text: 'nothing is running' }]);
    expect(turnAuthor(admitted[0])).toBe('operator');
    expect(h.db.query('SELECT work_mode FROM actor_turn_claims WHERE turn_id = ?').get(admitted[0].id)).toEqual({ work_mode: 'build' });
    expect(present(h.db.query<{ c: number }, []>('SELECT count(*) AS c FROM pending_steers').get(), 'the pending_steers count row').c).toBe(0);

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
    // The composer returns the draft on refusal; claiming placement here would be silent text loss.
    h.agent.harnessRefuseDriving({ reason: 'unavailable', error: 'another session is driving this workspace' });
    await expect(h.agent.harnessChatLoop.send('nothing is running')).rejects.toThrow(/another session is driving/);
    expect(present(h.db.query<{ c: number }, []>('SELECT count(*) AS c FROM pending_steers').get(), 'the pending_steers count row').c).toBe(0);
  });

  test('is taken mid-turn, announced as queued, and reaches the model at the next step', async () => {
    const h = steerHarness();
    await h.startTurn();

    await h.agent.send('also check staging', 'steer-staging');

    // Announced before the model has it: the composer needs "we took your words" immediately.
    expect(steerFrames(h.frames)).toEqual([
      { type: 'steer_status', status: 'queued', steerId: expect.any(String), text: 'also check staging' },
    ]);
    expect((await h.appended())).toEqual([]);

    // At the tail, after the latest results, which keeps role alternation provider-safe.
    expect(await stepMessages(h.agent, 0, HISTORY)).toEqual([
      ...HISTORY,
      { role: 'user', content: 'also check staging' },
    ]);

    const landed = steerFrames(h.frames);
    expect(landed.map((f) => f.status)).toEqual(['queued', 'landed']);
    expect(landed[1].steerId).toBe(landed[0].steerId);
  });

  test('a steer that names a skill the turn does not carry brings its body to the next step', async () => {
    // Skills resolve when the turn opens, so a mid-turn steer naming one must still activate it.
    const h = steerHarness();
    await h.startTurn();

    await h.agent.send('now build a slate that answers GET /ping', 'steer-ping');

    const carried = await stepMessages(h.agent, 0, HISTORY);
    expect(carried[HISTORY.length]).toEqual({ role: 'user', content: 'now build a slate that answers GET /ping' });
    const reference = carried[HISTORY.length + 1];
    expect(reference?.role).toBe('user');
    expect(JSON.stringify(reference?.content)).toContain('### slates');
    expect(JSON.stringify(reference?.content)).toContain('fetch(request)');
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

    // A user row, because the walk-back fork cuts at a user message; the step index places it within the turn.
    expect((await h.appended()).map((row) => JSON.parse(JSON.stringify(row)))).toEqual([{
      id: steerFrames(h.frames)[0].steerId,
      role: 'user',
      parts: [{ type: 'text', text: 'also check staging' }],
      metadata: { kinuSteer: true, kinuSteerAtStep: 4 },
    }]);
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
    // One message to the model (role alternation), two rows in history (the fork pivot matches an individual user message).
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

    // Written through SQL as an eviction leaves them; the next activation's loop is the restore/sweep entry point.
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

    expect(rerun.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'file', data: 'data:image/png;base64,AAAA', mediaType: 'image/png', filename: 'chart.png' },
        { type: 'text', text: 'attach this too' },
      ],
    });
    await chatSessionTurns(restarted.agent).settle({ messageId: 'a-rerun-file', text: 'attached' });
    expect(present(restarted.db.query<{ c: number }, []>('SELECT count(*) AS c FROM pending_steers').get(), 'the pending_steers count row').c).toBe(0);
  });
});

describe('stopping a turn with a steer still pending', () => {
  test('keeps the text queued instead of handing it back', async () => {
    const h = steerHarness();
    await h.startTurn();
    await h.agent.send('change of plans', 'steer-change');

    const outcome = await h.agent.cancelCurrentWork();

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
    await h.agent.send('one more thing', 'steer-5');
    const settled = await chatSessionTurns(h.agent).settle({ messageId: 'assistant-1', text: 'deployed', requestId: 'req-1' });

    expect(h.enqueued).toHaveLength(1);
    const steerId = steerFrames(h.frames).find((frame) => frame.status === 'queued')?.steerId;
    expect(steerId).toBeDefined();
    expect(h.enqueued[0]).toMatchObject({
      text: 'one more thing',
      origin: 'user',
      metadata: { kinuAuthor: 'operator', kinuMode: 'build' },
      idempotencyKey: `steer-rerun:${settled.turnId}:build:${steerId}`,
    });
    // No kinuEvent: that would make it a programmatic turn (one-shot surface, no outcome review, a card instead of a bubble).
    expect(h.enqueued[0]).not.toHaveProperty('metadata.kinuEvent');
    // The enqueue seam gives every row the `programmatic:` prefix, so the operator's authorship must be explicit.
  });

  test('answers its sender with the rerun, never with a guess at admission', async () => {
    const h = steerHarness();
    await h.startTurn();
    // What the send resolves with is the rows durable at that moment: the answer of the turn that ran the words.

    const atLanding = h.agent.harnessChatLoop.send('one more thing').then(async (landed) => ({
      landed,
      answers: (await h.agent.harnessTranscript.history()).filter((message) => message.role === 'assistant').map((message) => message.id),
    }));

    await chatSessionTurns(h.agent).settle({ messageId: 'assistant-1', text: 'deployed', requestId: 'req-1' });
    const landing = await atLanding;

    expect(landing.landed).toBe('turn');
    expect(landing.answers).toHaveLength(2);
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

    // Plan is the narrower grant, so one plan-mode message makes the whole rerun plan: merging never widens a grant.
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

    await h.startTurn('u-live');
    await h.agent.send('the live turn keeps me', 'steer-live');

    // Written through SQL: SQL, not RAM, is the authority an eviction tests.
    h.db.query(
      `INSERT INTO pending_steers (actor_id, id, turn_id, mode, text)
       VALUES (?, 'steer-dead-1', 'turn-dead', 'plan', 'orphaned by an eviction')`,
    ).run(actorId);
    h.db.query(
      `INSERT INTO pending_steers (actor_id, id, turn_id, mode, text)
       VALUES (?, 'steer-dead-2', 'turn-dead', 'plan', 'also orphaned')`,
    ).run(actorId);

    const restarted = await reactivateOrchestratorHarness(h.db);
    const resumed = await chatSessionTurns(restarted.agent).resume();
    expect(resumed.identity.turnId).toBe('u-live');

    expect(resumed.prompt.filter((message) => !v.is(DynamicContextSchema, message))).toEqual([
      { role: 'user', content: 'deploy the api' },
      { role: 'user', content: 'the live turn keeps me' },
    ]);
    await chatSessionTurns(restarted.agent).settle({ messageId: 'a-live-again', text: 'kept' });

    const rerun = present((await restarted.agent.harnessTranscript.history()).filter((message) => message.role === 'user').at(-1), 'the rerun user turn');

    expect(rerun.parts).toEqual([{ type: 'text', text: 'orphaned by an eviction\n\nalso orphaned' }]);
    expect(turnAuthor(rerun)).toBe('operator');
    expect(restarted.db.query('SELECT work_mode FROM actor_turn_claims WHERE turn_id = ?').get(rerun.id)).toEqual({ work_mode: 'plan' });

    expect(present(restarted.db.query<{ c: number }, []>('SELECT count(*) AS c FROM pending_steers').get(), 'the pending_steers count row').c).toBe(0);
  });
});
