import { readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import {
  DEFAULT_WORKERS_AI_MODEL_SPEC, agentCred, agentHome, agentIdentity,
  openWorkspaceMainActor, RunEventRecorder, SESSION_UID, WORKSPACE_RUN_ID,
  type JsonValue, type SlateSurfaceResult, actorHomeName } from '@kinu.run/core';
import { sqlOver } from '@kinu.run/test-utils';
import { scriptedTurnModel } from '@kinu.run/test-utils/turn-model';
import {
  gatewayWorkspace, hostedSubordinateHarness, chatSessionTurns, orchestratorHarness, reactivateOrchestratorHarness, storedChat, workspaceFiles,
} from './helpers/actor-harness';
import { chatCompletion, wordByWordCompletion, GATEWAY_MODEL, stubAiBinding } from './helpers/platform-gateway';
import { createWorkspaceBundle } from '../../core/tests/helpers';
import { createTestUserDO, provisionTestWorkspace, testOwner } from './helpers/user-do';
import { joinHarnessFibers, recordedMcpToolCalls, resetRecordedMcp, seedMcpTools, seedMcpAnswer } from './helpers/agents-sdk';
import { ROOT_SLATE_CALLER, type SlateCaller } from '../src/slates/bindings';
import { SlateId } from '@agent-core/core/slates';
import { slateDirectory } from '@kinu.run/core/slates';
import type { SqlDatabase, SqlRow, SqlValue as VendorSqlValue } from '@nimbus-sh/core/runtime/os-contracts.js';
import { present, toolExecute } from '@kinu.run/test-utils';

/** The credential is the child's provisioned identity, looked up (hiring provisioned it), never allocated here. */
async function childCaller(db: Database, agentName: string, actorName: string): Promise<SlateCaller> {
  // The vendor's `SqlDatabase` vocabulary has no boolean (SQLite has none): parse each binding into its union
  // rather than assert across the seam.
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

/** Calls on slate `id`'s surface, as `caller`. */
function surface(agent: ReturnType<typeof orchestratorHarness>['agent'], caller: SlateCaller, id: string) {
  return (path: string[], args: JsonValue[] = []): Promise<SlateSurfaceResult> => agent.slateCallAs(caller, id, 'workspace', { path, args, invocation: null });
}

test('an MCP tool called through eval answers its data whole, fails on a protocol failure, and obeys the allowlist', async () => {
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
      (id, name, server_url, transport, headers, allowed_tools)
      VALUES ('connection-id', 'github', 'https://github.example/sse', 'auto', NULL, NULL)`);
    await user.userDO.userMcp_list(owner);
    seedMcpTools('connection-id', [{ name: 'read_issue', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }]);
    actor.agent.harnessDrivingUserMessage('Read the issue.', { kinuMode: 'build' });

    const turn = await chatSessionTurns(actor.agent).prepare({ messages: [{ role: 'user', content: 'Read the issue.' }] });

    // Only `eval` reaches an MCP tool: no native definition carries it.
    expect(turn.activeTools).not.toContain('mcp_github_read_issue');
    const run = toolExecute<{ code: string }, JsonValue>(present(turn.tools.eval, 'eval'));
    // Distinct programs: an identical `eval` within one turn replays its first answer from the durable claim.
    const call = (attempt: number) => ({ code: `const attempt = ${attempt};\nreturn await tools["mcp_github_read_issue"]({});` });
    const data = { isError: false, content: [{ type: 'text', text: '{"error":"data"}' }], structuredContent: { isError: true, reason: 'data-only' }, reason: 'denied', error: 'historical incident' } satisfies Parameters<typeof seedMcpAnswer>[0];
    seedMcpAnswer(data);
    expect(await run(call(1))).toMatchObject({ result: data });
    const protocolFailure = { isError: true, content: [{ type: 'text', text: 'remote execution failed' }], structuredContent: { reason: 'remote-code', error: 'remote evidence' } } satisfies Parameters<typeof seedMcpAnswer>[0];
    seedMcpAnswer(protocolFailure);
    await expect(run(call(2))).rejects.toThrow('remote execution failed');
    await user.userDO.userMcp_update(owner, 'connection-id', { allowedTools: [] });
    await expect(run(call(3))).rejects.toThrow('not in the allowed_tools list');
  } finally { user.close(); resetRecordedMcp(); }
});

test("a server whose stored allowlist is corrupt offers none of its tools, and a call to one never reaches it", async () => {
  resetRecordedMcp();
  const ownerUserId = '0123456789abcdef0123456789abcdef';
  const workspace = 'corrupt-allowlist';
  const user = createTestUserDO({ durableObjectId: ownerUserId });

  try {
    const capability = await provisionTestWorkspace(user, workspace);
    const actor = orchestratorHarness(undefined, { userDO: user.userDO, workspace, ownerUserId });
    await actor.agent.installWorkspaceCapability(capability);
    const owner = await testOwner();
    await user.userDO.userMcp_list(owner);
    // Written, but not a list of names: the owner set an allowlist, and nothing may read it as "allow all".
    user.sql.exec(`INSERT INTO user_mcp_servers
      (id, name, server_url, transport, headers, allowed_tools)
      VALUES ('connection-id', 'github', 'https://github.example/sse', 'auto', NULL, '[1,2]')`);
    await user.userDO.userMcp_list(owner);
    seedMcpTools('connection-id', [{ name: 'read_issue', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }]);
    seedMcpAnswer({ isError: false, content: [{ type: 'text', text: 'issue body' }] });
    actor.agent.harnessDrivingUserMessage('Read the issue.', { kinuMode: 'build' });

    const turn = await chatSessionTurns(actor.agent).prepare({ messages: [{ role: 'user', content: 'Read the issue.' }] });
    const run = toolExecute<{ code: string }, JsonValue>(present(turn.tools.eval, 'eval'));

    await expect(run({ code: 'return await tools["mcp_github_read_issue"]({});' })).rejects.toThrow();
    expect(recordedMcpToolCalls()).toEqual([]);
    expect((await user.userDO.userMcp_list(owner)).map((server) => ({ toolsCount: server.toolsCount, flagged: server.error !== null })))
      .toEqual([{ toolsCount: 0, flagged: true }]);
  } finally { user.close(); resetRecordedMcp(); }
});

test('a slate\'s MCP call follows connection identity and the owner allowlist', async () => {
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
      (id, name, server_url, transport, headers, allowed_tools)
      VALUES ('connection-id', 'github', 'https://github.example/sse', 'auto', NULL, '["read_issue"]')`);
    await user.userDO.userMcp_list(owner);
    seedMcpTools('connection-id', [
      { name: 'read_issue', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'create_issue', inputSchema: { type: 'object' } },
    ]);
    const vfs = workspaceFiles(actor.agent);
    await vfs.mkdir('/slates/issues', { recursive: true });

    await writeText(vfs, '/slates/issues/package.json', JSON.stringify({ main: 'server.ts', slate: { title: 'Issues' } }));
    const on = (server: string, tool: string, caller: SlateCaller = ROOT_SLATE_CALLER) => surface(actor.agent, caller, 'issues')(['mcp', server, tool], [{}]);
    const call = (tool: string) => on('renamed-github', tool);

    // A server is named as the actor's programs name it, by its name, never by its connection id.
    expect(await on('connection-id', 'read_issue')).toMatchObject({ ok: false, reason: 'missing' });
    expect(await on('github', 'read_issue')).toEqual({ ok: true, value: { content: [] } });
    await user.userDO.userMcp_update(owner, 'connection-id', { name: 'renamed-github' });
    expect(await on('github', 'read_issue')).toMatchObject({ ok: false, reason: 'missing' });
    expect(await call('read_issue')).toEqual({ ok: true, value: { content: [] } });
    const incident = { content: [], isError: false, reason: 'denied', error: 'historical incident' };
    seedMcpAnswer(incident);
    expect(await call('read_issue')).toEqual({ ok: true, value: incident });
    const protocolFailure = { isError: true, content: [{ type: 'text', text: 'remote execution failed' }] } satisfies Parameters<typeof seedMcpAnswer>[0];
    seedMcpAnswer(protocolFailure);
    expect(await call('read_issue')).toEqual({ ok: true, value: protocolFailure });
    expect(await call('create_issue')).toMatchObject({ ok: false, reason: 'missing' });

    await user.userDO.userMcp_update(owner, 'connection-id', { allowedTools: ['read_issue', 'create_issue'] });
    const planCaller: SlateCaller = { ...ROOT_SLATE_CALLER, workMode: 'plan' };
    expect(await on('renamed-github', 'read_issue', planCaller)).toEqual({ ok: true, value: { content: [] } });
    expect(await on('renamed-github', 'create_issue', planCaller)).toMatchObject({ ok: false, reason: 'denied' });
    expect(await call('create_issue')).toEqual({ ok: true, value: { content: [] } });

    await user.userDO.userMcp_update(owner, 'connection-id', { allowedTools: [] });
    expect(await call('read_issue')).toMatchObject({ ok: false, reason: 'missing' });

    // A hosted actor connects no MCP servers of its own, so it refuses with the surface reason, not the role one.
    await user.userDO.userMcp_update(owner, 'connection-id', { allowedTools: ['read_issue'] });

    const child = await hostedSubordinateHarness(actor, {
      name: 'issue-reader', displayName: 'Issue reader', nameOrigin: 'user', roleId: 'task', mission: 'Read issues',
    });

    const asChild = await childCaller(actor.db, actorHomeName({ origin: 'agent', name: child.actor.handle.name, storageKey: child.actor.handle.storageKey }), 'issue-reader');
    expect(await on('renamed-github', 'read_issue', asChild)).toMatchObject({ ok: false, reason: 'denied' });
  } finally {
    user.close();
  }
});

