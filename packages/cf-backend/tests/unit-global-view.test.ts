/**
 * One filesystem, a home per agent, permissions as the boundary, driven through the real Nimbus shell (`rpcExec`).
 * Defends both halves: writes outside an agent's home are refused, and the origin's files stay readable
 * (the regression that reverted the last isolation attempt, `unit-head-fork.test.ts:4-8`).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { SqlDatabase, SqlRow, SqlValue, VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import {
  agentCred,
  agentHome,
  agentIdentity,
  confineAgentTmp,
  provisionAgentHome,
  AGENT_HOME_MODE,
  AGENT_UID_FLOOR,
  MAIN_AGENT,
  SESSION_UID,
  WORKSPACE_ROOT,
} from '@kinu.run/core';
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
  readonly sql: SqlDatabase;
  readonly join: (agentName: string) => VfsCred;
  readonly pidFor: (cred: VfsCred) => number;
  readonly processes: SessionProcessSupervisor;
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
    sql,
    join: (agentName) => {
      const identity = agentIdentity(sql, agentName);
      const root = workspace.vfs.as(ROOT);
      provisionAgentHome(root, agentName, identity);
      confineAgentTmp(workspace.vfs, agentName, identity);

      return agentCred(identity);
    },
    pidFor: (cred) => processes.spawn('agent', ['agent'], WORKSPACE_ROOT, { cred }).pid,
    processes,
  };
}

async function statOf(workspace: NimbusWorkspace, path: string): Promise<{ uid: number; mode: number }> {
  const stat = await workspace.vfs.as(ROOT).stat(path);

  if (stat === null) throw new Error(`no inode at ${path}`);

  return { uid: stat.uid, mode: stat.mode & 0o777 };
}

describe('the layout — one function answers for every agent', () => {
  test('the workspace agent keeps the substrate\u2019s own home; a node gets its own', () => {
    expect(agentHome(MAIN_AGENT)).toBe(WORKSPACE_ROOT);
    expect(agentHome('node-a')).toBe('/home/node-a');
  });

  test('a name that could escape /home is refused, not sanitised', () => {
    // The cap is 96: the longest valid subordinate slug is 64 and the `sub-` prefix must not push it out.
    for (const bad of ['../etc', 'a/b', '/abs', '', 'Node-A', 'a'.repeat(97)]) {
      expect(() => agentHome(bad)).toThrow(/not a usable agent name/);
    }
  });

  test('an agent uid is allocated once and is durable thereafter', async () => {
    const f = await openFixture();
    const first = agentIdentity(f.sql, 'node-a');
    const second = agentIdentity(f.sql, 'node-a');
    const other = agentIdentity(f.sql, 'node-b');

    expect(first).toEqual(second);
    expect(first.uid).toBeGreaterThanOrEqual(AGENT_UID_FLOOR);
    expect(other.uid).not.toBe(first.uid);
    // Its own group, so group membership is never a second way into a sibling.
    expect(first.gid).toBe(first.uid);
    expect(agentIdentity(f.sql, MAIN_AGENT)).toEqual({ uid: SESSION_UID, gid: SESSION_UID });
  });

  test('a provisioned home is owned by its agent and readable by all', async () => {
    const f = await openFixture();
    f.join('node-a');

    expect(await statOf(f.workspace, '/home/node-a')).toEqual({
      uid: agentIdentity(f.sql, 'node-a').uid,
      mode: AGENT_HOME_MODE,
    });
  });
});

describe('permissions are the boundary — through the one real shell', () => {
  test('a write inside the agent\u2019s own home succeeds', async () => {
    const f = await openFixture();
    const nodeA = f.join('node-a');

    const wrote = await rpcExec(f.host, 'echo mine > /home/node-a/proof.txt', { cred: nodeA });

    expect(wrote.exitCode).toBe(0);
    expect(await f.workspace.vfs.as(ROOT).readFileString('/home/node-a/proof.txt')).toBe('mine\n');
    expect((await statOf(f.workspace, '/home/node-a/proof.txt')).uid).toBe(nodeA.uid);
  });

  test('the same write into a sibling\u2019s home is refused, and nothing lands', async () => {
    const f = await openFixture();
    const nodeA = f.join('node-a');
    f.join('node-b');

    const refused = await rpcExec(f.host, 'echo leak > /home/node-b/leak.txt', { cred: nodeA });

    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr.toLowerCase()).toContain('permission denied');
    expect(await f.workspace.vfs.as(ROOT).exists('/home/node-b/leak.txt')).toBe(false);
  });

  test('a write into the origin\u2019s own tree is refused, and nothing lands', async () => {
    const f = await openFixture();
    const nodeA = f.join('node-a');

    const refused = await rpcExec(f.host, `echo leak > ${WORKSPACE_ROOT}/leak.txt`, { cred: nodeA });

    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr.toLowerCase()).toContain('permission denied');
    expect(await f.workspace.vfs.as(ROOT).exists(`${WORKSPACE_ROOT}/leak.txt`)).toBe(false);
  });

  test('the refusal is EACCES on the filesystem itself, fail-closed', async () => {
    const f = await openFixture();
    const nodeA = f.join('node-a');
    f.join('node-b');

    expect(() => f.workspace.vfs.as(nodeA).writeFile('/home/node-b/leak.txt', 'leak'))
      .toThrow(expect.objectContaining({ code: 'EACCES' }));
  });

  test('a node cannot widen its own home to let a sibling in', async () => {
    const f = await openFixture();
    const nodeA = f.join('node-a');

    // chmod is confined to the caller's own triad: refused, never clamped.
    expect(() => f.workspace.vfs.as(nodeA).chmod('/home/node-a', 0o777)).toThrow(
      expect.objectContaining({ code: 'EPERM' }),
    );
    expect((await statOf(f.workspace, '/home/node-a')).mode).toBe(AGENT_HOME_MODE);
  });

  test('a node cannot give its home away, because chown is uid-0 only', async () => {
    const f = await openFixture();
    const nodeA = f.join('node-a');
    const nodeB = f.join('node-b');

    expect(() => f.workspace.vfs.as(nodeA).chown('/home/node-a', nodeB.uid, nodeB.gid)).toThrow(
      expect.objectContaining({ code: 'EPERM' }),
    );
  });
});

describe('the read window — the regression that must be unreachable', () => {
  test('a node reads a file only the origin has, through the real shell', async () => {
    const f = await openFixture();
    // The origin's own bytes, which the node did not create.
    f.workspace.vfs.as(ROOT).mkdir(`${WORKSPACE_ROOT}/repo`, { recursive: true });
    f.workspace.vfs.as(ROOT).writeFile(`${WORKSPACE_ROOT}/repo/main.ts`, 'export const answer = 42;\n');
    const nodeA = f.join('node-a');

    const read = await rpcExec(f.host, `cat ${WORKSPACE_ROOT}/repo/main.ts`, { cred: nodeA });

    expect(read.exitCode).toBe(0);
    expect(read.stdout).toContain('export const answer = 42;');
  });

  test('a node can walk and search the origin\u2019s tree, not merely stat one known path', async () => {
    const f = await openFixture();
    const root = f.workspace.vfs.as(ROOT);
    root.mkdir(`${WORKSPACE_ROOT}/repo/src`, { recursive: true });
    root.writeFile(`${WORKSPACE_ROOT}/repo/src/needle.ts`, 'const findMe = 1;\n');
    const nodeA = f.join('node-a');

    const listed = await rpcExec(f.host, `ls ${WORKSPACE_ROOT}/repo`, { cred: nodeA });
    const grepped = await rpcExec(f.host, `grep -rn findMe ${WORKSPACE_ROOT}/repo`, { cred: nodeA });

    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain('src');
    expect(grepped.exitCode).toBe(0);
    expect(grepped.stdout).toContain('findMe');
  });

  test('a sibling\u2019s home is readable too — read/exec-only means readable', async () => {
    const f = await openFixture();
    const nodeA = f.join('node-a');
    const nodeB = f.join('node-b');
    await rpcExec(f.host, 'echo b-work > /home/node-b/note.txt', { cred: nodeB });

    const read = await rpcExec(f.host, 'cat /home/node-b/note.txt', { cred: nodeA });

    expect(read.exitCode).toBe(0);
    expect(read.stdout).toContain('b-work');
  });

  test('the grader reads a node\u2019s home without running as that node', async () => {
    const f = await openFixture();
    const nodeA = f.join('node-a');
    await rpcExec(f.host, 'echo candidate > /home/node-a/answer.txt', { cred: nodeA });

    // The session user — the origin agent, and who grades — is not node-a.
    const graded = await rpcExec(f.host, 'cat /home/node-a/answer.txt');

    expect(graded.exitCode).toBe(0);
    expect(graded.stdout).toContain('candidate');
  });
});

describe('/tmp is private at the shared path, on both planes', () => {
  test('one path, two nodes, two files — and a sibling cannot see the other\u2019s', async () => {
    const f = await openFixture();
    const nodeA = f.join('node-a');
    const nodeB = f.join('node-b');

    await rpcExec(f.host, 'echo a-scratch > /tmp/scratch.txt', { cred: nodeA });
    await rpcExec(f.host, 'echo b-scratch > /tmp/scratch.txt', { cred: nodeB });

    const readA = await rpcExec(f.host, 'cat /tmp/scratch.txt', { cred: nodeA });
    const readB = await rpcExec(f.host, 'cat /tmp/scratch.txt', { cred: nodeB });

    expect(readA.stdout).toContain('a-scratch');
    expect(readA.stdout).not.toContain('b-scratch');
    expect(readB.stdout).toContain('b-scratch');
    expect(readB.stdout).not.toContain('a-scratch');
  });

  test('the file plane agrees with the shell — one path, not two files', async () => {
    const f = await openFixture();
    const nodeA = f.join('node-a');
    const nodeB = f.join('node-b');

    await rpcExec(f.host, 'echo via-shell > /tmp/both.txt', { cred: nodeA });

    // Read back through the supervisor op (the session's file plane) under the same identity.
    const sameAgent = v.parse(v.nullable(v.string()), await f.workspace.supervisorOp({
      op: 'readFile', args: ['/tmp/both.txt'], pid: f.pidFor(nodeA),
    }));

    expect(sameAgent).toContain('via-shell');

    // And the sibling's file plane does not see it at the identical path.
    await f.workspace.supervisorOp({
      op: 'writeFile', args: ['/tmp/both.txt', 'b-only'], pid: f.pidFor(nodeB),
    });

    const backAsA = await rpcExec(f.host, 'cat /tmp/both.txt', { cred: nodeA });
    expect(backAsA.stdout).toContain('via-shell');
    expect(backAsA.stdout).not.toContain('b-only');
  });
});
