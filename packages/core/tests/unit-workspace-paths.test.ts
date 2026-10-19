/**
 * The workspace's file plane takes a path as a process takes it: a relative one from its home, and `..` after a link is
 * the parent of where the link leads, never the link's own directory (Nimbus's cwd-aware `WorkspaceFs`). So does every
 * plane over its namespace: the file tool past its approval gate, and the owner's file manager.
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { toolExecute } from '@kinu.run/test-utils';
import { createWorkspaceBundle, fileToolOver } from './helpers';
import { workspaceFilePlane } from '../src/vfs/mounts';
import { WORKSPACE_ROOT } from '../src/vfs/workspace-path';
import { cloudPlanes } from '../src/vfs/resolve';
import { withApprovalGatedFiles } from '../src/execution/approval';

import { TurnFileLedger } from '../src/vfs/file-ledger';
import { TurnContextBudget } from '../src/context-budget';
import { readExecutorFile, writeExecutorFileOp } from '../src/read-models/files';
import type { JsonObject, JsonValue } from '../src/utils/json';
import type { Memory } from '../src/types/primitives';

/** `link` leads to /home/main/deep/inner; a different target.txt beside the link and beside where it leads. */
async function linkedWorkspace() {
  const workspace = createWorkspaceBundle(new Database(':memory:'));
  await writeText(workspace.vfs, 'target.txt', 'beside the link');
  await writeText(workspace.vfs, 'deep/target.txt', 'beside where the link leads');
  await workspace.vfs.mkdir('deep/inner', { recursive: true });
  await (await workspace.session()).vfs.as(CRED_KERNEL).symlink('/home/main/deep/inner', '/home/main/link');

  return workspace;
}

test('`..` after a link is the parent of where the link leads, for a read and a write', async () => {
  const workspace = await linkedWorkspace();

  expect(await readText(workspace.vfs, 'link/../target.txt')).toBe('beside where the link leads');

  await writeText(workspace.vfs, 'link/../written.txt', 'through the link');

  expect(await readText(workspace.vfs, '/home/main/deep/written.txt')).toBe('through the link');
  expect(await workspace.vfs.stat('written.txt')).toBeNull();
});

test('an empty path is the home, as on the agent planes', async () => {
  const workspace = createWorkspaceBundle(new Database(':memory:'));
  await writeText(workspace.vfs, 'here.txt', 'at home');

  expect((await workspace.vfs.readdir('')).map((entry) => entry.name)).toContain('here.txt');
  expect((await workspace.vfs.stat(''))?.type).toBe('directory');
});

test('the file tool reads and writes where the walk lands, past its approval gate', async () => {
  const workspace = await linkedWorkspace();
  const { files } = workspaceFilePlane(workspace, { mounts: [], principal: {}, home: WORKSPACE_ROOT });

  // As the runtime gates it: the gate decides on the path the namespace's own lookup reaches.
  const gated = withApprovalGatedFiles(files, 'workspace', {
    planes: cloudPlanes(WORKSPACE_ROOT), resolve: (path, follow, creating) => files.resolve(path, { follow, creating }), userRoots: () => files.userRoots(),
    locate: null, parksWrites: true,
  }, { mode: () => 'strict' });

  const file = toolExecute<JsonObject, JsonValue>(fileToolOver({
    home: WORKSPACE_ROOT, planes: cloudPlanes(WORKSPACE_ROOT), vfs: gated, ledger: new TurnFileLedger(), budget: new TurnContextBudget(),
  }));

  expect(JSON.stringify(await file({ op: 'read', path: 'link/../target.txt' }))).toContain('beside where the link leads');

  await file({ op: 'write', path: 'link/../written.txt', content: 'through the link' });

  expect(await readText(workspace.vfs, '/home/main/deep/written.txt')).toBe('through the link');
  expect(await workspace.vfs.stat('written.txt')).toBeNull();
});

test('the owner\'s file manager opens, saves and uploads where the walk lands', async () => {
  const workspace = await linkedWorkspace();
  const { files } = workspaceFilePlane(workspace, { mounts: [], principal: {}, home: WORKSPACE_ROOT });
  const router = { getProvider: () => ({ files, homeDir: async () => WORKSPACE_ROOT }) };
  const opened = await readExecutorFile(router, 'workspace', '/home/main/link/../target.txt');

  expect(opened).toMatchObject({ content: 'beside where the link leads' });

  const saved = await writeExecutorFileOp(router, 'workspace', '/home/main/link/../target.txt', {
    bytes: new TextEncoder().encode('saved'), expectedRevision: opened.revision,
  });

  expect(saved).toMatchObject({ ok: true });
  expect(await writeExecutorFileOp(router, 'workspace', 'link/../uploaded.txt', { bytes: new TextEncoder().encode('uploaded') }))
    .toMatchObject({ ok: true });
  expect(await readText(workspace.vfs, 'deep/target.txt')).toBe('saved');
  expect(await readText(workspace.vfs, 'deep/uploaded.txt')).toBe('uploaded');
  expect(await readText(workspace.vfs, 'target.txt')).toBe('beside the link');
});