test('a lazy boot after activation failure still broadcasts Slate edits once', async () => {
  const actor = orchestratorHarness();
  const broadcasts: string[] = [];
  Reflect.set(actor.agent, 'broadcast', (payload: string) => { broadcasts.push(payload); });
  actor.db.exec('CREATE TABLE vfs_state (blocked INTEGER)');
  await expect(actor.agent.listSlates()).rejects.toThrow();
  actor.db.exec('DROP TABLE vfs_state');
  expect(await actor.agent.listSlates()).toEqual({ slates: [], problems: [] });
  const vfs = workspaceFiles(actor.agent);
  await vfs.mkdir('/slates/recovered', { recursive: true });
  broadcasts.length = 0;
  await writeText(vfs, '/slates/recovered/server.ts', 'export default { fetch() { return new Response("ready"); } };');
  expect(broadcasts.map((payload) => JSON.parse(payload))).toEqual([{ type: 'slates_changed', ids: ['recovered'] }]);
  await actor.agent.listSlates();
  broadcasts.length = 0;
  await writeText(vfs, '/slates/recovered/server.ts', 'export default { fetch() { return new Response("updated"); } };');
  expect(broadcasts.map((payload) => JSON.parse(payload))).toEqual([{ type: 'slates_changed', ids: ['recovered'] }]);
});

