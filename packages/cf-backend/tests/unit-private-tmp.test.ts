/**
 * Per-credential `/tmp` (the `PrivateTmp` shape): one path, per-agent storage. It must hold on both the
 * file plane (raw filesystem) and the shell (kernel mount table), so every claim asserts both planes.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { SqlDatabase, SqlRow, SqlValue, VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import {
  programmaticHostOver,
  ensureProgrammaticReady,
  rpcExec,
  type ProgrammaticHost,
} from './helpers/programmatic-host';

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const ROOT: VfsCred = { uid: 0, gid: 0, groups: [0], umask: 0o022 };

const SESSION_USER: VfsCred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

const AGENT_A: VfsCred = { uid: 2001, gid: 2001, groups: [2001], umask: 0o022 };

const AGENT_B: VfsCred = { uid: 2002, gid: 2002, groups: [2002], umask: 0o022 };

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

interface Fixture {
  readonly workspace: NimbusWorkspace;
  readonly host: ProgrammaticHost;
  readonly storageKeys: () => string[];
  readonly confine: (cred: VfsCred, name: string) => void;
  /** A pid carrying `cred`: how a file-plane RPC names its identity. */
  readonly pidFor: (cred: VfsCred) => number;
}

async function openFixture(): Promise<Fixture> {
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

  const processes = new SessionProcessSupervisor();

  const workspace = await NimbusWorkspace.create({
    sql,
    transactions: { storage: { transactionSync: <T,>(fn: () => T): T => database.transaction(fn)() } },
    generation: 1,
    processes,
  });

  const host = programmaticHostOver(workspace).host;

  await ensureProgrammaticReady(host);

  return {
    workspace,
    host,
    storageKeys: () => [...sql.exec("SELECT path FROM inodes WHERE path LIKE 'tmp%'")]
      .map((row) => v.parse(v.string(), row.path)).sort(),
    confine: (cred, name) => {
      // A per-agent chown is uid-0 only.
      const root = workspace.vfs.as(ROOT);
      root.mkdir(`tmp/${name}`, { recursive: true });
      root.chown(`tmp/${name}`, cred.uid, cred.gid);
      root.chmod(`tmp/${name}`, 0o700);
      workspace.vfs.confinePrincipal(cred.uid, `tmp/${name}`);
    },
    pidFor: (cred) => processes.spawn('agent', ['agent'], '/home/main', { cred }).pid,
  };
}

