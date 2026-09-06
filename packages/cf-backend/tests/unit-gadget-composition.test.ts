import { expect, test } from 'bun:test';
import { orchestratorHarness } from './helpers/actor-harness';
import { createTestUserDO, provisionTestWorkspace, testOwner } from './helpers/user-do';
import { resetRecordedMcp, seedMcpTools } from './helpers/agents-sdk';

test('an mcp binding names the connection id and dispatches exactly as the agent\'s own tool would', async () => {
  resetRecordedMcp();
  const ownerUserId = '0123456789abcdef0123456789abcdef';
  const workspace = 'gadget-mcp';
  const user = createTestUserDO({ durableObjectId: ownerUserId });
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
  await vfs.mkdir('gadgets/issues', { recursive: true });
  const bind = (server: string) => vfs.writeFile('gadgets/issues/gadget.json', JSON.stringify({
    v: 1, title: 'Issues', bindings: { GITHUB: { kind: 'mcp', server } },
  }));
  const call = (tool: string) => actor.agent.gadgetBindingCall('issues', 'GITHUB', { member: tool, args: [{}], depth: 0 });
  try {
    // The binding names the connection ID, never the display name: a binding
    // written against the name reaches no server.
    await bind('github');
    const byName = await call('read_issue');
    expect(byName.ok).toBe(false);
    if (byName.ok) return;
    expect(byName.error).toContain('Unknown MCP server');

    await bind('connection-id');
    expect(await call('read_issue')).toEqual({ ok: true, value: { content: [] } });
    // The owner's own allowlist on the connection answers for the gadget as it
    // answers for the agent: no second gate, and no second allowlist.
    const withheld = await call('create_issue');
    expect(withheld.ok).toBe(false);
    if (withheld.ok) return;
    expect(withheld.error).toContain('allowed_tools');

    await user.userDO.userMcp_update(owner, 'connection-id', { name: 'renamed-github' });
    expect(await call('read_issue')).toEqual({ ok: true, value: { content: [] } });
  } finally {
    await user.joinFibers();
    user.close();
  }
});

test('a lazy boot after activation failure still broadcasts gadget edits', async () => {
  const actor = orchestratorHarness();
  const broadcasts: string[] = [];
  Reflect.set(actor.agent, 'broadcast', (payload: string) => { broadcasts.push(payload); });
  actor.db.exec('CREATE TABLE inodes (blocked INTEGER)');
  await expect(actor.agent.listGadgets()).rejects.toThrow();
  actor.db.exec('DROP TABLE inodes');
  expect(await actor.agent.listGadgets()).toEqual({ gadgets: [], problems: [] });
  const vfs = actor.agent.observeRuntime().storage.vfs;
  await vfs.mkdir('gadgets/recovered', { recursive: true });
  broadcasts.length = 0;
  await vfs.writeFile('gadgets/recovered/client.js', 'document.body.textContent = "ready";');
  expect(broadcasts).toEqual([JSON.stringify({ type: 'gadgets_changed', slugs: ['recovered'] })]);
  await actor.agent.listGadgets();
  broadcasts.length = 0;
  await vfs.writeFile('gadgets/recovered/client.js', 'document.body.textContent = "updated";');
  expect(broadcasts).toEqual([JSON.stringify({ type: 'gadgets_changed', slugs: ['recovered'] })]);
});

test('the initial snapshot includes published gadget summaries', async () => {
  const actor = orchestratorHarness();
  const vfs = actor.agent.observeRuntime().storage.vfs;
  await vfs.mkdir('gadgets/overview', { recursive: true });
  await vfs.writeFile('gadgets/overview/gadget.json', JSON.stringify({ v: 1, title: 'Overview' }));
  await vfs.writeFile('gadgets/overview/server.js', 'export class Gadget {}');
  await vfs.writeFile('gadgets/overview/client.js', 'document.body.textContent = "overview";');
  const listed = await actor.agent.listGadgets();
  expect(listed.gadgets.map((gadget) => gadget.slug)).toEqual(['overview']);
  expect(await actor.agent.getWorkspaceSnapshot()).toHaveProperty('gadgets', listed.gadgets);
});
