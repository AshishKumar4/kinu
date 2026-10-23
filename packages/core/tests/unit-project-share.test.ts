/**
 * The project tree a share's viewer writes ({@link provisionProjectHome}, 1018-xar): the viewer writes the owner's project
 * and removes, renames or replaces none of the owner's state in it; nothing the viewer makes there is another agent's to
 * write; and the tree is shared by the boot that creates the workspace, never by a later one, wherever that boot stopped.
 */
import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { agentPlane, type TestAgent } from '@kinu.run/test-utils';
import { viewerCred } from '../src/execution/viewer-principal';
import { inlineWorkspaceStorage } from '../src/identity/inline-primitives';
import { facetHomeProvisioner } from '../src/strategy/node-workspace';
import {
  agentIdentity, confineAgentTmp, PROJECT_GID, PROJECT_OWNER_CRED, provisionAgentHome, provisionProjectHome, provisionWorkspaceSoul,
  VIEWER_HOME_NAME, type HomeRootVfs,
} from '../src/vfs/agent-home';
import { createWorkspace, workspaceGenerationStorage } from '../src/vfs/nimbus-workspace';
import { WORKSPACE_ROOT } from '../src/vfs/workspace-path';

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function stored(): Database {
  const database = new Database(':memory:');

  databases.push(database);

  return database;
}

/** The workspace in `database` as this build boots it. */
async function opened(database: Database) {
  const { sql, transactions } = inlineWorkspaceStorage(database);
  const bundle = createWorkspace({ sql, transactions, generation: workspaceGenerationStorage(sql) });
  const privileged = await bundle.privileged();
  const kernel = (await bundle.session()).vfs.as(CRED_KERNEL);

  return { bundle, sql, privileged, kernel };
}

/** A workspace this build has never booted: Nimbus's own tree, no `.kinu`. */
async function neverBooted(database: Database) {
  const { sql, transactions } = inlineWorkspaceStorage(database);
  const workspace = await NimbusWorkspace.create({ sql, transactions, generation: 1_000, cwd: WORKSPACE_ROOT, env: { HOME: WORKSPACE_ROOT } });

  return workspace.vfs.as(CRED_KERNEL);
}

/** What the project's root says about who writes it. */
function projectRoot(kernel: Pick<CredentialedVfs, 'stat' | 'getDefaultAcl'>) {
  const held = kernel.stat(WORKSPACE_ROOT);

  return { uid: held.uid, gid: held.gid, mode: held.mode & 0o7777, acl: kernel.getDefaultAcl(WORKSPACE_ROOT) };
}

const SHARED = { uid: 1000, gid: PROJECT_GID, mode: 0o3775, acl: 0o775 };

/** An older workspace's project, as it was before a share's commands wrote it. */
const UNSHARED = { uid: 1000, gid: 1000, mode: 0o755, acl: null };

