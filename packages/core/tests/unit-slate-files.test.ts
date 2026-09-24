import { afterEach, expect, test } from 'bun:test';
import { setSystemTime } from 'bun:test';
import type { ContentRef } from '@agent-core/core';
import { SlateId } from '@agent-core/core/slates';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SlateFiles, slateDirectory, type SlateFileTree } from '../src/slates/files';
import { WorkspaceSlateContentStore } from '../src/slates/content';
import { createTestWorkspace, createWorkspaceBundle, makeSqlExec } from './helpers';

afterEach(() => { setSystemTime(); });

/** A slate plane whose working-tree reads and writes are counted; the content store's own are not. */
async function slatePlane() {
  const ws = createTestWorkspace();
  const session = await createWorkspaceBundle(ws.db).session();
  const vfs = session.vfs.as(CRED_SESSION_USER);
  const counts = { reads: 0, writes: 0 };

  const tree: SlateFileTree = {
    ...vfs,
    readFileUncached(path) {
      counts.reads += 1;

      return vfs.readFileUncached(path);
    },
    writeFile(path, bytes, options) {
      counts.writes += 1;
      vfs.writeFile(path, bytes, options);
    },
  };

  const content = new WorkspaceSlateContentStore(session.vfs.as(CRED_KERNEL));
  const files = new SlateFiles(tree, content, makeSqlExec(ws.db), (body) => session.vfs.withTransaction(body));

  return { ws, vfs, files, counts };
}

/** Moves the clock on, as between two requests: a write and a version never share a millisecond. */
let clock = Date.parse('2026-09-24T00:00:00.000Z');

function tick(): void {
  clock += 1000;
  setSystemTime(clock);
}

function seed(vfs: Awaited<ReturnType<typeof slatePlane>>['vfs'], directory: string, count: number): void {
  vfs.mkdir(`${directory}/src`, { recursive: true });

  for (let index = 0; index < count; index += 1) vfs.writeFile(`${directory}/src/f${index}.ts`, `export const v${index} = ${index};\n`);
}

test('a Slate tree restores binaries, executable modes, symlinks and empty directories', async () => {
  const { ws, vfs, files } = await slatePlane();

  try {
    const id = new SlateId('notes');
    const directory = slateDirectory(id);
    vfs.mkdir(`${directory}/empty`, { recursive: true });
    vfs.writeFile(`${directory}/run`, new Uint8Array([0, 255, 3]), { mode: 0o755 });
    vfs.symlink('shell', `${directory}/link`);
    vfs.mkdir(`${directory}/protected`);
    vfs.writeFile(`${directory}/protected/config`, 'read-only source');
    vfs.chmod(`${directory}/protected`, 0o555);
    const version = files.capture(id);
    vfs.writeFile(`${directory}/run`, 'changed');
    vfs.writeFile(`${directory}/extra`, 'remove on restore');
    files.transaction(() => files.restore(id, version));
    expect(vfs.readFile(`${directory}/run`)).toEqual(new Uint8Array([0, 255, 3]));
    expect(vfs.stat(`${directory}/run`).mode & 0o777).toBe(0o755);
    expect(vfs.readlink(`${directory}/link`)).toBe('shell');
    expect(vfs.isDirectory(`${directory}/empty`)).toBe(true);
    expect(vfs.readFileString(`${directory}/protected/config`)).toBe('read-only source');
    expect(vfs.stat(`${directory}/protected`).mode & 0o777).toBe(0o555);
    expect(vfs.exists(`${directory}/extra`)).toBe(false);
    expect(files.capture(id).value).toBe(version.value);
    const fork = new SlateId('fork');
    files.restore(fork, version);
    vfs.writeFile(`${slateDirectory(fork)}/run`, 'fork changes');
    expect(vfs.readFile(`${directory}/run`)).toEqual(new Uint8Array([0, 255, 3]));
  } finally {
    ws.db.close();
  }
});

