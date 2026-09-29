/**
 * `@nimbus-sh/core` exports `"bun": src`, `"import": dist`; a patch to only one
 * would pass here and differ in production, so this suite loads `dist`.
 */
import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { inlineWorkspaceStorage } from '@kinu.run/core/identity';

// By file: every export, `./*.js` included, answers Bun's condition with `src`, which a bundled Worker never loads.
const DIST = new URL(import.meta.resolve('@nimbus-sh/core/vfs/sqlite-vfs.js')).pathname
  .replace(/\/src\/vfs\/sqlite-vfs\.ts$/u, '/dist/vfs/sqlite-vfs.js');

if (!DIST.endsWith('/dist/vfs/sqlite-vfs.js')) throw new Error(`no dist build of SqliteVFS beside ${DIST}`);

const { SqliteVFS }: typeof import('@nimbus-sh/core/vfs/sqlite-vfs.js') = await import(DIST);

const ROOT: VfsCred = { uid: 0, gid: 0, groups: [0], umask: 0o022 };

const A: VfsCred = { uid: 2001, gid: 2001, groups: [2001], umask: 0o022 };

const B: VfsCred = { uid: 2002, gid: 2002, groups: [2002], umask: 0o022 };

test('dist carries the per-credential /tmp, the list reverse-map, and confined chmod', () => {
  const database = new Database(':memory:');

  const { sql, transactions } = inlineWorkspaceStorage(database);

  const vfs = new SqliteVFS(sql, transactions);

  const root = vfs.as(ROOT);
  root.mkdir('tmp', { recursive: true });
  root.chmod('tmp', 0o755);

  for (const [cred, name] of [[A, 'agent-a'], [B, 'agent-b']] as const) {
    root.mkdir(`tmp/${name}`, { recursive: true });
    root.chown(`tmp/${name}`, cred.uid, cred.gid);
    root.chmod(`tmp/${name}`, 0o700);
    vfs.confinePrincipal(cred.uid, `tmp/${name}`);
  }

  vfs.as(A).writeFile('/tmp/note.txt', 'A bytes');
  vfs.as(B).writeFile('/tmp/note.txt', 'B bytes');

  const keys = [...sql.exec("SELECT path FROM vfs_inodes WHERE path LIKE 'tmp%'")]
    .map((row) => v.parse(v.string(), row.path)).sort();

  expect(keys).toContain('tmp/agent-a/note.txt');
  expect(keys).toContain('tmp/agent-b/note.txt');
  expect(vfs.as(A).readFileString('/tmp/note.txt')).toBe('A bytes');
  expect(vfs.as(B).readFileString('/tmp/note.txt')).toBe('B bytes');

  expect(vfs.as(A).readdir('/tmp').map((e: { name: string }) => e.name)).toEqual(['note.txt']);

  const seen = vfs.as(A).list(null, 500).entries
    .map((e: { path: string }) => e.path)
    .filter((p: string) => p.startsWith('tmp'));

  expect(seen).toContain('tmp/note.txt');
  expect(seen.some((p: string) => p.includes('agent-b'))).toBe(false);

  vfs.as(A).rename('/tmp/note.txt', '/tmp/moved.txt');
  expect(vfs.as(A).readFileString('/tmp/moved.txt')).toBe('A bytes');
  expect(vfs.as(B).readFileString('/tmp/note.txt')).toBe('B bytes');
  expect([...sql.exec("SELECT path FROM vfs_inodes WHERE path LIKE 'tmp/agent-a/%'")].map((row) => v.parse(v.string(), row.path)))
    .toEqual(['tmp/agent-a/moved.txt']);

  root.mkdir('home/agent-a', { recursive: true });
  root.chown('home/agent-a', A.uid, A.gid);
  root.chmod('home/agent-a', 0o700);
  root.writeFile('home/agent-a/s.sh', 'echo hi');
  root.chown('home/agent-a/s.sh', A.uid, A.gid);
  root.chmod('home/agent-a/s.sh', 0o600);

  vfs.as(A).chmod('home/agent-a/s.sh', 0o700);
  expect(root.stat('home/agent-a/s.sh').mode & 0o777).toBe(0o700);
  expect(() => vfs.as(A).chmod('home/agent-a/s.sh', 0o777)).toThrow(/use u\+x/);
  expect(root.stat('home/agent-a/s.sh').mode & 0o777).toBe(0o700);

  expect(() => root.chmod('home/agent-a/s.sh', 0o755)).not.toThrow();
  expect(root.stat('home/agent-a/s.sh').mode & 0o777).toBe(0o755);
});

test('dist keeps file bytes coherent across an embedder transaction rollback', () => {
  const database = new Database(':memory:');

  try {
    const { sql, transactions } = inlineWorkspaceStorage(database);

    const vfs = new SqliteVFS(sql, transactions);

    const files = vfs.as(ROOT);
    const original = new TextEncoder().encode('committed source bytes');
    const replacement = new TextEncoder().encode('replacement source bytes that must roll back');
    expect(vfs).toHaveProperty('withTransaction');
    const atomic = <T,>(body: () => T): T => vfs.withTransaction(body);

    const committed = atomic(() => {
      files.writeFile('server.js', original);

      return files.readFile('server.js');
    });

    expect(committed).toEqual(original);
    expect(files.readFile('server.js')).toEqual(original);

    const failure = new Error('source write failed');
    expect(() => atomic(() => {
      files.writeFile('server.js', replacement);
      throw failure;
    })).toThrow(expect.objectContaining({ cause: failure }));
    expect(files.readFile('server.js')).toEqual(original);
  } finally {
    database.close();
  }
});

// Fix 1 of ASK-core-0.13.1, shipped in core 0.13.1: rename rebuilt the live inode from the entry before the move, so
// what was moved into a shared directory stayed its owner's alone.
test('dist shares what is moved into a shared directory, in the engine that moved it', () => {
  const database = new Database(':memory:');

  try {
    const { sql, transactions } = inlineWorkspaceStorage(database);

    const vfs = new SqliteVFS(sql, transactions);

    const root = vfs.as(ROOT);
    const member: VfsCred = { ...A, groups: [A.gid, 1000] };
    root.mkdir('shared');
    root.chown('shared', 0, 1000);
    root.chmod('shared', 0o2775);
    root.setDefaultAcl('shared', 0o775);
    vfs.registerSharedDirectory('shared');
    root.mkdir('home/agent-a', { recursive: true });
    root.chown('home/agent-a', A.uid, A.gid);
    vfs.as(member).mkdir('home/agent-a/draft');
    vfs.as(member).writeFile('home/agent-a/draft/app.js', 'moved in');

    vfs.as(member).rename('home/agent-a/draft', 'shared/draft');

    expect(root.stat('shared/draft/app.js')).toMatchObject({ gid: 1000 });
    vfs.as({ ...B, groups: [B.gid, 1000] }).writeFile('shared/draft/app.js', 'the other member writes');
    expect(root.readFileString('shared/draft/app.js')).toBe('the other member writes');
  } finally {
    database.close();
  }
});