describe("a share's viewer in the owner's project", () => {
  async function principals() {
    const { bundle, sql, privileged, kernel } = await opened(stored());
    const identity = agentIdentity(sql, VIEWER_HOME_NAME);

    const viewer: TestAgent = {
      cred: viewerCred(identity),
      home: provisionAgentHome(privileged.root, VIEWER_HOME_NAME, identity),
      tmp: confineAgentTmp(privileged.confiner, VIEWER_HOME_NAME, identity),
    };

    const hired = await facetHomeProvisioner({ ...privileged, sql })('researcher');

    if (hired.cred === undefined || hired.tmp === undefined) throw new Error('the hire was given no credential');
    const sibling: TestAgent = { cred: hired.cred, home: hired.home, tmp: hired.tmp };
    const owner: TestAgent = { cred: PROJECT_OWNER_CRED, home: WORKSPACE_ROOT, tmp: '/tmp/main' };

    provisionWorkspaceSoul(kernel, '# Kiln\n\nShip the Worker.\n');
    const shell = async (agent: TestAgent, command: string) => await (await agentPlane(bundle, agent)).shell.exec(command);

    return { bundle, kernel, viewer, sibling, owner, shell };
  }

  test("writes the owner's files and removes, renames or replaces none of the owner's state", async () => {
    const { viewer, owner, shell } = await principals();

    expect(await shell(owner, `printf owner > ${WORKSPACE_ROOT}/owned.txt`)).toMatchObject({ exitCode: 0 });
    expect(await shell(viewer, `printf viewer > ${WORKSPACE_ROOT}/owned.txt && printf viewer > ${WORKSPACE_ROOT}/planted.txt`)).toMatchObject({ exitCode: 0 });

    const refused = [
      `rm -f ${WORKSPACE_ROOT}/SOUL.md`, `mv ${WORKSPACE_ROOT}/SOUL.md ${WORKSPACE_ROOT}/soul.md`, `mv ${WORKSPACE_ROOT}/planted.txt ${WORKSPACE_ROOT}/SOUL.md`,
      `mv ${WORKSPACE_ROOT}/.kinu ${WORKSPACE_ROOT}/.kinu-old`, `rm -rf ${WORKSPACE_ROOT}/.kinu`, `rm -f ${WORKSPACE_ROOT}/owned.txt`,
      `mv ${WORKSPACE_ROOT}/owned.txt ${WORKSPACE_ROOT}/moved.txt`, `printf x >> ${WORKSPACE_ROOT}/SOUL.md`,
    ];

    for (const command of refused) expect({ command, exitCode: (await shell(viewer, command)).exitCode }).not.toMatchObject({ exitCode: 0 });

    // Its own it renames and removes, and the owner removes what it left.
    expect(await shell(viewer, `mv ${WORKSPACE_ROOT}/planted.txt ${WORKSPACE_ROOT}/kept.txt`)).toMatchObject({ exitCode: 0 });
    expect(await shell(owner, `cat ${WORKSPACE_ROOT}/owned.txt ${WORKSPACE_ROOT}/SOUL.md && test -d ${WORKSPACE_ROOT}/.kinu && rm ${WORKSPACE_ROOT}/kept.txt`))
      .toMatchObject({ exitCode: 0, stdout: 'viewer# Kiln\n\nShip the Worker.\n' });
  });

  test('makes nothing in the project another agent writes: no ACL, umask or move grants others write', async () => {
    const { bundle, kernel, viewer, sibling, owner, shell } = await principals();

    expect(await shell(owner, `printf owner > ${WORKSPACE_ROOT}/owned.txt`)).toMatchObject({ exitCode: 0 });
    expect(await shell(viewer, `mkdir ${WORKSPACE_ROOT}/opened`)).toMatchObject({ exitCode: 0 });
    // A chmod past its own principal is refused it, and so is the same grant spelled as the ACL its entries are made by.
    expect((await shell(viewer, `setfacl -d -m u::rwx,g::rwx,o::rwx ${WORKSPACE_ROOT}/opened`)).exitCode).not.toBe(0);
    expect(kernel.getDefaultAcl(`${WORKSPACE_ROOT}/opened`)).toBe(0o775);
    // Narrowing it is its own to do.
    expect(await shell(viewer, `mkdir ${WORKSPACE_ROOT}/opened/narrow && setfacl -d -m u::rwx,g::rwx,o::--- ${WORKSPACE_ROOT}/opened/narrow`)).toMatchObject({ exitCode: 0 });
    expect(await shell(viewer, `touch ${WORKSPACE_ROOT}/opened/file && mkdir ${WORKSPACE_ROOT}/opened/sub`)).toMatchObject({ exitCode: 0 });
    // A process sets its own umask: under none, in a directory without an ACL, or in its own /tmp and moved in, what it
    // makes still grants others no write.
    expect(await shell(viewer, `mkdir ${WORKSPACE_ROOT}/bare && setfacl -k ${WORKSPACE_ROOT}/bare && umask 000 && touch ${WORKSPACE_ROOT}/bare/file && mkdir ${WORKSPACE_ROOT}/bare/sub`))
      .toMatchObject({ exitCode: 0 });
    expect(await shell(viewer, `umask 000 && mkdir /tmp/made && touch /tmp/made/file && mv /tmp/made ${WORKSPACE_ROOT}/moved`)).toMatchObject({ exitCode: 0 });

    const writes = [
      `printf x >> ${WORKSPACE_ROOT}/opened/file`, `touch ${WORKSPACE_ROOT}/opened/new`, `touch ${WORKSPACE_ROOT}/opened/sub/new`,
      `rm -f ${WORKSPACE_ROOT}/opened/file`, `printf x >> ${WORKSPACE_ROOT}/owned.txt`, `touch ${WORKSPACE_ROOT}/new.txt`,
      `printf x >> ${WORKSPACE_ROOT}/bare/file`, `touch ${WORKSPACE_ROOT}/bare/sub/new`, `printf x >> ${WORKSPACE_ROOT}/moved/file`,
      `touch ${WORKSPACE_ROOT}/moved/new`,
    ];

    for (const command of writes) expect({ command, exitCode: (await shell(sibling, command)).exitCode }).not.toMatchObject({ exitCode: 0 });

    const plane = (await agentPlane(bundle, sibling)).vfs;

    await expect(writeText(plane, `${WORKSPACE_ROOT}/opened/file`, 'x')).rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
    await expect(writeText(plane, `${WORKSPACE_ROOT}/opened/sub/new`, 'x')).rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
    await expect(writeText(plane, `${WORKSPACE_ROOT}/moved/file`, 'x')).rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
  });
});

