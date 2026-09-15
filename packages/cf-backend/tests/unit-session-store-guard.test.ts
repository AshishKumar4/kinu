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
 * Behavioural: the table is created by the vendor's own provider under Think's
 * session hydration, which runs BEFORE the actor's `onStart` — so the guard
 * asks before it builds anything of its own, and an activation whose vendor
 * boot declared the transcript elsewhere finds nothing and refuses.
 */
import { describe, expect, test } from 'bun:test';
import { orchestratorHarness, wakeOverMovedTranscript } from './helpers/actor-harness';

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

  test('a fresh activation whose vendor boot declared the transcript elsewhere refuses to wake', async () => {
    // The replatform, as a workspace would meet it: a wake on storage the
    // last SDK wrote, under an SDK whose session hydration declares
    // `cf_agents_session_*` and no `assistant_messages`. The old table is
    // gone with the old rows, and the new activation's own store has not
    // been built yet — which is exactly when the guard must ask.
    const { agent, db } = orchestratorHarness();
    await agent.activateActor();
    db.exec('DROP TABLE assistant_messages');

    await expect(wakeOverMovedTranscript(db)).rejects.toThrow('no `assistant_messages` table');
    // Refused BEFORE anything of the actor's declared the table itself: a
    // guard that built its own store first would have created the table
    // under every SDK and never fired.
    expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'assistant_messages'`).all()).toHaveLength(0);
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
