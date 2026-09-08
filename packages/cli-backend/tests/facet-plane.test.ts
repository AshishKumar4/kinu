import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { subordinateAgentName } from '@kinu.run/core';
import { scratchDir } from '@kinu.run/test-utils';
import { cleanupFacetCwdScratch, createCLIRuntime, makeSqlExec, shareLocalWorkspacePlane, type CLIRuntime } from '../src/runtime';
import { registerLocalActor, seedLocalActor } from '../src/actor-identity';

function rootRuntime(state: string, cwd?: string): CLIRuntime {
  const dbPath = join(state, 'agent.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  return createCLIRuntime(new Database(dbPath), { dbPath, llm: null, hostRoot: null, cwd, agentName: 'parent' });
}

async function childRuntime(parent: CLIRuntime, state: string, name: string): Promise<CLIRuntime> {
  const binding = registerLocalActor(parent.actor, { name, creationId: crypto.randomUUID(), kind: 'subordinate', lifetime: 'durable', dbPathForKey: (key) => join(state, `${key}.db`) });
  const db = new Database(binding.dbPath);
  seedLocalActor(db, makeSqlExec(db), binding);
  const facet = subordinateAgentName(binding.storageKey);
  const child = createCLIRuntime(db, { dbPath: binding.dbPath, llm: null, hostRoot: null, cwd: parent.cwd, facet, actorBinding: binding });
  return shareLocalWorkspacePlane(child, parent, facet);
}

async function exec(rt: CLIRuntime, command: string) {
  if (!rt.shell) throw new Error('The runtime has no shell.');
  return rt.shell.exec(command);
}

const home = (actor: CLIRuntime) => `/home/${subordinateAgentName(actor.actor.storageKey)}`;

describe('local actor file-plane identity', () => {
  test('same-name children under two parents have distinct homes and private scratch', async () => {
    const state = scratchDir('facet-plane-sqlite');
    const root = rootRuntime(state);
    const left = await childRuntime(root, state, 'left');
    const right = await childRuntime(root, state, 'right');
    const alpha = await childRuntime(left, state, 'reader');
    const beta = await childRuntime(right, state, 'reader');
    expect(alpha.actor.name).toBe(beta.actor.name);
    expect(alpha.actor.actorId).not.toBe(beta.actor.actorId);
    expect(home(alpha)).not.toBe(home(beta));
    await alpha.storage.vfs.writeFile(`${home(alpha)}/notes`, 'alpha');
    expect(await beta.storage.vfs.readFile(`${home(alpha)}/notes`, { encoding: 'utf8' })).toBe('alpha');
    await expect(beta.storage.vfs.writeFile(`${home(alpha)}/intruder`, 'beta')).rejects.toMatchObject({ code: 'EACCES' });
    expect((await exec(beta, `echo beta > ${home(alpha)}/intruder`)).exitCode).not.toBe(0);
    expect((await exec(alpha, 'echo private > /tmp/note')).exitCode).toBe(0);
    expect((await exec(beta, 'cat /tmp/note')).exitCode).not.toBe(0);
    expect(await root.storage.vfs.exists('/tmp/note')).toBe(false);
  });

  test('directory-bound children retain logical names and use distinct physical HOME values', async () => {
    const state = scratchDir('facet-plane-cwd');
    const project = join(state, 'project');
    mkdirSync(project);
    const root = rootRuntime(state, project);
    const child = await childRuntime(root, state, 'reader');
    const key = subordinateAgentName(child.actor.storageKey);
    expect((await exec(child, 'pwd; echo "$HOME"; echo "$TMPDIR"')).stdout.trim().split('\n')).toEqual([
      resolve(project), join(project, '.kinu', 'facets', key), join(project, '.kinu', 'facets', key, 'tmp'),
    ]);
    expect((await exec(child, 'echo shared > shared.txt')).exitCode).toBe(0);
    expect(await root.storage.vfs.readFile('shared.txt', { encoding: 'utf8' })).toBe('shared\n');
    expect(child.identity.name).toBe('reader');
  });

  test('hostile logical names are refused before a physical child is allocated', () => {
    const state = scratchDir('facet-plane-hostile');
    const root = rootRuntime(state);
    const register = (name: string) => registerLocalActor(root.actor, { name, creationId: crypto.randomUUID(), kind: 'subordinate', lifetime: 'durable', dbPathForKey: (key) => join(state, `${key}.db`) });
    expect(() => register('../escape')).toThrow(expect.objectContaining({ code: 'bad_input' }));
    expect(() => register('a/b')).toThrow(expect.objectContaining({ code: 'bad_input' }));
    expect(existsSync(join(state, 'escape'))).toBe(false);
  });

  test('scratch cleanup removes only its captured physical home and preserves shared files', async () => {
    const state = scratchDir('facet-plane-cleanup');
    const project = join(state, 'project');
    mkdirSync(project);
    const root = rootRuntime(state, project);
    const one = await childRuntime(root, state, 'one');
    const two = await childRuntime(root, state, 'two');
    expect((await exec(one, 'echo keep > keep.txt')).exitCode).toBe(0);
    const oneKey = subordinateAgentName(one.actor.storageKey);
    const twoKey = subordinateAgentName(two.actor.storageKey);
    const facets = join(project, '.kinu', 'facets');
    expect(readdirSync(join(facets, oneKey))).toEqual(['tmp']);
    cleanupFacetCwdScratch(project, oneKey);
    expect(readdirSync(facets)).toEqual([twoKey]);
    expect(existsSync(join(project, 'keep.txt'))).toBe(true);
  });
});
