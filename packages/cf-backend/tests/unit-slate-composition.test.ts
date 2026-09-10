import { expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import {
  DEFAULT_WORKERS_AI_MODEL_SPEC, agentCred, agentHome, agentIdentity, subordinateAgentName, nativeToolFunctions,
  type JsonValue, type SlateCallResult,
} from '@kinu.run/core';
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
    expect(await namespace.mcp_github_read_issue?.execute({})).toEqual(protocolFailure);
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
      name: 'issue-reader', displayName: 'Issue reader', nameOrigin: 'user', roleId: 'general', mission: 'Read issues',
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
    roleId: 'general', mission: 'Work inside the assigned private home',
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
    roleId: 'general', mission: 'Read what you may',
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
  changeRole('general');
  expect(await call(asChild, 'readFile', ['/home/user/private.md'])).toEqual({ ok: true, value: 'root wrote' });
  changeRole('scribe');
  expect(await call(asChild, 'readFile', ['/home/user/private.md'])).toMatchObject({ ok: false, reason: 'denied' });
});

test('workspace read models are the root\'s own reads; a hosted actor holds none of them', async () => {
  const parent = orchestratorHarness();
  const rootFiles = parent.agent.observeRuntime().storage.vfs;
  await rootFiles.mkdir('/home/user/slates/status', { recursive: true });
  await rootFiles.writeFile('/home/user/slates/status/package.json', JSON.stringify({
    main: 'server.ts', slate: { bindings: { DATA: { kind: 'rpc', methods: ['getExecutors'] } } },
  }));

  const child = await hostedSubordinateHarness(parent, {
    name: 'peeker', displayName: 'Peeker', nameOrigin: 'user', roleId: 'general', mission: 'Peek',
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
