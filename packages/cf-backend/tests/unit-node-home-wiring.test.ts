/**
 * The node home provisioner, against a real workspace.
 *
 * `agentHomeNodeProvisioner` is the seam a host fills so a swarm node stops
 * sharing the origin's file plane. It is asserted here rather than over a fake
 * because everything it claims is a substrate rule, not a line of its own code:
 * the uid floor, the uid-0-only `chown`, the 0o755 home mode and the EACCES a
 * sibling gets are all decided inside `SqliteVFS`, so a test with a stubbed root
 * view would assert only that three functions were called in order.
 *
 * The workspace is constructed directly, the way `unit-private-tmp.test.ts`
 * does, because the three things the seam needs — a uid-0 view, the principal
 * registry and durable SQL — are members of an in-isolate `NimbusWorkspace`.
 * A Durable Object holding a Nimbus SDK handle has none of them: every
 * filesystem RPC without a pid is pinned to the session user
 * (`@nimbus-sh/worker/dist/session/rpc.js:89-91`), and `confinePrincipal` has no
 * RPC at all — it exists only on `SqliteVFS`
 * (`@nimbus-sh/core/dist/vfs/sqlite-vfs.d.ts:302`). So the provisioner belongs
 * wherever the workspace object itself lives, and this is the plane that can
 * prove it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { SqlDatabase, SqlRow, SqlValue, VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import {
  agentHomeNodeProvisioner,
  AGENT_HOME_MODE,
  AGENT_TMP_MODE,
  AGENT_UID_FLOOR,
  type NodeIdentity,
  type NodeWorkspace,
  type NodeWorkspaceProvisioner,
} from '@proteus/core';
import {
  ensureProgrammaticReady,
  rpcExec,
  type ProgrammaticHost,
} from '../../../node_modules/@nimbus-sh/worker/dist/session/programmatic.js';

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const ROOT: VfsCred = { uid: 0, gid: 0, groups: [0], umask: 0o022 };

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
  /** The seam under test, wired from this workspace's own three members. */
  readonly provision: NodeWorkspaceProvisioner;
  /** A second provisioner over the same workspace — proves uid allocation is a
   *  row rather than state held by the closure that made it. */
  readonly reprovision: NodeWorkspaceProvisioner;
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
    processes: new SessionProcessSupervisor(),
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
  const wiring = { root: workspace.vfs.as(ROOT), confiner: workspace.vfs, sql };
  return {
    workspace,
    host,
    provision: agentHomeNodeProvisioner(wiring),
    reprovision: agentHomeNodeProvisioner({ ...wiring, root: workspace.vfs.as(ROOT) }),
  };
}

/** A node as the engine's own row names it. */
function node(nodeId: string): NodeIdentity {
  return { nodeId, rootId: 'root-1', depth: 1 };
}

/** Ownership and mode as the substrate itself records them, mode masked to the
 *  permission bits so a comparison is against `0o755` and not the file type. */
function statOf(workspace: NimbusWorkspace, path: string) {
  const stat = workspace.vfs.as(ROOT).stat(path);
  if (stat === null) throw new Error(`no inode at ${path}`);
  return { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
}

/** The credential the seam hands back, refusing the shared-plane value: a test
 *  that silently accepted `undefined` would pass against no boundary at all. */
function credOf(workspace: NodeWorkspace): VfsCred {
  if (!workspace.cred) throw new Error(`node at ${workspace.home} was given no credential`);
  return workspace.cred;
}

describe('a provisioned node gets a real home', () => {
  test('the home is its own, and the substrate agrees who owns it', async () => {
    const f = await openFixture();

    const provisioned = await f.provision(node('aX9'));

    expect(provisioned.isolation).toBe('private-home');
    expect(provisioned.home).toBe('/home/node-aX9');
    const cred = credOf(provisioned);
    expect(cred.uid).toBeGreaterThanOrEqual(AGENT_UID_FLOOR);
    // gid equals uid, so group membership is never a second way into a sibling.
    expect(cred.gid).toBe(cred.uid);
    expect(statOf(f.workspace, '/home/node-aX9')).toEqual({
      uid: cred.uid, gid: cred.uid, mode: AGENT_HOME_MODE,
    });
  });

  test('the node can write in its own home, through the one real shell', async () => {
    const f = await openFixture();
    const provisioned = await f.provision(node('aX9'));

    const wrote = await rpcExec(f.host, 'echo mine > /home/node-aX9/proof.txt', {
      cred: credOf(provisioned),
    });

    expect(wrote.exitCode).toBe(0);
    expect(f.workspace.vfs.as(ROOT).readFileString('/home/node-aX9/proof.txt')).toBe('mine\n');
  });

  test('its /tmp is private at the shared path', async () => {
    const f = await openFixture();
    const credA = credOf(await f.provision(node('aX9')));
    const credB = credOf(await f.provision(node('bK2')));

    f.workspace.vfs.as(credA).writeFile('/tmp/scratch', 'a');

    expect(f.workspace.vfs.as(credB).readdir('/tmp').map((entry) => entry.name)).toEqual([]);
    expect(statOf(f.workspace, 'tmp/node-aX9').mode).toBe(AGENT_TMP_MODE);
  });
});

describe('the allocation is durable and injective', () => {
  test('provisioning the same node twice returns the same uid and home', async () => {
    const f = await openFixture();

    const first = await f.provision(node('aX9'));
    // A fresh provisioner over the same workspace: an eviction between two
    // activations must not hand the node back a home it no longer owns.
    const second = await f.reprovision(node('aX9'));

    expect(credOf(second).uid).toBe(credOf(first).uid);
    expect(second.home).toBe(first.home);
    expect(statOf(f.workspace, first.home).uid).toBe(credOf(first).uid);
  });

  test('two nodes get two uids and two homes', async () => {
    const f = await openFixture();

    const a = await f.provision(node('aX9'));
    // A node id is a nanoid, so it may begin with `-`: the `node-` prefix has to
    // supply the safe first character without collapsing two ids into one home.
    const b = await f.provision(node('-Zq7'));

    expect(b.home).toBe('/home/node--Zq7');
    expect(credOf(b).uid).not.toBe(credOf(a).uid);
    expect(b.home).not.toBe(a.home);
  });
});

describe('one node cannot write into another node\u2019s home', () => {
  test('the shell refuses it and nothing lands', async () => {
    const f = await openFixture();
    const credA = credOf(await f.provision(node('aX9')));
    await f.provision(node('bK2'));

    const refused = await rpcExec(f.host, 'echo leak > /home/node-bK2/leak.txt', { cred: credA });

    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr.toLowerCase()).toContain('permission denied');
    expect(f.workspace.vfs.as(ROOT).exists('/home/node-bK2/leak.txt')).toBe(false);
  });

  test('the refusal is EACCES on the filesystem itself', async () => {
    const f = await openFixture();
    const credA = credOf(await f.provision(node('aX9')));
    await f.provision(node('bK2'));

    expect(() => f.workspace.vfs.as(credA).writeFile('/home/node-bK2/leak.txt', 'leak'))
      .toThrow(expect.objectContaining({ code: 'EACCES' }));
  });
});
