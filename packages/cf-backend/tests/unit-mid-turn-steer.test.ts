/**
 * Mid-turn steering on the hosted backend through the real `steerTurn` RPC and `beforeStep` hook.
 * Defends: Enter mid-turn doing nothing on cloud surfaces. `beforeStep` is called directly because Think's loop needs workerd.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { actorConnectionTag, turnAuthor } from '@kinu.run/core';
import type { ModelMessage, UIMessage } from 'ai';
import * as v from 'valibot';
import {
  driveUntil, gatewayWorkspace, mainDatabase, orchestratorHarness, reactivateOrchestratorHarness, chatSessionTurns, storedChat,
  type HarnessOrchestratorAgent, workspaceMainActor,
} from './helpers/actor-harness';
import { asPane } from './helpers/agents-sdk';
import { chatCompletion, openingOf, stubAiBinding } from './helpers/platform-gateway';
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
  appended(): Promise<UIMessage[]>;
  /** `liveTurnId` names the turn, which is what makes a resumed turn re-bind under it. */
  startTurn(liveTurnId?: string): Promise<void>;
}

function steerHarness(): SteerHarness {
  const { agent, db } = orchestratorHarness();
  const frames: string[] = [];
  Reflect.set(agent, 'broadcast', (payload: string) => { frames.push(payload); });

  return {
    agent, db, frames,
    appended: async () => (await storedChat({ agent, db }))
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


describe('a message typed while the agent is working', () => {
  test('is queued as the next ordinary turn when no turn is running', async () => {
    const h = steerHarness();
    const turns = chatSessionTurns(h.agent);
    const opened = turns.park();

    // Committed to the turn queue in the same slice as the idle decision, so no later turn can reorder these words (KINU-N026).
    await h.agent.send('nothing is running', 'm-idle');
    const turn = await opened;
    const admitted = (await storedChat(h)).filter((message) => message.role === 'user');
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.parts).toEqual([{ type: 'text', text: 'nothing is running' }]);
    expect(turnAuthor(admitted[0])).toBe('operator');
    expect(mainDatabase(h).query('SELECT work_mode FROM actor_turn_claims WHERE turn_id = ?').get(admitted[0].id)).toEqual({ work_mode: 'build' });
    expect(steerFrames(h.frames)).toEqual([]);
    expect(turn.prompt.filter((m) => !v.is(DynamicContextSchema, m))).toEqual([...turn.messages]);

    // The words' reservation retires with the answer, in one transaction: nothing is left to redeliver.
    await turns.settle({ messageId: 'a-idle', text: 'ok' });
    expect(present(mainDatabase(h).query<{ c: number }, []>('SELECT count(*) AS c FROM pending_steers').get(), 'the pending_steers count row').c).toBe(0);
  });

  test('a plan-mode steer that missed its turn queues a plan turn, not a build one', async () => {
    const h = steerHarness();
    const opened = chatSessionTurns(h.agent).park();

    await h.agent.send('tighten the rollout plan first', 'm-plan', [], 'plan');
    await opened;
    const admitted = (await storedChat(h)).filter((message) => message.role === 'user');
    expect(turnAuthor(admitted[0])).toBe('operator');
    expect(mainDatabase(h).query('SELECT work_mode FROM actor_turn_claims WHERE turn_id = ?').get(admitted[0].id)).toEqual({ work_mode: 'plan' });
    await chatSessionTurns(h.agent).settle({ messageId: 'a-plan', text: 'ok' });
  });

  test('an empty steer is refused outright rather than sent as a blank turn', async () => {
    const h = steerHarness();
    await h.startTurn();
    await expect(h.agent.send('   ', 'steer-blank')).rejects.toThrow(/requires the message text/);
  });

  test('a pending steer with an attachment survives a reset intact — the rerun carries real file data', async () => {
    const h = steerHarness();
    const actorId = workspaceMainActor(h.db).actorId;

    // A turn is open in main's isolate, so the workspace holds its wake, as it does whenever it hands main words.
    await h.startTurn('u-live');
    // Written through SQL as an eviction leaves them, in main's own isolate (D9): the next activation's loop is the
    // restore/sweep entry point.
    mainDatabase(h).query(
      `INSERT INTO pending_steers (actor_id, id, turn_id, mode, text)
       VALUES (?, 'steer-dead-file', 'turn-dead', 'build', 'attach this too')`,
    ).run(actorId);
    mainDatabase(h).query(
      `INSERT INTO pending_steer_files (actor_id, steer_id, filename, media_type, url)
       VALUES (?, 'steer-dead-file', 'chart.png', 'image/png', 'data:image/png;base64,AAAA')`,
    ).run(actorId);

    const restarted = await reactivateOrchestratorHarness(h.db);
    const turns = chatSessionTurns(restarted.agent);

    // The live turn reopens first; the dead turn's steer reruns after it, before main's isolate rests.
    await turns.resume();
    const rerun = turns.park();
    const live = turns.settle({ messageId: 'a-live-again', text: 'kept' });

    expect((await rerun).messages.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'file', data: 'data:image/png;base64,AAAA', mediaType: 'image/png', filename: 'chart.png' },
        { type: 'text', text: 'attach this too' },
      ],
    });
    await turns.settle({ messageId: 'a-rerun-file', text: 'attached' });
    await live;
    expect(present(mainDatabase(restarted).query<{ c: number }, []>('SELECT count(*) AS c FROM pending_steers').get(), 'the pending_steers count row').c).toBe(0);
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
  });

  test('two queued steers become the next turn, in order, once the abort settles', async () => {
    const h = steerHarness();
    const turns = chatSessionTurns(h.agent);
    await h.startTurn();
    await h.agent.send('first', 'steer-first');
    await h.agent.send('second', 'steer-second');
    await h.agent.cancelCurrentWork();

    const rerun = turns.park();
    const stopped = turns.settle({ messageId: 'assistant-stop', text: 'partial', requestId: 'req-stop', status: 'aborted' });

    expect((await rerun).identity.turnId).toBe('steer-first');
    await turns.settle({ messageId: 'a-rerun', text: 'both done' });
    await stopped;

    const rerunRows = (await storedChat(h)).filter((message) => message.role === 'user').slice(-2);
    expect(rerunRows.map((message) => [message.id, message.parts, turnAuthor(message)])).toEqual([
      ['steer-first', [{ type: 'text', text: 'first' }], 'operator'],
      ['steer-second', [{ type: 'text', text: 'second' }], 'operator'],
    ]);
    expect(mainDatabase(h).query('SELECT work_mode FROM actor_turn_claims WHERE turn_id = ?').get('steer-first')).toEqual({ work_mode: 'build' });
  });
});

