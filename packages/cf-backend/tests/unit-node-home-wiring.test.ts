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
} from '@kinu.run/core';
import type { NimbusSandboxHandle } from '@kinu.run/core';
import { AGENT_FS_CHUNK_BYTES, nimbusSessionFiles } from '@kinu.run/core';
import { createWorkspace } from '@kinu.run/core/workspace';
import {
  ensureProgrammaticReady,
  rpcExec,
  type ProgrammaticHost,
} from '../../../node_modules/@nimbus-sh/worker/dist/session/programmatic.js';
import {
  cleanupNimbusNodeHome, createNimbusNodeHomeProvisioner, withHostedNodeExecution,
  type HostedNodeHome,
} from '../src/node-home';

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

interface RootExecCall {
  readonly command: string;
  readonly options: {
    readonly cred?: VfsCred;
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    readonly stdin?: string;
  };
}

class RootExecNimbus {
  readonly calls: RootExecCall[] = [];
}

function hostedSql(database: Database): SqlDatabase {
  return {
    exec(query: string, ...bindings: SqlValue[]) {
      const statement = database.prepare<SqlRow, SQLQueryBindings[]>(query);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return statement.all(...bindings.map(sqlBinding));
      statement.run(...bindings.map(sqlBinding));
      return [];
    },
  };
}

/** A session that answers every command, and records what it was asked. The
 *  outcome is fixed: a test that needs a REFUSAL scripts one through
 *  {@link scriptedBox}, where the answer is the runner's own JSON. */
function nimbusBox(nimbus: RootExecNimbus): NimbusSandboxHandle {
  return {
    ready: async () => undefined,
    exec: async (command, options) => {
      nimbus.calls.push({ command, options: options ?? {} });
      return { command, success: true, exitCode: 0, stdout: '', stderr: '' };
    },
    files: {
      read: async () => null,
      write: async () => undefined,
      list: async () => [],
      exists: async () => false,
      delete: async () => undefined,
    },
  };
}

/** The node as its facet receives it, with the credential the layout allocates. */
const HOSTED_NODE: HostedNodeHome = {
  home: '/home/node-node-A',
  tmp: '/tmp/node-node-A',
  cred: { uid: 2000, gid: 2000, groups: [2000], umask: 0o022 },
};

