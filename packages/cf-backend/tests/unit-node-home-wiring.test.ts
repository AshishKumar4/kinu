/**
 * `facetHomeProvisioner` against a real workspace: the uid floor, uid-0-only `chown`, 0o755 home and sibling EACCES are
 * `SqliteVFS` rules, and `confinePrincipal` has no RPC (`@nimbus-sh/core/dist/vfs/sqlite-vfs.d.ts:302`).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { HostedRuntime } from '@nimbus-sh/worker/workspace-host';
import type { SqlDatabase, SqlRow, SqlValue, VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  facetHomeProvisioner, headAgentName,
  AGENT_HOME_MODE,
  AGENT_TMP_MODE,
  AGENT_UID_FLOOR,
  SESSION_UID,
  type NodeIdentity,
  type NodeWorkspace,
  type NodeWorkspaceProvisioner,
} from '@kinu.run/core';
import type { NimbusSandboxHandle } from '@kinu.run/core';
import { nimbusSessionFiles, readExecutorFile, writeExecutorFileOp, type ExecutorFileLookup, type VFS } from '@kinu.run/core';
import { createWorkspace, workspaceGenerationStorage } from '@kinu.run/core/workspace';
import {
  credentialedSessionBox,
  programmaticHostOver,
  ensureProgrammaticReady,
  rpcExec,
  type ProgrammaticHost,
} from './helpers/programmatic-host';
import { withHostedNodeExecution, type HostedNodeHome } from '@kinu.run/core';

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const ROOT: VfsCred = { uid: 0, gid: 0, groups: [0], umask: 0o022 };

/** The session user every unnamed exec runs as, and owner of the repo a node works on. */
const ORIGIN: VfsCred = { uid: SESSION_UID, gid: SESSION_UID, groups: [SESSION_UID], umask: 0o022 };

/** A tree only the ORIGIN has: the read window a node must keep. */
const ORIGIN_REPO = '/home/main/repo';

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
  readonly runtime: () => Promise<HostedRuntime>;
  readonly provision: NodeWorkspaceProvisioner;
  /** A second provisioner over the same workspace: uid allocation is a row, not closure state. */
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

  const composed = programmaticHostOver(workspace);
  const host = composed.host;

  await ensureProgrammaticReady(host);
  const wiring = { root: workspace.vfs.as(ROOT), confiner: workspace.vfs, sql };

  return {
    workspace,
    host,
    runtime: composed.runtime,
    // Keyed on the node actor's storage key, not the raw node id: a rename must not move the home, and
    // two actors that briefly shared a name across a retirement must not share one.
    provision: (identity: NodeIdentity) => facetHomeProvisioner(wiring)(headAgentName(identity.nodeId)),
    reprovision: (identity: NodeIdentity) =>
      facetHomeProvisioner({ ...wiring, root: workspace.vfs.as(ROOT) })(headAgentName(identity.nodeId)),
  };
}

function node(nodeId: string): NodeIdentity {
  return { nodeId, rootId: 'root-1', depth: 1 };
}

