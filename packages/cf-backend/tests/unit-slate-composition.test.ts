import { expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  DEFAULT_WORKERS_AI_MODEL_SPEC, agentHome, parseRefusal, subordinateAgentName,
  type JsonValue, type SlateCallResult,
} from '@kinu.run/core';
import { hiredSubordinateHarness, orchestratorHarness } from './helpers/actor-harness';
import { createTestUserDO, provisionTestWorkspace, testOwner } from './helpers/user-do';
import { resetRecordedMcp, seedMcpTools, seedMcpAnswer } from './helpers/agents-sdk';
import { ROOT_SLATE_CALLER, type SlateCaller } from '../src/slates/bindings';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';


test('an MCP binding follows connection identity, binding scope and the owner allowlist', async () => {
  resetRecordedMcp();
  const ownerUserId = '0123456789abcdef0123456789abcdef';
  const workspace = 'slate-mcp';
  const user = createTestUserDO({ durableObjectId: ownerUserId });
  try {
    const capability = await provisionTestWorkspace(user, workspace);
    const actor = orchestratorHarness(undefined, { userDO: user.userDO, workspace, ownerUserId });
    await actor.agent.installWorkspaceCapability(capability);
    const owner = await testOwner();
    await user.userDO.userMcp_list(owner);
    user.sql.exec(`INSERT INTO user_mcp_servers
      (id, name, server_url, transport, headers, allowed_tools, created_at, updated_at)
      VALUES ('connection-id', 'github', 'https://github.example/sse', 'auto', NULL, '["read_issue"]', 0, 0)`);
    await user.userDO.userMcp_list(owner);
    seedMcpTools('connection-id', [
      { name: 'read_issue', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'create_issue', inputSchema: { type: 'object' } },
    ]);
    const vfs = actor.agent.observeRuntime().storage.vfs;
    await vfs.mkdir('/home/user/slates/issues', { recursive: true });
    const bind = (server: string, tools?: string[]) => vfs.writeFile('/home/user/slates/issues/package.json', JSON.stringify({
      main: 'server.ts', slate: { title: 'Issues', bindings: { GITHUB: { kind: 'mcp', server, tools } } },
    }));
    const call = (tool: string) => actor.agent.slateBindingCallAs(ROOT_SLATE_CALLER, 'issues', 'GITHUB', { member: tool, args: [{}], depth: 0 });

    await bind('github');
    expect(await call('read_issue')).toMatchObject({ ok: false, reason: 'missing' });
    await bind('connection-id');
    expect(await call('read_issue')).toEqual({ ok: true, value: { content: [] } });
    const incident = { content: [], isError: false, reason: 'denied', error: 'historical incident' };
    seedMcpAnswer(incident);
    expect(await call('read_issue')).toEqual({ ok: true, value: incident });
    // Outside the owner's allowlist the tool is not on this actor's surface at all.
    expect(await call('create_issue')).toMatchObject({ ok: false, reason: 'missing' });

    await user.userDO.userMcp_update(owner, 'connection-id', { name: 'renamed-github' });
    expect(await call('read_issue')).toEqual({ ok: true, value: { content: [] } });

    await user.userDO.userMcp_update(owner, 'connection-id', { allowedTools: ['read_issue', 'create_issue'] });
    const planCaller: SlateCaller = { ...ROOT_SLATE_CALLER, workMode: 'plan' };
    expect(await actor.agent.slateBindingCallAs(planCaller, 'issues', 'GITHUB', { member: 'read_issue', args: [{}], depth: 0 }))
      .toEqual({ ok: true, value: { content: [] } });
    expect(await actor.agent.slateBindingCallAs(planCaller, 'issues', 'GITHUB', { member: 'create_issue', args: [{}], depth: 0 }))
      .toMatchObject({ ok: false, reason: 'denied' });
    await bind('connection-id', ['read_issue']);
    expect(await call('create_issue')).toMatchObject({ ok: false, reason: 'denied' });
    await bind('connection-id');
    expect(await call('create_issue')).toEqual({ ok: true, value: { content: [] } });

    await user.userDO.userMcp_update(owner, 'connection-id', { allowedTools: [] });
    expect(await call('read_issue')).toMatchObject({ ok: false, reason: 'missing' });

    // The owner's allowlist is not the caller's role. A facet whose role names
    // only `memory` cannot use a declared MCP binding it could not call natively,
    // even while the owner permits the tool.
    await user.userDO.userMcp_update(owner, 'connection-id', { allowedTools: ['read_issue'] });
    const child = await hiredSubordinateHarness(actor, {
      name: 'issue-reader', displayName: 'Issue reader', nameOrigin: 'user', role: 'general', mission: 'Read issues',
    }, { userDO: user.userDO, workspace, ownerUserId });
    // The push a hire makes: the child reaches the owner's MCP plane with the workspace's capability.
    await child.agent.installWorkspaceCapability(capability);
    const asChild = child.agent.observeSlateCaller();
    const childCall = (tool: string) => actor.agent.slateBindingCallAs(asChild, 'issues', 'GITHUB', { member: tool, args: [{}], depth: 0 });
    expect(await childCall('read_issue')).toEqual({ ok: true, value: { content: [] } });
    child.agent.harnessInstallCatalog({
      roles: { scribe: { description: 'Writes prose only.', instructions: 'Write.', tier: 'default', preset: 'ideate', allowedTools: ['memory'] } },
      tiers: { default: { model: DEFAULT_WORKERS_AI_MODEL_SPEC } },
    });
    await child.agent.setSubordinateIdentity({
      name: 'issue-reader', displayName: 'Issue reader', nameOrigin: 'user', role: 'scribe', mission: 'Read issues', lifetime: 'durable',
    });
    expect(await childCall('read_issue')).toMatchObject({ ok: false, reason: 'denied' });
  } finally {
    await user.joinFibers();
    user.close();
  }
});

