import { readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
// Local environments and the mount table: a directory-bound session works on the real bytes through one `workspace`
// executor, with no `/pc` or `/sandbox` mount.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCLIRuntime, type CLIRuntime } from '../src/runtime';
import { localFilePlane } from '../src/host-mount';
import * as v from 'valibot';
import { type ExecutionRouter } from '@kinu.run/core';
import { isVfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { present, scratchDir, scratchPath } from '@kinu.run/test-utils';

function freshRuntime(cwd = scratchDir('mount-plane-folder')) {
  const db = new Database(scratchPath('mount-plane', 'agent.db'), { create: true });
  // As `kinu create` publishes one: in WAL a commit waits on no fsync.
  db.exec('PRAGMA journal_mode = WAL');

  const config: Parameters<typeof createCLIRuntime>[1] = {
    llm: { name: 'x', baseURL: 'http://localhost:0', headers: {}, model: 'm' }, cwd,
  };

  return createCLIRuntime(db, config);
}

function routerOf(rt: CLIRuntime): ExecutionRouter {
  return present(rt.executionRouter, 'the runtime execution router');
}

describe('the local backend file plane', () => {
  test('the workspace is the one executor: no device runtime, bound or not', () => {
    const dir = scratchDir('mount-plane-bound');
    expect(routerOf(freshRuntime()).listExecutors().map((e) => e.name)).toEqual(['workspace']);
    expect(routerOf(freshRuntime(dir)).listExecutors().map((e) => e.name)).toEqual(['workspace']);
  });

  test('a bound directory IS the workspace: its real files, whole, through the one plane', async () => {
    const dir = scratchDir('mount-plane-host');
    writeFileSync(join(dir, 'existing.txt'), 'from the host');
    const rt = freshRuntime(dir);
    const mounted = rt.storage.vfs;

    // The absolute path and the plane-relative name are one file; nothing is copied. `/` is the machine's own root.
    expect(await readText(mounted, join(dir, 'existing.txt'))).toBe('from the host');
    expect(await readText(mounted, 'existing.txt')).toBe('from the host');
    expect((await mounted.readdir(dir)).map(({ name }) => name)).toContain('existing.txt');

    await writeText(mounted, 'written.txt', 'from the agent');
    expect(readFileSync(join(dir, 'written.txt'), 'utf8')).toBe('from the agent');

    const workspace = present(routerOf(rt).getProvider('workspace'), 'the workspace executor');
    const out = await workspace.tools.exec.execute('cat existing.txt');
    expect(v.parse(v.string(), out)).toContain('from the host');
  });

  // Issue #36: the CLI registers no device or sandbox runtime, so no mount answers for one: `/pc` and `/sandbox`
  // are ordinary paths, never a refusal naming a machine or a container the CLI cannot have.
  test('a local workspace has no /pc or /sandbox mount, bound to a directory or not', async () => {
    for (const rt of [freshRuntime(), freshRuntime(scratchDir('mount-plane-bound'))]) {
      for (const path of ['/pc', '/sandbox']) {
        let code: string | null = null;

        try { (await rt.storage.vfs.readdir(path)).map(({ name }) => name); } catch (caught) { code = isVfsError(caught) ? caught.code : 'unclassified'; }

        expect(code).not.toBe('ENXIO');
      }
    }

    // Nothing but the store answers at /sandbox: a write there meets what any top-level path meets, `/` being root's.
    const unbound = freshRuntime().storage.vfs;

    const writing = async (path: string) => {
      try {
        await writeText(unbound, path, 'a folder of the workspace');

        return 'written';
      } catch (caught) {
        return isVfsError(caught) ? caught.code : 'unclassified';
      }
    };

    const sandbox = await writing('/sandbox/notes.md');

    expect(sandbox).toBe(await writing('/elsewhere/notes.md'));
    expect(['written', 'ENXIO']).not.toContain(sandbox);
  });

  // The host plane has no native removal, so the composite walks it; a walk that kept anything must say so.
  test('a recursive removal the host refuses part of rejects, naming what it kept', async () => {
    const folder = scratchDir('mount-plane-removal');
    mkdirSync(join(folder, 'dir/locked'), { recursive: true });
    writeFileSync(join(folder, 'dir/locked/kept'), 'x');
    writeFileSync(join(folder, 'dir/gone'), 'y');
    chmodSync(join(folder, 'dir/locked'), 0o500);
    const machine = localFilePlane({ folder, space: join(folder, 'space'), views: [], checkpoints: undefined });

    try {
      await expect(machine.removeRecursive(join(folder, 'dir'))).rejects.toMatchObject({
        code: 'EACCES',
        message: expect.stringContaining(`removing ${join(folder, 'dir/locked/kept')} failed`),
      });
    } finally {
      chmodSync(join(folder, 'dir/locked'), 0o700);
    }

    expect(existsSync(join(folder, 'dir/locked/kept'))).toBe(true);
  });
});
