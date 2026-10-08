/**
 * Reach is read from one place each: a role reaches the `file` namespace only through the file capability, and a
 * slate reaches an operation only where its catalog entry says it may.
 */
import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { DEFAULT_WORKERS_AI_MODEL_SPEC, type JsonValue } from '@kinu.run/core';
import { hostedSubordinateHarness, orchestratorHarness, workspaceFiles } from './helpers/actor-harness';
import { ROOT_SLATE_CALLER } from '../src/slates/bindings';

/** A role with programs and a shell, but no file tool. */
const CODER = {
  roles: { coder: { description: 'Codes without the file tool.', instructions: 'Code.', tier: 'default', preset: 'ideate', allowedTools: ['eval', 'shell', 'memory'] } },
  tiers: { default: { model: DEFAULT_WORKERS_AI_MODEL_SPEC } },
} as const;

/** The workspace's own actor: the one with no parent. */
function workspaceActorId(db: Database): string {
  return v.parse(v.object({ actor_id: v.string() }), db.query('SELECT actor_id FROM workspace_actors WHERE parent_actor_id IS NULL').get()).actor_id;
}

const call = () => ({ callId: crypto.randomUUID() });

test('a role with eval but not the file tool reaches no file operation, as the workspace or as a hire', async () => {
  const workspace = orchestratorHarness();

  await workspace.agent.setSoul('# Purpose\n\nCode.');
  workspace.agent.harnessInstallCatalog(CODER);
  const hire = await hostedSubordinateHarness(workspace, { name: 'coder', displayName: 'Coder', nameOrigin: 'user', roleId: 'task', mission: 'Code' });

  hire.actor.stores.config.setRoleSelection('coder');
  await workspace.agent.setRole('coder');

  for (const actorId of [workspaceActorId(workspace.db), hire.actor.handle.actorId]) {
    const caller = { actorId, turnId: null, mode: 'build' as const };
    const ids = (await workspace.agent.listOperations(caller)).map(({ id }) => id);

    expect({ actorId, file: ids.filter((id) => id.startsWith('file.')), memory: ids.includes('memory.recall') }).toEqual({ actorId, file: [], memory: true });
    await expect(workspace.agent.callOperation(caller, 'file.read', { path: 'notes.md' }, call())).rejects.toMatchObject({ code: 'missing' });
  }
});

test("a slate's call reaches an operation only where its catalog entry says a slate may", async () => {
  const workspace = orchestratorHarness();
  const files = workspaceFiles(workspace.agent);

  await files.mkdir('/slates/notes', { recursive: true });
  await writeText(files, '/slates/notes/package.json', JSON.stringify({ main: 'server.ts' }));
  await writeText(files, '/home/main/note.txt', 'the note');
  const slate = (path: string[], args: JsonValue[]) => workspace.agent.slateCallAs(ROOT_SLATE_CALLER, 'notes', 'workspace', { path, args, invocation: null });

  expect(JSON.stringify(await slate(['file', 'read'], ['/home/main/note.txt']))).toContain('the note');
  expect(await slate(['state', 'set'], ['draft', 1])).toMatchObject({ ok: false, reason: 'denied', error: expect.stringContaining("not on a slate's surface") });
});
