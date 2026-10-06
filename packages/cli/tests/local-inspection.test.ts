import { seedTranscriptEntry } from '@kinu.run/test-utils';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CHAT_SESSION_ID, SessionHistory, WorkspaceActorDirectory, type ActorHandle } from '@kinu.run/core';
import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { MEMORY_PATH } from '@kinu.run/core';
import { createCLIRuntime, makeSql } from '@kinu.run/cli-backend';
import { createCliAgent } from '../src/agent-create';
import { AGENT_HOME, agentDbPath, updateConfigFile } from '../src/config';
import { inspectLocalSubordinate, readLocalMemory, searchLocalMemory } from '../src/local-inspection';
import { present } from '@kinu.run/test-utils';
import { scratchDir } from '../../test-utils/src/scratch';

if (resolve(AGENT_HOME) === resolve(join(homedir(), '.kinu')) || !resolve(AGENT_HOME).startsWith(resolve(tmpdir()))) {
  throw new Error(`local-inspection suite refuses to run against a real Kinu home (${AGENT_HOME}); scripts/test-preload.ts provides a throwaway one.`);
}

const NAME = `inspection-${Date.now()}`;

const MEMORY_NAME = `inspection-memory-${Date.now()}`;

afterAll(async () => {
  await updateConfigFile((config) => {
    if (config.agents) {
      delete config.agents[NAME];
      delete config.agents[MEMORY_NAME];
    }
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

// The index is for search: a file edited through the file plane, or saved without indexing, is newer than its chunks.
describe('local inspection of memory', () => {
  beforeAll(async () => {
    await createCliAgent({
      name: MEMORY_NAME, mode: 'local', purpose: 'keep notes',
      baseUrl: 'http://localhost:0/v1', auth: 'Bearer offline', model: 'openai-compatible/offline-model',
    });
  });

  test('reads MEMORY.md itself, never a reassembly of its search index', async () => {
    const db = new Database(agentDbPath(MEMORY_NAME));
    const rt = createCLIRuntime(db, { llm: { name: 'offline', baseURL: 'http://localhost:0', headers: {}, model: 'offline-model' }, cwd: scratchDir('inspection-folder') });
    await rt.memory.write(MEMORY_PATH, '# Memory\n\nindexed note\n');
    await writeText(present(rt.agentStateVfs, 'the agent state'), MEMORY_PATH, '# Memory\n\nedited in place\n');
    // The same file the agent's memory reads, not a second one beside it.
    expect(await rt.memory.read(MEMORY_PATH)).toBe('# Memory\n\nedited in place\n');
    db.close();

    expect(await readLocalMemory(MEMORY_NAME)).toBe('# Memory\n\nedited in place\n');
  });

  // The agent's own search ranks every term wherever it falls; inspection asks the same index the same way.
  test('searches as the agent does: terms in any order', async () => {
    const db = new Database(agentDbPath(MEMORY_NAME));
    const rt = createCLIRuntime(db, { llm: { name: 'offline', baseURL: 'http://localhost:0', headers: {}, model: 'offline-model' }, cwd: scratchDir('inspection-folder') });
    await rt.memory.write(MEMORY_PATH, '# Memory\n\nthe wrangler deploy goes to staging\n');
    await rt.memory.index(MEMORY_PATH);
    const agentHits = (await rt.memory.search('staging wrangler', 5)).map((hit) => hit.path);
    db.close();

    expect(agentHits).toEqual([MEMORY_PATH]);
    expect((await searchLocalMemory(MEMORY_NAME, 'staging wrangler', 5)).map((hit) => hit.path)).toEqual(agentHits);
  });
});
