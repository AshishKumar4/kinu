import { expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import {
  DEFAULT_WORKERS_AI_MODEL_SPEC, agentCred, agentHome, agentIdentity, subordinateAgentName, nativeToolFunctions,
  createProviderRegistry, openWorkspaceMainActor, RunEventRecorder, WORKSPACE_RUN_ID,
  type JsonValue, type SlateCallResult,
} from '@kinu.run/core';
import { sqlOver } from '@kinu.run/test-utils';
import { MockLanguageModelV3 } from 'ai/test';
import { hostedSubordinateHarness, orchestratorHarness } from './helpers/actor-harness';
import { createTestUserDO, provisionTestWorkspace, testOwner } from './helpers/user-do';
import { resetRecordedMcp, seedMcpTools, seedMcpAnswer } from './helpers/agents-sdk';
import { ROOT_SLATE_CALLER, type SlateCaller } from '../src/slates/bindings';
import { CRED_KERNEL, type SqlDatabase, type SqlRow, type SqlValue as VendorSqlValue } from '@nimbus-sh/core/runtime/os-contracts.js';
import { toolExecute } from '@kinu.run/test-utils';

/** A hosted child's slate caller: the hop path names the registered actor, and
 *  the credential is the child's own provisioned identity — looked up, never
 *  allocated here. Hiring provisioned the home and its uid row, so this is a
 *  read of the same row the child's file plane acts as, and `agentCred` is the
 *  production constructor for the per-call credential rather than a test
 *  re-declaration of it. The old facet caller carried an SDK class hop; a class
 *  name was never an identity, so the new shape is just the directory name. */
async function childCaller(db: Database, agentName: string, actorName: string): Promise<SlateCaller> {
  // The identity lookup reads through the VENDOR's `SqlDatabase`, whose row and
  // binding vocabulary is narrower than this repo's `SqlValue` — it carries no
  // boolean, because SQLite has none. So the adapter is built the way
  // `unit-facet-tmp-confinement.test.ts` builds its owner's sql: parse each
  // binding into the vendor's union rather than assert across the seam, and
  // answer rows straight from the statement the way a host does.
  const sql: SqlDatabase = {
    exec(query: string, ...bindings: VendorSqlValue[]) {
      const statement = db.prepare<SqlRow, SQLQueryBindings[]>(query);

      const bound = bindings.map((value) => {
        if (value instanceof ArrayBuffer) return new Uint8Array(value);

        if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

        return v.parse(v.union([v.string(), v.number(), v.bigint(), v.null()]), value);
      });

      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return statement.all(...bound);
      statement.run(...bound);

      return [];
    },
  };

  const identity = agentIdentity(sql, agentName);

  return { path: [{ name: actorName }], cred: agentCred(identity), workMode: 'build' };
}

test('native MCP protocol failures reject while namespace responses retain their envelope', async () => {
  resetRecordedMcp();
  const ownerUserId = '0123456789abcdef0123456789abcdef';
  const workspace = 'native-mcp';
  const user = createTestUserDO({ durableObjectId: ownerUserId });

  try {
    const capability = await provisionTestWorkspace(user, workspace);
    const actor = orchestratorHarness(undefined, { userDO: user.userDO, workspace, ownerUserId });
    await actor.agent.installWorkspaceCapability(capability);
    const owner = await testOwner();
    await user.userDO.userMcp_list(owner);
    user.sql.exec(`INSERT INTO user_mcp_servers
      (id, name, server_url, transport, headers, allowed_tools, created_at, updated_at)
      VALUES ('connection-id', 'github', 'https://github.example/sse', 'auto', NULL, NULL, 0, 0)`);
    await user.userDO.userMcp_list(owner);
    seedMcpTools('connection-id', [{ name: 'read_issue', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }]);
    actor.agent.harnessDrivingUserMessage('Read the issue.', { kinuMode: 'build' });

    const turn = await actor.agent.beforeTurn({ system: 'base', messages: [{ role: 'user', content: 'Read the issue.' }],
      tools: actor.agent.observeRawTools(), model: 'harness-model', continuation: false, body: {} });

    const native = turn?.tools?.mcp_github_read_issue;

    if (native === undefined) throw new Error('the native MCP tool was not admitted');
    const invoke = toolExecute<Record<string, never>, JsonValue>(native);
    const data = { isError: false, content: [{ type: 'text', text: '{"error":"data"}' }], structuredContent: { isError: true, reason: 'data-only' }, reason: 'denied', error: 'historical incident' } satisfies Parameters<typeof seedMcpAnswer>[0];
    seedMcpAnswer(data);
    expect(await invoke({})).toEqual(data);
    const protocolFailure = { isError: true, content: [{ type: 'text', text: 'remote execution failed' }], structuredContent: { reason: 'remote-code', error: 'remote evidence' } } satisfies Parameters<typeof seedMcpAnswer>[0];
    seedMcpAnswer(protocolFailure);
    const failed = invoke({});
    await expect(failed).rejects.toThrow('remote execution failed');
    await expect(failed).rejects.toThrow('remote evidence');
    await expect(failed).rejects.not.toHaveProperty('execution');
    seedMcpAnswer(protocolFailure);
    const namespace = nativeToolFunctions({ mcp_github_read_issue: native });
    expect(await namespace.mcp_github_read_issue?.execute({})).toEqual({
      success: false, reason: null, error: expect.stringContaining('remote execution failed'),
    });
    await user.userDO.userMcp_update(owner, 'connection-id', { allowedTools: [] });
    await expect(invoke({})).rejects.toThrow('not in the allowed_tools list');
  } finally { user.close(); resetRecordedMcp(); }
});

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

    const call = (tool: string) => actor.agent.slateBindingCallAs(ROOT_SLATE_CALLER, 'issues', 'GITHUB', { member: tool, args: [{}], invocation: null });

    await bind('github');
    expect(await call('read_issue')).toMatchObject({ ok: false, reason: 'missing' });
    await bind('connection-id');
    expect(await call('read_issue')).toEqual({ ok: true, value: { content: [] } });
    const incident = { content: [], isError: false, reason: 'denied', error: 'historical incident' };
    seedMcpAnswer(incident);
    expect(await call('read_issue')).toEqual({ ok: true, value: incident });
    const protocolFailure = { isError: true, content: [{ type: 'text', text: 'remote execution failed' }] } satisfies Parameters<typeof seedMcpAnswer>[0];
    seedMcpAnswer(protocolFailure);
    expect(await call('read_issue')).toEqual({ ok: true, value: protocolFailure });
    // Outside the owner's allowlist the tool is not on this actor's surface at all.
    expect(await call('create_issue')).toMatchObject({ ok: false, reason: 'missing' });

    await user.userDO.userMcp_update(owner, 'connection-id', { name: 'renamed-github' });
    expect(await call('read_issue')).toEqual({ ok: true, value: { content: [] } });

    await user.userDO.userMcp_update(owner, 'connection-id', { allowedTools: ['read_issue', 'create_issue'] });
    const planCaller: SlateCaller = { ...ROOT_SLATE_CALLER, workMode: 'plan' };
    expect(await actor.agent.slateBindingCallAs(planCaller, 'issues', 'GITHUB', { member: 'read_issue', args: [{}], invocation: null }))
      .toEqual({ ok: true, value: { content: [] } });
    expect(await actor.agent.slateBindingCallAs(planCaller, 'issues', 'GITHUB', { member: 'create_issue', args: [{}], invocation: null }))
      .toMatchObject({ ok: false, reason: 'denied' });
    await bind('connection-id', ['read_issue']);
    expect(await call('create_issue')).toMatchObject({ ok: false, reason: 'denied' });
    await bind('connection-id');
    expect(await call('create_issue')).toEqual({ ok: true, value: { content: [] } });

    await user.userDO.userMcp_update(owner, 'connection-id', { allowedTools: [] });
    expect(await call('read_issue')).toMatchObject({ ok: false, reason: 'missing' });

    // The owner's allowlist is not the caller's surface. A hosted actor
    // connects no MCP servers of its own — those are workspace-level surfaces
    // reached through the main actor — so the same binding it could watch the
    // owner call refuses for the child with the surface reason, not the role
    // one. Role narrowing of what a child CAN reach is pinned by the namespace
    // test below, where the route exists for both.
    await user.userDO.userMcp_update(owner, 'connection-id', { allowedTools: ['read_issue'] });

    const child = await hostedSubordinateHarness(actor, {
      name: 'issue-reader', displayName: 'Issue reader', nameOrigin: 'user', roleId: 'task', mission: 'Read issues',
    });

    const asChild = await childCaller(actor.db, subordinateAgentName(child.actor.handle.storageKey), 'issue-reader');
    const childCall = (tool: string) => actor.agent.slateBindingCallAs(asChild, 'issues', 'GITHUB', { member: tool, args: [{}], invocation: null });
    expect(await childCall('read_issue')).toMatchObject({ ok: false, reason: 'denied' });
  } finally {
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

test('a hosted actor cannot restore source that its own filesystem authority cannot write', async () => {
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

  const child = await hostedSubordinateHarness(parent, {
    name: 'slate-author', displayName: 'Slate author', nameOrigin: 'user',
    roleId: 'task', mission: 'Work inside the assigned private home',
  });

  // The authority itself, on the child's own file plane: the same uid the
  // binding below acts as, so an EACCES here and a denial there are one fact.
  await expect(child.actor.runtime.storage.vfs.writeFile(path, 'blocked'))
    .rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
  const asChild = await childCaller(parent.db, subordinateAgentName(child.actor.handle.storageKey), 'slate-author');
  const restored = await parent.agent.slateAs(asChild, { op: 'restore', id: 'root-app', version: version.id });
  expect(await files.readFile(path, { encoding: 'utf8' })).toBe(current);
  expect(restored).toMatchObject({ ok: false, reason: 'denied' });
});

test('a binding held by a hosted actor reaches its own files and role, never the root\'s', async () => {
  const parent = orchestratorHarness();
  const rootFiles = parent.agent.observeRuntime().storage.vfs;
  await rootFiles.mkdir('/home/user/slates/reader', { recursive: true });
  await rootFiles.writeFile('/home/user/slates/reader/package.json', JSON.stringify({
    main: 'server.ts', slate: { bindings: { FILES: { kind: 'namespace', namespace: 'workspace' } } },
  }));
  await rootFiles.writeFile('/home/user/private.md', 'root only');

  const child = await hostedSubordinateHarness(parent, {
    name: 'reader-1', displayName: 'Reader', nameOrigin: 'user',
    roleId: 'task', mission: 'Read what you may',
  });

  const agentName = subordinateAgentName(child.actor.handle.storageKey);
  const childHome = agentHome(agentName);
  const asChild = await childCaller(parent.db, agentName, 'reader-1');

  const call = (caller: SlateCaller, member: string, args: JsonValue[]) =>
    parent.agent.slateBindingCallAs(caller, 'reader', 'FILES', { member, args, invocation: null });

  expect(await call(asChild, 'writeFile', [`${childHome}/note.md`, 'mine'])).toMatchObject({ ok: true });
  expect(await rootFiles.readFile(`${childHome}/note.md`, { encoding: 'utf8' })).toBe('mine');
  // The origin's tree: readable (homes are 0o755) but a write is the child's own EACCES.
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

  const changeRole = (role: string) => { child.actor.stores.config.setRoleSelection(role); };

  parent.agent.harnessInstallCatalog(scribe);
  changeRole('scribe');
  expect(await call(asChild, 'readFile', ['/home/user/private.md'])).toMatchObject({ ok: false, reason: 'denied' });

  // No turn choreography: a hosted actor holds no chat session, so there is no
  // resolved profile cached across turns to test. The binding resolves the
  // actor's CURRENT role on every call — which is why the revocation above
  // bites immediately, and why restoring the role restores the reach.
  changeRole('task');
  expect(await call(asChild, 'readFile', ['/home/user/private.md'])).toEqual({ ok: true, value: 'root wrote' });
  changeRole('scribe');
  expect(await call(asChild, 'readFile', ['/home/user/private.md'])).toMatchObject({ ok: false, reason: 'denied' });
});

test('native tool bindings use the caller file plane and lose reach immediately with its role', async () => {
  const parent = orchestratorHarness();
  const files = parent.agent.observeRuntime().storage.vfs;
  await files.mkdir('/home/user/slates/native-reader', { recursive: true });
  await files.writeFile('/home/user/slates/native-reader/package.json', JSON.stringify({
    main: 'server.ts', slate: { bindings: { FILE: { kind: 'tool', name: 'file' }, NOTES: { kind: 'memory', members: ['remember', 'recall'] } } },
  }));
  await files.writeFile('/home/user/slate-note.txt', 'root note');

  const child = await hostedSubordinateHarness(parent, {
    name: 'native-reader', displayName: 'Native reader', nameOrigin: 'user', roleId: 'task', mission: 'Read',
  });

  const caller = await childCaller(parent.db, subordinateAgentName(child.actor.handle.storageKey), 'native-reader');

  const call = () => parent.agent.slateBindingCallAs(caller, 'native-reader', 'FILE', {
    member: 'call', args: [{ action: 'read', path: '/home/user/slate-note.txt' }], invocation: null,
  });

  expect(await call()).toMatchObject({ ok: true, value: expect.stringContaining('root note') });
  const memory = (asCaller: SlateCaller, member: string, args: JsonValue[]) => parent.agent.slateBindingCallAs(asCaller, 'native-reader', 'NOTES', { member, args, invocation: null });
  expect(await memory(caller, 'remember', ['slate-key', 'child fact'])).toMatchObject({ ok: true, value: { ok: true } });
  expect(await memory(ROOT_SLATE_CALLER, 'recall', ['slate-key'])).toMatchObject({ ok: true, value: { found: false } });
  parent.agent.harnessInstallCatalog({
    roles: { scribe: { description: 'Only memory.', instructions: 'Write.', tier: 'default', preset: 'ideate', allowedTools: ['memory'] } },
    tiers: { default: { model: DEFAULT_WORKERS_AI_MODEL_SPEC } },
  });
  child.actor.stores.config.setRoleSelection('scribe');
  expect(await call()).toMatchObject({ ok: true, value: { success: false, reason: 'denied' } });
  expect(await memory(caller, 'recall', ['slate-key'])).toMatchObject({ ok: true, value: { found: true, value: 'child fact' } });
  child.actor.stores.config.setRoleSelection('task');
  expect(await call()).toMatchObject({ ok: true, value: expect.stringContaining('root note') });
});

test('a slate cannot bind the agent, delegate through a tool alias, or widen a projection', async () => {
  const actor = orchestratorHarness();
  const files = actor.agent.observeRuntime().storage.vfs;
  await files.mkdir('/home/user/slates/limited', { recursive: true });

  const bind = (binding: JsonValue) => files.writeFile('/home/user/slates/limited/package.json', JSON.stringify({
    main: 'server.ts', slate: { bindings: { CAP: binding } },
  }));

  const call = (member: string, args: JsonValue[] = []) => actor.agent.slateBindingCallAs(ROOT_SLATE_CALLER, 'limited', 'CAP', { member, args, invocation: null });
  // The agent binding is the inbox, not a delegation surface: `hire` is not
  // a member it offers.
  await bind({ kind: 'agent' });
  expect(await call('hire')).toMatchObject({ ok: false, reason: 'denied' });
  await bind({ kind: 'tool', name: 'agents' });
  expect(await call('call', [{ action: 'hire', role: 'task', mission: 'should not run' }])).toMatchObject({ ok: true, value: { success: false, reason: 'denied' } });

  for (const namespace of ['agent', 'agents']) {
    await bind({ kind: 'namespace', namespace });
    expect(await call('hire')).toMatchObject({ ok: false, reason: 'denied' });
  }

  await bind({ kind: 'tasks', members: ['list'] });
  expect(await call('list')).toMatchObject({ ok: true });
  expect(await call('create', [{ title: 'not allowed' }])).toMatchObject({ ok: false, reason: 'denied' });
  await bind({ kind: 'tasks', members: ['add'] });
  expect(await call('add', [false])).toMatchObject({ ok: true, value: { success: false, reason: 'bad_input' } });
  await bind({ kind: 'memory', members: ['remember'] });
  expect(await call('remember', ['key', 'value', false])).toMatchObject({ ok: true, value: { success: false, reason: 'bad_input' } });
});

test('a tool binding keeps native Plan checks and the same approval ladder as codemode and direct run', async () => {
  const actor = orchestratorHarness();
  const files = actor.agent.observeRuntime().storage.vfs;
  await files.mkdir('/home/user/slates/tool-gate', { recursive: true });
  await files.writeFile('/home/user/slates/tool-gate/package.json', JSON.stringify({
    main: 'server.ts', slate: { bindings: { RUN: { kind: 'tool', name: 'run' }, FILE: { kind: 'tool', name: 'file' } } },
  }));
  const marker = '/home/user/slate-tool-approved';
  const command = `npm publish --dry-run && printf ran > ${marker}`;
  const binding = () => actor.agent.slateBindingCallAs(ROOT_SLATE_CALLER, 'tool-gate', 'RUN', { member: 'call', args: [{ command }], invocation: null });
  const native = nativeToolFunctions(actor.agent.observeRawTools());
  const codemode = () => native.run?.execute({ command });

  for (const [mode, reason] of [['deny_all', 'denied'], ['strict', 'unavailable']]) {
    await actor.agent.setShellApprovalMode(v.parse(v.picklist(['deny_all', 'strict']), mode));
    expect(await binding()).toMatchObject({ ok: true, value: { success: false, reason } });
    expect(await codemode()).toMatchObject({ success: false, reason });
    expect(await actor.agent.executeInExecutor('workspace', command)).toMatchObject({ refusal: { reason } });
    expect(await files.stat(marker)).toBeNull();
  }

  const planning: SlateCaller = { ...ROOT_SLATE_CALLER, workMode: 'plan' };

  const write = () => actor.agent.slateBindingCallAs(planning, 'tool-gate', 'FILE', {
    member: 'call', args: [{ action: 'write', path: marker, content: 'must not land' }], invocation: null,
  });

  expect(await write()).toMatchObject({ ok: true, value: { success: false, reason: 'denied' } });
  expect(await files.stat(marker)).toBeNull();
});

test('workspace read models are the root\'s own reads; a hosted actor holds none of them', async () => {
  const parent = orchestratorHarness();
  const rootFiles = parent.agent.observeRuntime().storage.vfs;
  await rootFiles.mkdir('/home/user/slates/status', { recursive: true });
  await rootFiles.writeFile('/home/user/slates/status/package.json', JSON.stringify({
    main: 'server.ts', slate: { bindings: { DATA: { kind: 'rpc', methods: ['getExecutors'] } } },
  }));

  const child = await hostedSubordinateHarness(parent, {
    name: 'peeker', displayName: 'Peeker', nameOrigin: 'user', roleId: 'task', mission: 'Peek',
  });

  const call = (caller: SlateCaller) => parent.agent.slateBindingCallAs(caller, 'status', 'DATA', { member: 'getExecutors', args: [], invocation: null });
  expect(await call(ROOT_SLATE_CALLER)).toMatchObject({ ok: true, value: expect.any(Array) });
  expect(await call(await childCaller(parent.db, subordinateAgentName(child.actor.handle.storageKey), 'peeker'))).toMatchObject({ ok: false, reason: 'denied' });
});

test('source capture does not retain a previous caller supplementary group', async () => {
  const parent = orchestratorHarness();
  const files = parent.agent.observeRuntime().storage.vfs;
  await files.mkdir('/home/user/slates/group-source', { recursive: true });
  await files.writeFile('/home/user/slates/group-source/package.json', JSON.stringify({ main: 'server.ts' }));
  await files.writeFile('/home/user/slates/group-source/server.ts', 'export default { fetch() { return new Response("group source"); } };');

  // Arranged as kernel, without the box: the permission bits are VFS state,
  // and the removed `workspaceBoxOp` monomorphic RPC was only ever a shell
  // around chown/chmod. Host-stamped through the harness, never agent-chosen.
  const protectedFile = await parent.agent.harnessBoxExec(
    'group-source-fixture',
    'chown 0:3000 /home/user/slates/group-source/server.ts && chmod 640 /home/user/slates/group-source/server.ts',
    CRED_KERNEL,
  );

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
  const binding = (command = gated) => actor.agent.slateBindingCallAs(ROOT_SLATE_CALLER, 'shell', 'FILES', { member: 'exec', args: [command], invocation: null });

  const codemode = () => {
    const workspace = (actor.agent.observeRuntime().executionRouter?.getProviders() ?? []).find((provider) => provider.name === 'workspace');

    if (workspace === undefined) throw new Error('No workspace provider');

    return workspace.tools.exec.execute(gated);
  };

  await actor.agent.setShellApprovalMode('deny_all');
  expect(await binding()).toMatchObject({ ok: false, reason: 'denied' });
  expect(await codemode()).toMatchObject({ reason: 'denied' });
  expect(await actor.agent.executeInExecutor('workspace', gated)).toMatchObject({ refusal: { reason: 'denied' } });
  expect(await files.stat(marker)).toBeNull();

  await actor.agent.setShellApprovalMode('strict');
  const parked = await binding();
  expect(parked).toMatchObject({ ok: false, reason: 'unavailable' });
  expect(await codemode()).toMatchObject({ reason: 'unavailable' });
  expect(await actor.agent.executeInExecutor('workspace', gated)).toMatchObject({ refusal: { reason: 'unavailable' } });
  expect(await files.stat(marker)).toBeNull();
  const queued = await actor.agent.listDeferredApprovals();
  expect(queued).toMatchObject([{ status: 'queued', command: gated, executor: 'workspace' }]);
  await actor.agent.decideDeferredApprovals(queued.map((action) => action.id), 'denied');
  expect(await binding()).toMatchObject({ ok: false, reason: 'denied' });

  await actor.agent.setShellApprovalMode('allow_all');
  const incident = JSON.stringify({ reason: 'denied', error: 'historical incident' });
  await files.writeFile('/home/user/incident.json', incident);
  expect(await binding('cat /home/user/incident.json')).toEqual({ ok: true, value: incident });
  expect(await actor.agent.executeInExecutor('workspace', 'cat /home/user/incident.json'))
    .toEqual({ stdout: incident, stderr: '', exitCode: 0 });
  expect(await actor.agent.executeInExecutor('workspace', 'echo failed; echo detail >&2; exit 1'))
    .toMatchObject({ exitCode: 1, refusal: { reason: 'io', error: expect.stringContaining('detail') } });
  const failed = await binding('printf ran > ' + marker + '; exit 1');
  expect(failed).toMatchObject({ ok: false, reason: 'io' });
  expect(await files.readFile(marker, { encoding: 'utf8' })).toBe('ran');
});

test('the reserved __storage binding answers the slate\'s own durable KV, per slate and within bounds', async () => {
  const actor = orchestratorHarness();
  const files = actor.agent.observeRuntime().storage.vfs;
  await files.mkdir('/home/user/slates/self-store', { recursive: true });
  await files.writeFile('/home/user/slates/self-store/package.json', JSON.stringify({ main: 'server.ts' }));
  await files.mkdir('/home/user/slates/peer-store', { recursive: true });
  await files.writeFile('/home/user/slates/peer-store/package.json', JSON.stringify({ main: 'server.ts' }));

  const storage = (id: string, member: string, args: JsonValue[] = []) =>
    actor.agent.slateBindingCallAs(ROOT_SLATE_CALLER, id, '__storage', { member, args, invocation: null });

  expect(await storage('self-store', 'get', ['k'])).toEqual({ ok: true, value: null });
  expect(await storage('self-store', 'put', ['k', { n: 1 }])).toEqual({ ok: true, value: null });
  expect(await storage('self-store', 'get', ['k'])).toEqual({ ok: true, value: { value: { n: 1 } } });
  expect(await storage('peer-store', 'get', ['k'])).toEqual({ ok: true, value: null });
  expect(await storage('self-store', 'list', [{ prefix: 'k' }])).toEqual({ ok: true, value: [['k', { n: 1 }]] });
  expect(await storage('self-store', 'delete', ['k'])).toEqual({ ok: true, value: true });
  expect(await storage('self-store', 'delete', ['k'])).toEqual({ ok: true, value: false });
  expect(await storage('self-store', 'list')).toEqual({ ok: true, value: [] });

  expect(await storage('self-store', 'get', [])).toMatchObject({ ok: false, reason: 'bad_input' });
  expect(await storage('self-store', 'nope', [])).toMatchObject({ ok: false, reason: 'denied' });

  const planning: SlateCaller = { ...ROOT_SLATE_CALLER, workMode: 'plan' };

  expect(await actor.agent.slateBindingCallAs(planning, 'self-store', '__storage', { member: 'get', args: ['k'], invocation: null }))
    .toMatchObject({ ok: true });
  expect(await actor.agent.slateBindingCallAs(planning, 'self-store', '__storage', { member: 'put', args: ['k', 1], invocation: null }))
    .toMatchObject({ ok: false, reason: 'denied' });
});

test('a slate agent binding delivers one inbox signal naming the slate', async () => {
  const actor = orchestratorHarness();
  const files = actor.agent.observeRuntime().storage.vfs;
  await files.mkdir('/home/user/slates/pager', { recursive: true });
  await files.writeFile('/home/user/slates/pager/package.json', JSON.stringify({
    main: 'server.ts', slate: { bindings: { AGENT: { kind: 'agent' } } },
  }));

  const delivered: Array<{ kind: string; text: string; metadata?: unknown }> = [];

  actor.agent.harnessSetSignalDeliverer(async (signal) => {
    delivered.push(signal);

    return 'queued';
  });

  const call = (args: JsonValue[]) =>
    actor.agent.slateBindingCallAs(ROOT_SLATE_CALLER, 'pager', 'AGENT', { member: 'send', args, invocation: null });

  expect(await call([{ text: 'done', data: { count: 2 } }])).toEqual({ ok: true, value: { outcome: 'queued' } });
  expect(delivered).toEqual([{ kind: 'slate', text: 'Slate pager: done', metadata: { slate: 'pager', data: { count: 2 } } }]);

  // A hosted caller holds no inbox of its own: the refusal says where the
  // route belongs rather than failing on a mechanism.
  const child = await hostedSubordinateHarness(actor, {
    name: 'pager-1', displayName: 'Pager', nameOrigin: 'user', roleId: 'task', mission: 'Page',
  });

  const asChild = await childCaller(actor.db, subordinateAgentName(child.actor.handle.storageKey), 'pager-1');

  expect(await actor.agent.slateBindingCallAs(asChild, 'pager', 'AGENT', { member: 'send', args: [{ text: 'x' }], invocation: null }))
    .toMatchObject({ ok: false, reason: 'denied', error: expect.stringContaining('no inbox of its own') });
});

test('a slate ai binding runs one model call under the caller authority, as a slate spend row', async () => {
  const actor = orchestratorHarness();
  const files = actor.agent.observeRuntime().storage.vfs;
  await files.mkdir('/home/user/slates/thinker', { recursive: true });
  await files.writeFile('/home/user/slates/thinker/package.json', JSON.stringify({
    main: 'server.ts', slate: { bindings: { MODEL: { kind: 'ai' } } },
  }));

  const seen: string[] = [];

  actor.agent.overrideProviderRegistry({
    registry: createProviderRegistry(),
    deps: { env: {}, getAuth: async () => null, hasCredential: async () => false },
    resolveModel: (spec) => {
      seen.push(spec);

      return new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text' as const, text: 'model answer' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: { inputTokens: { total: 9, noCache: 9, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 4, text: 4, reasoning: undefined } },
          warnings: [],
        }),
      });
    },
    normalizeSpecSync: (spec) => spec ?? 'test/model',
  });

  const call = (args: JsonValue[]) =>
    actor.agent.slateBindingCallAs(ROOT_SLATE_CALLER, 'thinker', 'MODEL', { member: 'run', args, invocation: null });

  const answer = await call([{ prompt: 'summarize', system: 'be brief' }]);

  expect(answer).toEqual({ ok: true, value: { text: 'model answer', model: DEFAULT_WORKERS_AI_MODEL_SPEC, usage: { input: 9, output: 4 } } });
  expect(seen).toEqual([DEFAULT_WORKERS_AI_MODEL_SPEC]);

  const operations = new RunEventRecorder(sqlOver(actor.db), openWorkspaceMainActor(sqlOver(actor.db)))
    .read(WORKSPACE_RUN_ID)
    .flatMap((event) => (event.type === 'model_operation' ? [event] : []));

  expect(operations.map((row) => row.source)).toEqual(['slate', 'slate']);
  expect(operations.map((row) => row.phase)).toEqual(['start', 'end']);

  // A tier the catalog never published is bad input, not an io failure.
  expect(await call([{ prompt: 'p', tier: 'imaginary' }])).toMatchObject({ ok: false, reason: 'bad_input' });
});