test('the initial snapshot discovers authored Slate projects', async () => {
  const actor = orchestratorHarness();
  const vfs = workspaceFiles(actor.agent);
  await vfs.mkdir('/slates/overview', { recursive: true });
  await writeText(vfs, '/slates/overview/package.json', JSON.stringify({ main: 'server.ts', slate: { title: 'Overview' } }));
  await writeText(vfs, '/slates/overview/server.ts', 'export default { fetch() { return new Response("overview"); } };');
  expect(await actor.agent.getWorkspaceSnapshot()).toHaveProperty('slates', [{ id: 'overview', title: 'Overview' }]);
});

test('slate history answers one bounded page and its cursor continues where it stopped', async () => {
  const actor = orchestratorHarness();
  const files = workspaceFiles(actor.agent);
  const root = '/slates/notes';
  await files.mkdir(root, { recursive: true });
  await writeText(files, root + '/package.json', JSON.stringify({ main: 'server.ts' }));
  const committed: string[] = [];

  for (let n = 0; n < 20; n += 1) {
    await writeText(files, root + '/server.ts', `export default { fetch() { return new Response("${String(n)}"); } };`);
    const result = await actor.agent.slate({ op: 'commit', id: 'notes' });

    if (!result.ok) throw new Error(result.reason + ': ' + result.error);
    committed.push(v.parse(v.object({ id: v.string() }), result.value).id);
  }

  const Page = v.object({ versions: v.array(v.object({ id: v.string() })), next: v.nullable(v.string()) });

  const page = async (after?: string) => {
    const result = await actor.agent.slate(after === undefined ? { op: 'history', id: 'notes' } : { op: 'history', id: 'notes', after });

    if (!result.ok) throw new Error(result.reason + ': ' + result.error);

    return v.parse(Page, result.value);
  };

  const first = await page();
  expect(first.versions.length).toBeLessThan(committed.length);
  expect(first.next).not.toBeNull();
  const seen = first.versions.map((version) => version.id);

  for (let cursor = first.next; cursor !== null;) {
    const next = await page(cursor);
    seen.push(...next.versions.map((version) => version.id));
    cursor = next.next;
  }

  expect(seen).toEqual(committed);
  expect(await actor.agent.slate({ op: 'history', id: 'notes', after: 'no-such-version' })).toMatchObject({ ok: false, reason: 'missing' });
});

test('the agent slate operation commits, forks and restores its authored source', async () => {
  const actor = orchestratorHarness();
  const files = workspaceFiles(actor.agent);
  const root = '/slates/notes';
  await files.mkdir(root, { recursive: true });
  await writeText(files, root + '/package.json', JSON.stringify({ main: 'server.ts' }));
  await writeText(files, root + '/server.ts', 'export default { fetch() { return new Response("first"); } };');

  const record = (result: SlateSurfaceResult) => {
    if (!result.ok) throw new Error(result.reason + ': ' + result.error);

    return v.parse(v.object({ id: v.string() }), result.value);
  };

  const first = record(await actor.agent.slate({ op: 'commit', id: 'notes' }));
  await writeText(files, root + '/server.ts', 'export default { fetch() { return new Response("second"); } };');
  const second = record(await actor.agent.slate({ op: 'commit', id: 'notes' }));
  const history = await actor.agent.slate({ op: 'history', id: 'notes' });

  if (!history.ok) throw new Error(history.reason + ': ' + history.error);
  expect(v.parse(v.object({ versions: v.array(v.object({ id: v.string() })) }), history.value).versions)
    .toEqual([{ id: first.id }, { id: second.id }]);
  record(await actor.agent.slate({ op: 'restore', id: 'notes', version: first.id }));
  expect(await readText(files, root + '/server.ts')).toContain('"first"');
  const fork = record(await actor.agent.slate({ op: 'fork', version: second.id }));
  expect(await readText(files, '/slates/' + fork.id + '/server.ts')).toContain('"second"');
  expect(await actor.agent.slate({ op: 'restore', id: fork.id, version: first.id })).toMatchObject({ ok: false, reason: 'missing' });
  expect(await actor.agent.slate({ op: 'commit', id: '../outside' })).toMatchObject({ ok: false, reason: 'bad_input' });
});

