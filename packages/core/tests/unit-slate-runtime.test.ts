import { expect, test } from 'bun:test';
import { WorkspaceId } from '@agent-core/core';
import { SlateId } from '@agent-core/core/slates';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SlateFiles, slateDirectory } from '../src/slates/files';
import { SqliteSlateContentStore } from '../src/slates/content';
import { SqliteSlateStore } from '../src/slates/store';
import { WorkspaceSlates } from '../src/slates/runtime';
import { KinuSlateProvider } from '../src/slates/provider';
import { createTestWorkspace, createWorkspaceBundle, makeSqlExec } from './helpers';

test('Slate source operations require Nimbus atomic-embedding rollback coherence', async () => {
  const ws = createTestWorkspace();
  try {
    const session = await createWorkspaceBundle(ws.db).session();
    const vfs = session.vfs.as(CRED_SESSION_USER);
    const store = new SqliteSlateStore(makeSqlExec(ws.db), (body) => ws.db.transaction(body)());
    const content = new SqliteSlateContentStore(makeSqlExec(ws.db), (body) => ws.db.transaction(body)());
    let allowed = true;
    const sourceWriteFailure = new Error('source write failed');
    let failWrite = false;
    const files = new SlateFiles({
      ...vfs,
      writeFile(...args: Parameters<typeof vfs.writeFile>) {
        vfs.writeFile(...args);
        if (failWrite && args[0].endsWith('/server.js')) throw sourceWriteFailure;
      },
    }, content);
    const slates = new WorkspaceSlates({
      workspaceId: new WorkspaceId('workspace'), store, files,
      provider: new KinuSlateProvider(async () => { throw new Error('source operations must not deploy'); }),
      mutations: { async mutate(_request, mutation) {
        if (!allowed) throw new Error('turn no longer owns mutation');
        return session.vfs.withTransaction(mutation);
      } },
      invocations: {
        async prepare() { throw new Error('source operations must not invoke providers'); },
        async invoke() { throw new Error('source operations must not invoke providers'); },
        async reconcile() { throw new Error('source operations must not invoke providers'); },
      },
      previewValidation: { async validate() { throw new Error('source operations must not link previews'); } },
    });
    const id = new SlateId('notes');
    const directory = slateDirectory(id);
    vfs.mkdir(directory, { recursive: true });
    vfs.writeFile(`${directory}/package.json`, '{"name":"notes","scripts":{"dev":"node server.js"}}');
    vfs.writeFile(`${directory}/server.js`, 'first version');
    const first = await slates.commit(id);
    expect(first.slateId.value).toBe('notes');
    vfs.writeFile(`${directory}/server.js`, 'second version');
    const second = await slates.commit(id);
    expect(second.parentVersionId?.value).toBe(first.id.value);
    const fork = await slates.fork(first.id);
    expect(fork.forkedFrom?.slateId.value).toBe(id.value);
    expect(fork.forkedFrom?.versionId.value).toBe(first.id.value);
    expect(vfs.readFileString(`${slateDirectory(fork.id)}/server.js`)).toBe('first version');
    await slates.restore(id, first.id);
    expect(vfs.readFileString(`${directory}/server.js`)).toBe('first version');
    expect(store.getVersion(second.id)?.source.value).toBe(second.source.value);
    failWrite = true;
    await expect(slates.restore(id, second.id)).rejects.toHaveProperty('cause', sourceWriteFailure);
    expect(vfs.readFileString(`${directory}/server.js`)).toBe('first version');
    expect(store.getSlate(id)?.source.value).toBe(first.source.value);
    failWrite = false;
    allowed = false;
    await expect(slates.restore(id, second.id)).rejects.toThrow('turn no longer owns mutation');
    expect(vfs.readFileString(`${directory}/server.js`)).toBe('first version');
    expect(store.getSlate(id)?.source.value).toBe(first.source.value);
  } finally {
    ws.db.close();
  }
});