/** The file tool past its approval gate, as the runtime builds it over `workspace`, and the owner's reader beside it. */
function gatedTool(workspace: ReturnType<typeof createWorkspaceBundle>, memory?: Memory) {
  const { files } = workspaceFilePlane(workspace, { mounts: [], principal: {}, home: WORKSPACE_ROOT });

  const gated = withApprovalGatedFiles(files, 'workspace', {
    planes: cloudPlanes(WORKSPACE_ROOT), resolve: (path, follow, creating) => files.resolve(path, { follow, creating }), userRoots: () => files.userRoots(),
    locate: null, parksWrites: true,
  }, { mode: () => 'strict' });

  const file = toolExecute<JsonObject, JsonValue>(fileToolOver({
    home: WORKSPACE_ROOT, planes: cloudPlanes(WORKSPACE_ROOT), vfs: gated, ledger: new TurnFileLedger(), budget: new TurnContextBudget(),
    ...(memory !== undefined && { memory }),
  }));

  const owner = { getProvider: () => ({ files, homeDir: async () => WORKSPACE_ROOT }) };

  return { file, owner };
}

// 2026-10-12 review: a write through `link/..` landed beside where the link leads but published the lexical reference.
test('a write or edit through a link names the file it changed, and that reference reads its bytes back', async () => {
  const workspace = await linkedWorkspace();
  const { file, owner } = gatedTool(workspace);

  const reference = 'vfs://home/main/deep/written.txt';

  expect(await file({ op: 'write', path: 'link/../written.txt', content: 'through the link' })).toMatchObject({ reference });
  expect(JSON.stringify(await file({ op: 'read', path: reference }))).toContain('through the link');
  // The owner opens the path the reference names.
  expect(await readExecutorFile(owner, 'workspace', '/home/main/deep/written.txt')).toMatchObject({ content: 'through the link' });

  await file({ op: 'read', path: 'link/../target.txt' });
  const edited = 'vfs://home/main/deep/target.txt';

  expect(await file({ op: 'edit', path: 'link/../target.txt', edits: [{ old_text: 'leads', new_text: 'led' }] })).toMatchObject({ reference: edited });
  expect(JSON.stringify(await file({ op: 'read', path: edited }))).toContain('beside where the link led');
  expect(await readExecutorFile(owner, 'workspace', '/home/main/deep/target.txt')).toMatchObject({ content: 'beside where the link led' });
});

// #61: the result was the path looked up again after the write's memory index, so a link moved meanwhile named another file.
test('a write or edit names the file it changed when its link moves while memory indexes it', async () => {
  const workspace = await linkedWorkspace();
  const kernel = (await workspace.session()).vfs.as(CRED_KERNEL);
  await workspace.vfs.mkdir('memory/orig/inner', { recursive: true });
  await workspace.vfs.mkdir('memory/new/inner', { recursive: true });
  await writeText(workspace.vfs, 'memory/new/written.txt', 'other file');
  await kernel.symlink('/home/main/memory/orig/inner', '/home/main/memory/link');

  const indexed: string[] = [];

  const memory: Memory = {
    chunk: async () => null, write: async () => {}, append: async () => {}, search: async () => [], read: async () => null, tail: async () => null,
    // Another call repoints the link while this one's index is awaited.
    async index(path) {
      indexed.push(path);
      await kernel.unlink('/home/main/memory/link');
      await kernel.symlink(indexed.length === 1 ? '/home/main/memory/new/inner' : '/home/main/memory/orig/inner', '/home/main/memory/link');
    },
  };

  const { file, owner } = gatedTool(workspace, memory);
  const written = 'vfs://home/main/memory/orig/written.txt';

  expect(await file({ op: 'write', path: 'memory/link/../written.txt', content: 'the write' })).toMatchObject({ reference: written });
  expect(await readExecutorFile(owner, 'workspace', '/home/main/memory/orig/written.txt')).toMatchObject({ content: 'the write' });

  // The link now leads to new/inner: the edit changes new/written.txt and names it, though the index moves the link back.
  await file({ op: 'read', path: 'memory/link/../written.txt' });
  const edited = 'vfs://home/main/memory/new/written.txt';

  expect(await file({ op: 'edit', path: 'memory/link/../written.txt', edits: [{ old_text: 'other', new_text: 'edited' }] }))
    .toMatchObject({ reference: edited });
  expect(await readExecutorFile(owner, 'workspace', '/home/main/memory/new/written.txt')).toMatchObject({ content: 'edited file' });
  expect(indexed).toEqual(['memory/orig/written.txt', 'memory/new/written.txt']);
});

