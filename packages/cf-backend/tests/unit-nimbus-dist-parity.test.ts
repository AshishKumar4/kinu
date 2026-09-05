/**
 * The patched dependency behaves the same in the artifact PRODUCTION loads.
 *
 * `@nimbus-sh/core` ships a conditional exports map — `"bun": "./src/*.ts"`,
 * `"import": "./dist/*.js"` — so Bun resolves the TypeScript sources while a
 * bundled Worker resolves `dist`. A patch that edited only one of them would be
 * honoured by every test here and absent in production, or the reverse, and
 * nothing would say so. This suite loads `dist` on purpose for that reason.
 */
import { test, expect } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import type {
  SqlDatabase,
  SqlRow,
  SqlValue,
  TransactionHost,
  VfsCred,
} from '@nimbus-sh/core/runtime/os-contracts.js';
// Deliberately the dist artifact, by path: Bun's exports condition resolves
// `src`, so a test that imported the package name would never load what a
// bundled Worker loads.
import { SqliteVFS } from '../../../node_modules/@nimbus-sh/core/dist/vfs/sqlite-vfs.js';

const ROOT: VfsCred = { uid: 0, gid: 0, groups: [0], umask: 0o022 };
const A: VfsCred = { uid: 2001, gid: 2001, groups: [2001], umask: 0o022 };
const B: VfsCred = { uid: 2002, gid: 2002, groups: [2002], umask: 0o022 };

function sqlBinding(value: SqlValue): SQLQueryBindings {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.byteLength);
    const source = new DataView(value.buffer, value.byteOffset, value.byteLength);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = source.getUint8(index);
    return bytes;
  }
  return v.parse(v.union([v.string(), v.number(), v.bigint(), v.null()]), value);
}

test('dist carries the per-credential /tmp, the list reverse-map, and confined chmod', () => {
  const database = new Database(':memory:');
  const sql: SqlDatabase = {
    exec(query: string, ...bindings: SqlValue[]) {
      const statement = database.prepare<SqlRow, SQLQueryBindings[]>(query);
      const bound = bindings.map(sqlBinding);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return statement.all(...bound);
      statement.run(...bound);
      return [];
    },
  };
  const ctx: TransactionHost = {
    storage: { transactionSync: <T,>(fn: () => T): T => database.transaction(fn)() },
  };
  const vfs = new SqliteVFS(sql, ctx);

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

  const keys = [...sql.exec("SELECT path FROM inodes WHERE path LIKE 'tmp%'")]
    .map((row) => String(row.path)).sort();

  expect(keys).toContain('tmp/agent-a/note.txt');
  expect(keys).toContain('tmp/agent-b/note.txt');
  expect(vfs.as(A).readFileString('/tmp/note.txt')).toBe('A bytes');
  expect(vfs.as(B).readFileString('/tmp/note.txt')).toBe('B bytes');

  // readdir remap
  expect(vfs.as(A).readdir('/tmp').map((e: { name: string }) => e.name)).toEqual(['note.txt']);

  // list reverse-map: own name, not the storage key, and not the neighbour
  const seen = vfs.as(A).list(null, 500).entries
    .map((e: { path: string }) => e.path)
    .filter((p: string) => p.startsWith('tmp'));
  expect(seen).toContain('tmp/note.txt');
  expect(seen.some((p: string) => p.includes('agent-b'))).toBe(false);

  // rename resolves both names through the private root
  vfs.as(A).rename('/tmp/note.txt', '/tmp/moved.txt');
  expect(vfs.as(A).readFileString('/tmp/moved.txt')).toBe('A bytes');
  expect(vfs.as(B).readFileString('/tmp/note.txt')).toBe('B bytes');
  expect([...sql.exec("SELECT path FROM inodes WHERE path LIKE 'tmp/agent-a/%'")].map((row) => String(row.path)))
    .toEqual(['tmp/agent-a/moved.txt']);

  // confined chmod: owner triad moves, widening refused, nothing clamped
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

  // unconfined is untouched: root moves the mode and nothing refuses it
  expect(() => root.chmod('home/agent-a/s.sh', 0o755)).not.toThrow();
  expect(root.stat('home/agent-a/s.sh').mode & 0o777).toBe(0o755);
});