describe('per-credential /tmp holds on both surfaces', () => {
  test('one path, two agents, two different files — and each plane agrees', async () => {
    const f = await openFixture();
    f.confine(AGENT_A, 'agent-a');
    f.confine(AGENT_B, 'agent-b');
    const pidA = f.pidFor(AGENT_A);
    const pidB = f.pidFor(AGENT_B);

    await f.workspace.supervisorOp({ op: 'writeFile', args: ['/tmp/note.txt', 'A via file plane'], pid: pidA });
    await f.workspace.supervisorOp({ op: 'writeFile', args: ['/tmp/note.txt', 'B via file plane'], pid: pidB });
    await rpcExec(f.host, 'echo A-shell > /tmp/shell.txt', { cred: AGENT_A });
    await rpcExec(f.host, 'echo B-shell > /tmp/shell.txt', { cred: AGENT_B });

    expect(f.storageKeys()).toEqual([
      'tmp',
      'tmp/agent-a',
      'tmp/agent-a/note.txt',
      'tmp/agent-a/shell.txt',
      'tmp/agent-b',
      'tmp/agent-b/note.txt',
      'tmp/agent-b/shell.txt',
    ]);

    expect(v.parse(v.nullable(v.string()), await f.workspace.supervisorOp({
      op: 'readFile', args: ['/tmp/note.txt'], pid: pidA,
    }))).toBe('A via file plane');
    expect(v.parse(v.nullable(v.string()), await f.workspace.supervisorOp({
      op: 'readFile', args: ['/tmp/note.txt'], pid: pidB,
    }))).toBe('B via file plane');

    // The design's core assertion: the shell reads the same bytes as the file plane, per agent.
    expect(await rpcExec(f.host, 'cat /tmp/note.txt', { cred: AGENT_A }))
      .toMatchObject({ stdout: 'A via file plane', exitCode: 0 });
    expect(await rpcExec(f.host, 'cat /tmp/note.txt', { cred: AGENT_B }))
      .toMatchObject({ stdout: 'B via file plane', exitCode: 0 });

    expect(v.parse(v.nullable(v.string()), await f.workspace.supervisorOp({
      op: 'readFile', args: ['/tmp/shell.txt'], pid: pidA,
    }))).toBe('A-shell\n');
    expect(v.parse(v.nullable(v.string()), await f.workspace.supervisorOp({
      op: 'readFile', args: ['/tmp/shell.txt'], pid: pidB,
    }))).toBe('B-shell\n');
  });

  test('an agent cannot see another agent through /tmp, on either plane', async () => {
    const f = await openFixture();
    f.confine(AGENT_A, 'agent-a');
    f.confine(AGENT_B, 'agent-b');
    await f.workspace.supervisorOp({ op: 'writeFile', args: ['/tmp/secret.txt', 'A only'], pid: f.pidFor(AGENT_A) });

    expect(v.parse(v.nullable(v.string()), await f.workspace.supervisorOp({
      op: 'readFile', args: ['/tmp/secret.txt'], pid: f.pidFor(AGENT_B),
    }))).toBeNull();
    expect(await rpcExec(f.host, 'cat /tmp/secret.txt', { cred: AGENT_B }))
      .toMatchObject({ exitCode: 1 });

    // Spelling the private root lands inside B's own tree.
    expect(await rpcExec(f.host, 'cat /tmp/agent-a/secret.txt', { cred: AGENT_B }))
      .toMatchObject({ exitCode: 1 });
    expect(f.storageKeys()).not.toContain('tmp/agent-b/secret.txt');
  });

  test('listing /tmp shows the agent its own tree, on both planes', async () => {
    const f = await openFixture();
    f.confine(AGENT_A, 'agent-a');
    f.confine(AGENT_B, 'agent-b');
    await f.workspace.supervisorOp({ op: 'writeFile', args: ['/tmp/mine.txt', 'a'], pid: f.pidFor(AGENT_A) });
    await f.workspace.supervisorOp({ op: 'writeFile', args: ['/tmp/theirs.txt', 'b'], pid: f.pidFor(AGENT_B) });

    expect(await rpcExec(f.host, 'ls /tmp', { cred: AGENT_A }))
      .toMatchObject({ stdout: 'mine.txt\n', exitCode: 0 });
    expect(workspace_readdir(f, AGENT_A)).toEqual(['mine.txt']);
    expect(workspace_readdir(f, AGENT_B)).toEqual(['theirs.txt']);
  });

  test('an unconfined principal is unchanged: /tmp is the shared tree', async () => {
    const f = await openFixture();
    f.confine(AGENT_A, 'agent-a');
    await rpcExec(f.host, 'echo shared > /tmp/plain.txt');

    expect(f.storageKeys()).toContain('tmp/plain.txt');
    expect(await rpcExec(f.host, 'cat /tmp/plain.txt')).toMatchObject({ stdout: 'shared\n' });
    expect(await rpcExec(f.host, 'cat /tmp/plain.txt', { cred: AGENT_A }))
      .toMatchObject({ exitCode: 1 });
  });

  test('a symlink with an absolute target cannot escape the private tree', async () => {
    const f = await openFixture();
    f.confine(AGENT_A, 'agent-a');
    await rpcExec(f.host, 'echo shared-secret > /tmp/bait.txt');
    expect(f.storageKeys()).toContain('tmp/bait.txt');

    await rpcExec(f.host, 'ln -s /tmp/bait.txt /tmp/escape', { cred: AGENT_A });
    const read = await rpcExec(f.host, 'cat /tmp/escape', { cred: AGENT_A });

    expect(read.stdout).not.toContain('shared-secret');
    expect(read.exitCode).not.toBe(0);
  });

  test('removal stays inside the private tree', async () => {
    const f = await openFixture();
    f.confine(AGENT_A, 'agent-a');
    await rpcExec(f.host, 'echo shared > /tmp/keep.txt');
    await f.workspace.supervisorOp({ op: 'writeFile', args: ['/tmp/keep.txt', 'a private one'], pid: f.pidFor(AGENT_A) });

    expect(await rpcExec(f.host, 'rm /tmp/keep.txt', { cred: AGENT_A }))
      .toMatchObject({ exitCode: 0 });

    expect(f.storageKeys()).not.toContain('tmp/agent-a/keep.txt');
    expect(f.storageKeys()).toContain('tmp/keep.txt');
  });

  test('a rename stays inside the private tree, on both planes', async () => {
    const f = await openFixture();
    f.confine(AGENT_A, 'agent-a');
    const pidA = f.pidFor(AGENT_A);
    await f.workspace.supervisorOp({ op: 'writeFile', args: ['/tmp/draft.txt', 'first'], pid: pidA });
    await f.workspace.supervisorOp({ op: 'writeFile', args: ['/tmp/final.txt', 'old'], pid: pidA });

    f.workspace.vfs.as(AGENT_A).rename('/tmp/draft.txt', '/tmp/final.txt');
    expect(v.parse(v.nullable(v.string()), await f.workspace.supervisorOp({
      op: 'readFile', args: ['/tmp/final.txt'], pid: pidA,
    }))).toBe('first');
    expect(f.storageKeys()).toEqual(['tmp', 'tmp/agent-a', 'tmp/agent-a/final.txt']);

    expect(await rpcExec(f.host, 'mv /tmp/final.txt /tmp/moved.txt', { cred: AGENT_A }))
      .toMatchObject({ exitCode: 0 });
    expect(v.parse(v.nullable(v.string()), await f.workspace.supervisorOp({
      op: 'readFile', args: ['/tmp/moved.txt'], pid: pidA,
    }))).toBe('first');
    expect(f.storageKeys()).toEqual(['tmp', 'tmp/agent-a', 'tmp/agent-a/moved.txt']);
  });

  test('releasing a principal detaches its scratch — /tmp dies with the node', async () => {
    const f = await openFixture();
    f.confine(AGENT_A, 'agent-a');
    await f.workspace.supervisorOp({ op: 'writeFile', args: ['/tmp/scratch.txt', 'private'], pid: f.pidFor(AGENT_A) });
    expect(f.storageKeys()).toContain('tmp/agent-a/scratch.txt');
    expect(v.parse(v.nullable(v.string()), await f.workspace.supervisorOp({
      op: 'readFile', args: ['/tmp/scratch.txt'], pid: f.pidFor(AGENT_A),
    }))).toBe('private');

    f.workspace.vfs.releasePrincipal(AGENT_A.uid);

    // Dropping the registration makes the scratch unreachable by path, so node /tmp is discarded at node
    // death while home survives to settle; only the host can remove the bytes.
    expect(v.parse(v.nullable(v.string()), await f.workspace.supervisorOp({
      op: 'readFile', args: ['/tmp/scratch.txt'], pid: f.pidFor(AGENT_A),
    }))).toBeNull();
    expect(f.workspace.vfs.as(ROOT).readFileString('tmp/agent-a/scratch.txt')).toBe('private');

    f.workspace.vfs.as(ROOT).removeRecursive('tmp/agent-a');
    expect(f.storageKeys()).not.toContain('tmp/agent-a/scratch.txt');
  });

  test('list reports the caller its own path space, never a storage key', async () => {
    const f = await openFixture();
    f.confine(AGENT_A, 'agent-a');
    f.confine(AGENT_B, 'agent-b');
    await f.workspace.supervisorOp({ op: 'writeFile', args: ['/tmp/mine.txt', 'a'], pid: f.pidFor(AGENT_A) });
    await f.workspace.supervisorOp({ op: 'writeFile', args: ['/tmp/theirs.txt', 'b'], pid: f.pidFor(AGENT_B) });

    const seen = f.workspace.vfs.as(AGENT_A).list(null, 500).entries.map((e) => e.path)
      .filter((p) => p === 'tmp' || p.startsWith('tmp/'));

    expect(seen).toContain('tmp/mine.txt');
    expect(seen).not.toContain('tmp/agent-a/mine.txt');
    // Emitting the shared root under `tmp` too would enumerate one name twice.
    expect(seen.filter((p) => p === 'tmp')).toHaveLength(1);
    expect(seen.some((p) => p.startsWith('tmp/agent-b'))).toBe(false);
    expect(seen).not.toContain('tmp/theirs.txt');
  });

  test('the shared and private trees keep separate change counters', async () => {
    const f = await openFixture();
    f.confine(AGENT_A, 'agent-a');
    await rpcExec(f.host, 'echo shared > /tmp/r.txt');
    const sharedRev = f.workspace.vfs.as(SESSION_USER).revision('tmp/r.txt');

    await f.workspace.supervisorOp({ op: 'writeFile', args: ['/tmp/r.txt', 'private'], pid: f.pidFor(AGENT_A) });

    // Two counters: one clock would invalidate an agent's cache on a stranger's write.
    expect(f.workspace.vfs.as(AGENT_A).revision('tmp/r.txt')).not.toBe(0);
    expect(f.workspace.vfs.as(SESSION_USER).revision('tmp/r.txt')).toBe(sharedRev);
  });
});