describe("the boot that shares the project", () => {
  test('is the one that creates the workspace: a reopening, or one whose generation restarted, leaves an older tree as it is', async () => {
    const database = stored();
    const first = await opened(database);

    expect(projectRoot(first.kernel)).toEqual(SHARED);
    first.kernel.chown(WORKSPACE_ROOT, 1000, 1000);
    first.kernel.chmod(WORKSPACE_ROOT, 0o755);
    first.kernel.setDefaultAcl(WORKSPACE_ROOT, null);

    expect(projectRoot((await opened(database)).kernel)).toEqual(UNSHARED);
    // The pid generation restarts at 1 when its row is lost while the tree survives: still a reopening.
    database.run('DELETE FROM kinu_workspace_generation');
    expect(projectRoot((await opened(database)).kernel)).toEqual(UNSHARED);
  });

  test('shares a new workspace however its first boot stopped: the next boot finishes it', async () => {
    /** The kernel's mutations, the `at`-th of which kills the boot. */
    const dying = (kernel: HomeRootVfs & Pick<CredentialedVfs, 'setDefaultAcl'>, at: number) => {
      let step = 0;

      const mutate = () => {
        if (step++ === at) throw new Error('the boot died here');
      };

      return {
        steps: () => step,
        root: {
          exists: (path: string) => kernel.exists(path),
          stat: (path: string) => kernel.stat(path),
          removeRecursive: (path: string) => kernel.removeRecursive(path),
          mkdir: (path: string, options?: { recursive?: boolean; mode?: number }) => { mutate(); kernel.mkdir(path, options); },
          chown: (path: string, uid: number | null, gid: number | null) => { mutate(); kernel.chown(path, uid, gid); },
          chmod: (path: string, mode: number) => { mutate(); kernel.chmod(path, mode); },
          setDefaultAcl: (path: string, perms: number | null) => { mutate(); kernel.setDefaultAcl(path, perms); },
        },
      };
    };

    const clean = dying(await neverBooted(stored()), Number.POSITIVE_INFINITY);

    provisionProjectHome(clean.root, { uid: 1000, gid: 1000 });
    const steps = clean.steps();

    expect(steps).toBeGreaterThan(3);

    for (let at = 0; at < steps; at++) {
      const database = stored();
      const boot = dying(await neverBooted(database), at);

      expect(() => provisionProjectHome(boot.root, { uid: 1000, gid: 1000 })).toThrow('the boot died here');
      expect({ at, root: projectRoot((await opened(database)).kernel) }).toEqual({ at, root: SHARED });
    }
  });
});
