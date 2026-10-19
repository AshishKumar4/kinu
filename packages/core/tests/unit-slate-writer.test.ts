import { afterEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SlateId } from '@agent-core/core/slates';
import { createTestWorkspace, makeSqlExec } from './helpers';
import { sha256Hex } from '../src/safety/argument-digest';
import { SlateController } from '../src/slates/controller';
import { initSlateBuildTable, SlateBuilds } from '../src/slates/builds';
import { slateAuthority } from '../src/slates/authority';
import { ROOT_SLATE_CALLER } from '../src/slates/caller';
import { SlateLiveShareStore } from '../src/slates/live-shares';
import { initSlateUsageTable } from '../src/slates/usage';
import { serverAuthority } from '../src/slates/share-policy';
import { rollbackSlateBatch, writeSlateBatch } from '../src/slates/slate-writer';
import type { SlateFileChange } from '../src/slates/rpc';
import { parseSlateProject } from '../src/slates/project';
import { SlateFiles } from '../src/slates/files';
import { WorkspaceSlateContentStore } from '../src/slates/content';
import { SharedServers } from '../src/slates/shared-server';
import { slateRevision } from '../src/slates/share-policy';

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

async function editorTree() {
  const workspace = createTestWorkspace();
  databases.push(workspace.db);
  const session = await workspace.bundle.session();
  const user = session.vfs.as(CRED_SESSION_USER);
  const kernel = session.vfs.as(CRED_KERNEL);
  const marks = new SlateLiveShareStore(makeSqlExec(workspace.db));
  const root = '/slates/board';
  user.mkdir(root, { recursive: true });
  user.writeFile(`${root}/a.ts`, 'before-a');
  user.writeFile(`${root}/b.ts`, 'before-b');

  const write = (files: SlateFileChange, editor = 'pat@example.test', revision: string | null = 'r0') =>
    writeSlateBatch({ session, root, files, marks, slate: 'board', editor, revision });

  const rollback = (batch: ReturnType<typeof write>) => rollbackSlateBatch({ session, root, slate: 'board', marks, batch });

  return { ...workspace, session, user, kernel, root, marks, write, rollback };
}

const replace = (text: string | null, base: string | null) => ({ text, base: base === null ? null : sha256Hex(base) });

test('a fully no-op batch neither changes files nor creates an edit mark', async () => {
  const { user, root, marks, write, bundle } = await editorTree();
  const changes: string[] = [];
  const stop = bundle.onFilesChanged((paths) => changes.push(...paths));
  const before = user.lstat(`${root}/a.ts`);
  const batch = write({ 'a.ts': replace('before-a', 'before-a'), 'absent.txt': replace(null, null) });
  stop();

  expect(batch.paths).toEqual([]);
  expect(batch.before).toEqual({});
  expect(batch.wrote).toEqual({});
  expect(user.lstat(`${root}/a.ts`)).toEqual(before);
  expect(changes).toEqual([]);
  expect(marks.editMark('board')).toBeNull();
});

test('a no-op batch keeps an existing editor mark exactly as it was', async () => {
  const { marks, write } = await editorTree();
  write({ 'a.ts': replace('actual edit', 'before-a') }, 'pat', 'r0');
  const before = marks.editMark('board');
  const batch = write({ 'a.ts': replace('actual edit', 'actual edit'), absent: replace(null, null) }, 'sam', 'r1');

  expect(batch.paths).toEqual([]);
  expect(marks.editMark('board')).toEqual(before);
});

test('a mixed batch reports and snapshots only paths whose bytes actually change', async () => {
  const { write } = await editorTree();
  const batch = write({ 'a.ts': replace('before-a', 'before-a'), 'b.ts': replace('changed-b', 'before-b'), absent: replace(null, null) });

  expect(batch.paths).toEqual(['b.ts']);
  expect(batch.before).toEqual({ 'b.ts': { text: 'before-b', sha256: sha256Hex('before-b') } });
  expect(batch.wrote).toEqual({ 'b.ts': sha256Hex('changed-b') });
});

