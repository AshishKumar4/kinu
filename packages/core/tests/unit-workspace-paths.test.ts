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
import { createWorkspaceBundle } from './helpers';
import { workspaceFilePlane } from '../src/vfs/mounts';
import { WORKSPACE_ROOT } from '../src/vfs/workspace-path';
import { cloudPlanes } from '../src/vfs/resolve';
import { withApprovalGatedFiles } from '../src/execution/approval';
import { createFileTool } from '../src/tools/file-operations';
import { TurnFileLedger } from '../src/vfs/file-ledger';
import { TurnContextBudget } from '../src/context-budget';
import { readExecutorFile, writeExecutorFileOp } from '../src/read-models/files';
import type { JsonObject, JsonValue } from '../src/utils/json';

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
    planes: cloudPlanes(WORKSPACE_ROOT), resolve: (path, follow) => files.resolve(path, { follow }), userRoots: () => files.userRoots(),
    locate: null, parksWrites: true,
  }, { mode: () => 'strict' });

  const file = toolExecute<JsonObject, JsonValue>(createFileTool({
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
