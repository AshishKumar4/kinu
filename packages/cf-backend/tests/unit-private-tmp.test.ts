/**
 * Per-credential `/tmp` — the `PrivateTmp` shape.
 *
 * One global view per workspace, every agent's `/tmp` at the SAME path, backed
 * by that agent's own storage. The requirement that makes it hard is that it
 * must hold on BOTH surfaces: the file tool (`box.files.*`, which resolves the
 * raw filesystem) and the one real shell (`box.exec`, which resolves through
 * the kernel mount table). Those are different routes to the same tree, so a
 * fix at the mount layer alone would move the shell and leave the file tool
 * behind — one path meaning two files, which is the divergence the
 * one-real-shell rule exists to prevent. Both planes are asserted here for
 * every claim, because a test that exercised one would not notice.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { SqlDatabase, SqlRow, SqlValue, VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import {
  ensureProgrammaticReady,
  rpcExec,
  type ProgrammaticHost,
} from '../../../node_modules/@nimbus-sh/worker/dist/session/programmatic.js';
import {
  _rpcReadFile,
  _rpcWriteFile,
} from '../../../node_modules/@nimbus-sh/worker/dist/session/rpc.js';

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
  /** Raw storage keys under the scratch tree — what actually got written where. */
  readonly storageKeys: () => string[];
  /** Register a confined principal and provision its root, host-side. */
  readonly confine: (cred: VfsCred, name: string) => void;
  /** A pid carrying `cred`, which is how a file-plane RPC names its identity. */
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
  const workspace = await NimbusWorkspace.create({
    sql,
    transactions: { storage: { transactionSync: <T,>(fn: () => T): T => database.transaction(fn)() } },
    generation: 1,
  });
  const durable = new Map<string, unknown>();
  const processes = new SessionProcessSupervisor();
  const host: ProgrammaticHost = {
    _w1SessionDestroyed: false,
    env: {},
    ctx: {
      storage: {
        get: async (key) => durable.get(key),
        put: async (key, value) => { durable.set(key, value); },
        delete: async (key) => { durable.delete(key); },
        deleteAll: async () => { durable.clear(); },
        deleteAlarm: async () => undefined,
      },
    },
    shell: workspace.shell,
    shellProcessPid: null,
    sqliteFs: workspace.vfs,
    processes,
    portRegistry: new PortRegistry(),
    facetManager: null,
    viteDevServer: null,
    cirrusReal: null,
    _cpRegistry: workspace.registry,
    _viteShimPid: null,
    _viteShimPort: null,
    ensureSqliteFs: () => undefined,
    ensureFacetManager: () => undefined,
    initSession: async () => { throw new Error('workspace is already composed'); },
  };
  await ensureProgrammaticReady(host);
  return {
    workspace,
    host,
    storageKeys: () => [...sql.exec("SELECT path FROM inodes WHERE path LIKE 'tmp%'")]
      .map((row) => String(row.path)).sort(),
    confine: (cred, name) => {
      // A guest cannot provision its own root: a per-agent chown is uid-0 only.
      const root = workspace.vfs.as(ROOT);
      root.mkdir(`tmp/${name}`, { recursive: true });
      root.chown(`tmp/${name}`, cred.uid, cred.gid);
      root.chmod(`tmp/${name}`, 0o700);
      workspace.vfs.confinePrincipal(cred.uid, `tmp/${name}`);
    },
    pidFor: (cred) => processes.spawn('agent', ['agent'], '/home/user', { cred }).pid,
  };
}