test('a hired agent makes a slate where slates live, restores it with the main agent, and cannot share it', async () => {
  const parent = orchestratorHarness();

  const child = await hostedSubordinateHarness(parent, {
    name: 'builder', displayName: 'Builder', nameOrigin: 'user', roleId: 'task', mission: 'Build the widgets slate',
  });

  const dir = slateDirectory(new SlateId('widgets'));
  const own = child.actor.runtime.storage.vfs;

  const first = 'import { SlateObject } from "kinu:slate";\nexport class Slate extends SlateObject { async count() { return 3; } }\n';

  await own.mkdir(dir, { recursive: true });
  await writeText(own, `${dir}/package.json`, JSON.stringify({ main: 'server.ts', slate: { title: 'Widgets', runtime: 'worker' } }));
  await writeText(own, `${dir}/server.ts`, first);
  const asChild = await childCaller(parent.db, actorHomeName({ origin: 'agent', name: child.actor.handle.name, storageKey: child.actor.handle.storageKey }), 'builder');
  const committed = await parent.agent.slateAs(asChild, { op: 'commit', id: 'widgets' });

  if (!committed.ok) throw new Error(committed.reason + ': ' + committed.error);
  // The main agent changes the hire's slate as its own, and the hire puts its version back.
  await writeText(workspaceFiles(parent.agent), `${dir}/server.ts`, first.replace('3', '4'));
  const version = v.parse(v.object({ id: v.string() }), committed.value).id;
  expect(await parent.agent.slateAs(asChild, { op: 'restore', id: 'widgets', version })).toMatchObject({ ok: true });

  expect(await readText(workspaceFiles(parent.agent), `${dir}/server.ts`)).toBe(first);
  expect(await parent.agent.slateAs(asChild, { op: 'list' })).toMatchObject({
    ok: true, value: { slates: [expect.objectContaining({ id: 'widgets', title: 'Widgets' })], problems: [] },
  });
  expect(await parent.agent.slateAs(asChild, { op: 'share', id: 'widgets', visibility: 'public', approved: [], fork: false }))
    .toMatchObject({ ok: false, reason: 'denied' });
});

test('a hosted actor cannot restore source that its own filesystem authority cannot write', async () => {
  const parent = orchestratorHarness();
  const files = workspaceFiles(parent.agent);
  const dir = slateDirectory(new SlateId('root-app'));
  const path = `${dir}/server.ts`;
  await files.mkdir(dir, { recursive: true });
  await writeText(files, `${dir}/package.json`, JSON.stringify({ main: 'server.ts' }));
  await writeText(files, path, 'export default { fetch() { return new Response("first"); } };');
  const committed = await parent.agent.slate({ op: 'commit', id: 'root-app' });

  if (!committed.ok) throw new Error(committed.reason + ': ' + committed.error);
  const version = v.parse(v.object({ id: v.string() }), committed.value);
  const current = 'export default { fetch() { return new Response("second"); } };';
  await writeText(files, path, current);

  // A file in the shared slates the root kept to itself: a group the child is not in. Permission bits are VFS state a
  // host stamps as uid 0 over the stored rows; the next activation reads them from storage.
  const { root } = await createWorkspaceBundle(parent.db).privileged();
  root.chown(path, SESSION_UID, 0);
  const reopened = await reactivateOrchestratorHarness(parent.db);

  const child = await hostedSubordinateHarness(reopened, {
    name: 'slate-author', displayName: 'Slate author', nameOrigin: 'user',
    roleId: 'task', mission: 'Work inside the assigned private home',
  });

  // Same uid as the binding below, so an EACCES here and a denial there are one fact.
  await expect(writeText(child.actor.runtime.storage.vfs, path, 'blocked'))
    .rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
  const asChild = await childCaller(parent.db, actorHomeName({ origin: 'agent', name: child.actor.handle.name, storageKey: child.actor.handle.storageKey }), 'slate-author');
  const restored = await reopened.agent.slateAs(asChild, { op: 'restore', id: 'root-app', version: version.id });
  expect(await readText(workspaceFiles(reopened.agent), path)).toBe(current);
  expect(restored).toMatchObject({ ok: false, reason: 'denied' });
});

test('a slate calling as a hosted actor reaches its own files and role, never the root\'s', async () => {
  const parent = orchestratorHarness();
  const rootFiles = workspaceFiles(parent.agent);
  await rootFiles.mkdir('/slates/reader', { recursive: true });
  await writeText(rootFiles, '/slates/reader/package.json', JSON.stringify({ main: 'server.ts' }));
  await writeText(rootFiles, '/home/main/private.md', 'root only');

  const child = await hostedSubordinateHarness(parent, {
    name: 'reader-1', displayName: 'Reader', nameOrigin: 'user',
    roleId: 'task', mission: 'Read what you may',
  });

  const agentName = actorHomeName({ origin: 'agent', name: child.actor.handle.name, storageKey: child.actor.handle.storageKey });
  const childHome = agentHome(agentName);
  const asChild = await childCaller(parent.db, agentName, 'reader-1');

  const call = (caller: SlateCaller, member: string, args: JsonValue[]) => surface(parent.agent, caller, 'reader')(['workspace', member], args);

  expect(await call(asChild, 'writeFile', [`${childHome}/note.md`, 'mine'])).toMatchObject({ ok: true });
  expect(await readText(rootFiles, `${childHome}/note.md`)).toBe('mine');
  // Readable (homes are 0o755), but a write is the child's own EACCES.
  expect(await call(asChild, 'readFile', ['/home/main/private.md'])).toEqual({ ok: true, value: 'root only' });
  expect(await call(asChild, 'writeFile', ['/home/main/private.md', 'stolen'])).toMatchObject({ ok: false, reason: 'denied' });
  expect(await readText(rootFiles, '/home/main/private.md')).toBe('root only');
  // Under the root's own read-before-overwrite guard, which a blind write trips.
  expect(await call(ROOT_SLATE_CALLER, 'writeFile', ['/home/main/private.md', 'blind'])).toMatchObject({ ok: false, reason: 'bad_input' });
  expect(await call(ROOT_SLATE_CALLER, 'readFile', ['/home/main/private.md'])).toEqual({ ok: true, value: 'root only' });
  expect(await call(ROOT_SLATE_CALLER, 'writeFile', ['/home/main/private.md', 'root wrote'])).toMatchObject({ ok: true });
  expect(await readText(rootFiles, '/home/main/private.md')).toBe('root wrote');

  const scribe = {
    roles: { scribe: { description: 'Writes prose only.', instructions: 'Write.', tier: 'default', preset: 'ideate', allowedTools: ['memory'] } },
    tiers: { default: { model: DEFAULT_WORKERS_AI_MODEL_SPEC } },
  } as const;

  const changeRole = (role: string) => { child.actor.stores.config.setRoleSelection(role); };

  parent.agent.harnessInstallCatalog(scribe);
  changeRole('scribe');
  expect(await call(asChild, 'readFile', ['/home/main/private.md'])).toMatchObject({ ok: false, reason: 'denied' });

  // Each call resolves the actor's current role, so revocation and restoration bite immediately.
  changeRole('task');
  expect(await call(asChild, 'readFile', ['/home/main/private.md'])).toEqual({ ok: true, value: 'root wrote' });
  changeRole('scribe');
  expect(await call(asChild, 'readFile', ['/home/main/private.md'])).toMatchObject({ ok: false, reason: 'denied' });
});

