// The local backend's environments, and the mount table that joins them into
// one view. The workspace keeps its own durable filesystem; the machine the
// CLI runs on is the `laptop` EXECUTOR, whose files ALSO appear in the
// workspace plane at `/pc` (vfs/mounts.ts). The property this suite has always
// protected — that the agent can actually reach the host's files, and that
// they are never silently confused with its own — survives as: host files
// under the mount point, workspace bytes canonical, no container locally.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCLIRuntime } from '../src/runtime';
import { walkRecursive } from '@kinu.run/agent-utils/vfs';
import { isVfsError } from '@kinu.run/core';
import { scratchDir, scratchPath } from '@kinu.run/test-utils';

function freshRuntime() {
  const db = new Database(':memory:');
  return createCLIRuntime(db, {
    dbPath: scratchPath('mount-plane', 'agent.db'),
    llm: { name: 'x', baseURL: 'http://localhost:0', headers: {}, model: 'm' },
  });
}

describe('the local backend file plane', () => {
  test('the workspace and the machine stay separate executors with different bytes', () => {
    const rt = freshRuntime();
    const names = rt.executionRouter!.listExecutors().map((e) => e.name).sort();
    expect(names).toEqual(['laptop', 'workspace']);

    const workspace = rt.executionRouter!.getProvider('workspace')!.files;
    const laptop = rt.executionRouter!.getProvider('laptop')!.files;
    expect(workspace).toBeDefined();
    expect(laptop).toBeDefined();
    expect(workspace).not.toBe(laptop);
  });

  test('/pc serves the real host filesystem inside the agent own plane', async () => {
    const rt = freshRuntime();
    const dir = scratchDir('mount-plane-host');
    writeFileSync(join(dir, 'existing.txt'), 'from the host');
    const mounted = rt.storage.vfs;

    // The machine's own absolute path, whole, under the mount point.
    expect(await mounted.readFile(`/pc${join(dir, 'existing.txt')}`, { encoding: 'utf8' }))
      .toBe('from the host');
    expect(await mounted.readdir(`/pc${dir}`)).toEqual(['existing.txt']);

    // A walk crosses the mount boundary and reports the machine's entries.
    const walk = await walkRecursive(mounted, `/pc${dir}`, 10, 100);
    expect(walk.truncated).toBe(false);
    expect(walk.entries.map((e) => e.path)).toEqual([`/pc${dir}/existing.txt`]);

    // Writes through the plane land on the machine.
    await mounted.writeFile(`/pc${dir}/written.txt`, 'from the agent');
    expect(readFileSync(join(dir, 'written.txt'), 'utf8')).toBe('from the agent');
  });

  test('/sandbox states its absence: no container binding exists locally', async () => {
    const mounted = freshRuntime().storage.vfs;

    let error: unknown;
    try { await mounted.readdir('/sandbox'); } catch (caught) { error = caught; }
    if (!isVfsError(error)) throw new Error(`expected a classified refusal, got ${String(error)}`);
    expect(error.code).toBe('ENXIO');
    expect(error.message).toContain('/sandbox — no Sandbox container bound');
    expect(await mounted.exists('/sandbox/workspace')).toBe(false);
    expect(await mounted.stat('/sandbox')).toBeNull();
  });

  test('the workspace tree stays canonical: host paths name nothing in it', async () => {
    const rt = freshRuntime();
    const dir = scratchDir('mount-plane-host');
    writeFileSync(join(dir, 'host-only.txt'), 'on the machine');
    const mounted = rt.storage.vfs;

    // A host path outside the mount point names nothing in the workspace.
    expect(await mounted.exists(join(dir, 'host-only.txt'))).toBe(false);

    await mounted.writeFile('notes.md', 'in the workspace');
    expect(await mounted.readFile('notes.md', { encoding: 'utf8' })).toBe('in the workspace');
  });
});
