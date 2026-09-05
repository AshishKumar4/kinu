/**
 * A local subordinate joins the one workspace plane as itself.
 *
 * On the in-SQLite plane a facet gets a home of its own in the one tree and a
 * private `/tmp`, and both its planes act as its uid: the same boundary a swarm
 * node gets, reached through the same provisioner. On a directory-bound plane
 * the tree stays shared and the facet's commands run with `HOME` and `TMPDIR`
 * in its own scratch. Every assertion here drives the facet's own runtime the
 * way its turn does, through its file plane and its shell.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { LLMProviderConfig } from '@kinu.run/core';
import { isVfsError } from '@kinu.run/core';
import { scratchDir } from '@kinu.run/test-utils';
import { cleanupFacetCwdScratch, createCLIRuntime, shareLocalWorkspacePlane, type CLIRuntime } from '../src/runtime';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

function agentRuntime(state: string, name: string, options: { cwd?: string; facet?: string } = {}): CLIRuntime {
  const dbPath = join(state, name, 'agent.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const config: Parameters<typeof createCLIRuntime>[1] = { dbPath, llm: DUMMY_LLM, agentName: name };
  if (options.cwd !== undefined) config.cwd = options.cwd;
  if (options.facet !== undefined) config.facet = options.facet;
  return createCLIRuntime(new Database(dbPath), config);
}

async function exec(rt: CLIRuntime, command: string): Promise<{ stdout: string; exitCode: number }> {
  if (!rt.shell) throw new Error('the runtime has no shell');
  const result = await rt.shell.exec(command);
  return { stdout: result.stdout.trim(), exitCode: result.exitCode };
}

describe('a facet on the in-SQLite plane', () => {
  test('owns its home, keeps /tmp to itself, and cannot write into a sibling', async () => {
    const state = scratchDir('facet-plane-sqlite');
    const parent = agentRuntime(state, 'parent');
    const alpha = await shareLocalWorkspacePlane(agentRuntime(state, 'alpha'), parent, 'sub-alpha');
    const beta = await shareLocalWorkspacePlane(agentRuntime(state, 'beta'), parent, 'sub-beta');

    // Each facet's own home, written through its file plane and read by a
    // sibling and by the origin: one tree, per-facet ownership.
    await alpha.storage.vfs.writeFile('/home/sub-alpha/notes.md', 'alpha wrote this');
    expect(await beta.storage.vfs.readFile('/home/sub-alpha/notes.md', { encoding: 'utf8' })).toBe('alpha wrote this');
    expect(await parent.storage.vfs.readFile('/home/sub-alpha/notes.md', { encoding: 'utf8' })).toBe('alpha wrote this');

    // A sibling's home refuses a write on both planes.
    let refused: unknown;
    try {
      await beta.storage.vfs.writeFile('/home/sub-alpha/intruder.md', 'beta was here');
    } catch (error) {
      refused = error;
    }
    expect(isVfsError(refused) && refused.code === 'EACCES').toBe(true);
    expect((await exec(beta, 'echo beta > /home/sub-alpha/intruder.txt')).exitCode).not.toBe(0);
    expect(await alpha.storage.vfs.readdir('/home/sub-alpha')).toEqual(['notes.md']);

    // A bare /tmp is private per facet, on the shell and on the file plane.
    expect((await exec(alpha, 'echo alpha > /tmp/scratch.txt')).exitCode).toBe(0);
    expect((await exec(beta, 'cat /tmp/scratch.txt')).exitCode).not.toBe(0);
    expect(await beta.storage.vfs.exists('/tmp/scratch.txt')).toBe(false);
    expect(await alpha.storage.vfs.readFile('/tmp/scratch.txt', { encoding: 'utf8' })).toBe('alpha\n');
  });
});

describe('a facet on a directory-bound plane', () => {
  test('runs its commands with HOME and TMPDIR in its own scratch, over the shared tree', async () => {
    const root = scratchDir('facet-plane-cwd');
    const state = join(root, 'state');
    const project = join(root, 'project');
    mkdirSync(state, { recursive: true });
    mkdirSync(project, { recursive: true });
    const parent = agentRuntime(state, 'parent', { cwd: project });
    const child = await shareLocalWorkspacePlane(
      agentRuntime(state, 'child', { cwd: project, facet: 'sub-child' }), parent, 'sub-child',
    );

    const env = await exec(child, 'pwd; echo "$HOME"; echo "$TMPDIR"');
    expect(env.stdout.split('\n')).toEqual([
      resolve(project),
      join(resolve(project), '.kinu', 'facets', 'sub-child'),
      join(resolve(project), '.kinu', 'facets', 'sub-child', 'tmp'),
    ]);
    expect((await exec(child, 'echo shared > shared.txt')).exitCode).toBe(0);
    expect(await parent.storage.vfs.readFile('shared.txt', { encoding: 'utf8' })).toBe('shared\n');
    expect((await exec(parent, 'echo "$HOME"')).stdout).toBe(process.env.HOME ?? '');
  });

  test('a hostile facet name never reaches the state directory', () => {
    const root = scratchDir('facet-plane-hostile');
    const project = join(root, 'project');
    mkdirSync(project, { recursive: true });
    expect(() => agentRuntime(root, 'escape', { cwd: project, facet: '../escape' })).toThrow('not a usable agent name');
    expect(() => agentRuntime(root, 'slash', { cwd: project, facet: 'a/b' })).toThrow('not a usable agent name');
    expect(existsSync(join(project, '.kinu'))).toBe(false);
  });

  test('the scratch copies no workspace bytes, and cleanup removes that facet alone', async () => {
    const root = scratchDir('facet-plane-cleanup');
    const project = join(root, 'project');
    mkdirSync(project, { recursive: true });
    const one = agentRuntime(root, 'one', { cwd: project, facet: 'sub-one' });
    agentRuntime(root, 'two', { cwd: project, facet: 'sub-two' });
    expect((await exec(one, 'echo keep > keep.txt')).exitCode).toBe(0);

    const facets = join(project, '.kinu', 'facets');
    expect(readdirSync(join(facets, 'sub-one'))).toEqual(['tmp']);
    cleanupFacetCwdScratch(project, 'sub-one');
    expect(readdirSync(facets)).toEqual(['sub-two']);
    expect(existsSync(join(project, 'keep.txt'))).toBe(true);
  });
});
