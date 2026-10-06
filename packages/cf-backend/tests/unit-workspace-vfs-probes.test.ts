/**
 * The shell's `filesystem.namespaceFs(cred)` view implements `CredentialedVfs`'s type probes. Defends: `touch` on an
 * existing file died with `targetVfs.isDirectory is not a function` (unix-commands.ts:3123).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { CRED_KERNEL, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { inlineWorkspaceStorage } from '@kinu.run/core/identity';
import { settleWorkspaceRoot, WORKSPACE_ROOT } from '@kinu.run/core';

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const ROOT: VfsCred = { uid: 0, gid: 0, groups: [0], umask: 0o022 };

const SESSION_USER: VfsCred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

const OTHER: VfsCred = { uid: 2001, gid: 2001, groups: [2001], umask: 0o022 };

async function openWorkspace(): Promise<NimbusWorkspace> {
  const database = new Database(':memory:');
  databases.push(database);

  const { sql, transactions } = inlineWorkspaceStorage(database);

  const workspace = await NimbusWorkspace.create({
    sql,
    transactions,
    generation: 1,
    env: { HOME: WORKSPACE_ROOT },
  });

  // As Kinu's boot leaves it: Nimbus seeds the configured home, and root owns /home.
  settleWorkspaceRoot(workspace.vfs.as(CRED_KERNEL));

  return workspace;
}

describe('the shell filesystem view answers the type probes its callers make', () => {
  test('touch on an existing file keeps its bytes instead of throwing', async () => {
    const workspace = await openWorkspace();
    await workspace.fs.writeFile('/home/main/keepme.txt', 'important bytes');

    const result = await workspace.exec('touch /home/main/keepme.txt');

    expect(result.stderr).not.toContain('isDirectory');
    expect(result.exitCode).toBe(0);
    expect(await workspace.fs.readFileString('/home/main/keepme.txt')).toBe('important bytes');
  });

  test('touch under /tmp too — a mounted path resolves through a provider', async () => {
    const workspace = await openWorkspace();
    await workspace.fs.writeFile('/tmp/keepme.txt', 'scratch bytes');

    expect(await workspace.exec('touch /tmp/keepme.txt')).toMatchObject({ exitCode: 0 });
    expect(await workspace.fs.readFileString('/tmp/keepme.txt')).toBe('scratch bytes');
  });

  test('touch still creates a file that does not exist', async () => {
    const workspace = await openWorkspace();

    expect(await workspace.exec('touch /home/main/fresh.txt')).toMatchObject({ exitCode: 0 });
    expect(await workspace.fs.readFileString('/home/main/fresh.txt')).toBe('');
  });

  test('the probes are mount-aware and answer false for what is absent', async () => {
    const workspace = await openWorkspace();
    await workspace.fs.writeFile('/home/main/f.txt', 'x');
    const view = workspace.filesystem.namespaceFs(SESSION_USER);

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

    const stranger = workspace.filesystem.namespaceFs(OTHER);

    // Traverse-x is missing for OTHER: EACCES, never a false a caller would read as a structural miss.
    expect(() => stranger.isFile('/home/main/private/secret.txt')).toThrow(/EACCES/);
    expect(workspace.filesystem.namespaceFs(SESSION_USER).isFile('/home/main/private/secret.txt')).toBe(true);
  });
});