test('a lazy boot after activation failure still broadcasts Slate edits once', async () => {
  const actor = orchestratorHarness();
  const broadcasts: string[] = [];
  Reflect.set(actor.agent, 'broadcast', (payload: string) => { broadcasts.push(payload); });
  actor.db.exec('CREATE TABLE inodes (blocked INTEGER)');
  await expect(actor.agent.listSlates()).rejects.toThrow();
  actor.db.exec('DROP TABLE inodes');
  expect(await actor.agent.listSlates()).toEqual({ slates: [], problems: [] });
  const vfs = actor.agent.observeRuntime().storage.vfs;
  await vfs.mkdir('/home/user/slates/recovered', { recursive: true });
  broadcasts.length = 0;
  await vfs.writeFile('/home/user/slates/recovered/server.ts', 'export default { fetch() { return new Response("ready"); } };');
  expect(broadcasts.map((payload) => JSON.parse(payload))).toEqual([{ type: 'slates_changed', ids: ['recovered'] }]);
  await actor.agent.listSlates();
  broadcasts.length = 0;
  await vfs.writeFile('/home/user/slates/recovered/server.ts', 'export default { fetch() { return new Response("updated"); } };');
  expect(broadcasts.map((payload) => JSON.parse(payload))).toEqual([{ type: 'slates_changed', ids: ['recovered'] }]);
});

test('the initial snapshot discovers authored Slate projects', async () => {
  const actor = orchestratorHarness();
  const vfs = actor.agent.observeRuntime().storage.vfs;
  await vfs.mkdir('/home/user/slates/overview', { recursive: true });
  await vfs.writeFile('/home/user/slates/overview/package.json', JSON.stringify({
    main: 'server.ts', slate: { title: 'Overview', bindings: { JOBS: { kind: 'rpc', methods: ['listBackgroundJobs'] } } },
  }));
  await vfs.writeFile('/home/user/slates/overview/server.ts', 'export default { fetch() { return new Response("overview"); } };');
  expect(await actor.agent.getWorkspaceSnapshot()).toHaveProperty('slates', [
    { id: 'overview', title: 'Overview', bindings: ['JOBS'] },
  ]);
});