test('an atomic batch rolls back the first write when the second write fails and leaves no edit mark', async () => {
  const { user, kernel, root, marks, write } = await editorTree();
  kernel.chmod(`${root}/b.ts`, 0o444);

  expect(() => write({ 'a.ts': replace('after-a', 'before-a'), 'b.ts': replace('after-b', 'before-b') })).toThrow();
  expect(user.readFileString(`${root}/a.ts`)).toBe('before-a');
  expect(user.readFileString(`${root}/b.ts`)).toBe('before-b');
  expect(marks.editMark('board')).toBeNull();
});

test('a failed later batch preserves the exact previous edit mark and before images', async () => {
  const { user, kernel, root, marks, write } = await editorTree();
  write({ 'a.ts': replace('earlier editor save', 'before-a') }, 'earlier', 'r0');
  kernel.chmod(`${root}/b.ts`, 0o444);

  expect(() => write({ 'a.ts': replace('later edit', 'earlier editor save'), 'b.ts': replace('no', 'before-b') }, 'later', 'r1')).toThrow();
  expect(user.readFileString(`${root}/a.ts`)).toBe('earlier editor save');
  expect(marks.editMark('board')).toEqual({ editor: 'earlier', revisionBefore: 'r0' });
});

test('an edit mark write failure rolls source changes back in the same transaction', async () => {
  const { db, user, root, marks, write } = await editorTree();
  db.exec("CREATE TRIGGER refuse_edit_mark BEFORE INSERT ON slate_edit_marks BEGIN SELECT RAISE(ABORT, 'mark unavailable'); END");

  expect(() => write({ 'a.ts': replace('after-a', 'before-a') })).toThrow(/mark unavailable/);
  expect(user.readFileString(`${root}/a.ts`)).toBe('before-a');
  expect(marks.editMark('board')).toBeNull();
});

test('an editor refuses leaf symlinks and symlinked parents without reading or changing the outside file', async () => {
  const { user, root, marks, write } = await editorTree();
  user.mkdir('/slates/notes', { recursive: true });
  user.writeFile('/slates/notes/secret.ts', 'private');
  user.symlink('/slates/notes/secret.ts', `${root}/notes.md`);
  user.symlink('/slates/notes', `${root}/linked`);

  for (const path of ['notes.md', 'linked/secret.ts']) {
    expect(() => write({ [path]: replace('stolen', 'private') })).toThrow(/symlink/);
    expect(() => write({ [path]: replace(null, 'private') })).toThrow(/symlink/);
  }

  expect(user.readFileString('/slates/notes/secret.ts')).toBe('private');
  expect(marks.editMark('board')).toBeNull();
});

test('an editor refuses a symlinked slate root and directory leaves', async () => {
  const { session, user, root, marks, write } = await editorTree();
  user.mkdir(`${root}/directory`);
  user.symlink(root, '/slates/alias');

  expect(() => write({ directory: replace('no', null) })).toThrow(/regular file/);
  expect(() => writeSlateBatch({ session, root: '/slates/alias', files: { 'a.ts': replace('no', 'before-a') }, slate: 'alias', marks, editor: 'pat', revision: 'r0' })).toThrow(/real directory/);
  expect(user.readFileString(`${root}/a.ts`)).toBe('before-a');
});

test('stale bases name all conflicts and refuse the whole batch, distinguishing absence from empty text', async () => {
  const { user, root, marks, write } = await editorTree();
  user.writeFile(`${root}/empty`, '');

  expect(() => write({ 'a.ts': replace('after-a', 'before-a'), 'b.ts': replace('after-b', 'stale'), empty: replace('no', null) })).toThrow(/File conflict: b.ts, empty/);
  expect(user.readFileString(`${root}/a.ts`)).toBe('before-a');
  expect(user.readFileString(`${root}/b.ts`)).toBe('before-b');
  expect(user.readFileString(`${root}/empty`)).toBe('');
  expect(marks.editMark('board')).toBeNull();
});