describe('a steer that never saw a step boundary', () => {
  test('reruns as a USER-origin turn, not as a programmatic one', async () => {
    const h = steerHarness();
    const turns = chatSessionTurns(h.agent);
    await h.startTurn();
    await h.agent.send('one more thing', 'steer-5');

    const rerun = turns.park();
    const first = turns.settle({ messageId: 'assistant-1', text: 'deployed', requestId: 'req-1' });

    expect((await rerun).identity.turnId).toBe('steer-5');
    const asked = present((await storedChat(h)).filter((message) => message.role === 'user').at(-1), 'the rerun\'s user row');
    expect(asked.id).toBe('steer-5');
    expect(turnAuthor(asked)).toBe('operator');
    // No kinuEvent: that would make it a programmatic turn (one-shot surface, no outcome review, a card instead of a bubble).
    expect(asked).not.toHaveProperty('metadata.kinuEvent');
    expect(mainDatabase(h).query('SELECT work_mode FROM actor_turn_claims WHERE turn_id = ?').get('steer-5')).toEqual({ work_mode: 'build' });
    await turns.settle({ messageId: 'a-rerun', text: 'done' });
    await first;
  });

  test('tells its sender the words became the next turn, under the id it holds', async () => {
    const h = steerHarness();
    const turns = chatSessionTurns(h.agent);
    await h.startTurn();
    await h.agent.send('one more thing', 'steer-late');

    const rerun = turns.park();
    const first = turns.settle({ messageId: 'assistant-1', text: 'deployed', requestId: 'req-1' });
    await rerun;
    await turns.settle({ messageId: 'a-rerun', text: 'done' });
    await first;

    expect(steerFrames(h.frames).map((frame) => [frame.status, frame.steerId])).toEqual([
      ['queued', 'steer-late'], ['turn', 'steer-late'],
    ]);
    // The rerun opened under the steer's id, so the sender's bubble is the row a reload draws, and it was answered.
    const stored = await storedChat(h);
    expect(stored.filter((message) => message.role === 'user').at(-1)?.id).toBe('steer-late');
    expect(stored.filter((message) => message.role === 'assistant')).toHaveLength(2);
  });

  test('leftovers of mixed modes rerun as ONE plan turn', async () => {
    const h = steerHarness();
    const turns = chatSessionTurns(h.agent);
    await h.startTurn();
    await h.agent.send('first build', 'steer-b1', [], 'build');
    await h.agent.send('plan next', 'steer-p', [], 'plan');
    await h.agent.send('second build', 'steer-b2', [], 'build');

    const rerun = turns.park();
    const first = turns.settle({ messageId: 'assistant-groups', text: 'ok', requestId: 'req-groups' });

    expect((await rerun).identity.turnId).toBe('steer-b1');
    // Plan is the narrower grant, so one plan-mode message makes the whole rerun plan: merging never widens a grant.
    expect(mainDatabase(h).query('SELECT work_mode FROM actor_turn_claims WHERE turn_id = ?').get('steer-b1')).toEqual({ work_mode: 'plan' });
    await turns.settle({ messageId: 'a-rerun', text: 'planned' });
    await first;

    const rerunRows = (await storedChat(h)).filter((message) => message.role === 'user').slice(-3);
    expect(rerunRows.map((message) => message.id)).toEqual(['steer-b1', 'steer-p', 'steer-b2']);
  });

  test('is not rerun twice — the turn that takes it drains it', async () => {
    const h = steerHarness();
    const turns = chatSessionTurns(h.agent);
    await h.startTurn();
    await h.agent.send('one more thing', 'steer-6');

    const rerun = turns.park();
    const first = turns.settle({ messageId: 'assistant-1', text: 'ok', requestId: 'req-1' });
    await rerun;
    await turns.settle({ messageId: 'a-rerun', text: 'ok again' });
    await first;
    await h.agent.harnessAgentsIdle();

    expect(present(mainDatabase(h).query<{ c: number }, []>('SELECT count(*) AS c FROM pending_steers').get(), 'the pending_steers count row').c).toBe(0);
    expect((await storedChat(h)).filter((message) => message.role === 'user' && message.id === 'steer-6')).toHaveLength(1);
  });
});