test('a path-scoped workspace binding reaches inside its prefixes and nowhere else', async () => {
  const actor = orchestratorHarness();
  const files = actor.agent.observeRuntime().storage.vfs;
  await files.mkdir('/home/user/slates/warden', { recursive: true });
  await files.writeFile('/home/user/slates/warden/package.json', JSON.stringify({
    main: 'server.ts', slate: { bindings: { FILES: { kind: 'namespace', namespace: 'workspace', paths: ['/home/user/allowed'] } } },
  }));
  await files.mkdir('/home/user/allowed', { recursive: true });
  await files.writeFile('/home/user/allowed/ok.md', 'in');
  await files.writeFile('/home/user/secret.md', 'out');

  const call = (member: string, args: JsonValue[]) =>
    actor.agent.slateBindingCallAs(ROOT_SLATE_CALLER, 'warden', 'FILES', { member, args, invocation: null });

  expect(await call('readFile', ['/home/user/allowed/ok.md'])).toEqual({ ok: true, value: 'in' });
  expect(await call('readFile', ['/home/user/secret.md'])).toMatchObject({ ok: false, reason: 'denied', error: expect.stringContaining('/home/user/allowed') });
  expect(await call('exec', ['ls'])).toMatchObject({ ok: false, reason: 'denied', error: expect.stringContaining('only file members') });
});
