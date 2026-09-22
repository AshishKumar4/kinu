// The local backend's environments, and the mount table that joins them into
// one view. In the CLI the machine IS the workspace: a session bound to a
// directory works on that directory's real bytes through the one `workspace`
// executor, and a session bound to nothing keeps the in-SQLite plane. There
// is no device runtime and no container locally, so `/pc` and `/sandbox` are
// stated absences rather than empty folders — the property this suite has
// always protected, that the agent's own files are never silently confused
// with anything else, survives as: one executor, one plane, each mount point
// naming what it cannot serve.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCLIRuntime, type CLIRuntime } from '../src/runtime';
import * as v from 'valibot';
import { walkRecursive } from '@kinu.run/agent-utils/vfs';
import { isVfsError, type ExecutionRouter } from '@kinu.run/core';
import { present, scratchDir, scratchPath } from '@kinu.run/test-utils';

function freshRuntime(cwd?: string) {
  const db = new Database(scratchPath('mount-plane', 'agent.db'), { create: true });

  const config: Parameters<typeof createCLIRuntime>[1] = {
    dbPath: db.filename,
    llm: { name: 'x', baseURL: 'http://localhost:0', headers: {}, model: 'm' },
  };

  if (cwd !== undefined) config.cwd = cwd;

  return createCLIRuntime(db, config);
}

/** Every local runtime installs one, so its absence is a broken fixture. */
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

    // The directory's own absolute path and the plane-relative name are one
    // file; nothing is copied and nothing sits under a mount point.
    expect(await mounted.readFile(join(dir, 'existing.txt'), { encoding: 'utf8' })).toBe('from the host');
    expect(await mounted.readFile('existing.txt', { encoding: 'utf8' })).toBe('from the host');
    expect(await mounted.readdir('/')).toContain('existing.txt');

    // A walk reports the machine's entries as the workspace's own.
    const walk = await walkRecursive(mounted, '', 10, 100);
    expect(walk.truncated).toBe(false);
    expect(walk.entries.map((e) => e.path)).toContain('existing.txt');

    // Writes through the plane land in the directory.
    await mounted.writeFile('written.txt', 'from the agent');
    expect(readFileSync(join(dir, 'written.txt'), 'utf8')).toBe('from the agent');

    // And the workspace shell runs THERE: the machine is the workspace.
    const workspace = present(routerOf(rt).getProvider('workspace'), 'the workspace executor');
    const out = await workspace.tools.exec.execute('cat existing.txt');
    expect(v.parse(v.string(), out)).toContain('from the host');
  });

  test('/pc states its absence: no machine is mounted in the CLI', async () => {
    const mounted = freshRuntime().storage.vfs;

    let error: unknown;

    try { await mounted.readdir('/pc'); } catch (caught) { error = caught; }

    if (!isVfsError(error)) throw new Error(`expected a classified refusal, got ${String(error)}`);
    expect(error.code).toBe('ENXIO');
    expect(await mounted.exists('/pc')).toBe(false);
    expect(await mounted.stat('/pc')).toBeNull();
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
