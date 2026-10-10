/**
 * An exploration head is a hosted actor with no chat: its transcript is the head journal, so a pager naming it is
 * refused. Paging itself, actor apart, and an unknown id's refusal are the workerd public-surface journey's.
 */
import { expect, test } from 'bun:test';
import { hostedExplorationHarness, orchestratorHarness } from './helpers/actor-harness';
import { createTestWorkspace } from '../../core/tests/helpers';
import { createTestActorsOver, seedTranscriptEntry } from '@kinu.run/test-utils';
import { CHAT_SESSION_ID, PLATFORM_CATALOG, SessionHistory, WORKSPACE_ROOT, actorReferenceOf, type NimbusSandboxHandle, type StoredRow } from '@kinu.run/core';
import { AgentDatabase } from '../src/agent-facet/agent-database';
import { makeCtx } from './helpers/platform-context';
import { readText } from '@nimbus-sh/core/vfs/vfs.js';

function retainedDatabase() {
  const created = createTestWorkspace();
  const actors = createTestActorsOver(created.db, { name: 'inspection-owner' });
  const child = actors.directory.create({ parent: actors.main, name: 'helper', creationId: 'helper', origin: 'user', lifetime: 'task' });
  const refuse = (): never => { throw new Error('a retained inspection invoked a mutating workspace operation'); };

  const box: NimbusSandboxHandle = { ready: refuse, exec: refuse, files: {
    read: path => readText(created.vfs, path), readBytes: async path => created.vfs.readFile(path),
    write: refuse, list: refuse, stat: refuse, exists: refuse, delete: refuse,
  } };

  const context = makeCtx(created.db, 'retained-agent');
  let indexInitializations = 0;
  const exec = context.storage.sql.exec.bind(context.storage.sql);
  context.storage.sql.exec = (query, ...bindings) => {
    if (query.includes('CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts')) indexInitializations++;

    return exec(query, ...bindings);
  };

  const database = new AgentDatabase(context.storage, {
    agent: () => box, home: WORKSPACE_ROOT, state: refuse, enqueueTurn: refuse, broadcast: refuse,
    turnInFlight: () => false, memory: refuse, program: refuse, sayToParent: refuse, logActivity: refuse,
  });

  const identity = created.sql<StoredRow>`SELECT * FROM workspace_identity`[0];

  if (identity === undefined) throw new Error('the workspace fixture has no identity');
  database.adopt({ identity,
    lineage: created.sql<StoredRow>`SELECT * FROM workspace_actors WHERE actor_id IN (${actors.main.actorId}, ${child.actorId}) ORDER BY parent_actor_id`,
    config: [], scaffold: [], workspaceName: 'inspection-owner', installedBuild: null, artifactDirectory: '/retained/context',
  });

  const history = new SessionHistory({ sql: created.sql, actor: child, transactionSync: write => created.db.transaction(write)(),
    files: async () => ({ vfs: created.vfs, artifactDirectory: '/retained/context' }) });

  return { ...created, actors, child, database, history, indexInitializations: () => indexInitializations };
}

test('consecutive public conversation calls retain their warm actor index', async () => {
  const f = retainedDatabase();

  try {
    await seedTranscriptEntry(f.history, CHAT_SESSION_ID, { id: 'recall', origin: 'input', message: { role: 'user', content: 'retained search evidence' } });
    const first = await f.database.conversations().search('evidence');
    const second = await f.database.conversations().search('evidence');
    expect(first.map(hit => hit.messageId)).toEqual(['recall']);
    expect(second).toEqual(first);
    expect(f.indexInitializations()).toBe(1);
  } finally { f.db.close(); }
});

test('a retired actor keeps its spilled history readable without actor reacquisition', async () => {
  const f = retainedDatabase();

  try {
    const content = 'retained payload '.repeat(Math.ceil(PLATFORM_CATALOG['do.sqlite.row_bytes'].limit.value / 16));
    await seedTranscriptEntry(f.history, CHAT_SESSION_ID, { id: 'retained', origin: 'input', message: { role: 'user', content } });
    f.actors.directory.apply(actorReferenceOf(f.actors.main), [], { action: 'retire', name: 'helper', reference: actorReferenceOf(f.child) });
    const before = f.sql`SELECT * FROM workspace_actors`;
    const inspected = await f.database.inspect({ view: 'history', path: [], page: {} });

    if (inspected.view !== 'history') throw new Error('retained history was not inspectable');
    expect(inspected.page.items.map(item => item.content)).toEqual([content]);
    expect(f.sql`SELECT * FROM workspace_actors`).toEqual(before);
  } finally { f.db.close(); }
});

test('a hosted actor with no chat pane is refused', async () => {
  const workspace = orchestratorHarness();
  await workspace.agent.activateActor();
  const head = await hostedExplorationHarness(workspace, 'head-without-a-pane');

  await expect(workspace.agent.getChatHistoryPage({ limit: 10, actor: head.actor.handle.actorId }))
    .rejects.toThrow(/does not name a chat/);
});