describe('per-credential /tmp holds on both surfaces', () => {
  test('one path, two agents, two different files — and each plane agrees', async () => {
    const f = await openFixture();
    f.confine(AGENT_A, 'agent-a');
    f.confine(AGENT_B, 'agent-b');
    const pidA = f.pidFor(AGENT_A);
    const pidB = f.pidFor(AGENT_B);

    // One write per plane per agent, all naming the identical logical path.
    await _rpcWriteFile(f.host, '/tmp/note.txt', 'A via file plane', pidA);
    await _rpcWriteFile(f.host, '/tmp/note.txt', 'B via file plane', pidB);
    await rpcExec(f.host, 'echo A-shell > /tmp/shell.txt', { cred: AGENT_A });
    await rpcExec(f.host, 'echo B-shell > /tmp/shell.txt', { cred: AGENT_B });

    // Backed by separate storage, which is what makes the same path private.
    expect(f.storageKeys()).toEqual([
      'tmp',
      'tmp/agent-a',
      'tmp/agent-a/note.txt',
      'tmp/agent-a/shell.txt',
      'tmp/agent-b',
      'tmp/agent-b/note.txt',
      'tmp/agent-b/shell.txt',
    ]);

    // The file plane reads its own.
    expect(await _rpcReadFile(f.host, '/tmp/note.txt', pidA)).toBe('A via file plane');
    expect(await _rpcReadFile(f.host, '/tmp/note.txt', pidB)).toBe('B via file plane');

    // The shell plane reads THE SAME bytes as the file plane, per agent. This
    // is the assertion the whole design exists to satisfy.
    expect(await rpcExec(f.host, 'cat /tmp/note.txt', { cred: AGENT_A }))
      .toMatchObject({ stdout: 'A via file plane', exitCode: 0 });
    expect(await rpcExec(f.host, 'cat /tmp/note.txt', { cred: AGENT_B }))
      .toMatchObject({ stdout: 'B via file plane', exitCode: 0 });

    // ...and the file plane reads what the shell wrote.
    expect(await _rpcReadFile(f.host, '/tmp/shell.txt', pidA)).toBe('A-shell\n');
    expect(await _rpcReadFile(f.host, '/tmp/shell.txt', pidB)).toBe('B-shell\n');
  });

  test('an agent cannot see another agent through /tmp, on either plane', async () => {
    const f = await openFixture();
    f.confine(AGENT_A, 'agent-a');
    f.confine(AGENT_B, 'agent-b');
    await _rpcWriteFile(f.host, '/tmp/secret.txt', 'A only', f.pidFor(AGENT_A));

    // B naming the same path gets its own absence, not A's file.
    expect(await _rpcReadFile(f.host, '/tmp/secret.txt', f.pidFor(AGENT_B))).toBeNull();
    expect(await rpcExec(f.host, 'cat /tmp/secret.txt', { cred: AGENT_B }))
      .toMatchObject({ exitCode: 1 });

    // And B cannot reach A's storage by spelling the private root either: that
    // spelling lands inside B's own tree.
    expect(await rpcExec(f.host, 'cat /tmp/agent-a/secret.txt', { cred: AGENT_B }))
      .toMatchObject({ exitCode: 1 });
    expect(f.storageKeys()).not.toContain('tmp/agent-b/secret.txt');
  });

  test('listing /tmp shows the agent its own tree, on both planes', async () => {
    const f = await openFixture();
    f.confine(AGENT_A, 'agent-a');
    f.confine(AGENT_B, 'agent-b');
    await _rpcWriteFile(f.host, '/tmp/mine.txt', 'a', f.pidFor(AGENT_A));
    await _rpcWriteFile(f.host, '/tmp/theirs.txt', 'b', f.pidFor(AGENT_B));

    expect(await rpcExec(f.host, 'ls /tmp', { cred: AGENT_A }))
      .toMatchObject({ stdout: 'mine.txt\n', exitCode: 0 });
    expect(workspace_readdir(f, AGENT_A)).toEqual(['mine.txt']);
    expect(workspace_readdir(f, AGENT_B)).toEqual(['theirs.txt']);
  });

  test('an unconfined principal is unchanged: /tmp is the shared tree', async () => {
    const f = await openFixture();
    f.confine(AGENT_A, 'agent-a');
    await rpcExec(f.host, 'echo shared > /tmp/plain.txt');

    // No registration, so no rewrite — the key is the one it always was.
    expect(f.storageKeys()).toContain('tmp/plain.txt');
    expect(await rpcExec(f.host, 'cat /tmp/plain.txt')).toMatchObject({ stdout: 'shared\n' });
    // And a confined agent does not see it, because /tmp is its own root.
    expect(await rpcExec(f.host, 'cat /tmp/plain.txt', { cred: AGENT_A }))
      .toMatchObject({ exitCode: 1 });
  });

  test('a symlink with an absolute target cannot escape the private tree', async () => {
    const f = await openFixture();
    f.confine(AGENT_A, 'agent-a');
    await rpcExec(f.host, 'echo shared-secret > /tmp/bait.txt');
    expect(f.storageKeys()).toContain('tmp/bait.txt');

    // A link A can create, whose target names the shared tree by absolute path.
    await rpcExec(f.host, 'ln -s /tmp/bait.txt /tmp/escape', { cred: AGENT_A });
    const read = await rpcExec(f.host, 'cat /tmp/escape', { cred: AGENT_A });

    expect(read.stdout).not.toContain('shared-secret');
    expect(read.exitCode).not.toBe(0);
  });

  test('removal stays inside the private tree', async () => {
    const f = await openFixture();
    f.confine(AGENT_A, 'agent-a');
    await rpcExec(f.host, 'echo shared > /tmp/keep.txt');
    await _rpcWriteFile(f.host, '/tmp/keep.txt', 'a private one', f.pidFor(AGENT_A));

    expect(await rpcExec(f.host, 'rm /tmp/keep.txt', { cred: AGENT_A }))
      .toMatchObject({ exitCode: 0 });

    // A's copy is gone; the shared one it shares a NAME with is untouched.
    expect(f.storageKeys()).not.toContain('tmp/agent-a/keep.txt');
    expect(f.storageKeys()).toContain('tmp/keep.txt');
  });

  test('releasing a principal detaches its scratch — /tmp dies with the node', async () => {
    const f = await openFixture();
    f.confine(AGENT_A, 'agent-a');
    await _rpcWriteFile(f.host, '/tmp/scratch.txt', 'private', f.pidFor(AGENT_A));
    expect(f.storageKeys()).toContain('tmp/agent-a/scratch.txt');
    expect(await _rpcReadFile(f.host, '/tmp/scratch.txt', f.pidFor(AGENT_A))).toBe('private');

    f.workspace.vfs.releasePrincipal(AGENT_A.uid);

    // The registration is the only thing that pointed /tmp at that tree, so
    // dropping it makes the scratch unreachable by the path that wrote it —
    // which is what lets a node's /tmp be discarded at node death while its
    // home survives to be graded at settle. The bytes are still there for the
    // host to remove, and only for the host.
    expect(await _rpcReadFile(f.host, '/tmp/scratch.txt', f.pidFor(AGENT_A))).toBeNull();
    expect(f.workspace.vfs.as(ROOT).readFileString('tmp/agent-a/scratch.txt')).toBe('private');

    f.workspace.vfs.as(ROOT).removeRecursive('tmp/agent-a');
    expect(f.storageKeys()).not.toContain('tmp/agent-a/scratch.txt');
  });

  test('list reports the caller its own path space, never a storage key', async () => {
    const f = await openFixture();
    f.confine(AGENT_A, 'agent-a');
    f.confine(AGENT_B, 'agent-b');
    await _rpcWriteFile(f.host, '/tmp/mine.txt', 'a', f.pidFor(AGENT_A));
    await _rpcWriteFile(f.host, '/tmp/theirs.txt', 'b', f.pidFor(AGENT_B));

    const seen = f.workspace.vfs.as(AGENT_A).list(null, 500).entries.map((e) => e.path)
      .filter((p) => p === 'tmp' || p.startsWith('tmp/'));

    // Its own file under the name it knows, and nothing it cannot name: not the
    // private root, not the shared tree, not the other agent's.
    expect(seen).toContain('tmp/mine.txt');
    expect(seen).not.toContain('tmp/agent-a/mine.txt');
    // `tmp` names exactly one directory here — the caller's own root. Emitting
    // the shared root under the same name would enumerate one name twice.
    expect(seen.filter((p) => p === 'tmp')).toHaveLength(1);
    expect(seen.some((p) => p.startsWith('tmp/agent-b'))).toBe(false);
    expect(seen).not.toContain('tmp/theirs.txt');
  });

  test('the shared and private trees keep separate change counters', async () => {
    const f = await openFixture();
    f.confine(AGENT_A, 'agent-a');
    await rpcExec(f.host, 'echo shared > /tmp/r.txt');
    const sharedRev = f.workspace.vfs.as(SESSION_USER).revision('tmp/r.txt');

    await _rpcWriteFile(f.host, '/tmp/r.txt', 'private', f.pidFor(AGENT_A));

    // Same spelling, two files, so two counters. One clock for both would make
    // an agent's cache invalidate on a stranger's write.
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

    // The redirect created it 0644 under the default umask; u+x moves exactly
    // the owner x bit and leaves group and other at the value they were
    // provisioned with, which is the whole rule.
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
    // The refusal names the spelling that works, so the caller is not left
    // guessing which part offended.
    expect(`${refused.stdout}${refused.stderr}`).toContain('u+x');
    // A clamp would have applied 0o700 and reported success; the mode is
    // untouched, which is the difference between a refusal and a lie.
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
    await rpcExec(f.host, 'echo hi > /home/user/own.sh');

    expect(await rpcExec(f.host, 'chmod 755 /home/user/own.sh')).toMatchObject({ exitCode: 0 });
    expect(f.workspace.vfs.as(ROOT).stat('/home/user/own.sh').mode & 0o777).toBe(0o755);
  });
});
