// The local backend's environments. There is no mount table any more: the
// workspace has its own durable filesystem, and the machine the CLI runs on is
// the `laptop` EXECUTOR, reached through its own namespace in the machine's own
// absolute paths. The property this suite has always protected — that the
// agent can actually reach the host's files, and that they are not silently
// confused with its own — survives the change and is what is asserted here.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCLIRuntime } from '../src/runtime';
import { scratchDir, scratchPath } from '@proteus/test-utils';

function freshRuntime() {
  const db = new Database(':memory:');
  return createCLIRuntime(db, {
    dbPath: scratchPath('mount-plane', 'agent.db'),
    llm: { name: 'x', baseURL: 'http://localhost:0', headers: {}, model: 'm' },
  });
}

describe('the local backend’s environments', () => {
  test('the workspace and the machine are separate filesystems', () => {
    const rt = freshRuntime();
    const names = rt.executionRouter!.listExecutors().map((e) => e.name).sort();
    expect(names).toEqual(['laptop', 'workspace']);

    // Both carry a file view, and they are different objects addressing
    // different bytes — which is what stops a host path from being confused
    // with a workspace path.
    const workspace = rt.executionRouter!.getProvider('workspace')!.files;
    const laptop = rt.executionRouter!.getProvider('laptop')!.files;
    expect(workspace).toBeDefined();
    expect(laptop).toBeDefined();
    expect(workspace).not.toBe(laptop);
  });

  test('the laptop executor reads and writes the real host filesystem', async () => {
    const laptop = freshRuntime().executionRouter!.getProvider('laptop')!.files!;
    const dir = scratchDir('mount-plane-host');
    writeFileSync(join(dir, 'existing.txt'), 'from the host');

    // The machine's OWN absolute paths — no prefix to add or strip.
    expect(await laptop.readFile(join(dir, 'existing.txt'), { encoding: 'utf8' }))
      .toBe('from the host');
    expect(await laptop.readdir(dir)).toEqual(['existing.txt']);

    await laptop.mkdir(join(dir, 'nested'), { recursive: true });
    await laptop.writeFile(join(dir, 'nested', 'written.txt'), 'from the agent');
    expect(readFileSync(join(dir, 'nested', 'written.txt'), 'utf8')).toBe('from the agent');

    const stat = await laptop.stat(join(dir, 'nested'));
    expect(stat?.isDir).toBe(true);
    // Core VFS contract: a missing path stats as null rather than throwing.
    expect(await laptop.stat(join(dir, 'absent'))).toBeNull();

    await laptop.unlink(join(dir, 'existing.txt'));
    expect(await laptop.exists(join(dir, 'existing.txt'))).toBe(false);
  });

  test("the workspace filesystem is the agent's own, not the host's", async () => {
    const rt = freshRuntime();
    const dir = scratchDir('mount-plane-host');
    writeFileSync(join(dir, 'host-only.txt'), 'on the machine');

    // A host path names nothing in the workspace: they are separate
    // filesystems, and the agent is told so rather than silently served the
    // wrong bytes.
    expect(await rt.storage.vfs.exists(join(dir, 'host-only.txt'))).toBe(false);

    await rt.storage.vfs.writeFile('notes.md', 'in the workspace');
    expect(await rt.storage.vfs.readFile('notes.md', { encoding: 'utf8' })).toBe('in the workspace');
  });
});
