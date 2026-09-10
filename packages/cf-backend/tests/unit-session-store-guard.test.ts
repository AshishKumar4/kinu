/**
 * The wake guard for the SDK's transcript store.
 *
 * Every conversational reader in core selects `assistant_messages` where it
 * exists and plain `messages` where it does not (`hasPaneStore`), so an SDK
 * that moves the transcript out of that table does not make a hosted workspace
 * fail — it makes fork, archive, search, the eval split and inherited context
 * read an empty default chat. `@cloudflare/think`'s `brisk-chats-branch`
 * changeset does exactly that on first wake. The guard is the one place the
 * absence is named and refused, at the activation, before any of them runs.
 *
 * Behavioural: the table is created by the vendor's own provider, the way
 * Think's boot creates it, and the activation is the actor's real `onStart`.
 */
import { describe, expect, test } from 'bun:test';
import { Session } from 'agents/experimental/memory/session';
import { orchestratorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';

/** What Think's `startThink` does before it reaches the actor's `onStart`:
 *  create the session and read it, which is what runs the provider's DDL. */
async function bootThinkSession(agent: HarnessOrchestratorAgent): Promise<void> {
  agent.session = Session.create(agent);
  await agent.session.getLatestLeaf();
}

describe('the activation refuses a hosted workspace whose SDK transcript store is gone', () => {
  test('a fresh workspace whose first wake has the table and no rows yet wakes', async () => {
    // The guard asks for the TABLE, never for rows: a workspace's first wake
    // has an empty store, and that is a conversation that has not started.
    const { agent, db } = orchestratorHarness();
    await bootThinkSession(agent);
    expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'assistant_messages'`).all()).toHaveLength(1);
    expect(db.query(`SELECT COUNT(*) AS n FROM assistant_messages`).get()).toEqual({ n: 0 });

    await agent.activateActor();
    await agent.harnessSettleBackgroundTasks();
  });

  test('an activation whose Think booted and whose store is absent throws, naming the table', async () => {
    const { agent, db } = orchestratorHarness();
    await bootThinkSession(agent);
    // The replatform's end state: the SDK lifted the rows elsewhere and dropped
    // the table Kinu's readers name.
    db.exec('DROP TABLE assistant_messages');

    await expect(agent.activateActor()).rejects.toThrow('no `assistant_messages` table');
  });

  test('an activation with no Think session is the harness shape, not a moved store, and wakes', async () => {
    // The bun harness boots the actor half of `onStart` alone; a local
    // workspace has no Think at all. Neither has the table, and neither is
    // the fault the guard names.
    const { agent, db } = orchestratorHarness();
    expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'assistant_messages'`).all()).toHaveLength(0);

    await agent.activateActor();
    await agent.harnessSettleBackgroundTasks();
  });
});
