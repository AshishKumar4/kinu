import { expect, test } from 'bun:test';
import { toolExecute } from '@kinu.run/test-utils';
import { providersInWorkMode, type JsonValue } from '@kinu.run/core';
import { orchestratorHarness, chatSessionTurns } from './helpers/actor-harness';
import * as v from 'valibot';
import { ROOT_SLATE_CALLER } from '../src/slates/bindings';

test('a real Plan turn reads files but cannot edit them, even after a Build turn starts', async () => {
  const { agent } = orchestratorHarness();
  const files = agent.observeRuntime().storage.vfs;
  const path = '/home/main/source.txt';
  await files.writeFile(path, 'original');
  agent.harnessDrivingUserMessage('Inspect only.', { kinuMode: 'plan' });
  const planTools = agent.observeRawTools();
  await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'Inspect only.' }], tools: planTools });
  const planFile = planTools.file;

  if (planFile === undefined) throw new Error('Plan has no file inspection tool');
  const plan = toolExecute<JsonValue, JsonValue>(planFile);
  expect(await plan({ action: 'read', path })).toEqual(expect.stringContaining('original'));
  await expect(plan({ action: 'edit', path, edits: [{ old_text: 'original', new_text: 'modified' }] }))
    .rejects.toMatchObject({ code: 'denied' });
  expect(await files.readFile(path, { encoding: 'utf8' })).toBe('original');
  await chatSessionTurns(agent).settle({ messageId: 'plan-answer', text: 'Inspection done.', requestId: 'plan-answer' });
  agent.harnessDrivingUserMessage('Now implement.', { kinuMode: 'build' });
  const buildTools = agent.observeRawTools();
  const buildFile = buildTools.file;

  if (buildFile === undefined) throw new Error('Build has no file tool');
  const build = toolExecute<JsonValue, JsonValue>(buildFile);
  await build({ action: 'read', path });
  expect(await build({ action: 'write', path, content: 'built' })).toMatchObject({ ok: true });
  expect(await files.readFile(path, { encoding: 'utf8' })).toBe('built');
  await expect(plan({ action: 'write', path, content: 'late Plan overwrite' })).rejects.toMatchObject({ code: 'denied' });
  expect(await files.readFile(path, { encoding: 'utf8' })).toBe('built');
});

test('Plan blocks slate source restoration and authored calls without converting an existing Build app', async () => {
  const { agent } = orchestratorHarness();
  const files = agent.observeRuntime().storage.vfs;
  const path = '/home/main/slates/app/server.ts';
  await files.mkdir('/home/main/slates/app', { recursive: true });
  await files.writeFile('/home/main/slates/app/package.json', JSON.stringify({ main: 'server.ts', slate: { bindings: { FILES: { kind: 'namespace', namespace: 'workspace' }, PEER: { kind: 'app', id: 'app' } } } }));
  await files.writeFile(path, 'first');
  const committed = await agent.slate({ op: 'commit', id: 'app' });

  if (!committed.ok) throw new Error(committed.error);
  const version = v.parse(v.object({ id: v.string() }), committed.value);
  await files.writeFile(path, 'second');
  agent.harnessDrivingUserMessage('Plan only.', { kinuMode: 'plan' });
  const native = agent.observeRawTools();
  await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'Plan only.' }], tools: native });
  const providers = providersInWorkMode('plan', agent.observeRuntime().executionRouter?.getProviders() ?? []);
  const workspace = providers.find((provider) => provider.name === 'workspace');

  if (workspace === undefined) throw new Error('No workspace provider');
  expect(await workspace.tools.readFile.execute(path)).toBe('second');
  expect(await workspace.tools.writeFile.execute(path, 'forbidden')).toMatchObject({ reason: 'denied' });
  expect(await workspace.tools.exec.execute('printf forbidden')).toMatchObject({ reason: 'denied' });
  expect(await workspace.tools.createTool.execute('forbidden', 'not research', '() => 1')).toMatchObject({ reason: 'denied' });
  expect(await workspace.tools.slate.execute({ op: 'restore', id: 'app', version: version.id })).toMatchObject({ reason: 'denied' });
  const planCaller = { ...ROOT_SLATE_CALLER, workMode: 'plan' } satisfies typeof ROOT_SLATE_CALLER;
  expect(await agent.slateAs(planCaller, { op: 'restore', id: 'app', version: version.id })).toMatchObject({ ok: false, reason: 'denied' });
  expect(await agent.slateAs(planCaller, { op: 'call', id: 'app', method: 'shell' })).toMatchObject({ ok: false, reason: 'denied' });
  expect(await agent.slateBindingCallAs(planCaller, 'app', 'PEER', { member: 'shell', args: [], invocation: null })).toMatchObject({ ok: false, reason: 'denied' });
  expect(await files.readFile(path, { encoding: 'utf8' })).toBe('second');
  // The retained Build app has separate invocation authority from this Plan turn.
  expect(await agent.slateBindingCallAs(ROOT_SLATE_CALLER, 'app', 'FILES', { member: 'readFile', args: [path], invocation: null })).toEqual({ ok: true, value: 'second' });
  expect(await agent.slateBindingCallAs(ROOT_SLATE_CALLER, 'app', 'FILES', { member: 'writeFile', args: [path, 'build app wrote'], invocation: null })).toMatchObject({ ok: true });
  expect(await files.readFile(path, { encoding: 'utf8' })).toBe('build app wrote');
  await chatSessionTurns(agent).settle({ messageId: 'done', text: 'Plan ready.', requestId: 'done' });
  expect(await agent.slateAs(planCaller, { op: 'restore', id: 'app', version: version.id })).toMatchObject({ ok: false, reason: 'denied' });
  expect(await agent.slate({ op: 'restore', id: 'app', version: version.id })).toMatchObject({ ok: true });
  expect(await files.readFile(path, { encoding: 'utf8' })).toBe('first');
});

test('a planner role records Plan authority for deferred work even when the message requested Build', async () => {
  const { agent } = orchestratorHarness();
  await agent.setRole('planner');
  agent.harnessDrivingUserMessage('Inspect the project.', { kinuMode: 'build' });
  const requested = agent.observeRawTools();
  const configured = await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'Inspect the project.' }], tools: requested });
  const submitted = configured.tools.submit_plan;

  if (submitted === undefined) throw new Error('Role-imposed Plan has no plan submission operation');
  expect(await toolExecute(submitted)({ edits: [{ start: 1, content: '# Plan\nInspect the source before implementation.' }] })).toMatchObject({ ok: true, status: 'pending' });
  expect(await agent.getActivePlanReview()).toMatchObject({ status: 'pending' });
  await chatSessionTurns(agent).settle({ messageId: 'role-plan-answer', text: 'Plan ready.', requestId: 'role-plan-answer' });
  const runs = await agent.listRuns();
  const run = runs.items[0];

  if (run === undefined) throw new Error('The real turn produced no run record');
  const events = await agent.getRunEvents(run.runId);
  expect(events.find((event) => event.type === 'turn_end')).toMatchObject({ workMode: 'plan' });
});