/** Mode masked to permission bits, so comparisons are against `0o755`, not the file type. */
function statOf(workspace: NimbusWorkspace, path: string) {
  const stat = workspace.vfs.as(ROOT).stat(path);

  if (stat === null) throw new Error(`no inode at ${path}`);

  return { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
}

/** Refuses the shared-plane `undefined`, which would pass against no boundary at all. */
function credOf(workspace: NodeWorkspace): VfsCred {
  if (!workspace.cred) throw new Error(`node at ${workspace.home} was given no credential`);

  return workspace.cred;
}

describe('a provisioned node gets a real home', () => {
  test('the home is its own, and the substrate agrees who owns it', async () => {
    const f = await openFixture();

    const provisioned = await f.provision(node('aX9'));

    expect(provisioned.isolation).toBe('private-home');
    expect(provisioned.home).toBe('/home/head-aX9');
    const cred = credOf(provisioned);
    expect(cred.uid).toBeGreaterThanOrEqual(AGENT_UID_FLOOR);
    // gid equals uid, so group membership is never a second way into a sibling.
    expect(cred.gid).toBe(cred.uid);
    expect(statOf(f.workspace, '/home/head-aX9')).toEqual({
      uid: cred.uid, gid: cred.uid, mode: AGENT_HOME_MODE,
    });
  });

  test('the node can write in its own home, through the one real shell', async () => {
    const f = await openFixture();
    const provisioned = await f.provision(node('aX9'));

    const wrote = await rpcExec(f.host, 'echo mine > /home/head-aX9/proof.txt', {
      cred: credOf(provisioned),
    });

    expect(wrote.exitCode).toBe(0);
    expect(f.workspace.vfs.as(ROOT).readFileString('/home/head-aX9/proof.txt')).toBe('mine\n');
  });

  test('its /tmp is private at the shared path', async () => {
    const f = await openFixture();
    const credA = credOf(await f.provision(node('aX9')));
    const credB = credOf(await f.provision(node('bK2')));

    f.workspace.vfs.as(credA).writeFile('/tmp/scratch', 'a');

    expect(f.workspace.vfs.as(credB).readdir('/tmp').map((entry) => entry.name)).toEqual([]);
    expect(statOf(f.workspace, 'tmp/head-aX9').mode).toBe(AGENT_TMP_MODE);
  });

  test('two readers who are not the node can read it — which is what 0o755 is for', async () => {
    const f = await openFixture();
    const provisioned = await f.provision(node('aX9'));
    f.workspace.vfs.as(credOf(provisioned)).writeFile(`${provisioned.home}/candidate.md`, 'my answer\n');

    // Grader and merge-back run as the origin and need traverse plus read. Asserted as a read, not against
    // `AGENT_HOME_MODE`: a home narrowed to 0o700 would satisfy that equality and lock both out.
    const origin = f.workspace.vfs.as(ORIGIN);
    expect(origin.readdir(provisioned.home).map((entry) => entry.name)).toEqual(['.kinu', 'candidate.md']);
    expect(origin.readFileString(`${provisioned.home}/candidate.md`)).toBe('my answer\n');
    expect(statOf(f.workspace, provisioned.home).mode).toBe(0o755);
  });
});

describe('the allocation is durable and injective', () => {
  test('provisioning the same node twice returns the same uid and home', async () => {
    const f = await openFixture();

    const first = await f.provision(node('aX9'));
    // An eviction between two activations must not hand the node back a home it no longer owns.
    const second = await f.reprovision(node('aX9'));

    expect(credOf(second).uid).toBe(credOf(first).uid);
    expect(second.home).toBe(first.home);
    expect(statOf(f.workspace, first.home).uid).toBe(credOf(first).uid);
  });

  test('two nodes get two uids and two homes', async () => {
    const f = await openFixture();

    const a = await f.provision(node('aX9'));
    // A nanoid may begin with `-`: the `head-` prefix supplies a safe first character without merging homes.
    const b = await f.provision(node('-Zq7'));

    expect(b.home).toBe('/home/head--Zq7');
    expect(credOf(b).uid).not.toBe(credOf(a).uid);
    expect(b.home).not.toBe(a.home);
  });
});

describe('one node cannot write into another node\u2019s home', () => {
  test('the shell refuses it and nothing lands', async () => {
    const f = await openFixture();
    const credA = credOf(await f.provision(node('aX9')));
    await f.provision(node('bK2'));

    const refused = await rpcExec(f.host, 'echo leak > /home/head-bK2/leak.txt', { cred: credA });

    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr.toLowerCase()).toContain('permission denied');
    expect(f.workspace.vfs.as(ROOT).exists('/home/head-bK2/leak.txt')).toBe(false);
  });

  test('the refusal is EACCES on the filesystem itself', async () => {
    const f = await openFixture();
    const credA = credOf(await f.provision(node('aX9')));
    await f.provision(node('bK2'));

    expect(() => f.workspace.vfs.as(credA).writeFile('/home/head-bK2/leak.txt', 'leak'))
      .toThrow(expect.objectContaining({ code: 'EACCES' }));
  });
});

