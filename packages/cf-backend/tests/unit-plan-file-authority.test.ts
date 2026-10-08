import { readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { expect, test } from 'bun:test';
import { toolExecute } from '@kinu.run/test-utils';
import type { JsonValue } from '@kinu.run/core';
import { orchestratorHarness, chatSessionTurns, workspaceFiles } from './helpers/actor-harness';
import * as v from 'valibot';
import { ROOT_SLATE_CALLER } from '../src/slates/bindings';

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
  expect(await agent.slateCallAs(planCaller, 'app', 'workspace', { path: ['slates', 'peer', 'shell'], args: [], invocation: null })).toMatchObject({ ok: false, reason: 'denied' });
  expect(await readText(files, path)).toBe('second');
  // The retained Build app has separate invocation authority from this Plan turn.
  expect(await agent.slateCallAs(ROOT_SLATE_CALLER, 'app', 'workspace', { path: ['readFile'], args: [path], invocation: null })).toEqual({ ok: true, value: 'second' });
  expect(await agent.slateCallAs(ROOT_SLATE_CALLER, 'app', 'workspace', { path: ['writeFile'], args: [path, 'build app wrote'], invocation: null })).toMatchObject({ ok: true });
  expect(await readText(files, path)).toBe('build app wrote');
  await chatSessionTurns(agent).settle({ messageId: 'done', text: 'Plan ready.', requestId: 'done' });
  expect(await agent.slateAs(planCaller, { op: 'restore', id: 'app', version: version.id })).toMatchObject({ ok: false, reason: 'denied' });
  expect(await agent.slate({ op: 'restore', id: 'app', version: version.id })).toMatchObject({ ok: true });
  expect(await readText(files, path)).toBe('first');
});

test('a planner role records Plan authority for deferred work even when the message requested Build', async () => {
  const { agent } = orchestratorHarness();
  await agent.setRole('planner');
  agent.harnessDrivingUserMessage('Inspect the project.', { kinuMode: 'build' });
  const configured = await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'Inspect the project.' }] });
  const submitted = configured.tools.submit_plan;

  if (submitted === undefined) throw new Error('Role-imposed Plan has no plan submission operation');
  expect(await toolExecute(submitted)({ edits: [{ start: 1, content: '# Plan\nInspect the source before implementation.' }] })).toMatchObject({ status: 'pending' });
  expect(await agent.getActivePlanReview()).toMatchObject({ status: 'pending' });
  await chatSessionTurns(agent).settle({ messageId: 'role-plan-answer', text: 'Plan ready.', requestId: 'role-plan-answer' });
  const runs = await agent.listRuns();
  const run = runs.items[0];

  if (run === undefined) throw new Error('The real turn produced no run record');
  const events = await agent.getRunEvents(run.runId);
  expect(events.find((event) => event.type === 'turn_end')).toMatchObject({ workMode: 'plan' });
});