test('a slate\'s file and memory calls use the caller\'s own plane and lose reach immediately with its role', async () => {
  const parent = orchestratorHarness();
  const files = workspaceFiles(parent.agent);
  await files.mkdir('/slates/native-reader', { recursive: true });
  await writeText(files, '/slates/native-reader/package.json', JSON.stringify({ main: 'server.ts' }));
  await writeText(files, '/home/main/slate-note.txt', 'root note');

  const child = await hostedSubordinateHarness(parent, {
    name: 'native-reader', displayName: 'Native reader', nameOrigin: 'user', roleId: 'task', mission: 'Read',
  });

  const caller = await childCaller(parent.db, actorHomeName({ origin: 'agent', name: child.actor.handle.name, storageKey: child.actor.handle.storageKey }), 'native-reader');
  const read = async () => JSON.stringify(await surface(parent.agent, caller, 'native-reader')(['readFile'], ['/home/main/slate-note.txt']));
  const memory = (asCaller: SlateCaller, member: string, args: JsonValue[]) => surface(parent.agent, asCaller, 'native-reader')(['memory', member], args);

  expect(await read()).toContain('root note');
  expect(await memory(caller, 'remember', ['slate-key', 'child fact'])).toMatchObject({ ok: true, value: { key: 'slate-key' } });
  expect(await memory(ROOT_SLATE_CALLER, 'recall', ['slate-key'])).toMatchObject({ ok: true, value: null });
  parent.agent.harnessInstallCatalog({
    roles: { scribe: { description: 'Only memory.', instructions: 'Write.', tier: 'default', preset: 'ideate', allowedTools: ['memory'] } },
    tiers: { default: { model: DEFAULT_WORKERS_AI_MODEL_SPEC } },
  });
  child.actor.stores.config.setRoleSelection('scribe');
  expect(await read()).toContain('"reason":"denied"');
  expect(await memory(caller, 'recall', ['slate-key'])).toMatchObject({ ok: true, value: { key: 'slate-key', value: 'child fact' } });
  child.actor.stores.config.setRoleSelection('task');
  expect(await read()).toContain('root note');
});

test("a class's browser member is authorized at the host by its caller's role as it is now, and only a browser member is", async () => {
  const parent = orchestratorHarness();
  const files = workspaceFiles(parent.agent);
  await files.mkdir('/slates/driver', { recursive: true });
  await writeText(files, '/slates/driver/package.json', JSON.stringify({ main: 'server.ts' }));

  const child = await hostedSubordinateHarness(parent, {
    name: 'driver', displayName: 'Driver', nameOrigin: 'user', roleId: 'task', mission: 'Drive',
  });

  const caller = await childCaller(parent.db, actorHomeName({ origin: 'agent', name: child.actor.handle.name, storageKey: child.actor.handle.storageKey }), 'driver');

  const authorize = (asCaller: SlateCaller, path: string[]) =>
    parent.agent.slateCallAs(asCaller, 'driver', 'workspace', { path, args: [], invocation: null, authorize: true });

  expect(await authorize(caller, ['web', 'connectBrowser'])).toEqual({ ok: true, value: null });
  parent.agent.harnessInstallCatalog({
    roles: { scribe: { description: 'Only memory.', instructions: 'Write.', tier: 'default', preset: 'ideate', allowedTools: ['memory'] } },
    tiers: { default: { model: DEFAULT_WORKERS_AI_MODEL_SPEC } },
  });
  // A role that has since lost the web has the class's next connect refused before it dials.
  child.actor.stores.config.setRoleSelection('scribe');
  expect(await authorize(caller, ['web', 'connectBrowser'])).toMatchObject({ ok: false, reason: 'denied' });
  // What runs at the host is never only authorized: its answer would be the class's to make up.
  expect(await authorize(ROOT_SLATE_CALLER, ['readFile'])).toMatchObject({ ok: false, reason: 'bad_input' });
});