/** The needle sits deep enough that finding it requires walking, not stat-ing a known path. */
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

    // A node reads through both the filesystem and the shell; the boundary must hold on both.
    expect(f.workspace.vfs.as(credOf(provisioned)).readFileString(`${ORIGIN_REPO}/README.md`))
      .toBe('the origin cloned this\n');
    expect(await rpcExec(f.host, `cat ${ORIGIN_REPO}/README.md`, { cred: credOf(provisioned) }))
      .toMatchObject({ exitCode: 0, stdout: 'the origin cloned this\n' });
  });

  test('it WALKS and greps the origin tree, rather than stat-ing one known path', async () => {
    const f = await openFixture();
    seedOriginRepo(f.workspace);
    const cred = credOf(await f.provision(node('aX9')));

    // A walk needs +x down the chain and a grep needs +r on unnamed files; a single stat would pass an empty tree.
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
    const refused = await rpcExec(f.host, `echo planted > ${ORIGIN_REPO}/planted.ts`, { cred });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr.toLowerCase()).toContain('permission denied');
    expect(f.workspace.vfs.as(ROOT).exists(`${ORIGIN_REPO}/planted.ts`)).toBe(false);
  });

  test('an existing origin file cannot be overwritten either', async () => {
    const f = await openFixture();
    seedOriginRepo(f.workspace);
    const cred = credOf(await f.provision(node('aX9')));

    // Distinct from create: the parent's write bit stops a create, the file's own bits stop an overwrite.
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

    // The owner triad moves freely (a node must `u+x` what it built); group and other must not.
    // `confineAgentTmp` registers the uid, and registration is what applies the chmod ceiling.
    expect(() => f.workspace.vfs.as(cred).chmod(provisioned.home, 0o777))
      .toThrow(expect.objectContaining({ code: 'EPERM' }));
    expect(statOf(f.workspace, provisioned.home).mode).toBe(AGENT_HOME_MODE);
  });

  test('a sibling still cannot write it after the attempt', async () => {
    const f = await openFixture();
    const target = await f.provision(node('aX9'));
    const credA = credOf(target);
    const credB = credOf(await f.provision(node('bK2')));

    expect(() => f.workspace.vfs.as(credA).chmod(target.home, 0o777)).toThrow(
      expect.objectContaining({ code: 'EPERM' }),
    );
    expect(() => f.workspace.vfs.as(credB).writeFile(`${target.home}/leak.txt`, 'leak'))
      .toThrow(expect.objectContaining({ code: 'EACCES' }));
  });

  test('giving the home away is refused — only uid 0 may chown across uids', async () => {
    const f = await openFixture();
    const provisioned = await f.provision(node('aX9'));
    const cred = credOf(provisioned);

    // Handing the home to the origin would put graded output under an owner the grader cannot attribute.
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

/** Answers every command and records it; a refusal is scripted through {@link scriptedBox}. */
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

describe('hosted node execution', () => {
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
    // A credential is host-injected: an option arriving from anywhere else must not choose one.
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

/** `exec` and the pid-less file RPCs carry the same credential, so file tools and commands are one identity. */
function sessionBox(f: Fixture, cred: VfsCred): NimbusSandboxHandle {
  return credentialedSessionBox(f.runtime, cred);
}

describe('the hosted file plane acts as the node, or the home is unwritable', () => {
  test('an uncredentialed plane keeps the SDK surface — the ORIGIN is not routed through a runner', async () => {
    const nimbus = new RootExecNimbus();
    const box = nimbusBox(nimbus);
    const written: string[] = [];
    box.files.write = async (path) => { written.push(path); };

    await nimbusSessionFiles(box).writeFile('/home/main/notes.md', 'origin');

    expect(written).toEqual(['/home/main/notes.md']);
    expect(nimbus.calls).toEqual([]);
  });

  test('a credentialed plane whose view lacks stat, mkdir or readRange still acts as the node', async () => {
    // A fallback to the session user would silently change identity: the boundary is uid/gid on real inodes.
    const nimbus = new RootExecNimbus();
    const box = nimbusBox(nimbus);
    const cred: VfsCred = { uid: 2000, gid: 2000, groups: [2000], umask: 0o022 };
    box.files.as = () => ({ read: async () => null, write: async () => undefined, list: async () => [], exists: async () => false, delete: async () => undefined });

    const plane = nimbusSessionFiles(box, cred);
    await plane.mkdir('/home/node-A/dir', { recursive: true });
    await plane.stat('/home/node-A/dir');
    await plane.readRange('/home/node-A/file', 0, 4);

    expect(nimbus.calls).toHaveLength(3);
    expect(nimbus.calls.map((call) => call.options.cred)).toEqual([cred, cred, cred]);
  });

  test('a handle with no credential-bound plane refuses to act as a node, by name', () => {
    const box = nimbusBox(new RootExecNimbus());
    const cred: VfsCred = { uid: 2000, gid: 2000, groups: [2000], umask: 0o022 };

    expect(() => nimbusSessionFiles(box, cred)).toThrow(expect.objectContaining({ code: 'unsupported' }));
  });

  test('against the real substrate: the node writes its own home, a sibling is refused', async () => {
    const f = await openFixture();
    const a = credOf(await f.provision(node('aX9')));
    const b = credOf(await f.provision(node('bK2')));
    const asA = nimbusSessionFiles(sessionBox(f, a), a);
    const asB = nimbusSessionFiles(sessionBox(f, b), b);

    const bytes = new Uint8Array([0, 1, 2, 0xff, 0xfe, 0x80, 0x0a, 0x27, 0x5c]);
    await asA.writeFile('/home/head-aX9/candidate.bin', bytes);

    expect(await asA.readFile('/home/head-aX9/candidate.bin')).toEqual(bytes);
    expect(f.workspace.vfs.as(ROOT).readFile('/home/head-aX9/candidate.bin')).toEqual(bytes);
    expect(await asA.readdir('/home/head-aX9')).toEqual(['.kinu', 'candidate.bin']);
    expect((await asA.stat('/home/head-aX9/candidate.bin'))?.size).toBe(bytes.byteLength);
    expect(await asB.readFile('/home/head-aX9/candidate.bin')).toEqual(bytes);
    // The sibling's file tools are refused, not only its shell.
    await expect(asB.writeFile('/home/head-aX9/candidate.bin', 'overwritten'))
      .rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
    await expect(asB.mkdir('/home/head-aX9/hostile')).rejects.toThrow(
      expect.objectContaining({ code: 'EACCES' }),
    );
    await expect(asB.unlink('/home/head-aX9/candidate.bin')).rejects.toThrow(
      expect.objectContaining({ code: 'EACCES' }),
    );
    expect(f.workspace.vfs.as(ROOT).exists('/home/head-aX9/hostile')).toBe(false);
    // Absent is ENOENT and stat answers `null`; a boundary is neither.
    await expect(asA.readFile('/home/head-aX9/absent')).rejects.toThrow(
      expect.objectContaining({ code: 'ENOENT' }),
    );
    expect(await asA.stat('/home/head-aX9/absent')).toBeNull();
    // A real refusal: `stat` must not answer `null`, or a caller reads a boundary as empty space and writes into it.
    const shut = '/home/head-aX9/shut';
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
    const asA = nimbusSessionFiles(sessionBox(f, a), a);
    const names = ["we\nird 'q'-name", '--dash-leading', 'two  spaces\ttab', 'back\\slash$dollar'];

    for (const [index, name] of names.entries()) {
      await asA.writeFile(`/home/head-aX9/${name}`, `body ${String(index)}`);
    }

    expect((await asA.readdir('/home/head-aX9')).sort()).toEqual(['.kinu', ...names].sort());
    expect(await asA.readFile(`/home/head-aX9/${names[0]}`, { encoding: 'utf8' })).toBe('body 0');
    await asA.rename(`/home/head-aX9/${names[0]}`, '/home/head-aX9/clean');
    expect(await asA.exists(`/home/head-aX9/${names[0]}`)).toBe(false);
    expect(await asA.readFile('/home/head-aX9/clean', { encoding: 'utf8' })).toBe('body 0');
    await asA.unlink(`/home/head-aX9/${names[1]}`);
    expect((await asA.readdir('/home/head-aX9')).sort())
      .toEqual(['.kinu', 'back\\slash$dollar', 'clean', 'two  spaces\ttab']);
    await asA.mkdir('/home/head-aX9/nest/deep', { recursive: true });
    await asA.writeFile('/home/head-aX9/nest/deep/leaf', 'leaf');
    await asA.removeRecursive('/home/head-aX9/nest');
    expect(await asA.exists('/home/head-aX9/nest')).toBe(false);
  });

  test('against the real substrate: a large file lands byte-exact through the bound plane', async () => {
    const f = await openFixture();
    const a = credOf(await f.provision(node('aX9')));
    const asA = nimbusSessionFiles(sessionBox(f, a), a);
    // Non-repeating and past any single chunk, so a lost or reordered piece cannot pass.
    const big = new Uint8Array(2 * 1024 * 1024 + 4096);

    for (let at = 0; at < big.length; at += 1) big[at] = (at * 31 + (at >> 8)) & 0xff;

    await asA.writeFile('/home/head-aX9/big.bin', big);
    const read = await asA.readFile('/home/head-aX9/big.bin');
    const bytes = v.parse(v.instance(Uint8Array), read);

    expect(bytes).toEqual(big);
    expect((await asA.stat('/home/head-aX9/big.bin'))?.size).toBe(big.byteLength);
    expect(await asA.readRange('/home/head-aX9/big.bin', big.length - 8, 8)).toEqual(big.subarray(big.length - 8));
  });

  test('against the real substrate: a write onto a directory is refused and touches nothing', async () => {
    const f = await openFixture();
    const a = credOf(await f.provision(node('aX9')));
    const asA = nimbusSessionFiles(sessionBox(f, a), a);
    await asA.writeFile('/home/head-aX9/keeper', 'the old bytes\n');
    await asA.mkdir('/home/head-aX9/occupied', { recursive: true });
    await asA.writeFile('/home/head-aX9/occupied/child', 'child');

    await expect(asA.writeFile('/home/head-aX9/occupied', 'clobber')).rejects.toThrow();

    expect(await asA.readFile('/home/head-aX9/keeper', { encoding: 'utf8' })).toBe('the old bytes\n');
    expect(await asA.readFile('/home/head-aX9/occupied/child', { encoding: 'utf8' })).toBe('child');
    expect((await asA.readdir('/home/head-aX9')).sort()).toEqual(['.kinu', 'keeper', 'occupied']);
  });
});

describe('the in-isolate plane acts as the node on both surfaces', () => {
  test('main and a node keep private temporary files after workspace reset', async () => {
    const database = new Database(':memory:');
    databases.push(database);
    const sql = hostedSql(database);
    const transactions = { storage: { transactionSync: <T,>(fn: () => T): T => database.transaction(fn)() } };
    // One counter row bumped per open: the second workspace is the next generation of the same database.
    const first = createWorkspace({ sql, transactions, generation: workspaceGenerationStorage(sql) });
    const provision = facetHomeProvisioner(first.privileged().then((host) => ({ ...host, sql })));
    const identity = await provision(headAgentName(node('reset').nodeId));

    if (identity.isolation !== 'private-home') throw new Error('node needs its own home');
    const child = await first.asAgent(identity);
    expect(await first.shell.exec('echo main > /tmp/note; echo shared > /home/main/shared')).toMatchObject({ exitCode: 0 });
    expect(await child.shell.exec('echo node > /tmp/note')).toMatchObject({ exitCode: 0 });
    expect((await first.shell.exec('echo $HOME $TMPDIR')).stdout.trim()).toBe('/home/main /tmp/main');
    const second = createWorkspace({ sql, transactions, generation: workspaceGenerationStorage(sql) });
    const restored = await second.asAgent(identity);
    expect((await second.shell.exec('cat /tmp/note')).stdout).toBe('main\n');
    expect((await restored.shell.exec('cat /tmp/note')).stdout).toBe('node\n');
    expect(await restored.vfs.readFile('/home/main/shared', { encoding: 'utf8' })).toBe('shared\n');
    const root = (await second.privileged()).root;
    expect(root.exists('tmp/main/note')).toBe(true);
    await second.destroy();
  });
  test('its own writes pass, a sibling is refused, and the ORIGIN keeps its own identity', async () => {
    const database = new Database(':memory:');
    databases.push(database);
    const sql = hostedSql(database);

    const workspace = createWorkspace({
      sql,
      transactions: { storage: { transactionSync: <T,>(fn: () => T): T => database.transaction(fn)() } },
      generation: workspaceGenerationStorage(sql),
    });

    const provision = facetHomeProvisioner(
      workspace.privileged().then((privileged) => ({ ...privileged, sql })),
    );

    const a = await provision(headAgentName(node('aX9').nodeId));
    const b = await provision(headAgentName(node('bK2').nodeId));

    if (a.isolation !== 'private-home' || b.isolation !== 'private-home') {
      throw new Error('the in-isolate seam must provision credentials');
    }

    const asA = await workspace.asAgent(a);
    const asB = await workspace.asAgent(b);

    await asA.vfs.writeFile(`${a.home}/candidate.md`, 'my answer\n');
    expect(await asA.vfs.readFile(`${a.home}/candidate.md`, { encoding: 'utf8' })).toBe('my answer\n');
    await expect(asB.vfs.writeFile(`${a.home}/candidate.md`, 'stolen'))
      .rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
    expect(await asB.vfs.readFile(`${a.home}/candidate.md`, { encoding: 'utf8' })).toBe('my answer\n');

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

    expect((await workspace.shell.exec('id -u')).stdout).toContain(String(SESSION_UID));
    expect(await workspace.vfs.readFile(`${a.home}/candidate.md`, { encoding: 'utf8' })).toBe('my answer\n');

    // One plane per uid: a shell holds cwd, so a second call must not forget the node's `cd`.
    expect(await workspace.asAgent(a)).toBe(asA);
  });
});

/** The SDK's `files.write` takes no precondition and `stat` reports no revision, so no plane declares
 *  `writeFileIfRevision`: in-place save is `unsupported`, unconditional save lands. */
describe('a plane with no compare-and-write says so, once, in one voice', () => {
  const lookupFor = (files: VFS): ExecutorFileLookup => ({ getProvider: () => ({ files, homeDir: async () => '/home/main' }) });

  test('neither session plane declares a conditional write', async () => {
    const f = await openFixture();
    const a = credOf(await f.provision(node('cw1')));
    expect(nimbusSessionFiles(sessionBox(f, a), a)).not.toHaveProperty('writeFileIfRevision');
    expect(nimbusSessionFiles(sessionBox(f, ORIGIN))).not.toHaveProperty('writeFileIfRevision');
  });

  test('an in-place save is refused as unsupported and writes nothing; an unconditional save lands', async () => {
    const f = await openFixture();
    const a = credOf(await f.provision(node('cw2')));
    const plane = nimbusSessionFiles(sessionBox(f, a), a);
    const target = '/home/head-cw2/report.md';
    await plane.writeFile(target, 'the previous file');

    const refused = await writeExecutorFileOp(lookupFor(plane), 'workspace', target, { bytes: new TextEncoder().encode('the replacement'), expectedRevision: 3 });

    if (!('unsupported' in refused)) throw new Error('expected the unsupported refusal');
    expect(await plane.readFile(target, { encoding: 'utf8' })).toBe('the previous file');

    expect(await writeExecutorFileOp(lookupFor(plane), 'workspace', target, { bytes: new TextEncoder().encode('the replacement') })).toEqual({ ok: true });
    expect(await plane.readFile(target, { encoding: 'utf8' })).toBe('the replacement');
  });

  test('the viewer is handed the reason rather than an edit token', async () => {
    const f = await openFixture();
    const a = credOf(await f.provision(node('cw3')));
    const plane = nimbusSessionFiles(sessionBox(f, a), a);
    const target = '/home/head-cw3/notes.md';
    await plane.writeFile(target, 'editable text');

    const refused = await writeExecutorFileOp(lookupFor(plane), 'workspace', target, { bytes: new TextEncoder().encode('an edit'), expectedRevision: 7 });

    if (!('unsupported' in refused)) throw new Error('expected the unsupported refusal');
    const viewed = await readExecutorFile(lookupFor(plane), 'workspace', target);

    expect(viewed.content).toBe('editable text');
    expect(viewed.revision).toBeUndefined();
    expect(viewed.readOnlyReason).toBe(refused.error);
  });
});
