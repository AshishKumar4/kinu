import { seedTranscriptEntry } from '@kinu.run/test-utils';
import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CHAT_SESSION_ID, SessionHistory, WorkspaceActorDirectory, type ActorHandle } from '@kinu.run/core';
import { makeSql } from '@kinu.run/cli-backend';
import { createCliAgent } from '../src/agent-create';
import { AGENT_HOME, agentDbPath, updateConfigFile } from '../src/config';
import { inspectLocalSubordinate } from '../src/local-inspection';

if (resolve(AGENT_HOME) === resolve(join(homedir(), '.kinu')) || !resolve(AGENT_HOME).startsWith(resolve(tmpdir()))) {
  throw new Error(`local-inspection suite refuses to run against a real Kinu home (${AGENT_HOME}); scripts/test-preload.ts provides a throwaway one.`);
}

const NAME = `inspection-${Date.now()}`;

afterAll(async () => {
  await updateConfigFile((config) => {
    if (config.agents) delete config.agents[NAME];
  });
});

async function say(db: Database, actor: ActorHandle, id: string, content: string): Promise<void> {
  const history = new SessionHistory({
    sql: makeSql(db), actor, transactionSync: (write) => db.transaction(write)(),
    files: () => Promise.reject(new Error('a short message stores no file')),
  });

  await seedTranscriptEntry(history, CHAT_SESSION_ID, { id, origin: 'input', message: { role: 'user', content } });
}

describe('local inspection of a subordinate', () => {
  test('a request that names an actor reads that actor\'s kept chat, not the owner\'s', async () => {
    await createCliAgent({
      name: NAME, mode: 'local', purpose: 'inspect a helper',
      baseUrl: 'http://localhost:0/v1', auth: 'Bearer offline', model: 'openai-compatible/offline-model',
    });

    const db = new Database(agentDbPath(NAME));
    const identity = db.query<{ id: string; owner_user_id: string | null }, []>('SELECT id, owner_user_id FROM workspace_identity').get();

    if (identity === null) throw new Error('the created workspace has no identity row');
    const directory = new WorkspaceActorDirectory(makeSql(db), { workspaceId: identity.id, ownerUserId: identity.owner_user_id ?? '' });
    const main = directory.main();
    const helper = directory.create({ parent: main, name: 'ask-refiner-a1', creationId: 'lane/ask-refiner-a1', origin: 'evolution', lifetime: 'task' });
    await say(db, main, 'owner-words', 'the owner asked');
    await say(db, helper, 'helper-words', 'the refiner answered');
    db.close();

    const read = await inspectLocalSubordinate(NAME, { path: [], view: 'history', page: {}, actor: helper.actorId });

    expect(read).toMatchObject({ view: 'history', page: { items: [{ content: 'the refiner answered' }] } });
  });
});
