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
  SESSION_UID,
  type NodeIdentity,
  type NodeWorkspace,
  type NodeWorkspaceProvisioner,
} from '@kinu/core';
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

/** The ORIGIN: the session user every unnamed exec already runs as, and the owner
 *  of the repository a node is asked to work on. Its uid is the substrate's, not
 *  this file's — see {@link SESSION_UID}. */
const ORIGIN: VfsCred = { uid: SESSION_UID, gid: SESSION_UID, groups: [SESSION_UID], umask: 0o022 };

/** A tree only the ORIGIN has: the read window a node must keep. */
const ORIGIN_REPO = '/home/user/repo';

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

  test('two readers who are not the node can read it — which is what 0o755 is for', async () => {
    const f = await openFixture();
    const provisioned = await f.provision(node('aX9'));
    f.workspace.vfs.as(credOf(provisioned)).writeFile(`${provisioned.home}/candidate.md`, 'my answer\n');

    // The GRADER is scored on what is in a node's home and does not run as the
    // node; MERGE-BACK copies the winner's diff out. Both are the ORIGIN here,
    // and both need traverse plus read. Asserted as a read rather than against
    // `AGENT_HOME_MODE`, because comparing the substrate's record to the constant
    // that set it moves both sides of the comparison together — a home narrowed
    // to 0o700 satisfies that equality and locks both readers out.
    const origin = f.workspace.vfs.as(ORIGIN);
    expect(origin.readdir(provisioned.home).map((entry) => entry.name)).toEqual(['candidate.md']);
    expect(origin.readFileString(`${provisioned.home}/candidate.md`)).toBe('my answer\n');
    // The literal, once: owner writes, everyone reads.
    expect(statOf(f.workspace, provisioned.home).mode).toBe(0o755);
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

/** A repository only the ORIGIN has, with a needle deep enough that finding it
 *  requires walking rather than stat-ing a path the test already knows. */
function seedOriginRepo(workspace: NimbusWorkspace): void {
  const origin = workspace.vfs.as(ORIGIN);
  origin.mkdir(`${ORIGIN_REPO}/src/parser`, { recursive: true });
  origin.writeFile(`${ORIGIN_REPO}/README.md`, 'the origin cloned this\n');
  origin.writeFile(`${ORIGIN_REPO}/src/parser/lexer.ts`, 'export const NEEDLE_TOKEN = 1;\n');
}

describe('a node keeps the origin\u2019s read window', () => {
  test('it reads a file only the origin has', async () => {
    const f = await openFixture();
    seedOriginRepo(f.workspace);
    const provisioned = await f.provision(node('aX9'));

    // Through the filesystem, and through the one real shell, because a node
    // reads with both and a boundary that held for only one is not a boundary.
    expect(f.workspace.vfs.as(credOf(provisioned)).readFileString(`${ORIGIN_REPO}/README.md`))
      .toBe('the origin cloned this\n');
    expect(await rpcExec(f.host, `cat ${ORIGIN_REPO}/README.md`, { cred: credOf(provisioned) }))
      .toMatchObject({ exitCode: 0, stdout: 'the origin cloned this\n' });
  });

  test('it WALKS and greps the origin tree, rather than stat-ing one known path', async () => {
    const f = await openFixture();
    seedOriginRepo(f.workspace);
    const cred = credOf(await f.provision(node('aX9')));

    // The distinction that matters: a walk needs +x on every directory down the
    // chain, and a grep needs +r on files the node never named. The empty-tree
    // regression this design exists to prevent would pass a single stat of a path
    // handed to it and fail exactly here.
    const walked = await rpcExec(f.host, `find ${ORIGIN_REPO} -type f`, { cred });
    expect(walked.exitCode).toBe(0);
    expect(walked.stdout.split('\n').filter((line) => line.length > 0).sort()).toEqual([
      `${ORIGIN_REPO}/README.md`,
      `${ORIGIN_REPO}/src/parser/lexer.ts`,
    ]);

    const grepped = await rpcExec(f.host, `grep -rn NEEDLE_TOKEN ${ORIGIN_REPO}`, { cred });
    expect(grepped.exitCode).toBe(0);
    expect(grepped.stdout).toContain(`${ORIGIN_REPO}/src/parser/lexer.ts:1:`);
  });
});

describe('a node cannot write outside its own home, fail-closed', () => {
  test('the origin\u2019s tree refuses it, EACCES on the filesystem itself', async () => {
    const f = await openFixture();
    seedOriginRepo(f.workspace);
    const cred = credOf(await f.provision(node('aX9')));

    expect(() => f.workspace.vfs.as(cred).writeFile(`${ORIGIN_REPO}/planted.ts`, 'planted'))
      .toThrow(expect.objectContaining({ code: 'EACCES' }));
    // And through the shell, where a refusal the node can actually read matters.
    const refused = await rpcExec(f.host, `echo planted > ${ORIGIN_REPO}/planted.ts`, { cred });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr.toLowerCase()).toContain('permission denied');
    expect(f.workspace.vfs.as(ROOT).exists(`${ORIGIN_REPO}/planted.ts`)).toBe(false);
  });

  test('an existing origin file cannot be overwritten either', async () => {
    const f = await openFixture();
    seedOriginRepo(f.workspace);
    const cred = credOf(await f.provision(node('aX9')));

    // Separate from creating one: the parent directory's write bit stops a create,
    // the FILE's own bits stop an overwrite, and only one of those was asserted.
    expect(() => f.workspace.vfs.as(cred).writeFile(`${ORIGIN_REPO}/README.md`, 'rewritten'))
      .toThrow(expect.objectContaining({ code: 'EACCES' }));
    expect(f.workspace.vfs.as(ROOT).readFileString(`${ORIGIN_REPO}/README.md`))
      .toBe('the origin cloned this\n');
  });
});

describe('a node cannot widen its own home nor chown it away', () => {
  test('widening past its own principal is refused, and the mode is unchanged', async () => {
    const f = await openFixture();
    const provisioned = await f.provision(node('aX9'));
    const cred = credOf(provisioned);

    // The owner triad moves freely — `u+x` on a script a node wrote must work, or
    // the node cannot run what it built. What must not move is group and other,
    // and a confined principal is what makes that a substrate rule rather than a
    // convention: `confineAgentTmp` registers the uid, and registration is also
    // what makes the chmod ceiling apply.
    expect(() => f.workspace.vfs.as(cred).chmod(provisioned.home, 0o777))
      .toThrow(expect.objectContaining({ code: 'EPERM' }));
    expect(statOf(f.workspace, provisioned.home).mode).toBe(AGENT_HOME_MODE);
  });

  test('a sibling still cannot write it after the attempt', async () => {
    const f = await openFixture();
    const target = await f.provision(node('aX9'));
    const credA = credOf(target);
    const credB = credOf(await f.provision(node('bK2')));

    // The consequence, not just the refusal: a widened home would be a sibling's
    // to overwrite, which is the whole thing the boundary is for.
    expect(() => f.workspace.vfs.as(credA).chmod(target.home, 0o777)).toThrow();
    expect(() => f.workspace.vfs.as(credB).writeFile(`${target.home}/leak.txt`, 'leak'))
      .toThrow(expect.objectContaining({ code: 'EACCES' }));
  });

  test('giving the home away is refused — only uid 0 may chown across uids', async () => {
    const f = await openFixture();
    const provisioned = await f.provision(node('aX9'));
    const cred = credOf(provisioned);

    // Handing it to the origin would put a node's graded output under an owner the
    // grader cannot attribute, which is the shared plane again by another route.
    expect(() => f.workspace.vfs.as(cred).chown(provisioned.home, SESSION_UID, SESSION_UID))
      .toThrow(expect.objectContaining({ code: 'EPERM' }));
    expect(statOf(f.workspace, provisioned.home)).toEqual({
      uid: cred.uid, gid: cred.uid, mode: AGENT_HOME_MODE,
    });
  });
});