test('a slate never reaches what only the agent does', async () => {
  const actor = orchestratorHarness();
  const files = workspaceFiles(actor.agent);
  await files.mkdir('/slates/limited', { recursive: true });
  await writeText(files, '/slates/limited/package.json', JSON.stringify({ main: 'server.ts' }));
  const call = (path: string[], args: JsonValue[] = []) => surface(actor.agent, ROOT_SLATE_CALLER, 'limited')(path, args);

  for (const path of [['agent', 'hire'], ['workspace', 'createTool'], ['workspace', 'slate'], ['report', 'send'], ['tasks', 'switchRole']]) {
    expect(await call(path, [{ mission: 'should not run' }]), path.join('.')).toMatchObject({ ok: false, reason: 'denied' });
  }

  // A native tool is its own namespace on the surface, never a member of `tools`; `$` members are the agent's lifecycle.
  expect(await call(['tools', 'agents'], [{ op: 'hire', role: 'task', mission: 'should not run' }]))
    .toMatchObject({ ok: true, value: { success: false, reason: 'missing' } });
  expect(await call(['slates', 'limited', '$share'])).toMatchObject({ ok: false });
  expect(await call(['tasks', 'list'])).toMatchObject({ ok: true });
  expect(await call(['tasks', 'add'], [false])).toMatchObject({ ok: false, reason: 'bad_input' });
  expect(await call(['memory', 'remember'], ['key', 'value', false])).toMatchObject({ ok: false, reason: 'bad_input' });
});

test('the owner\'s own slate hires a helper and lists it as the owner does; a hired agent\'s slate does neither', async () => {
  const parent = gatewayWorkspace(stubAiBinding((run) => chatCompletion(run, 'Counted 3 files.')));
  const files = workspaceFiles(parent.agent);
  await files.mkdir('/slates/board', { recursive: true });
  await writeText(files, '/slates/board/package.json', JSON.stringify({ main: 'server.ts' }));
  const asOwner = surface(parent.agent, ROOT_SLATE_CALLER, 'board');

  // As a program calls it: role, mission, then its options.
  expect(await asOwner(['agents', 'hire'], ['task', 'Count the files in /home', { name: 'counter' }])).toMatchObject({ ok: true });
  expect((await parent.agent.listSubordinates()).map((entry) => entry.name)).toContain('counter');

  const listed = await asOwner(['agents', 'list']);

  expect(listed).toMatchObject({ ok: true });
  expect(JSON.stringify(listed.ok ? listed.value : null)).toContain('counter');

  // The helper's own slate reaches no helpers: refused where the host routes it, before any actor is asked.
  const child = await hostedSubordinateHarness(parent, { name: 'reader', displayName: 'Reader', nameOrigin: 'user', roleId: 'task', mission: 'Read' });
  const asChild = await childCaller(parent.db, actorHomeName({ origin: 'agent', storageKey: child.actor.handle.storageKey }), 'reader');
  const own = child.actor.runtime.storage.vfs;
  await own.mkdir('/slates/own', { recursive: true });
  await writeText(own, '/slates/own/package.json', JSON.stringify({ main: 'server.ts' }));

  for (const path of [['agents', 'list'], ['agents', 'hire']]) {
    expect(await surface(parent.agent, asChild, 'own')(path, ['task', 'should not run']), path.join('.')).toMatchObject({ ok: false, reason: 'denied' });
  }
});

test('a slate\'s file write in Plan is refused before it lands', async () => {
  const actor = orchestratorHarness();
  const files = workspaceFiles(actor.agent);
  await files.mkdir('/slates/tool-gate', { recursive: true });
  await writeText(files, '/slates/tool-gate/package.json', JSON.stringify({ main: 'server.ts' }));
  const marker = '/home/main/slate-tool-approved';
  const planning: SlateCaller = { ...ROOT_SLATE_CALLER, workMode: 'plan' };

  expect(await surface(actor.agent, planning, 'tool-gate')(['writeFile'], [marker, 'must not land'])).toMatchObject({ ok: false, reason: 'denied' });
  expect(await files.stat(marker)).toBeNull();
});

test('workspace read models are the root\'s own reads; a hosted actor holds none of them', async () => {
  const parent = orchestratorHarness();
  const rootFiles = workspaceFiles(parent.agent);
  await rootFiles.mkdir('/slates/status', { recursive: true });
  await writeText(rootFiles, '/slates/status/package.json', JSON.stringify({ main: 'server.ts' }));

  const child = await hostedSubordinateHarness(parent, {
    name: 'peeker', displayName: 'Peeker', nameOrigin: 'user', roleId: 'task', mission: 'Peek',
  });

  const call = (caller: SlateCaller) => surface(parent.agent, caller, 'status')(['reads', 'getExecutors']);
  expect(await call(ROOT_SLATE_CALLER)).toMatchObject({ ok: true, value: expect.any(Array) });
  expect(await call(await childCaller(parent.db, actorHomeName({ origin: 'agent', name: child.actor.handle.name, storageKey: child.actor.handle.storageKey }), 'peeker'))).toMatchObject({ ok: false, reason: 'denied' });
});