describe('hosted node home seam', () => {
  test('applies the ONE layout, restores immutable identity after reset, and reclaims only bytes', async () => {
    const database = new Database(':memory:');
    databases.push(database);
    const nimbus = new RootExecNimbus();
    const first = createNimbusNodeHomeProvisioner(hostedSql(database), nimbusBox(nimbus));
    const initial = await first({ nodeId: 'node-A', rootId: 'root-1', depth: 2 });
    const afterReset = createNimbusNodeHomeProvisioner(hostedSql(database), nimbusBox(nimbus));
    const recovered = await afterReset({ nodeId: 'node-A', rootId: 'root-1', depth: 2 });

    expect(recovered).toEqual(initial);
    expect(initial).toMatchObject({
      home: '/home/node-node-A', tmp: '/tmp/node-node-A', isolation: 'private-home',
    });
    if (initial.isolation !== 'private-home') throw new Error('the hosted seam must provision a credential');
    expect(initial.cred.uid).toBeGreaterThanOrEqual(AGENT_UID_FLOOR);
    // The layout is core's table, applied as uid 0 and in ONE command: a home
    // created but not owned is a home its node cannot write.
    const applied = nimbus.calls[0];
    expect(applied?.options.cred?.uid).toBe(0);
    expect(applied?.command).toBe(
      `mkdir -p -- '/home/node-node-A' && chown ${initial.cred.uid}:${initial.cred.gid} '/home/node-node-A'`
      + " && chmod 755 '/home/node-node-A'"
      + ` && mkdir -p -- '/tmp/node-node-A' && chown ${initial.cred.uid}:${initial.cred.gid} '/tmp/node-node-A'`
      + " && chmod 700 '/tmp/node-node-A'",
    );

    await cleanupNimbusNodeHome(nimbusBox(nimbus), 'node-A');
    // Both directories, because the scratch is no longer inside the home.
    expect(nimbus.calls.at(-1)?.command).toBe("rm -rf -- '/home/node-node-A' '/tmp/node-node-A'");
    expect(database.prepare('SELECT agent_name, uid, gid FROM kinu_agent_identity').all())
      .toHaveLength(1);
  });

  test('rejects a hostile node id before it reaches the session shell', async () => {
    const database = new Database(':memory:');
    databases.push(database);
    const nimbus = new RootExecNimbus();

    await expect(createNimbusNodeHomeProvisioner(hostedSql(database), nimbusBox(nimbus))({
      nodeId: "node'; rm -rf /", rootId: 'root-1', depth: 2,
    })).rejects.toThrow('not a usable agent name');

    expect(nimbus.calls).toEqual([]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'kinu_agent_identity'").all())
      .toEqual([]);
  });

  test('binds the node credential, its home and its own scratch to every command', async () => {
    const nimbus = new RootExecNimbus();
    const base: NimbusSandboxHandle = {
      ...nimbusBox(nimbus),
      startProcess: async (command, options) => {
        nimbus.calls.push({ command, options: options ?? {} });
        return {
          command, pid: 1, startedAt: 0, ports: [],
          process: { pid: 1, command, state: 'running', exitCode: null, longRunning: true },
        };
      },
      runCode: async (code, options) => {
        nimbus.calls.push({ command: code, options: options ?? {} });
        return { command: code, success: true, exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const execution = withHostedNodeExecution(base, HOSTED_NODE);
    // A credential is HOST-INJECTED: an option arriving from anywhere else must
    // not be able to choose one.
    const attacker = { uid: 0, gid: 0, groups: [0], umask: 0o022 };

    await execution.exec('exec', { cred: attacker, cwd: '/outside', env: { HOME: '/outside' } });
    await execution.startProcess?.('process', { cred: attacker });
    await execution.runCode?.('code', { cred: attacker });

    expect(nimbus.calls).toHaveLength(3);
    expect(nimbus.calls.every(({ options }) => options.cred === HOSTED_NODE.cred)).toBe(true);
    expect(nimbus.calls[1]?.options.cwd).toBe(HOSTED_NODE.home);
    expect(nimbus.calls[2]?.options.env)
      .toEqual({ HOME: HOSTED_NODE.home, TMPDIR: HOSTED_NODE.tmp });
  });
});

/** The session as this repo reaches it: `exec` with a credential is the ONE
 *  surface that carries one, so the credentialed file plane is built on it. */
function sessionBox(host: ProgrammaticHost, cred: VfsCred): NimbusSandboxHandle {
  return {
    ready: async () => undefined,
    exec: async (rawCommand, options) => {
      // Assigned rather than spread conditionally: an absent environment must
      // stay an ABSENT KEY, because the runner reads presence to decide whether
      // it was handed a request at all.
      const forwarded: Parameters<typeof rpcExec>[2] = { cred: options?.cred ?? cred };
      if (options?.env !== undefined) forwarded.env = options.env;
      const result = await rpcExec(host, rawCommand, forwarded);
      return {
        command: rawCommand,
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    files: {
      read: async () => { throw new Error('a credentialed plane must not fall back to the session user'); },
      write: async () => { throw new Error('a credentialed plane must not fall back to the session user'); },
      list: async () => { throw new Error('a credentialed plane must not fall back to the session user'); },
      exists: async () => { throw new Error('a credentialed plane must not fall back to the session user'); },
      delete: async () => { throw new Error('a credentialed plane must not fall back to the session user'); },
    },
  };
}

/**
 * The runner's request, as this test reads it back off the wire.
 *
 * PARSED, never cast: this test's whole claim is that the plane put the path and
 * the payload in the environment as JSON, and a cast would assert that claim
 * against itself. The environment is parsed too, so a call that carried no
 * request fails here instead of reading as `{}`.
 */
const RequestEnvSchema = v.object({ KINU_AGENT_FS_REQUEST: v.string() });
const RequestSchema = v.object({
  op: v.string(),
  path: v.optional(v.string()),
  temp: v.optional(v.string()),
  b64: v.optional(v.string()),
  from: v.optional(v.string()),
  to: v.optional(v.string()),
  off: v.optional(v.number()),
  len: v.optional(v.number()),
  recursive: v.optional(v.boolean()),
});
type AgentFsRequest = v.InferOutput<typeof RequestSchema>;

function requestOf(call: RootExecCall | undefined): AgentFsRequest {
  const carried = v.parse(RequestEnvSchema, call?.options.env);
  return v.parse(RequestSchema, JSON.parse(carried.KINU_AGENT_FS_REQUEST));
}

/** A box answering the runner protocol from a script, so a mid-stream failure
 *  is a decision this test makes rather than one it waits for. */
function scriptedBox(
  nimbus: RootExecNimbus,
  answer: (op: string, index: number) => string,
): NimbusSandboxHandle {
  let index = 0;
  return {
    ...nimbusBox(nimbus),
    exec: async (rawCommand, options) => {
      const call: RootExecCall = { command: rawCommand, options: options ?? {} };
      nimbus.calls.push(call);
      const stdout = answer(requestOf(call).op, index);
      index += 1;
      return { command: rawCommand, success: true, exitCode: 0, stdout, stderr: '' };
    },
  };
}

describe('the hosted file plane acts as the node, or the home is unwritable', () => {
  test('the request is JSON in the environment; no path and no payload is shell text', async () => {
    const nimbus = new RootExecNimbus();
    const files = nimbusSessionFiles(
      scriptedBox(nimbus, () => JSON.stringify({ ok: true })), HOSTED_NODE.cred,
    );

    // A name and a payload holding everything a shell would act on.
    await files.writeFile("/home/node-node-A/we\nird 'q'-name", new Uint8Array([0, 0xff, 0x27, 0x60, 0x24]));

    const staged = nimbus.calls[0];
    expect(staged?.options.cred).toBe(HOSTED_NODE.cred);
    // ONE fixed program, and the only interpolated text in it.
    expect(staged?.command.startsWith('node -e ')).toBe(true);
    expect(staged?.command).not.toContain('node-node-A');
    expect(staged?.command).not.toContain('AP8nYCQ');
    expect(requestOf(staged)).toMatchObject({ op: 'stage', b64: 'AP8nYCQ=' });
    // Staged beside the target, then renamed onto it.
    const temp = String(requestOf(staged).temp);
    expect(temp.startsWith("/home/node-node-A/we\nird 'q'-name.kinu-")).toBe(true);
    expect(requestOf(nimbus.calls[1])).toEqual({
      op: 'commit', temp, path: "/home/node-node-A/we\nird 'q'-name",
    });
    expect(nimbus.calls).toHaveLength(2);
  });
  test('a refusal carries the substrate’s own errno, and absent is not refused', async () => {
    const nimbus = new RootExecNimbus();
    const refusing = (code: string) => nimbusSessionFiles(
      scriptedBox(nimbus, (op) => JSON.stringify(
        op === 'discard'
          ? { ok: true }
          : { ok: false, code, message: `${code}: home/node-node-B` },
      )),
      HOSTED_NODE.cred,
    );

    await expect(refusing('EACCES').writeFile('/home/node-node-B/leak', 'x'))
      .rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
    await expect(refusing('ENOTDIR').readdir('/home/node-node-B/file/inner'))
      .rejects.toThrow(expect.objectContaining({ code: 'ENOTDIR' }));
    // `stat` answers `null` for ENOENT ONLY. A refusal must not read as an
    // empty directory, and `exists` must not answer `false` to a boundary.
    expect(await refusing('ENOENT').stat('/home/node-node-A/absent')).toBeNull();
    expect(await refusing('ENOENT').exists('/home/node-node-A/absent')).toBe(false);
    await expect(refusing('EACCES').stat('/home/node-node-B/private'))
      .rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
    await expect(refusing('EACCES').exists('/home/node-node-B/private'))
      .rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
  });

  test('a write that fails mid-stream discards its temp and never touches the target', async () => {
    const nimbus = new RootExecNimbus();
    const files = nimbusSessionFiles(
      scriptedBox(nimbus, (op) => JSON.stringify(
        op === 'commit' ? { ok: false, code: 'EACCES', message: 'EACCES: home/node-node-A/target' } : { ok: true },
      )),
      HOSTED_NODE.cred,
    );

    await expect(files.writeFile('/home/node-node-A/target', 'new bytes'))
      .rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));

    const ops = nimbus.calls.map((call) => requestOf(call).op);
    expect(ops).toEqual(['stage', 'commit', 'discard']);
    // The temp it removes is the temp it staged — never the target.
    expect(requestOf(nimbus.calls[2]).temp).toBe(requestOf(nimbus.calls[0]).temp);
  });

  test('an uncredentialed plane keeps the SDK surface — the ORIGIN is not routed through a runner', async () => {
    const nimbus = new RootExecNimbus();
    const box = nimbusBox(nimbus);
    const written: string[] = [];
    box.files.write = async (path) => { written.push(path); };

    await nimbusSessionFiles(box).writeFile('/home/user/notes.md', 'origin');

    expect(written).toEqual(['/home/user/notes.md']);
    expect(nimbus.calls).toEqual([]);
  });

  test('against the real substrate: the node writes its own home, a sibling is refused', async () => {
    const f = await openFixture();
    const a = credOf(await f.provision(node('aX9')));
    const b = credOf(await f.provision(node('bK2')));
    const asA = nimbusSessionFiles(sessionBox(f.host, a), a);
    const asB = nimbusSessionFiles(sessionBox(f.host, b), b);

    const bytes = new Uint8Array([0, 1, 2, 0xff, 0xfe, 0x80, 0x0a, 0x27, 0x5c]);
    await asA.writeFile('/home/node-aX9/candidate.bin', bytes);

    // Byte-exact, and the ORIGIN's uid-0 view agrees these are the same rows.
    expect(await asA.readFile('/home/node-aX9/candidate.bin')).toEqual(bytes);
    expect(f.workspace.vfs.as(ROOT).readFile('/home/node-aX9/candidate.bin')).toEqual(bytes);
    expect(await asA.readdir('/home/node-aX9')).toEqual(['candidate.bin']);
    expect((await asA.stat('/home/node-aX9/candidate.bin'))?.size).toBe(bytes.byteLength);
    // The read window: a sibling reads a 0o755 home, which the grader and
    // merge-back need too.
    expect(await asB.readFile('/home/node-aX9/candidate.bin')).toEqual(bytes);
    // And the boundary: the sibling's FILE TOOLS are refused, not only its
    // shell. This is the half a session-user plane could never enforce.
    await expect(asB.writeFile('/home/node-aX9/candidate.bin', 'overwritten'))
      .rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
    await expect(asB.mkdir('/home/node-aX9/hostile')).rejects.toThrow(
      expect.objectContaining({ code: 'EACCES' }),
    );
    await expect(asB.unlink('/home/node-aX9/candidate.bin')).rejects.toThrow(
      expect.objectContaining({ code: 'EACCES' }),
    );
    expect(f.workspace.vfs.as(ROOT).exists('/home/node-aX9/hostile')).toBe(false);
    // Absent is ENOENT and stat answers `null`; a boundary is neither.
    await expect(asA.readFile('/home/node-aX9/absent')).rejects.toThrow(
      expect.objectContaining({ code: 'ENOENT' }),
    );
    expect(await asA.stat('/home/node-aX9/absent')).toBeNull();
    // And against a real refusal rather than a scripted one: a sibling's 0o700
    // directory inside A's home. `stat` must NOT answer `null` here, or a caller
    // reads a boundary as an empty space and writes into it.
    const shut = '/home/node-aX9/shut';
    f.workspace.vfs.as(ROOT).mkdir(shut, { recursive: true });
    f.workspace.vfs.as(ROOT).chown(shut, b.uid, b.gid);
    f.workspace.vfs.as(ROOT).chmod(shut, 0o700);
    f.workspace.vfs.as(ROOT).writeFile(`${shut}/secret`, 's');
    f.workspace.vfs.as(ROOT).chown(`${shut}/secret`, b.uid, b.gid);
    await expect(asA.stat(`${shut}/secret`)).rejects.toThrow(
      expect.objectContaining({ code: 'EACCES' }),
    );
    await expect(asA.exists(`${shut}/secret`)).rejects.toThrow(
      expect.objectContaining({ code: 'EACCES' }),
    );
  });

  test('against the real substrate: hostile names list, read, rename and delete exactly', async () => {
    const f = await openFixture();
    const a = credOf(await f.provision(node('aX9')));
    const asA = nimbusSessionFiles(sessionBox(f.host, a), a);
    // Every name `ls` cannot express unambiguously.
    const names = ["we\nird 'q'-name", '--dash-leading', 'two  spaces\ttab', 'back\\slash$dollar'];

    for (const [index, name] of names.entries()) {
      await asA.writeFile(`/home/node-aX9/${name}`, `body ${String(index)}`);
    }

    expect((await asA.readdir('/home/node-aX9')).sort()).toEqual([...names].sort());
    expect(await asA.readFile(`/home/node-aX9/${names[0]}`, { encoding: 'utf8' })).toBe('body 0');
    await asA.rename(`/home/node-aX9/${names[0]}`, '/home/node-aX9/clean');
    expect(await asA.exists(`/home/node-aX9/${names[0]}`)).toBe(false);
    expect(await asA.readFile('/home/node-aX9/clean', { encoding: 'utf8' })).toBe('body 0');
    await asA.unlink(`/home/node-aX9/${names[1]}`);
    expect((await asA.readdir('/home/node-aX9')).sort())
      .toEqual(['back\\slash$dollar', 'clean', 'two  spaces\ttab']);
    await asA.mkdir('/home/node-aX9/nest/deep', { recursive: true });
    await asA.writeFile('/home/node-aX9/nest/deep/leaf', 'leaf');
    await asA.removeRecursive('/home/node-aX9/nest');
    expect(await asA.exists('/home/node-aX9/nest')).toBe(false);
  });

  test('against the real substrate: a file larger than one payload, and what it costs', async () => {
    const f = await openFixture();
    const a = credOf(await f.provision(node('aX9')));
    const nimbus = new RootExecNimbus();
    const counted = sessionBox(f.host, a);
    const box: NimbusSandboxHandle = {
      ...counted,
      exec: async (rawCommand, options) => {
        nimbus.calls.push({ command: rawCommand, options: options ?? {} });
        return await counted.exec(rawCommand, options);
      },
    };
    const asA = nimbusSessionFiles(box, a);
    // Straddling the chunk boundary, with a non-repeating tail so a lost or
    // reordered chunk cannot pass.
    const big = new Uint8Array(AGENT_FS_CHUNK_BYTES + 4096);
    for (let at = 0; at < big.length; at += 1) big[at] = (at * 31 + (at >> 8)) & 0xff;

    await asA.writeFile('/home/node-aX9/big.bin', big);
    const writeCalls = nimbus.calls.length;
    nimbus.calls.length = 0;
    const read = await asA.readFile('/home/node-aX9/big.bin');
    const readCalls = nimbus.calls.length;
    // Parsed rather than tested at runtime: a byte read that came back decoded
    // would be a different contract, and this states which one is under test.
    const bytes = v.parse(v.instance(Uint8Array), read);

    expect(bytes).toEqual(big);
    expect((await asA.stat('/home/node-aX9/big.bin'))?.size).toBe(big.byteLength);
    // MEASURED COST, and the reason the chunk is a wire bound and not a file
    // limit: two chunks plus one commit to write; two chunks plus the
    // zero-length read that proves EOF to read.
    expect(writeCalls).toBe(3);
    expect(readCalls).toBe(3);
    // The base64 boundary itself: the last chunk is short and its own encode
    // must not pad into the middle of the stream.
    expect(bytes.subarray(AGENT_FS_CHUNK_BYTES - 3, AGENT_FS_CHUNK_BYTES + 3))
      .toEqual(big.subarray(AGENT_FS_CHUNK_BYTES - 3, AGENT_FS_CHUNK_BYTES + 3));
  });

  test('against the real substrate: a failed commit leaves the old target byte-exact and no temp', async () => {
    const f = await openFixture();
    const a = credOf(await f.provision(node('aX9')));
    const asA = nimbusSessionFiles(sessionBox(f.host, a), a);
    await asA.writeFile('/home/node-aX9/keeper', 'the old bytes\n');
    // A directory the rename cannot land on: the stage succeeds, the commit
    // fails, and the target must survive untouched.
    await asA.mkdir('/home/node-aX9/occupied', { recursive: true });
    await asA.writeFile('/home/node-aX9/occupied/child', 'child');

    await expect(asA.writeFile('/home/node-aX9/occupied', 'clobber')).rejects.toThrow();

    expect(await asA.readFile('/home/node-aX9/keeper', { encoding: 'utf8' })).toBe('the old bytes\n');
    expect(await asA.readFile('/home/node-aX9/occupied/child', { encoding: 'utf8' })).toBe('child');
    // And no staging file left behind for a later reader to trip over.
    expect((await asA.readdir('/home/node-aX9')).filter((name) => name.includes('.kinu-'))).toEqual([]);
  });
});


describe('the in-isolate plane acts as the node on both surfaces', () => {
  test('its own writes pass, a sibling is refused, and the ORIGIN keeps its own identity', async () => {
    const database = new Database(':memory:');
    databases.push(database);
    const sql = hostedSql(database);
    const workspace = createWorkspace({
      sql,
      transactions: { storage: { transactionSync: <T,>(fn: () => T): T => database.transaction(fn)() } },
      generation: 1,
    });
    const provision = agentHomeNodeProvisioner(
      workspace.privileged().then((privileged) => ({ ...privileged, sql })),
    );
    const a = await provision(node('aX9'));
    const b = await provision(node('bK2'));
    if (a.isolation !== 'private-home' || b.isolation !== 'private-home') {
      throw new Error('the in-isolate seam must provision credentials');
    }

    const asA = await workspace.asAgent(a);
    const asB = await workspace.asAgent(b);

    // FILE PLANE: its own home is writable, which a session-user plane refuses.
    await asA.vfs.writeFile(`${a.home}/candidate.md`, 'my answer\n');
    expect(await asA.vfs.readFile(`${a.home}/candidate.md`, { encoding: 'utf8' })).toBe('my answer\n');
    await expect(asB.vfs.writeFile(`${a.home}/candidate.md`, 'stolen'))
      .rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
    // The read window stays open, for the grader and for merge-back.
    expect(await asB.vfs.readFile(`${a.home}/candidate.md`, { encoding: 'utf8' })).toBe('my answer\n');

    // SHELL PLANE: the same identity, the node's home as cwd, and its own tmp.
    expect(await asA.shell.exec('pwd')).toMatchObject({ exitCode: 0, stdout: `${a.home}\n` });
    expect((await asA.shell.exec('echo $HOME $TMPDIR')).stdout.trim()).toBe(`${a.home} ${a.tmp}`);
    expect(await asA.shell.exec(`echo mine > ${a.home}/via-shell.txt`)).toMatchObject({ exitCode: 0 });
    const refused = await asB.shell.exec(`echo leak > ${a.home}/leak.txt`);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr.toLowerCase()).toContain('permission denied');
    expect(await asA.vfs.exists(`${a.home}/leak.txt`)).toBe(false);

    // A bare `/tmp` write is the node's own, because this isolate can rewrite it.
    expect(await asA.shell.exec('echo scratch > /tmp/pad.txt')).toMatchObject({ exitCode: 0 });
    expect(await workspace.vfs.exists('/tmp/pad.txt')).toBe(false);
    expect(await asA.vfs.readFile('/tmp/pad.txt', { encoding: 'utf8' })).toBe('scratch\n');

    // The ORIGIN is untouched: same filesystem, its own identity, and it can
    // still read every home it must grade.
    expect((await workspace.shell.exec('id -u')).stdout).toContain(String(SESSION_UID));
    expect(await workspace.vfs.readFile(`${a.home}/candidate.md`, { encoding: 'utf8' })).toBe('my answer\n');

    // One plane per uid: a shell holds cwd, so a second call must not hand the
    // node a fresh one that forgot its own `cd`.
    expect(await workspace.asAgent(a)).toBe(asA);
  });
});