test('a successful batch hashes UTF-8 bytes, creates parents and records its before images and edit mark', async () => {
  const { user, root, marks, write } = await editorTree();
  const batch = write({ 'a.ts': replace('snow 雪', 'before-a'), 'b.ts': replace(null, 'before-b'), 'new/deep.txt': replace('', null) });

  expect(batch.paths).toEqual(['a.ts', 'b.ts', 'new/deep.txt']);
  expect(batch.wrote).toEqual({ 'a.ts': sha256Hex('snow 雪'), 'b.ts': null, 'new/deep.txt': sha256Hex('') });
  expect(batch.before).toEqual({ 'a.ts': { text: 'before-a', sha256: sha256Hex('before-a') }, 'b.ts': { text: 'before-b', sha256: sha256Hex('before-b') }, 'new/deep.txt': { text: null, sha256: null } });
  expect(user.readFileString(`${root}/a.ts`)).toBe('snow 雪');
  expect(user.exists(`${root}/b.ts`)).toBe(false);
  expect(user.lstat(`${root}/new`).type).toBe('directory');
  expect(marks.editMark('board')).toEqual({ editor: 'pat@example.test', revisionBefore: 'r0' });
});

test('each edit fences its current revision and complete rollback restores the exact prior mark, including null', async () => {
  const { marks, write, rollback } = await editorTree();
  const first = write({ 'a.ts': replace('first', 'before-a') }, 'pat', null);
  const second = write({ 'a.ts': replace('second', 'first') }, 'sam', 'r1');

  expect(marks.editMark('board')).toEqual({ editor: 'sam', revisionBefore: 'r1' });
  expect(rollback(second)).toEqual({ restored: ['a.ts'], conflicts: [] });
  expect(marks.editMark('board')).toEqual({ editor: 'pat', revisionBefore: null });
  expect(rollback(first)).toEqual({ restored: ['a.ts'], conflicts: [] });
  expect(marks.editMark('board')).toBeNull();
});

test('failed-build rollback keeps a newer owner save, names the conflict and retains the unapproved mark', async () => {
  const { user, root, marks, write, rollback } = await editorTree();
  const batch = write({ 'a.ts': replace('broken edit', 'before-a'), 'b.ts': replace(null, 'before-b') });
  // The build awaited; a later save wins even when the old build now reports failure.
  user.writeFile(`${root}/a.ts`, 'newer owner version');

  expect(rollback(batch)).toEqual({ restored: ['b.ts'], conflicts: ['a.ts'] });
  expect(user.readFileString(`${root}/a.ts`)).toBe('newer owner version');
  expect(user.readFileString(`${root}/b.ts`)).toBe('before-b');
  expect(marks.editMark('board')?.editor).toBe('pat@example.test');
});

test('a failed first batch cannot erase the mark of a disjoint second edit by the same editor at the same revision', async () => {
  const { user, root, marks, write, rollback } = await editorTree();
  const first = write({ 'a.ts': replace('first broken edit', 'before-a') }, 'pat', 'r0');
  write({ 'b.ts': replace('second pending edit', 'before-b') }, 'pat', 'r0');

  expect(rollback(first)).toEqual({ restored: ['a.ts'], conflicts: [] });
  expect(user.readFileString(`${root}/a.ts`)).toBe('before-a');
  expect(user.readFileString(`${root}/b.ts`)).toBe('second pending edit');
  expect(marks.editMark('board')).toEqual({ editor: 'pat', revisionBefore: 'r0' });
});

test('the rollback tree fingerprint records symlink targets without reading outside the slate', async () => {
  const { user, kernel, root, marks, write, rollback } = await editorTree();
  user.mkdir('/slates/notes', { recursive: true });
  user.writeFile('/slates/notes/private', 'outside private bytes');
  kernel.chmod('/slates/notes/private', 0o000);
  user.symlink('/slates/notes/private', `${root}/private-link`);
  const batch = write({ 'a.ts': replace('edit', 'before-a') });

  expect(rollback(batch)).toEqual({ restored: ['a.ts'], conflicts: [] });
  expect(marks.editMark('board')).toBeNull();
});

test('rollback refuses a replaced symlink and preserves a newer creation after an editor deletion', async () => {
  const { user, root, marks, write, rollback } = await editorTree();
  const batch = write({ 'a.ts': replace('edit', 'before-a'), 'b.ts': replace(null, 'before-b') });
  user.writeFile(`${root}/b.ts`, 'recreated');
  user.unlink(`${root}/a.ts`);
  user.symlink(`${root}/b.ts`, `${root}/a.ts`);

  expect(rollback(batch)).toEqual({ restored: [], conflicts: ['a.ts', 'b.ts'] });
  expect(user.readFileString(`${root}/b.ts`)).toBe('recreated');
  expect(marks.editMark('board')).not.toBeNull();
});

