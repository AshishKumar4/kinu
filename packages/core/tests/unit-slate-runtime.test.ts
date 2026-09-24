import { expect, test } from 'bun:test';
import { WorkspaceId } from '@agent-core/core';
import { SlateId } from '@agent-core/core/slates';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SlateFiles, slateDirectory } from '../src/slates/files';
import { WorkspaceSlateContentStore } from '../src/slates/content';
import { SqliteSlateStore } from '../src/slates/store';
import { WorkspaceSlates } from '../src/slates/runtime';
import { createTestWorkspace, createWorkspaceBundle, makeSqlExec } from './helpers';
import { Database } from 'bun:sqlite';
import { archiveSqlFromDatabase, writeWorkspaceArchive, restoreWorkspaceArchive } from '../src/identity/archive';

test('Slate source operations require Nimbus atomic-embedding rollback coherence', async () => {
  const ws = createTestWorkspace();

  try {
    const session = await createWorkspaceBundle(ws.db).session();
    const vfs = session.vfs.as(CRED_SESSION_USER);
    const store = new SqliteSlateStore(makeSqlExec(ws.db), (body) => ws.db.transaction(body)());
    const content = new WorkspaceSlateContentStore(session.vfs.as(CRED_KERNEL));
    let allowed = true;
    const sourceWriteFailure = new Error('source write failed');
    let failWrite = false;

    const files = new SlateFiles({
      ...vfs,
      writeFile(...args: Parameters<typeof vfs.writeFile>) {
        vfs.writeFile(...args);

        if (failWrite && args[0].endsWith('/server.js')) throw sourceWriteFailure;
      },
    }, content, makeSqlExec(ws.db), (body) => session.vfs.withTransaction(body));

    const slates = new WorkspaceSlates({
      workspaceId: new WorkspaceId('workspace'), store, files,
      mutations: { async mutate(_request, mutation) {
        if (!allowed) throw new Error('turn no longer owns mutation');

        return session.vfs.withTransaction(mutation);
      } },
    });

    const id = new SlateId('notes');
    const directory = slateDirectory(id);
    vfs.mkdir(directory, { recursive: true });
    vfs.writeFile(`${directory}/package.json`, '{"name":"notes","scripts":{"dev":"node server.js"}}');
    vfs.writeFile(`${directory}/server.js`, 'first version');
    const first = await slates.commit(id);
    expect(first.slateId.value).toBe('notes');
    const publication = await slates.publish(first.id, []);
    await expect(slates.deploy(publication.id, 'source-only')).rejects.toMatchObject({ code: 'unsupported' });
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
    const archive = await writeWorkspaceArchive(archiveSqlFromDatabase(ws.db), { workspace: 'workspace', source: 'cloud' });
    const restored = new Database(':memory:');

    try {
      await restoreWorkspaceArchive(archiveSqlFromDatabase(restored), archive);
      const restoredSession = await createWorkspaceBundle(restored).session();
      const restoredContent = new WorkspaceSlateContentStore(restoredSession.vfs.as(CRED_KERNEL));

      const restoredFiles = new SlateFiles(restoredSession.vfs.as(CRED_SESSION_USER), restoredContent, makeSqlExec(restored),
        (body) => restoredSession.vfs.withTransaction(body));

      restoredSession.vfs.withTransaction(() => restoredFiles.restore(id, second.source));
      expect(restoredSession.vfs.as(CRED_SESSION_USER).readFileString(directory + '/server.js')).toBe('second version');
      restoredSession.vfs.withTransaction(() => restoredFiles.restore(id, first.source));
      expect(restoredSession.vfs.as(CRED_SESSION_USER).readFileString(directory + '/server.js')).toBe('first version');
    } finally {
      restored.close();
    }

    failWrite = true;
    await expect(slates.restore(id, second.id)).rejects.toHaveProperty('cause', sourceWriteFailure);
    expect(vfs.readFileString(`${directory}/server.js`)).toBe('first version');
    expect(store.getSlate(id)?.source.value).toBe(first.source.value);
    failWrite = false;
    allowed = false;
    await expect(slates.restore(id, second.id)).rejects.toThrow('turn no longer owns mutation');
    expect(vfs.readFileString(`${directory}/server.js`)).toBe('first version');
    expect(store.getSlate(id)?.source.value).toBe(first.source.value);
    allowed = true;
    const tree = files.readTree(second.source);
    const file = tree.entries.find((entry) => entry.kind === 'file' && entry.path === 'server.js');

    if (file?.kind !== 'file') throw new Error('version has no server.js');
    const retainedPath = '/etc/kinu-slate-content/' + file.content.slice('sha256:'.length);
    session.vfs.as(CRED_KERNEL).unlink(retainedPath);
    await expect(slates.restore(id, second.id)).rejects.toThrow();
    expect(vfs.readFileString(directory + '/server.js')).toBe('first version');
    expect(store.getSlate(id)?.source.value).toBe(first.source.value);
  } finally {
    ws.db.close();
  }
});
