import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createCLIRuntime } from '../src/runtime';
import { localActorDirectory } from '../src/actor-identity';
import { SessionPayloads } from '../../core/src/orchestrator/session-payload';

test('large canonical payloads use the issued child home and deny sibling reads', async () => {
  const db = new Database(':memory:');
  const runtime = createCLIRuntime(db, { dbPath: db.filename, llm: { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model' } });

  try {
    const { directory } = localActorDirectory(runtime.actor);
    const left = directory.create({ parent: runtime.actor, name: 'left', kind: 'subordinate', lifetime: 'durable', creationId: 'left' });
    const right = directory.create({ parent: runtime.actor, name: 'right', kind: 'subordinate', lifetime: 'durable', creationId: 'right' });

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