test('a later rollback write failure rolls back earlier restorations and keeps the edit mark', async () => {
  const { user, kernel, root, marks, write, rollback } = await editorTree();
  const batch = write({ 'a.ts': replace('after-a', 'before-a'), 'b.ts': replace('after-b', 'before-b') });
  kernel.chmod(`${root}/b.ts`, 0o444);

  expect(() => rollback(batch)).toThrow();
  expect(user.readFileString(`${root}/a.ts`)).toBe('after-a');
  expect(user.readFileString(`${root}/b.ts`)).toBe('after-b');
  expect(marks.editMark('board')?.editor).toBe('pat@example.test');
});

async function controlledTree(catalog: () => Promise<{ mcp: never[]; slates: string[] }> = async () => ({ mcp: [], slates: ['board'] })) {
  const tree = await editorTree();
  initSlateBuildTable(tree.execRaw);
  initSlateUsageTable(tree.execRaw);
  const builds = new SlateBuilds(makeSqlExec(tree.db));
  const project = parseSlateProject({ main: 'a.ts' });

  const controller = new SlateController({
    workspace: 'writer-test', sql: makeSqlExec(tree.db), builds, transaction: (body) => tree.db.transaction(body)(),
    session: async () => tree.session, catalog, shareEntry: () => null,
    apps: { ensure: async () => ({ port: 3100, capability: 'test' }), remove: async () => ({ removed: true, port: 3100 }), url: async () => ({ url: 'https://example.test' }), owners: async () => new Map() },
    resolve: async () => ({ kind: 'files' as const, root: tree.root, project }), digest: async () => 'source',
    build: async () => ({ modules: {}, inputs: [] }),
    launch: async () => ({ id: 'test', port: null, methods: [], isRunning: async () => true, stop: async () => {} }),
    call: async () => ({ ok: true, value: null }),
  });

  const content = tree.session.vfs.withTransaction(() => new WorkspaceSlateContentStore(tree.kernel));
  const files = new SlateFiles(tree.user, content, makeSqlExec(tree.db), (body) => tree.session.vfs.withTransaction(body));
  const snapshot = () => files.transaction(() => files.capture(new SlateId('board')).digest.value);

  const revision = (label: string, source = snapshot()): string => {
    const key = `${source}:tree:${label}`;
    builds.built('board', slateAuthority(ROOT_SLATE_CALLER.cred), key, { modules: {}, inputs: [], scope: 'tree' });

    return key;
  };

  const share = controller.live.add({ id: 'share', slate: 'board', visibility: 'users', handle: '0123456789', grant: { slates: ['board'], members: [] } });
  const initial = revision('r0');

  return { ...tree, controller, revision, share, snapshot, initial };
}

test('owner-mode approval is fenced at the revision before an own-mode edit, and only a built current revision clears the mark', async () => {
  const { controller, revision, share, initial } = await controlledTree();
  const batch = await controller.writeShared('board', { 'a.ts': replace('r1', 'before-a') }, 'pat');
  expect(batch.ok).toBe(true);
  const pending = await controller.setLiveShareMode({ workspace: 'writer-test', share: share.id, mode: 'owner', revision: initial, approved: [] });

  expect(pending).toMatchObject({ ok: false, reason: 'bad_input' });
  expect(!pending.ok && pending.error).toContain("pat's change is still building; approve once it has built");
  expect(controller.live.get(share.id)).toMatchObject({ mode: 'own', editedBy: 'pat' });
  const current = revision('r1');
  const stale = await controller.setLiveShareMode({ workspace: 'writer-test', share: share.id, mode: 'owner', revision: initial, approved: [] });
  expect(stale).toMatchObject({ ok: false, reason: 'bad_input' });
  expect(controller.live.editMark('board')?.editor).toBe('pat');
  const approved = await controller.setLiveShareMode({ workspace: 'writer-test', share: share.id, mode: 'owner', revision: current, approved: [] });

  expect(approved).toMatchObject({ ok: true, value: { mode: 'owner', grantRevision: current, editedBy: null } });
  expect(controller.live.editMark('board')).toBeNull();
  expect(serverAuthority(controller.live.authoritiesOf('board'), current).kind).toBe('grant');
});

