import { readText } from '@nimbus-sh/core/vfs/vfs.js';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { actorHomeName, codemodeSurface, narrowToolSurface, type JsonValue } from '@kinu.run/core';
import { scratchDir, toolExecute, workspaceDatabase } from '@kinu.run/test-utils';
import { cleanupFacetScratch, createCLIRuntime, shareLocalWorkspacePlane, type CLIRuntime } from '../src/runtime';
import { createNodeCodemodeToolFactory } from '../src/codemode-tool-factory';
import { registerLocalActor } from '@kinu.run/core';

interface LocalRoot {
  readonly rt: CLIRuntime;
  readonly db: Database;
  readonly dbPath: string;
}

function rootRuntime(state: string, cwd = scratchDir('facet-plane-folder')): LocalRoot {
  const dbPath = join(state, 'agent.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = workspaceDatabase(dbPath);

  return { rt: createCLIRuntime(db, { llm: null, cwd, agentName: 'parent' }), db, dbPath };
}

/** A child over its root's database: same handle, same file, its own actor row. */
function childRuntime(parent: CLIRuntime, root: LocalRoot, name: string): CLIRuntime {
  const binding = registerLocalActor(parent.actor, { name, creationId: crypto.randomUUID(), origin: 'agent', lifetime: 'durable' });
  const facet = actorHomeName({ origin: 'agent', storageKey: binding.storageKey });
  const child = createCLIRuntime(root.db, { llm: null, cwd: parent.cwd, facet, actorBinding: binding });

  return shareLocalWorkspacePlane(child, parent);
}

async function exec(rt: CLIRuntime, command: string) {
  if (!rt.shell) throw new Error('The runtime has no shell.');

  return rt.shell.exec(command);
}

describe('local actor file-plane identity', () => {
  // 2026-10-04: a child's scratch was `<folder>/.kinu/facets/<key>`, in the user's project; it is its own home in the own space.
  test('directory-bound children work in the folder, with their own home in the own space beside the database', async () => {
    const state = scratchDir('facet-plane-cwd');
    const project = join(state, 'project');
    mkdirSync(project);
    const root = rootRuntime(state, project);
    const child = childRuntime(root.rt, root, 'reader');
    const key = actorHomeName({ origin: 'agent', storageKey: child.actor.storageKey });
    expect((await exec(child, 'pwd; echo "$HOME"; echo "$TMPDIR"')).stdout.trim().split('\n')).toEqual([
      resolve(project), join(state, 'home', key), join(state, 'home', key, 'tmp'),
    ]);
    expect((await exec(child, 'echo shared > shared.txt')).exitCode).toBe(0);
    expect(await readText(root.rt.storage.vfs, join(project, 'shared.txt'))).toBe('shared\n');
    expect(readdirSync(project)).toEqual(['shared.txt']);
    expect(child.identity.name).toBe('reader');
  });

  test('hostile logical names are refused before a physical child is allocated', () => {
    const state = scratchDir('facet-plane-hostile');
    const root = rootRuntime(state);
    const register = (name: string) => registerLocalActor(root.rt.actor, { name, creationId: crypto.randomUUID(), origin: 'agent', lifetime: 'durable' });
    expect(() => register('../escape')).toThrow(expect.objectContaining({ code: 'bad_input' }));
    expect(() => register('a/b')).toThrow(expect.objectContaining({ code: 'bad_input' }));
    expect(existsSync(join(state, 'escape'))).toBe(false);
  });

  test('scratch cleanup removes only its captured physical home and preserves shared files', async () => {
    const state = scratchDir('facet-plane-cleanup');
    const project = join(state, 'project');
    mkdirSync(project);
    const root = rootRuntime(state, project);
    const one = childRuntime(root.rt, root, 'one');
    const two = childRuntime(root.rt, root, 'two');
    expect((await exec(one, 'echo keep > keep.txt')).exitCode).toBe(0);
    const oneKey = actorHomeName({ origin: 'agent', storageKey: one.actor.storageKey });
    const twoKey = actorHomeName({ origin: 'agent', storageKey: two.actor.storageKey });
    expect(existsSync(join(state, 'home', oneKey))).toBe(true);
    cleanupFacetScratch(state, oneKey);
    expect(existsSync(join(state, 'home', oneKey))).toBe(false);
    expect(existsSync(join(state, 'home', twoKey))).toBe(true);
    expect(readdirSync(project)).toEqual(['keep.txt']);
  });

  // Release review, 2026-10-04: joining the plane rebuilt the child's shell under the root's policy, so the
  // child's narrowing was lost and a force-push the root had granted reached the box.
  test("a joined child keeps its own narrowing of the root's grants", async () => {
    const root = rootRuntime(scratchDir('facet-plane-grants'));
    root.rt.actor.config.grantShellApproval([{ rule: 'git-force-push', executor: 'workspace' }]);
    const child = childRuntime(root.rt, root, 'publisher');
    child.actor.config.grantShellApproval([{ rule: 'package-publish', executor: 'workspace' }]);
    const command = 'git push --force origin main';
    expect((await exec(root.rt, command)).stderr).not.toContain('git-force-push');
    const refused = await exec(child, command);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain('git-force-push');
  });

  // Release review, 2026-10-04: eval's Node `process` and `fs` started in the root's home, so a child's relative
  // paths missed the files its own shell wrote. A child works in its workspace's folder, as its shell does.
  test("a joined child's eval starts where its shell does", async () => {
    const root = rootRuntime(scratchDir('facet-plane-eval-home'));
    const child = childRuntime(root.rt, root, 'writer');
    expect((await exec(child, 'echo mine > note.txt')).exitCode).toBe(0);
    const run = toolExecute<{ code: string }, { result: JsonValue }>(createNodeCodemodeToolFactory({ reach: narrowToolSurface(undefined) })(codemodeSurface(child, {})));
    const read = await run({ code: 'return [process.cwd(), await require("fs/promises").readFile("note.txt", "utf8")];' });
    expect(read.result).toEqual([child.cwd, 'mine\n']);
  });
});