test('the agent slate operation commits, forks and restores its authored source', async () => {
  const actor = orchestratorHarness();
  const files = actor.agent.observeRuntime().storage.vfs;
  const root = '/home/user/slates/notes';
  await files.mkdir(root, { recursive: true });
  await files.writeFile(root + '/package.json', JSON.stringify({ main: 'server.ts' }));
  await files.writeFile(root + '/server.ts', 'export default { fetch() { return new Response("first"); } };');
  const record = (result: SlateCallResult) => {
    if (!result.ok) throw new Error(result.reason + ': ' + result.error);
    return v.parse(v.object({ id: v.string() }), result.value);
  };
  const first = record(await actor.agent.slate({ op: 'commit', id: 'notes' }));
  await files.writeFile(root + '/server.ts', 'export default { fetch() { return new Response("second"); } };');
  const second = record(await actor.agent.slate({ op: 'commit', id: 'notes' }));
  const history = await actor.agent.slate({ op: 'history', id: 'notes' });
  if (!history.ok) throw new Error(history.reason + ': ' + history.error);
  expect(v.parse(v.object({ versions: v.array(v.object({ id: v.string() })) }), history.value).versions)
    .toEqual([{ id: first.id }, { id: second.id }]);
  record(await actor.agent.slate({ op: 'restore', id: 'notes', version: first.id }));
  expect(await files.readFile(root + '/server.ts', { encoding: 'utf8' })).toContain('"first"');
  const fork = record(await actor.agent.slate({ op: 'fork', version: second.id }));
  expect(await files.readFile('/home/user/slates/' + fork.id + '/server.ts', { encoding: 'utf8' })).toContain('"second"');
  expect(await actor.agent.slate({ op: 'restore', id: fork.id, version: first.id })).toMatchObject({ ok: false, reason: 'missing' });
  expect(await actor.agent.slate({ op: 'commit', id: '../outside' })).toMatchObject({ ok: false, reason: 'bad_input' });
});

test('a facet cannot restore source that its own filesystem authority cannot write', async () => {
  const parent = orchestratorHarness();
  const files = parent.agent.observeRuntime().storage.vfs;
  const path = '/home/user/slates/root-app/server.ts';
  await files.mkdir('/home/user/slates/root-app', { recursive: true });
  await files.writeFile('/home/user/slates/root-app/package.json', JSON.stringify({ main: 'server.ts' }));
  await files.writeFile(path, 'export default { fetch() { return new Response("first"); } };');
  const committed = await parent.agent.slate({ op: 'commit', id: 'root-app' });
  if (!committed.ok) throw new Error(committed.reason + ': ' + committed.error);
  const version = v.parse(v.object({ id: v.string() }), committed.value);
  const current = 'export default { fetch() { return new Response("second"); } };';
  await files.writeFile(path, current);
  const child = await hiredSubordinateHarness(parent, {
    name: 'slate-author', displayName: 'Slate author', nameOrigin: 'user',
    role: 'general', mission: 'Work inside the assigned private home',
  });
  await expect(child.agent.observeRuntime().storage.vfs.writeFile(path, 'blocked'))
    .rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
  const restored = await child.agent.slate({ op: 'restore', id: 'root-app', version: version.id });
  expect(await files.readFile(path, { encoding: 'utf8' })).toBe(current);
  expect(restored).toMatchObject({ ok: false, reason: 'denied' });
});