test('an owner build never advances any owner share while the slate has an editor mark', async () => {
  const { controller, revision, share, initial } = await controlledTree();
  await controller.setLiveShareMode({ workspace: 'writer-test', share: share.id, mode: 'owner', revision: initial, approved: [] });
  await controller.writeShared('board', { 'a.ts': replace('r1', 'before-a') }, 'pat');
  revision('r1');
  const current = revision('r2');

  expect(controller.live.get(share.id)).toMatchObject({ mode: 'owner', grantRevision: initial, editedBy: 'pat' });
  expect(serverAuthority(controller.live.authoritiesOf('board'), current).kind).toBe('none');
  await controller.setLiveShareMode({ workspace: 'writer-test', share: share.id, mode: 'own' });
  expect(controller.live.editMark('board')).not.toBeNull();
});

test('an edit arriving while approval awaits the capability graph is fenced in the final transaction', async () => {
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  const { controller, share, initial } = await controlledTree(async () => {
    ready.resolve();
    await release.promise;

    return { mcp: [], slates: ['board'] };
  });

  const approval = controller.setLiveShareMode({ workspace: 'writer-test', share: share.id, mode: 'owner', revision: initial, approved: [] });
  await ready.promise;
  await controller.writeShared('board', { 'a.ts': replace('r1', 'before-a') }, 'pat');
  release.resolve();

  expect(await approval).toMatchObject({ ok: false });
  expect(controller.live.get(share.id)?.mode).toBe('own');
});

test('a pending editor mark denies owner authority at the send before any new build publishes', async () => {
  const { controller, share, initial } = await controlledTree();
  controller.live.setAuthority(share.id, { mode: 'owner', grantRevision: initial }, {
    slates: ['board'], members: [{ slate: 'board', namespace: 'workspace', member: 'fs.text', impact: 'observe' }],
  });

  const servers = new SharedServers({
    authoritiesOf: (slate) => controller.live.authoritiesOf(slate), revision: (slate) => slateRevision(controller.builds, slate), generation: () => 0,
  });

  const call = { slate: 'board', chain: [], address: { namespace: 'workspace', member: 'fs.text' } };
  servers.within(call);
  await controller.writeShared('board', { 'a.ts': replace('redirected runtime config', 'before-a') }, 'pat');

  expect(() => servers.within(call)).toThrow();
  expect(servers.authorityOf('board').kind).toBe('none');
  expect(controller.live.authoritiesOf('board')).toMatchObject([{ mode: 'owner', grantRevision: null, editedBy: 'pat' }]);
});

test('an unrelated in-flight build cannot clear a newer editor mark', async () => {
  const { controller, share, revision, snapshot, user, root } = await controlledTree();
  user.writeFile(`${root}/a.ts`, 'r1 earlier source');
  const earlierSource = snapshot();
  await controller.writeShared('board', { 'a.ts': replace('r2 editor source', 'r1 earlier source') }, 'pat');
  const unrelated = revision('r1', earlierSource);
  const approval = await controller.setLiveShareMode({ workspace: 'writer-test', share: share.id, mode: 'owner', revision: unrelated, approved: [] });

  expect(approval).toMatchObject({ ok: false, reason: 'bad_input' });
  expect(!approval.ok && approval.error).toContain("pat's change is still building");
  expect(controller.live.editMark('board')?.editor).toBe('pat');
  const built = revision('r2');
  const reviewed = await controller.setLiveShareMode({ workspace: 'writer-test', share: share.id, mode: 'owner', revision: built, approved: [] });

  expect(reviewed).toMatchObject({ ok: true, value: { editedBy: null } });
  expect(controller.live.editMark('board')).toBeNull();
});

test('a no-op rollback cannot change a later pending edit mark', async () => {
  const { write, rollback, marks } = await editorTree();
  const noop = write({ 'a.ts': replace('before-a', 'before-a') });
  write({ 'b.ts': replace('actual edit', 'before-b') }, 'sam');

  expect(rollback(noop)).toEqual({ restored: [], conflicts: [] });
  expect(marks.editMark('board')?.editor).toBe('sam');
});
