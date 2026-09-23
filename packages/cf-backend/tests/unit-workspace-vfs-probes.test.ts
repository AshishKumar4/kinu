/**
 * The shell's `kernel.vfs.as(cred)` view implements `CredentialedVfs`'s type probes. Defends: `touch` on an
 * existing file died with `targetVfs.isDirectory is not a function` (unix-commands.ts:3123).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { SqlDatabase, SqlRow, SqlValue, VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const ROOT: VfsCred = { uid: 0, gid: 0, groups: [0], umask: 0o022 };

const SESSION_USER: VfsCred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

const OTHER: VfsCred = { uid: 2001, gid: 2001, groups: [2001], umask: 0o022 };

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

async function openWorkspace(): Promise<NimbusWorkspace> {
  const database = new Database(':memory:');
  databases.push(database);

  const sql: SqlDatabase = {
    exec(query: string, ...bindings: SqlValue[]) {
      const statement = database.prepare<SqlRow, SQLQueryBindings[]>(query);
      const bound = bindings.map(sqlBinding);

      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return statement.all(...bound);
      statement.run(...bound);

      return [];
    },
  };

  return NimbusWorkspace.create({
    sql,
    transactions: { storage: { transactionSync: <T,>(fn: () => T): T => database.transaction(fn)() } },
    generation: 1,
  });
}

describe('the shell filesystem view answers the type probes its callers make', () => {
  test('touch on an existing file keeps its bytes instead of throwing', async () => {
    const workspace = await openWorkspace();
    await workspace.fs.writeFile('/home/main/keepme.txt', 'important bytes');

    const result = await workspace.exec('touch /home/main/keepme.txt');

    expect(result.stderr).not.toContain('isDirectory');
    expect(result.exitCode).toBe(0);
    expect(await workspace.fs.readFile('/home/main/keepme.txt')).toBe('important bytes');
  });

  test('touch under /tmp too — a mounted path resolves through a provider', async () => {
    const workspace = await openWorkspace();
    await workspace.fs.writeFile('/tmp/keepme.txt', 'scratch bytes');

    expect(await workspace.exec('touch /tmp/keepme.txt')).toMatchObject({ exitCode: 0 });
    expect(await workspace.fs.readFile('/tmp/keepme.txt')).toBe('scratch bytes');
  });

  test('touch still creates a file that does not exist', async () => {
    const workspace = await openWorkspace();

    expect(await workspace.exec('touch /home/main/fresh.txt')).toMatchObject({ exitCode: 0 });
    expect(await workspace.fs.readFile('/home/main/fresh.txt')).toBe('');
  });

  test('the probes are mount-aware and answer false for what is absent', async () => {
    const workspace = await openWorkspace();
    await workspace.fs.writeFile('/home/main/f.txt', 'x');
    const view = workspace.kernel.vfs.as(SESSION_USER);

    expect(view.isDirectory('/home/main')).toBe(true);
    expect(view.isFile('/home/main')).toBe(false);
    expect(view.isFile('/home/main/f.txt')).toBe(true);
    expect(view.isDirectory('/home/main/f.txt')).toBe(false);
    expect(view.isDirectory('/')).toBe(true);
    // Absent is false, never a throw (fs.existsSync semantics).
    expect(view.isFile('/home/main/nope.txt')).toBe(false);
    expect(view.isDirectory('/home/main/nope')).toBe(false);
  });

  test('a denial throws rather than collapsing into a quiet false', async () => {
    const workspace = await openWorkspace();
    const root = workspace.vfs.as(ROOT);
    root.mkdir('home/main/private', { recursive: true });
    root.chown('home/main/private', SESSION_USER.uid, SESSION_USER.gid);
    root.chmod('home/main/private', 0o700);
    root.writeFile('home/main/private/secret.txt', 'session bytes');

    const stranger = workspace.kernel.vfs.as(OTHER);

    // Traverse-x is missing for OTHER: EACCES, never a false a caller would read as a structural miss.
    expect(() => stranger.isFile('/home/main/private/secret.txt')).toThrow(/EACCES/);
    expect(workspace.kernel.vfs.as(SESSION_USER).isFile('/home/main/private/secret.txt')).toBe(true);
  });
});