test('a binding held by a facet reaches the facet\'s own files and role, never the root\'s', async () => {
  const parent = orchestratorHarness();
  const rootFiles = parent.agent.observeRuntime().storage.vfs;
  await rootFiles.mkdir('/home/user/slates/reader', { recursive: true });
  await rootFiles.writeFile('/home/user/slates/reader/package.json', JSON.stringify({
    main: 'server.ts', slate: { bindings: { FILES: { kind: 'namespace', namespace: 'workspace' } } },
  }));
  await rootFiles.writeFile('/home/user/private.md', 'root only');
  const child = await hiredSubordinateHarness(parent, {
    name: 'reader-1', displayName: 'Reader', nameOrigin: 'user',
    role: 'general', mission: 'Read what you may',
  });
  const childHome = agentHome(subordinateAgentName('reader-1'));
  const asChild = child.agent.observeSlateCaller();
  const call = (caller: SlateCaller, member: string, args: JsonValue[]) =>
    parent.agent.slateBindingCallAs(caller, 'reader', 'FILES', { member, args, depth: 0 });

  // The facet's own home: readable and writable through its binding.
  expect(await call(asChild, 'writeFile', [`${childHome}/note.md`, 'mine'])).toMatchObject({ ok: true });
  expect(await rootFiles.readFile(`${childHome}/note.md`, { encoding: 'utf8' })).toBe('mine');
  // The origin's tree: readable (homes are 0o755) but a write is the facet's own EACCES.
  expect(await call(asChild, 'readFile', ['/home/user/private.md'])).toEqual({ ok: true, value: 'root only' });
  expect(await call(asChild, 'writeFile', ['/home/user/private.md', 'stolen'])).toMatchObject({ ok: false, reason: 'denied' });
  expect(await rootFiles.readFile('/home/user/private.md', { encoding: 'utf8' })).toBe('root only');
  // The same binding for the root writes the origin's tree, as the root does —
  // under the root's own read-before-overwrite guard, which a blind write trips.
  expect(await call(ROOT_SLATE_CALLER, 'writeFile', ['/home/user/private.md', 'blind'])).toMatchObject({ ok: false, reason: 'bad_input' });
  expect(await call(ROOT_SLATE_CALLER, 'readFile', ['/home/user/private.md'])).toEqual({ ok: true, value: 'root only' });
  expect(await call(ROOT_SLATE_CALLER, 'writeFile', ['/home/user/private.md', 'root wrote'])).toMatchObject({ ok: true });
  expect(await rootFiles.readFile('/home/user/private.md', { encoding: 'utf8' })).toBe('root wrote');

  // A role that names no workspace-reaching capability loses the namespace on the next call.
  const scribe = {
    roles: { scribe: { description: 'Writes prose only.', instructions: 'Write.', tier: 'default', preset: 'ideate', allowedTools: ['memory'] } },
    tiers: { default: { model: DEFAULT_WORKERS_AI_MODEL_SPEC } },
  } as const;
  const reseed = (role: string) => child.agent.setSubordinateIdentity({
    name: 'reader-1', displayName: 'Reader', nameOrigin: 'user', role,
    mission: 'Read what you may', lifetime: 'durable',
  });
  child.agent.harnessInstallCatalog(scribe);
  await reseed('scribe');
  expect(await call(asChild, 'readFile', ['/home/user/private.md'])).toMatchObject({ ok: false, reason: 'denied' });

  // A COMPLETED turn leaves its resolved profile cached until the next one
  // opens. A role revoked in that window must not keep the old reach alive.
  // The turn is the real one: `beforeTurn` resolves and holds the profile,
  // `onChatResponse` settles it.
  await reseed('general');
  const openTurn = async (content: string) => {
    const message = { id: `u-${content}`, role: 'user' as const, parts: [{ type: 'text' as const, text: content }] };
    Object.defineProperty(child.agent, 'messages', { value: [message], configurable: true });
    await child.agent.beforeTurn({
      system: 'base', messages: [{ role: 'user', content }], tools: child.agent.observeRawTools(),
      model: 'harness-model', continuation: false, body: {},
    });
  };
  const settleTurn = (id: string) => child.agent.onChatResponse({
    message: { id, role: 'assistant', parts: [{ type: 'text', text: 'done' }] },
    requestId: `req-${id}`, continuation: false, status: 'completed',
  });
  await openTurn('read the file');
  expect(await call(asChild, 'readFile', ['/home/user/private.md'])).toEqual({ ok: true, value: 'root wrote' });
  await settleTurn('a-1');
  await reseed('scribe');
  expect(await call(asChild, 'readFile', ['/home/user/private.md'])).toMatchObject({ ok: false, reason: 'denied' });
  // While a turn IS live, its own resolved profile governs, as it does natively.
  await openTurn('read it again');
  expect(await call(asChild, 'readFile', ['/home/user/private.md'])).toMatchObject({ ok: false, reason: 'denied' });
  await settleTurn('a-2');
});