test('restore turns a changed kind back: a directory where a file was, a file where a directory was, a retargeted symlink', async () => {
  const { ws, vfs, files } = await slatePlane();

  try {
    const id = new SlateId('kinds');
    const directory = slateDirectory(id);
    vfs.mkdir(`${directory}/was-dir`, { recursive: true });
    vfs.writeFile(`${directory}/was-dir/inner.txt`, 'inside');
    vfs.writeFile(`${directory}/was-file`, 'a file');
    vfs.symlink('was-file', `${directory}/link`);
    const version = files.capture(id);

    vfs.removeRecursive(`${directory}/was-dir`);
    vfs.writeFile(`${directory}/was-dir`, 'now a file');
    vfs.unlink(`${directory}/was-file`);
    vfs.mkdir(`${directory}/was-file/deeper`, { recursive: true });
    vfs.unlink(`${directory}/link`);
    vfs.symlink('elsewhere', `${directory}/link`);
    files.transaction(() => files.restore(id, version));

    expect(vfs.readFileString(`${directory}/was-dir/inner.txt`)).toBe('inside');
    expect(vfs.readFileString(`${directory}/was-file`)).toBe('a file');
    expect(vfs.readlink(`${directory}/link`)).toBe('was-file');
    expect(files.capture(id).value).toBe(version.value);
  } finally {
    ws.db.close();
  }
});

test('a version reads only the files that changed since the last one', async () => {
  const { ws, vfs, files, counts } = await slatePlane();

  try {
    const id = new SlateId('app');
    const directory = slateDirectory(id);
    tick();
    seed(vfs, directory, 20);
    tick();
    const first = files.transaction(() => files.capture(id));
    expect(counts.reads).toBe(20);

    counts.reads = 0;
    expect(files.transaction(() => files.capture(id)).value).toBe(first.value);
    expect(counts.reads).toBe(0);

    vfs.writeFile(`${directory}/src/f7.ts`, 'export const v7 = 70;\n');
    tick();
    const edited = files.transaction(() => files.capture(id));
    expect(counts.reads).toBe(1);
    expect(edited.value).not.toBe(first.value);
  } finally {
    ws.db.close();
  }
});

test('a rewrite in the millisecond a version was taken, keeping the size, is still in the next version', async () => {
  const { ws, vfs, files } = await slatePlane();

  try {
    const id = new SlateId('racy');
    const file = `${slateDirectory(id)}/value.txt`;
    tick();
    vfs.mkdir(slateDirectory(id), { recursive: true });
    vfs.writeFile(file, 'aaaa');
    const first: ContentRef = files.capture(id);
    // Same millisecond, same size, same inode: only the time the version was taken tells them apart.
    vfs.writeFile(file, 'bbbb');
    tick();
    const second = files.capture(id);

    expect(second.value).not.toBe(first.value);
    files.transaction(() => files.restore(id, first));
    expect(vfs.readFileString(file)).toBe('aaaa');
    // Restored in the same millisecond as this rewrite: the next version must still see it.
    vfs.writeFile(file, 'cccc');
    expect(files.capture(id).value).not.toBe(first.value);
  } finally {
    ws.db.close();
  }
});

test('a fork writes the tree once and its first version reads nothing; a restore rewrites only what differs', async () => {
  const { ws, vfs, files, counts } = await slatePlane();

  try {
    const id = new SlateId('origin');
    const directory = slateDirectory(id);
    tick();
    seed(vfs, directory, 20);
    tick();
    const version = files.transaction(() => files.capture(id));

    counts.writes = 0;
    const copy = new SlateId('copy');
    files.transaction(() => files.restore(copy, version));
    expect(counts.writes).toBe(20);
    counts.reads = 0;
    expect(files.transaction(() => files.capture(copy)).value).toBe(version.value);
    expect(counts.reads).toBe(0);

    vfs.writeFile(`${directory}/src/f3.ts`, 'changed');
    vfs.unlink(`${directory}/src/f4.ts`);
    vfs.writeFile(`${directory}/src/extra.ts`, 'not in the version');
    tick();
    counts.writes = 0;
    files.transaction(() => files.restore(id, version));

    expect(counts.writes).toBe(2);
    expect(vfs.readFileString(`${directory}/src/f3.ts`)).toBe('export const v3 = 3;\n');
    expect(vfs.readFileString(`${directory}/src/f4.ts`)).toBe('export const v4 = 4;\n');
    expect(vfs.exists(`${directory}/src/extra.ts`)).toBe(false);
    counts.reads = 0;
    expect(files.transaction(() => files.capture(id)).value).toBe(version.value);
    expect(counts.reads).toBe(0);
  } finally {
    ws.db.close();
  }
});