test('source capture does not retain a previous caller supplementary group', async () => {
  const parent = orchestratorHarness();
  const files = workspaceFiles(parent.agent);
  await files.mkdir('/slates/group-source', { recursive: true });
  await writeText(files, '/slates/group-source/package.json', JSON.stringify({ main: 'server.ts' }));
  await writeText(files, '/slates/group-source/server.ts', 'export default { fetch() { return new Response("group source"); } };');

  // Permission bits are VFS state a host stamps as uid 0 over the stored rows, never agent-chosen;
  // the next activation reads them from storage.
  // A chmod in /slates gives an entry back the directory's group, so the group is stamped last.
  const { root } = await createWorkspaceBundle(parent.db).privileged();
  root.chmod('/slates/group-source/server.ts', 0o640);
  root.chown('/slates/group-source/server.ts', 0, 3000);
  const reopened = await reactivateOrchestratorHarness(parent.db);
  const grouped: SlateCaller = { workMode: 'build', path: [], cred: { uid: 1000, gid: 1000, groups: [3000], umask: 0o022 } };
  const ungrouped: SlateCaller = { workMode: 'build', path: [], cred: { uid: 1000, gid: 1000, groups: [], umask: 0o022 } };
  expect(await reopened.agent.slateAs(grouped, { op: 'commit', id: 'group-source' })).toMatchObject({ ok: true });
  expect(await reopened.agent.slateAs(ungrouped, { op: 'commit', id: 'group-source' })).toMatchObject({ ok: false, reason: 'denied' });
});

test('a command the approval ladder stops answers every surface with its class, and never runs', async () => {
  const actor = orchestratorHarness();
  const files = workspaceFiles(actor.agent);
  await files.mkdir('/slates/shell', { recursive: true });
  await writeText(files, '/slates/shell/package.json', JSON.stringify({ main: 'server.ts' }));
  const marker = '/home/main/never-written.txt';
  const gated = 'npm publish --dry-run && printf ran > ' + marker;
  const binding = (command = gated) => surface(actor.agent, ROOT_SLATE_CALLER, 'shell')(['exec'], [command]);

  await actor.agent.setShellApprovalMode('deny_all');
  expect(await binding()).toMatchObject({ ok: false, reason: 'denied' });
  expect(await actor.agent.executeInExecutor('workspace', gated)).toMatchObject({ refusal: { reason: 'denied' } });
  expect(await files.stat(marker)).toBeNull();

  await actor.agent.setShellApprovalMode('strict');
  const parked = await binding();
  expect(parked).toMatchObject({ ok: false, reason: 'unavailable' });
  expect(await actor.agent.executeInExecutor('workspace', gated)).toMatchObject({ refusal: { reason: 'unavailable' } });
  expect(await files.stat(marker)).toBeNull();
  const queued = await actor.agent.listDeferredApprovals();
  expect(queued).toMatchObject([{ status: 'queued', command: gated, executor: 'workspace' }]);
  await actor.agent.decideDeferredApprovals(queued.map((action) => action.id), 'denied');
  expect(await binding()).toMatchObject({ ok: false, reason: 'denied' });

  await actor.agent.setShellApprovalMode('allow_all');
  const incident = JSON.stringify({ reason: 'denied', error: 'historical incident' });
  await writeText(files, '/home/main/incident.json', incident);
  expect(await binding('cat /home/main/incident.json')).toEqual({ ok: true, value: incident });
  expect(await actor.agent.executeInExecutor('workspace', 'cat /home/main/incident.json'))
    .toEqual({ stdout: incident, stderr: '', exitCode: 0 });
  expect(await actor.agent.executeInExecutor('workspace', 'echo failed; echo detail >&2; exit 1'))
    .toMatchObject({ exitCode: 1, refusal: { reason: 'io', error: expect.stringContaining('detail') } });
  const failed = await binding('printf ran > ' + marker + '; exit 1');
  expect(failed).toMatchObject({ ok: false, reason: 'io' });
  expect(await readText(files, marker)).toBe('ran');
});

test('the reserved __storage channel answers the slate\'s own durable KV, per slate and within bounds', async () => {
  const actor = orchestratorHarness();
  const files = workspaceFiles(actor.agent);
  await files.mkdir('/slates/self-store', { recursive: true });
  await writeText(files, '/slates/self-store/package.json', JSON.stringify({ main: 'server.ts' }));
  await files.mkdir('/slates/peer-store', { recursive: true });
  await writeText(files, '/slates/peer-store/package.json', JSON.stringify({ main: 'server.ts' }));

  const storage = (id: string, member: string, args: JsonValue[] = []) =>
    actor.agent.slateCallAs(ROOT_SLATE_CALLER, id, '__storage', { path: [member], args, invocation: null });

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

  expect(await actor.agent.slateCallAs(planning, 'self-store', '__storage', { path: ['get'], args: ['k'], invocation: null }))
    .toMatchObject({ ok: true });
  expect(await actor.agent.slateCallAs(planning, 'self-store', '__storage', { path: ['put'], args: ['k', 1], invocation: null }))
    .toMatchObject({ ok: false, reason: 'denied' });
});