function workspace_readdir(f: Fixture, cred: VfsCred): string[] {
  return f.workspace.vfs.as(cred).readdir('/tmp').map((entry) => entry.name).sort();
}

describe('a confined principal may move its own bits and no others', () => {
  test('u+x is allowed: a guest that writes a script can run it', async () => {
    const f = await openFixture();
    f.confine(AGENT_A, 'agent-a');
    const home = f.workspace.vfs.as(ROOT);
    home.mkdir('home/agent-a', { recursive: true });
    home.chown('home/agent-a', AGENT_A.uid, AGENT_A.gid);
    home.chmod('home/agent-a', 0o700);

    await rpcExec(f.host, 'echo echo hi > /home/agent-a/build.sh', { cred: AGENT_A });
    expect(await rpcExec(f.host, 'chmod u+x /home/agent-a/build.sh', { cred: AGENT_A }))
      .toMatchObject({ exitCode: 0 });

    // u+x moves exactly the owner x bit and leaves group/other as provisioned.
    const mode = f.workspace.vfs.as(ROOT).stat('/home/agent-a/build.sh').mode & 0o777;
    expect(mode).toBe(0o744);
  });

  test('a widening mode is REFUSED, not quietly narrowed', async () => {
    const f = await openFixture();
    f.confine(AGENT_A, 'agent-a');
    const root = f.workspace.vfs.as(ROOT);
    root.mkdir('home/agent-a', { recursive: true });
    root.chown('home/agent-a', AGENT_A.uid, AGENT_A.gid);
    root.chmod('home/agent-a', 0o700);
    root.writeFile('home/agent-a/s.sh', 'echo hi');
    root.chown('home/agent-a/s.sh', AGENT_A.uid, AGENT_A.gid);
    root.chmod('home/agent-a/s.sh', 0o600);

    const refused = await rpcExec(f.host, 'chmod 777 /home/agent-a/s.sh', { cred: AGENT_A });

    expect(refused.exitCode).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toContain('u+x');
    // A clamp would apply 0o700 and report success; untouched mode is a refusal, not a lie.
    expect(f.workspace.vfs.as(ROOT).stat('/home/agent-a/s.sh').mode & 0o777).toBe(0o600);
  });

  test('`+x`, which sets all three triads, is refused for the same reason', async () => {
    const f = await openFixture();
    f.confine(AGENT_A, 'agent-a');
    const root = f.workspace.vfs.as(ROOT);
    root.mkdir('home/agent-a', { recursive: true });
    root.chown('home/agent-a', AGENT_A.uid, AGENT_A.gid);
    root.chmod('home/agent-a', 0o700);
    root.writeFile('home/agent-a/t.sh', 'echo hi');
    root.chown('home/agent-a/t.sh', AGENT_A.uid, AGENT_A.gid);
    root.chmod('home/agent-a/t.sh', 0o644);

    expect(await rpcExec(f.host, 'chmod +x /home/agent-a/t.sh', { cred: AGENT_A }))
      .toMatchObject({ exitCode: 1 });
    expect(f.workspace.vfs.as(ROOT).stat('/home/agent-a/t.sh').mode & 0o777).toBe(0o644);
  });

  test('an UNCONFINED principal keeps full chmod — this rule is for guests only', async () => {
    const f = await openFixture();
    await rpcExec(f.host, 'echo hi > /home/main/own.sh');

    expect(await rpcExec(f.host, 'chmod 755 /home/main/own.sh')).toMatchObject({ exitCode: 0 });
    expect(f.workspace.vfs.as(ROOT).stat('/home/main/own.sh').mode & 0o777).toBe(0o755);
  });
});
