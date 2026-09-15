/**
 * The wake guard for the SDK's transcript store.
 *
 * Every conversational reader in core selects `assistant_messages` where it
 * exists and plain `actor_messages` where it does not (`hasPaneStore`), so an
 * SDK that moves the transcript out of that table does not make a hosted
 * workspace fail — it makes fork, archive, search, the eval split and
 * inherited context read an empty default chat. The Agents SDK's
 * `brisk-chats-branch` changeset does exactly that on first wake. The guard is
 * the one place the absence is named and refused, at the activation, before
 * any of them runs.
 *
 * Behavioural: the table is created by the vendor's own provider under the
 * transcript store the actor builds at wake, and the activation is the actor's
 * real `onStart`.
 */
import { describe, expect, test } from 'bun:test';
import { orchestratorHarness } from './helpers/actor-harness';

describe('the activation refuses a hosted workspace whose SDK transcript store is gone', () => {
  test('a fresh workspace wakes with the table and no rows yet', async () => {
    // The guard asks for the TABLE, never for rows: the store's first breath
    // creates it, and a workspace's first wake is a conversation that has not
    // started.
    const { agent, db } = orchestratorHarness();
    await agent.activateActor();
    await agent.harnessSettleBackgroundTasks();

    expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'assistant_messages'`).all()).toHaveLength(1);
    expect(db.query(`SELECT COUNT(*) AS n FROM assistant_messages`).get()).toEqual({ n: 0 });
  });

  test('an activation whose store is gone throws, naming the table', async () => {
    const { agent, db } = orchestratorHarness();
    await agent.activateActor();
    await agent.harnessSettleBackgroundTasks();
    // The replatform's end state: the SDK lifted the rows elsewhere and dropped
    // the table Kinu's readers name — after the store believed it had built it.
    db.exec('DROP TABLE assistant_messages');

    await expect(agent.activateActor()).rejects.toThrow('no `assistant_messages` table');
  });

  test('the store the guard reads is the one every turn writes', async () => {
    // One table, created once: the guard's read and the transcript's writes
    // name the same store, so a wake that passed the guard is a wake whose
    // turns will be found by the readers.
    const { agent, db } = orchestratorHarness();
    await agent.activateActor();
    await agent.harnessSettleBackgroundTasks();
    agent.harnessTranscript.appendUser({ id: 'u-1', text: 'hello' });

    expect(db.query(`SELECT id FROM assistant_messages`).all()).toEqual([{ id: 'u-1' }]);
  });
});