test('a slate\'s agent.send delivers one inbox signal naming the slate', async () => {
  const actor = orchestratorHarness();
  const files = workspaceFiles(actor.agent);
  await files.mkdir('/slates/pager', { recursive: true });
  await writeText(files, '/slates/pager/package.json', JSON.stringify({ main: 'server.ts' }));

  // The observable effect of `send` is the turn the inbox admits; the model is scripted so the turn commits.
  actor.agent.modelFactory = () => scriptedTurnModel({ doGenerate: () => ({
    content: [{ type: 'text', text: 'paged' }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
  }) });

  const call = (args: JsonValue[]) => surface(actor.agent, ROOT_SLATE_CALLER, 'pager')(['agent', 'send'], args);

  expect(await call([{ text: 'done', data: { count: 2 } }])).toEqual({ ok: true, value: { outcome: 'queued' } });
  await joinHarnessFibers();
  const admitted = (await storedChat(actor)).filter((message) => message.role === 'user');
  expect(admitted).toHaveLength(1);
  expect(admitted[0]).toMatchObject({
    parts: [{ type: 'text', text: 'Slate pager: done' }],
    metadata: expect.objectContaining({ slate: 'pager', data: { count: 2 }, kinuEvent: 'slate' }),
  });

  const child = await hostedSubordinateHarness(actor, {
    name: 'pager-1', displayName: 'Pager', nameOrigin: 'user', roleId: 'task', mission: 'Page',
  });

  const asChild = await childCaller(actor.db, actorHomeName({ origin: 'agent', name: child.actor.handle.name, storageKey: child.actor.handle.storageKey }), 'pager-1');

  expect(await surface(actor.agent, asChild, 'pager')(['agent', 'send'], [{ text: 'x' }]))
    .toMatchObject({ ok: false, reason: 'denied', error: expect.stringContaining('no inbox of its own') });
});

test('a slate\'s ai.stream hands over the answer as the model writes it, and files its spend once it is read through', async () => {
  const gateway = stubAiBinding((run) => wordByWordCompletion(run, ['Typ', 'ing ', 'live']));
  const actor = orchestratorHarness(undefined, { aiGateway: gateway });
  actor.agent.harnessInstallCatalog({ tiers: { default: { model: GATEWAY_MODEL } }, availableModels: [GATEWAY_MODEL] });
  const files = workspaceFiles(actor.agent);
  await files.mkdir('/slates/typist', { recursive: true });
  await writeText(files, '/slates/typist/package.json', JSON.stringify({ main: 'server.ts' }));

  const answer = await surface(actor.agent, ROOT_SLATE_CALLER, 'typist')(['ai', 'stream'], [{ prompt: 'say it', system: 'be brief' }]);

  if (!answer.ok || !(answer.value instanceof ReadableStream)) throw new Error(`ai.stream answered no stream: ${JSON.stringify(answer)}`);
  const reader = answer.value.getReader();
  const decoder = new TextDecoder();
  const pieces: string[] = [];

  for (let read = await reader.read(); !read.done; read = await reader.read()) pieces.push(decoder.decode(read.value));

  // The text arrives a piece at a time, in order, and whole.
  expect(pieces.join('')).toBe('Typing live');
  expect(pieces.length).toBeGreaterThan(1);
  expect(JSON.stringify(gateway.runs[0]?.query)).toContain('be brief');

  const ledger = new RunEventRecorder(sqlOver(actor.db), openWorkspaceMainActor(sqlOver(actor.db)));

  expect(ledger.spendByProducer().get('slate')).toMatchObject({ calls: 1, callsWithoutUsage: 0 });
});

test('a slate\'s ai.run runs one model call under the caller authority, as a slate spend row', async () => {
  const gateway = stubAiBinding((run) => chatCompletion(run, 'model answer'));
  const actor = orchestratorHarness(undefined, { aiGateway: gateway });
  actor.agent.harnessInstallCatalog({ tiers: { default: { model: GATEWAY_MODEL } }, availableModels: [GATEWAY_MODEL] });
  const files = workspaceFiles(actor.agent);
  await files.mkdir('/slates/thinker', { recursive: true });
  await writeText(files, '/slates/thinker/package.json', JSON.stringify({ main: 'server.ts' }));
  const call = (args: JsonValue[]) => surface(actor.agent, ROOT_SLATE_CALLER, 'thinker')(['ai', 'run'], args);

  const answer = await call([{ prompt: 'summarize', system: 'be brief' }]);

  expect(answer).toMatchObject({ ok: true, value: { text: 'model answer', model: GATEWAY_MODEL, tier: 'default', usage: { input: 1, output: 1 } } });
  // One call reached the platform, carrying the slate's prompt and system.
  expect(gateway.runs).toHaveLength(1);
  expect(JSON.stringify(gateway.runs[0]?.query)).toContain('summarize');
  expect(JSON.stringify(gateway.runs[0]?.query)).toContain('be brief');

  const ledger = new RunEventRecorder(sqlOver(actor.db), openWorkspaceMainActor(sqlOver(actor.db)));
  const operations = ledger.read(WORKSPACE_RUN_ID).flatMap((event) => (event.type === 'model_operation' ? [event] : []));

  expect(operations.map((row) => row.source)).toEqual(['slate', 'slate']);
  expect(operations.map((row) => row.phase)).toEqual(['start', 'end']);

  expect(await call([{ prompt: 'p', tier: 'imaginary' }])).toMatchObject({ ok: false, reason: 'bad_input' });
  expect(gateway.runs).toHaveLength(1);
  // The call reached the spend total as the slate's, and the refused one reached nothing.
  expect(ledger.spendByProducer().get('slate')).toMatchObject({ calls: 1, callsWithoutUsage: 0, usage: { input: 1, output: 1 } });
});
