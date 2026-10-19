/**
 * The workspace's one shared directory ({@link SCRATCH_ROOT}): every agent of a hosted workspace, whatever its kind,
 * reads and writes it through its file plane and its shell, and edits what another left there; what they leave stays
 * as any other file does. Each home stays its own agent's to write.
 */
import { readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { agentPlane, type TestAgent } from '@kinu.run/test-utils';
import { inlineWorkspaceStorage } from '../src/identity/inline-primitives';
import { facetHomeProvisioner, facetHomeReleaser, type NodeWorkspace } from '../src/strategy/node-workspace';
import type { WorkspaceActor } from '../src/identity/workspace-actors';
import { actorHomeName } from '../src/vfs/agent-home';
import { createWorkspace, workspaceGenerationStorage } from '../src/vfs/nimbus-workspace';
import { SCRATCH_ROOT, WORKSPACE_ROOT } from '../src/vfs/workspace-path';

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/** A workspace's rows, kept for the test's length. */
function stored(): Database {
  const database = new Database(':memory:');

  databases.push(database);

  return database;
}

/** The workspace in `database` as this build opens it, and its homes as the host provisions and releases each agent's. */
async function opened(database: Database) {
  const { sql, transactions } = inlineWorkspaceStorage(database);
  const bundle = createWorkspace({ sql, transactions, generation: workspaceGenerationStorage(sql) });
  const privileged = await bundle.privileged();

  return { bundle, kernel: privileged.root, homes: facetHomeProvisioner({ ...privileged, sql }), release: facetHomeReleaser({ ...privileged, sql }) };
}

/** A host's provisioner of an agent's home, named as `actorHomeName` names it. */
type Homes = (agentName: string) => Promise<NodeWorkspace>;

type ActorRecord = Pick<WorkspaceActor, 'origin' | 'name' | 'storageKey'>;

/** An agent as its host provisions it. */
async function provisioned(homes: Homes, record: ActorRecord): Promise<TestAgent & { readonly name: string }> {
  const name = actorHomeName(record);
  const home = await homes(name);

  if (home.cred === undefined || home.tmp === undefined) throw new Error(`${record.name} was given no credential`);

  return { name, cred: home.cred, home: home.home, tmp: home.tmp };
}

/** One agent of each kind: the workspace's own, a hire, a background agent and a swarm node. */
async function everyKind(homes: Homes): Promise<ReadonlyMap<string, TestAgent>> {
  return new Map<string, TestAgent>([
    ['main', { cred: CRED_SESSION_USER, home: WORKSPACE_ROOT, tmp: '/tmp/main' }],
    ['hire', await provisioned(homes, { origin: 'agent', name: 'researcher', storageKey: 'researcher' })],
    ['background', await provisioned(homes, { origin: 'evolution', name: 'tidy', storageKey: 'tidy' })],
    ['node', await provisioned(homes, { origin: 'swarm', name: 'exp:aX9', storageKey: 'aX9bK2cD3eF4gH5iJ6kL7m' })],
  ]);
}

describe('the shared directory', () => {
  test("a workspace made before it has it once this build opens it: root's, the workspace group's, setgid, with its ACL", async () => {
    const database = stored();
    const { sql, transactions } = inlineWorkspaceStorage(database);
    const before = await NimbusWorkspace.create({ sql, transactions, generation: 1_000, cwd: WORKSPACE_ROOT, env: { HOME: WORKSPACE_ROOT } });

    expect(before.vfs.as(CRED_KERNEL).exists(SCRATCH_ROOT)).toBe(false);
    const { bundle } = await opened(database);
    const kernel = (await bundle.session()).vfs.as(CRED_KERNEL);
    const held = kernel.stat(SCRATCH_ROOT);

    expect({ uid: held.uid, gid: held.gid, mode: held.mode & 0o7777, acl: kernel.getDefaultAcl(SCRATCH_ROOT) })
      .toEqual({ uid: 0, gid: 1000, mode: 0o2775, acl: 0o775 });
  });

  test('every kind of agent writes it through its file plane and its shell, and edits what another left', async () => {
    const { bundle, homes } = await opened(stored());
    const agents = await everyKind(homes);
    const kinds = [...agents];

    for (const [kind, agent] of kinds) {
      const plane = await agentPlane(bundle, agent);

      await writeText(plane.vfs, `${SCRATCH_ROOT}/${kind}.md`, `${kind} wrote this\n`);
      expect(await plane.shell.exec(`echo ${kind} >> ${SCRATCH_ROOT}/log.txt`)).toMatchObject({ exitCode: 0 });
    }

    // Each edits the next one's file in place through its file plane, and reads it back through its shell.
    for (const [index, [kind, agent]] of kinds.entries()) {
      const [next] = kinds[(index + 1) % kinds.length] ?? [kind];
      const plane = await agentPlane(bundle, agent);

      await writeText(plane.vfs, `${SCRATCH_ROOT}/${next}.md`, `${kind} edited ${next}'s\n`);
      expect(await plane.shell.exec(`cat ${SCRATCH_ROOT}/${next}.md`)).toMatchObject({ exitCode: 0, stdout: `${kind} edited ${next}'s\n` });
    }

    expect((await readText(bundle.vfs, `${SCRATCH_ROOT}/log.txt`)).trim().split('\n')).toEqual(kinds.map(([kind]) => kind));
  });

  test('what an agent leaves there stays: past its release and a reopening, while each home is still its own to write', async () => {
    const database = stored();
    const first = await opened(database);
    const hire = await provisioned(first.homes, { origin: 'agent', name: 'researcher', storageKey: 'researcher' });
    const node = await provisioned(first.homes, { origin: 'swarm', name: 'exp:aX9', storageKey: 'aX9bK2cD3eF4gH5iJ6kL7m' });
    const asHire = await agentPlane(first.bundle, hire);
    const asNode = await agentPlane(first.bundle, node);

    await writeText(asHire.vfs, `${SCRATCH_ROOT}/findings.md`, 'kept\n');
    // The homes keep their owners: the hire writes neither main's project nor the node's home.
    await expect(writeText(asHire.vfs, `${WORKSPACE_ROOT}/notes.md`, 'x')).rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
    await expect(writeText(asHire.vfs, `${node.home}/plan.md`, 'x')).rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
    expect((await asNode.shell.exec(`echo x > ${hire.home}/theirs.md`)).exitCode).not.toBe(0);

    await first.release(hire.name);
    const reopened = await opened(database);

    expect(await readText(reopened.bundle.vfs, `${SCRATCH_ROOT}/findings.md`)).toBe('kept\n');
  });
});
