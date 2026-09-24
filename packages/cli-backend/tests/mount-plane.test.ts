// Local environments and the mount table: a directory-bound session works on the real bytes through one `workspace`
// executor; `/pc` and `/sandbox` are stated absences locally, never empty folders.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCLIRuntime, type CLIRuntime } from '../src/runtime';
import * as v from 'valibot';
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

    // The absolute path and the plane-relative name are one file; nothing is copied.
    expect(await mounted.readFile(join(dir, 'existing.txt'), { encoding: 'utf8' })).toBe('from the host');
    expect(await mounted.readFile('existing.txt', { encoding: 'utf8' })).toBe('from the host');
    expect(await mounted.readdir('/')).toContain('existing.txt');

    await mounted.writeFile('written.txt', 'from the agent');
    expect(readFileSync(join(dir, 'written.txt'), 'utf8')).toBe('from the agent');

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

    expect(await mounted.exists(join(dir, 'host-only.txt'))).toBe(false);

    await mounted.writeFile('notes.md', 'in the workspace');
    expect(await mounted.readFile('notes.md', { encoding: 'utf8' })).toBe('in the workspace');
  });
});
