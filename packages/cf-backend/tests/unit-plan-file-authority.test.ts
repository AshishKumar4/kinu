import { readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { expect, test } from 'bun:test';
import { present, toolExecute } from '@kinu.run/test-utils';
import type { JsonValue } from '@kinu.run/core';
import { orchestratorHarness, chatSessionTurns, workspaceFiles } from './helpers/actor-harness';
import * as v from 'valibot';
import { ROOT_SLATE_CALLER } from '@kinu.run/core/slates';

/** A slate's process as its bindings name it, started before any share of it: its sharing's first generation. */
const UNSHARED = { incarnation: 'test', generation: 0, ancestors: {} };

test('a real Plan turn reads files but cannot edit them, even after a Build turn starts', async () => {
  const { agent } = orchestratorHarness();
  const files = workspaceFiles(agent);
  const path = '/home/main/source.txt';
  await writeText(files, path, 'original');
  agent.harnessDrivingUserMessage('Inspect only.', { kinuMode: 'plan' });
  // The tools each turn's model call carries.
  const planTools = (await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'Inspect only.' }] })).tools;
  const planFile = planTools.file;

  if (planFile === undefined) throw new Error('Plan has no file inspection tool');
  const plan = toolExecute<JsonValue, JsonValue>(planFile);
  expect(await plan({ op: 'read', path })).toEqual(expect.stringContaining('original'));
  await expect(plan({ op: 'edit', path, edits: [{ old_text: 'original', new_text: 'modified' }] }))
    .rejects.toMatchObject({ code: 'denied' });
  expect(await readText(files, path)).toBe('original');
  await chatSessionTurns(agent).settle({ messageId: 'plan-answer', text: 'Inspection done.', requestId: 'plan-answer' });
  agent.harnessDrivingUserMessage('Now implement.', { kinuMode: 'build' });
  const buildTools = (await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'Now implement.' }] })).tools;
  const buildFile = buildTools.file;

  if (buildFile === undefined) throw new Error('Build has no file tool');
  const build = toolExecute<JsonValue, JsonValue>(buildFile);
  await build({ op: 'read', path });
  expect(await build({ op: 'write', path, content: 'built' })).toMatchObject({ action: 'replaced' });
  expect(await readText(files, path)).toBe('built');
  await expect(plan({ op: 'write', path, content: 'late Plan overwrite' })).rejects.toMatchObject({ code: 'denied' });
  expect(await readText(files, path)).toBe('built');
});

test('Plan blocks slate source restoration and authored calls without converting an existing Build app', async () => {
  const { agent } = orchestratorHarness();
  const files = workspaceFiles(agent);
  const path = '/slates/app/server.ts';
  await files.mkdir('/slates/app', { recursive: true });
  await writeText(files, '/slates/app/package.json', JSON.stringify({ main: 'server.ts' }));
  await writeText(files, path, 'first');
  const committed = await agent.slate({ op: 'commit', id: 'app' });

  if (!committed.ok) throw new Error(committed.error);
  const version = v.parse(v.object({ id: v.string() }), committed.value);
  await writeText(files, path, 'second');
  agent.harnessDrivingUserMessage('Plan only.', { kinuMode: 'plan' });
  await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'Plan only.' }] });
  const planCaller = { ...ROOT_SLATE_CALLER, workMode: 'plan' } satisfies typeof ROOT_SLATE_CALLER;
  expect(await agent.slateAs(planCaller, { op: 'restore', id: 'app', version: version.id })).toMatchObject({ ok: false, reason: 'denied' });
  expect(await agent.slateAs(planCaller, { op: 'call', id: 'app', method: 'shell' })).toMatchObject({ ok: false, reason: 'denied' });
  expect(await agent.slateCallAs({ caller: planCaller, id: 'app', name: 'workspace', lineage: UNSHARED }, { path: ['slates', 'peer', 'shell'], args: [], invocation: null })).toMatchObject({ ok: false, reason: 'denied' });
  expect(await readText(files, path)).toBe('second');
  // The retained Build app has separate invocation authority from this Plan turn.
  expect(await agent.slateCallAs({ caller: ROOT_SLATE_CALLER, id: 'app', name: 'workspace', lineage: UNSHARED }, { path: ['fs', 'text'], args: [path], invocation: null })).toEqual({ ok: true, value: 'second' });
  expect(await agent.slateCallAs({ caller: ROOT_SLATE_CALLER, id: 'app', name: 'workspace', lineage: UNSHARED }, { path: ['fs', 'write'], args: [path, 'build app wrote'], invocation: null })).toMatchObject({ ok: true });
  expect(await readText(files, path)).toBe('build app wrote');
  await chatSessionTurns(agent).settle({ messageId: 'done', text: 'Plan ready.', requestId: 'done' });
  expect(await agent.slateAs(planCaller, { op: 'restore', id: 'app', version: version.id })).toMatchObject({ ok: false, reason: 'denied' });
  expect(await agent.slate({ op: 'restore', id: 'app', version: version.id })).toMatchObject({ ok: true });
  expect(await readText(files, path)).toBe('first');
});

test('a planner role runs a Plan turn even when the message requested Build', async () => {
  const { agent } = orchestratorHarness();
  await agent.setRole('planner');
  agent.harnessDrivingUserMessage('Inspect the project.', { kinuMode: 'build' });
  const configured = await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'Inspect the project.' }] });

  expect(configured.activeTools).toContain('submit_plan');
  await chatSessionTurns(agent).settle({
    messageId: 'role-plan-answer', text: 'Plan ready.', requestId: 'role-plan-answer',
    calls: [{ name: 'submit_plan', input: { edits: [{ start: 1, content: '# Plan\nInspect the source before implementation.' }] } }],
  });
  // Only a Plan turn is offered submit_plan, and only its call opens a review.
  expect(await agent.getActivePlanReview()).toMatchObject({ status: 'pending' });
});

test("outside any turn, the agent's own file tool and a slate's call read and write through one ledger", async () => {
  const { agent } = orchestratorHarness();
  const files = workspaceFiles(agent);

  await files.mkdir('/slates/app', { recursive: true });
  await writeText(files, '/slates/app/package.json', JSON.stringify({ main: 'server.ts' }));
  await writeText(files, '/slates/app/server.ts', 'export default {}');
  await writeText(files, '/home/main/a.md', 'first a');
  await writeText(files, '/home/main/b.md', 'first b');

  const file = toolExecute<JsonValue, JsonValue>(present(agent.getTools().file, "the agent's file tool"));
  const slate = async (path: string[], args: JsonValue[]) => await agent.slateCallAs({ caller: ROOT_SLATE_CALLER, id: 'app', name: 'workspace', lineage: UNSHARED }, { path, args, invocation: null });

  // A read through the agent's own tool lets a slate's write through ...
  await file({ op: 'read', path: '/home/main/a.md' });
  expect(await slate(['fs', 'write'], ['/home/main/a.md', 'the slate wrote'])).toMatchObject({ ok: true });
  // ... and a slate's read lets the agent's own tool write.
  expect(await slate(['fs', 'text'], ['/home/main/b.md'])).toEqual({ ok: true, value: 'first b' });
  expect(await toolExecute<JsonValue, JsonValue>(present(agent.getTools().file, "the agent's file tool"))({ op: 'write', path: '/home/main/b.md', content: 'the tool wrote' }))
    .toMatchObject({ action: 'replaced' });
  expect([await readText(files, '/home/main/a.md'), await readText(files, '/home/main/b.md')]).toEqual(['the slate wrote', 'the tool wrote']);
});
