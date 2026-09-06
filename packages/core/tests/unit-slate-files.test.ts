import { expect, test } from 'bun:test';
import { SlateId } from '@agent-core/core/slates';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SlateFiles, slateDirectory } from '../src/slates/files';
import { SqliteSlateContentStore } from '../src/slates/content';
import { createTestWorkspace, createWorkspaceBundle, makeSqlExec } from './helpers';

test('a Slate tree restores binaries, executable modes, symlinks and empty directories', async () => {
  const ws = createTestWorkspace();
  try {
    const session = await createWorkspaceBundle(ws.db).session();
    const vfs = session.vfs.as(CRED_SESSION_USER);
    const content = new SqliteSlateContentStore(makeSqlExec(ws.db), (body) => ws.db.transaction(body)());
    const files = new SlateFiles(vfs, content);
    const id = new SlateId('notes');
    const directory = slateDirectory(id);
    vfs.mkdir(`${directory}/empty`, { recursive: true });
    vfs.writeFile(`${directory}/run`, new Uint8Array([0, 255, 3]), { mode: 0o755 });
    vfs.symlink('run', `${directory}/link`);
    vfs.mkdir(`${directory}/protected`);
    vfs.writeFile(`${directory}/protected/config`, 'read-only source');
    vfs.chmod(`${directory}/protected`, 0o555);
    const version = files.capture(id);
    vfs.writeFile(`${directory}/run`, 'changed');
    vfs.writeFile(`${directory}/extra`, 'remove on restore');
    ws.db.transaction(() => files.restore(id, version))();
    expect(vfs.readFile(`${directory}/run`)).toEqual(new Uint8Array([0, 255, 3]));
    expect(vfs.stat(`${directory}/run`).mode & 0o777).toBe(0o755);
    expect(vfs.readlink(`${directory}/link`)).toBe('run');
    expect(vfs.isDirectory(`${directory}/empty`)).toBe(true);
    expect(vfs.readFileString(`${directory}/protected/config`)).toBe('read-only source');
    expect(vfs.stat(`${directory}/protected`).mode & 0o777).toBe(0o555);
    expect(vfs.exists(`${directory}/extra`)).toBe(false);
    expect(files.capture(id).value).toBe(version.value);
    const fork = new SlateId('fork');
    files.restore(fork, version);
    vfs.writeFile(`${slateDirectory(fork)}/run`, 'fork changes');
    expect(vfs.readFile(`${directory}/run`)).toEqual(new Uint8Array([0, 255, 3]));
    const materialized = files.materialize(version);
    expect(vfs.readFileString(`${materialized}/protected/config`)).toBe('read-only source');
    expect(vfs.stat(`${materialized}/protected`).mode & 0o777).toBe(0o555);
  } finally {
    ws.db.close();
  }
});