describe('an eviction with acknowledged steers', () => {
  test('restores only the live turn\'s rows and sweeps a dead turn\'s as one user-origin turn', async () => {
    const h = steerHarness();
    const actorId = workspaceMainActor(h.db).actorId;

    await h.startTurn('u-live');
    await h.agent.send('the live turn keeps me', 'steer-live');

    // Written through SQL: SQL, not RAM, is the authority an eviction tests. Main's are its isolate's rows (D9).
    mainDatabase(h).query(
      `INSERT INTO pending_steers (actor_id, id, turn_id, mode, text)
       VALUES (?, 'steer-dead-1', 'turn-dead', 'plan', 'orphaned by an eviction')`,
    ).run(actorId);
    mainDatabase(h).query(
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

    // One rerun turn, opened under the first send's id, each send published under its own.
    const rerun = (await storedChat(restarted)).filter((message) => message.role === 'user').slice(-2);

    expect(rerun.map((message) => [message.id, message.parts, turnAuthor(message)])).toEqual([
      ['steer-dead-1', [{ type: 'text', text: 'orphaned by an eviction' }], 'operator'],
      ['steer-dead-2', [{ type: 'text', text: 'also orphaned' }], 'operator'],
    ]);
    expect(mainDatabase(restarted).query('SELECT work_mode FROM actor_turn_claims WHERE turn_id = ?').get('steer-dead-1')).toEqual({ work_mode: 'plan' });

    expect(present(mainDatabase(restarted).query<{ c: number }, []>('SELECT count(*) AS c FROM pending_steers').get(), 'the pending_steers count row').c).toBe(0);
  });
});

describe("a message typed into an added agent's window while it works", () => {
  // The agent's chat runs in its own isolate, whose frames reach its window only through the workspace.
  test('tells its window the words were taken, then that they became the next turn', async () => {
    const ASK = 'Note where the parser buffers tokens.';
    const release = Promise.withResolvers<void>();
    let held = false;

    const gateway = stubAiBinding(async (run) => {
      if (!openingOf(run).includes(ASK)) return chatCompletion(run, 'Noted.');
      held = true;
      await release.promise;

      return chatCompletion(run, 'Tokens buffer in a lookahead ring.');
    });

    const workspace = gatewayWorkspace(gateway);
    const frames: string[] = [];

    Reflect.set(workspace.agent, 'broadcast', (payload: string) => { frames.push(payload); });
    await workspace.agent.setSoul('# Purpose\n\nKeep the parser notes.');
    const { subordinate } = await workspace.agent.createSubordinateAgent();
    const pane = [actorConnectionTag(subordinate.actorId ?? '')];

    await asPane(pane, () => workspace.agent.send(ASK, crypto.randomUUID()));
    await driveUntil(workspace, "the agent's model was never asked", () => held);
    await asPane(pane, () => workspace.agent.send('and the ring size', 'steer-added'));
    release.resolve();
    await workspace.agent.harnessAgentsIdle();

    expect(steerFrames(frames).map((frame) => [frame.status, frame.steerId])).toEqual([
      ['queued', 'steer-added'], ['turn', 'steer-added'],
    ]);
  });
});