test('workspace read models are the root\'s own reads; a facet holds none of them', async () => {
  const parent = orchestratorHarness();
  const rootFiles = parent.agent.observeRuntime().storage.vfs;
  await rootFiles.mkdir('/home/user/slates/status', { recursive: true });
  await rootFiles.writeFile('/home/user/slates/status/package.json', JSON.stringify({
    main: 'server.ts', slate: { bindings: { DATA: { kind: 'rpc', methods: ['getExecutors'] } } },
  }));
  const child = await hiredSubordinateHarness(parent, {
    name: 'peeker', displayName: 'Peeker', nameOrigin: 'user', role: 'general', mission: 'Peek',
  });
  const call = (caller: SlateCaller) => parent.agent.slateBindingCallAs(caller, 'status', 'DATA', { member: 'getExecutors', args: [], depth: 0 });
  expect(await call(ROOT_SLATE_CALLER)).toMatchObject({ ok: true, value: expect.any(Array) });
  expect(await call(child.agent.observeSlateCaller())).toMatchObject({ ok: false, reason: 'denied' });
});

test('source capture does not retain a previous caller supplementary group', async () => {
  const parent = orchestratorHarness();
  const files = parent.agent.observeRuntime().storage.vfs;
  await files.mkdir('/home/user/slates/group-source', { recursive: true });
  await files.writeFile('/home/user/slates/group-source/package.json', JSON.stringify({ main: 'server.ts' }));
  await files.writeFile('/home/user/slates/group-source/server.ts', 'export default { fetch() { return new Response("group source"); } };');
  const protectedFile = await parent.agent.workspaceBoxOp('group-source-fixture', {
    op: 'exec', command: 'chown 0:3000 /home/user/slates/group-source/server.ts && chmod 640 /home/user/slates/group-source/server.ts',
    options: { cred: CRED_KERNEL },
  });
  expect(protectedFile).toMatchObject({ exitCode: 0 });
  const grouped: SlateCaller = { workMode: 'build', path: [], cred: { uid: 1000, gid: 1000, groups: [3000], umask: 0o022 } };
  const ungrouped: SlateCaller = { workMode: 'build', path: [], cred: { uid: 1000, gid: 1000, groups: [], umask: 0o022 } };
  expect(await parent.agent.slateAs(grouped, { op: 'commit', id: 'group-source' })).toMatchObject({ ok: true });
  expect(await parent.agent.slateAs(ungrouped, { op: 'commit', id: 'group-source' })).toMatchObject({ ok: false, reason: 'denied' });
});

test('a command the approval ladder stops answers every surface with its class, and never runs', async () => {
  const actor = orchestratorHarness();
  const files = actor.agent.observeRuntime().storage.vfs;
  await files.mkdir('/home/user/slates/shell', { recursive: true });
  await files.writeFile('/home/user/slates/shell/package.json', JSON.stringify({
    main: 'server.ts', slate: { bindings: { FILES: { kind: 'namespace', namespace: 'workspace', members: ['exec'] } } },
  }));
  const marker = '/home/user/never-written.txt';
  const gated = 'npm publish --dry-run && printf ran > ' + marker;
  const binding = () => actor.agent.slateBindingCallAs(ROOT_SLATE_CALLER, 'shell', 'FILES', { member: 'exec', args: [gated], depth: 0 });
  const codemode = () => {
    const workspace = (actor.agent.observeRuntime().executionRouter?.getProviders() ?? []).find((provider) => provider.name === 'workspace');
    if (workspace === undefined) throw new Error('No workspace provider');
    return workspace.tools.exec.execute(gated);
  };

  await actor.agent.setShellApprovalMode('deny_all');
  expect(await binding()).toMatchObject({ ok: false, reason: 'denied' });
  expect(parseRefusal(v.parse(v.string(), await codemode()))).toMatchObject({ reason: 'denied' });

  await actor.agent.setShellApprovalMode('strict');
  const parked = await binding();
  expect(parked).toMatchObject({ ok: false, reason: 'unavailable' });
  expect(parseRefusal(v.parse(v.string(), await codemode()))).toMatchObject({ reason: 'unavailable' });
  const queued = await actor.agent.listDeferredApprovals();
  expect(queued).toMatchObject([{ status: 'queued', command: gated, executor: 'workspace' }]);
  await actor.agent.decideDeferredApprovals(queued.map((action) => action.id), 'denied');
  expect(await binding()).toMatchObject({ ok: false, reason: 'denied' });

  await actor.agent.setShellApprovalMode('allow_all');
  const failed = await binding();
  expect(failed).toMatchObject({ ok: true });
  expect(v.parse(v.object({ value: v.string() }), failed).value).toStartWith('Error (exit ');
  expect(await files.stat(marker)).toBeNull();
});