// 2026-10-12 review: the gate resolved every op as a write that makes its parents, so a read passed a missing directory.
test('the file tool refuses a read through a directory that is not there, as the owner\'s reader does', async () => {
  const workspace = await linkedWorkspace();
  const { file, owner } = gatedTool(workspace);

  await expect(file({ op: 'read', path: './missing/../target.txt' })).rejects.toMatchObject({ code: 'missing' });
  const opened = await readExecutorFile(owner, 'workspace', '/home/main/missing/../target.txt');

  expect(opened).toHaveProperty('error');
  expect(opened).not.toHaveProperty('content');

  // A write still makes the directories it names.
  await file({ op: 'write', path: 'made/new.txt', content: 'made' });
  expect(await readText(workspace.vfs, 'made/new.txt')).toBe('made');
});

// A write makes its parents through a link whose target is not there yet: it lands where the link leads.
test('the file tool writes through a link whose target is not there yet, where the link leads', async () => {
  const workspace = await linkedWorkspace();
  const { file } = gatedTool(workspace);
  await (await workspace.session()).vfs.as(CRED_KERNEL).symlink('relative/target', '/home/main/near');

  await file({ op: 'write', path: 'near/file.txt', content: 'through a dangling link' });

  expect(await readText(workspace.vfs, 'relative/target/file.txt')).toBe('through a dangling link');
  expect((await workspace.vfs.stat('near', { follow: false }))?.type).toBe('symlink');
});

// Its target walks back through a directory that is not there: refused as the namespace's lookup refuses it.
test('the file tool refuses a read through a link that climbs out of a missing directory, and goes on reading', async () => {
  const workspace = await linkedWorkspace();
  const { file } = gatedTool(workspace);
  await (await workspace.session()).vfs.as(CRED_KERNEL).symlink('missing/../loop', '/home/main/loop');

  await expect(file({ op: 'read', path: 'loop/file.txt' })).rejects.toMatchObject({ code: 'missing' });
  expect(JSON.stringify(await file({ op: 'read', path: 'target.txt' }))).toContain('beside the link');
});

// Staging 5c522f12d: 23 first skill reads dropped `vfs://`, and a computer's own path reached the workspace's file tool.
test('a path that names nothing is told what it names under each prefix', async () => {
  const { file } = gatedTool(await linkedWorkspace());

  await expect(file({ op: 'read', path: 'skills/slates/SKILL.md' })).rejects
    .toThrow('`skills/slates/SKILL.md` is `/home/main/skills/slates/SKILL.md` here, `vfs://skills/slates/SKILL.md` is `/skills/slates/SKILL.md` and `computer://skills/slates/SKILL.md` is `/computer/skills/slates/SKILL.md`');
  await expect(file({ op: 'list', path: '/workspace/true-myth' })).rejects.toThrow('`computer://workspace/true-myth` is `/computer/workspace/true-myth`');
  await expect(file({ op: 'stat', path: '/workspace/true-myth/src/maybe.ts' })).rejects.toThrow('`computer://workspace/true-myth/src/maybe.ts` is `/computer/workspace/true-myth/src/maybe.ts`');
});

// Luna searched the directory `archive` three times in a row on staging 5c522f12d; the refusal never said it was one.
test('a read or search of a directory is told it is one, and how to look inside it', async () => {
  const { file } = gatedTool(await linkedWorkspace());

  await expect(file({ op: 'search', path: 'deep', query: 'beside' })).rejects
    .toThrow('`deep` is a directory, and `search` takes one file: list it with `list`, or search under it with `grep -rn` in a shell');
});

test('a reference that names nothing is told where it landed, with no prefix written over it', async () => {
  const { file } = gatedTool(await linkedWorkspace());

  await expect(file({ op: 'read', path: 'vfs://nowhere/x.md' })).rejects
    .toThrow("`vfs://nowhere/x.md` is `/nowhere/x.md` here; a relative path starts at `/home/main`");
});
