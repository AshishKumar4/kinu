import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createCLIRuntime } from '../src/runtime';
import { localActorDirectory, actorHomeName } from '@kinu.run/core';
import { SessionPayloads } from '../../core/src/session/payload';

test('large canonical payloads use the issued child home and deny sibling reads', async () => {
  const db = new Database(':memory:');
  const runtime = createCLIRuntime(db, { llm: { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model' } });

  try {
    const { directory } = localActorDirectory(runtime.actor);
    const left = directory.create({ parent: runtime.actor, name: 'left', origin: 'agent', lifetime: 'durable', creationId: 'left' });
    const right = directory.create({ parent: runtime.actor, name: 'right', origin: 'agent', lifetime: 'durable', creationId: 'right' });

    if (!runtime.filesForActor) throw new Error('runtime did not install its actor file resolver');
    const filesForActor = runtime.filesForActor;
    const payloads = new SessionPayloads(() => filesForActor(left));
    const text = 'retained\ud83d\ude00'.repeat(110_000);
    const payload = await payloads.prepare(text);

    if (payload.path === null) throw new Error('large payload was not published through VFS');
    const leftPlane = await filesForActor(left);
    const rightPlane = await filesForActor(right);
    expect(payload.path.startsWith(`${leftPlane.artifactDirectory}/`)).toBe(true);
    expect(await payloads.read(payload)).toBe(text);
    await expect(rightPlane.vfs.readFile(payload.path)).rejects.toMatchObject({ code: 'EACCES' });
  } finally {
    db.close();
  }
});

// A home is named by storage key: two parents may each hire a `helper`, and one name would be one home for both.
test('two hires of one name under two parents keep separate homes, named as the shell and retirement name them', async () => {
  const db = new Database(':memory:');
  const runtime = createCLIRuntime(db, { llm: { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model' } });

  try {
    const { directory } = localActorDirectory(runtime.actor);
    const lead = directory.create({ parent: runtime.actor, name: 'lead', origin: 'agent', lifetime: 'durable', creationId: 'lead' });
    const mine = directory.create({ parent: runtime.actor, name: 'helper', origin: 'agent', lifetime: 'durable', creationId: 'mine' });
    const theirs = directory.create({ parent: lead, name: 'helper', origin: 'agent', lifetime: 'durable', creationId: 'theirs' });

    if (!runtime.filesForActor) throw new Error('runtime did not install its actor file resolver');
    const [a, b] = [await runtime.filesForActor(mine), await runtime.filesForActor(theirs)];

    expect(a.artifactDirectory).not.toBe(b.artifactDirectory);
    expect(a.artifactDirectory.startsWith(`/home/${actorHomeName({ origin: 'agent', storageKey: mine.storageKey })}/`)).toBe(true);
    expect(b.artifactDirectory.startsWith(`/home/${actorHomeName({ origin: 'agent', storageKey: theirs.storageKey })}/`)).toBe(true);
  } finally {
    db.close();
  }
});
