import { expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  BlueprintBundleSchema, BlueprintForkSchema, BlueprintInspectionSchema, PublishedBlueprintSchema, SlateShareRecordSchema, type AgentRuntime, type SlateAnswer,
} from '@kinu.run/core';
import { orchestratorHarness, workspaceFiles } from './helpers/actor-harness';
import { createTestUserDO, provisionTestWorkspace, testOwner } from './helpers/user-do';
import { resetRecordedMcp } from './helpers/agents-sdk';
import { ROOT_SLATE_CALLER, type SlateCaller } from '../src/slates/bindings';

function answered<Schema extends v.GenericSchema>(result: SlateAnswer<unknown>, schema: Schema): v.InferOutput<Schema> {
  if (!result.ok) throw new Error(result.reason + ': ' + result.error);

  return v.parse(schema, result.value);
}

async function authorIssuesSlate(files: AgentRuntime['storage']['vfs'], extra: Record<string, string> = {}) {
  const root = '/slates/issues';
  await files.mkdir(root + '/src', { recursive: true });
  await files.mkdir(root + '/scratch', { recursive: true });
  await files.writeFile(root + '/package.json', JSON.stringify({
    name: 'issues', description: 'Triage the open issues', main: 'src/server.ts',
    slate: { title: 'Issue triage', bindings: {
      GITHUB: { kind: 'mcp', server: 'connection-id', tools: ['read_issue'] },
      FILES: { kind: 'namespace', namespace: 'workspace', members: ['readFile'] },
      NOTES: { kind: 'memory', members: ['recall'] },
      PEER: { kind: 'app', id: 'other' },
    } },
  }));
  await files.writeFile(root + '/src/server.ts', 'export default { fetch() { return new Response("issues"); } };');
  await files.writeFile(root + '/scratch/notes.txt', 'owner scratch, not for the blueprint');

  for (const [path, content] of Object.entries(extra)) await files.writeFile(root + '/' + path, content);
}

test('a blueprint admits with every requirement unsatisfied and carries nothing of the owner\'s (S8)', async () => {
  resetRecordedMcp();
  const ownerUserId = '0123456789abcdef0123456789abcdef';
  const user = createTestUserDO({ durableObjectId: ownerUserId });
  const forkerUser = createTestUserDO({ durableObjectId: 'fedcba9876543210fedcba9876543210' });

  try {
    const capability = await provisionTestWorkspace(user, 'issues-owner');
    const owner = orchestratorHarness(undefined, { userDO: user.userDO, workspace: 'issues-owner', ownerUserId });
    await owner.agent.installWorkspaceCapability(capability);
    const caller = await testOwner();
    // MCP header, provider key and vault secret: none is in the slate tree, and none may reach the forker.
    const mcpHeader = 'Bearer owner-mcp-header-' + 'a1b2c3d4e5f6';
    await user.userDO.userMcp_list(caller);
    user.sql.exec(`INSERT INTO user_mcp_servers (id, name, server_url, transport, headers, allowed_tools, created_at, updated_at)
      VALUES ('connection-id', 'github', 'https://github.example/sse', 'auto', ?, NULL, 0, 0)`, JSON.stringify({ authorization: mcpHeader }));
    const providerKey = ['sk-ant-', 'owner-provider-key-0123456789'].join('');
    await user.userDO.setCredential(caller, 'anthropic', { kind: 'bearer', token: providerKey });
    const vaultSecret = 'owner-vault-secret-' + '9f8e7d6c';
    const vault = await user.userDO.putEgressSecret(caller, { id: 'vault-1', label: 'Stripe', host: 'api.stripe.com', secret: vaultSecret });

    const files = workspaceFiles(owner.agent);
    await authorIssuesSlate(files);
    const committed = answered(await owner.agent.slate({ op: 'commit', id: 'issues' }), v.object({ id: v.string() }));

    const inspection = answered(await owner.agent.slate({ op: 'inspect', id: 'issues', version: committed.id, include: ['src'] }), BlueprintInspectionSchema);
    expect(inspection.entries.filter((entry) => entry.included).map((entry) => entry.path)).toEqual(['package.json', 'src', 'src/server.ts']);
    expect(inspection.bindings.filter((binding) => binding.credentialed).map((binding) => binding.name)).toEqual(['GITHUB', 'FILES', 'NOTES']);
    expect(inspection.warnings).toEqual([]);

    const published = answered(await owner.agent.slate({ op: 'publish', id: 'issues', version: committed.id, include: ['src'] }), PublishedBlueprintSchema);
    expect(published.share).toMatchObject({ slate: 'issues', kind: 'blueprint', included: ['package.json', 'src'], revokedAt: null });
    expect(answered(await owner.agent.slate({ op: 'shares' }), v.array(SlateShareRecordSchema)).map((share) => share.id)).toEqual([published.share.id]);

    const bundle = answered(await owner.agent.blueprintBundle(published.share.id), BlueprintBundleSchema);
    expect(Object.keys(bundle).sort()).toEqual(['blobs', 'skeleton', 'tree']);
    const carried = JSON.stringify(bundle) + Object.values(bundle.blobs).map((blob) => atob(blob)).join('\n');

    for (const secret of [mcpHeader, providerKey, vaultSecret, vault.placeholder, capability, 'issues-owner', 'connection-id-header']) {
      expect(carried).not.toContain(secret);
    }

    expect(carried).not.toContain('scratch');
    const reading = await owner.agent.readBlueprint(published.share.id);

    if (!reading.ok) throw new Error(reading.error);
    expect(reading.value.view.title).toBe('Issue triage');
    expect(reading.value.view.entries.map((entry) => entry.path)).toEqual(['package.json', 'src', 'src/server.ts']);

    const forker = orchestratorHarness(undefined, { userDO: forkerUser.userDO, workspace: 'issues-fork', ownerUserId: 'fedcba9876543210fedcba9876543210' });
    await forker.agent.installWorkspaceCapability(await provisionTestWorkspace(forkerUser, 'issues-fork'));
    const fork = answered(await forker.agent.admitBlueprint(bundle), BlueprintForkSchema);
    expect(fork.workspace).toBe('issues-fork');
    expect(fork.requirements).toEqual([
      { name: 'files', facet: 'kinu.slate.namespace' },
      { name: 'github', facet: 'kinu.slate.mcp' },
      { name: 'notes', facet: 'kinu.slate.memory' },
      { name: 'peer', facet: 'kinu.slate.app' },
    ]);
    expect(fork.bindings.map((binding) => [binding.name, binding.kind, binding.credentialed])).toEqual([
      ['GITHUB', 'mcp', true], ['FILES', 'namespace', true], ['NOTES', 'memory', true], ['PEER', 'app', false],
    ]);
    const forkerFiles = workspaceFiles(forker.agent);
    const landed = '/slates/' + fork.slate;
    expect(await forkerFiles.readFile(landed + '/src/server.ts', { encoding: 'utf8' })).toContain('"issues"');
    expect(await forkerFiles.stat(landed + '/scratch')).toBeNull();
    const admittedTree = JSON.stringify(await forkerFiles.readFile(landed + '/package.json', { encoding: 'utf8' })) + await forkerFiles.readFile(landed + '/src/server.ts', { encoding: 'utf8' });

    for (const secret of [mcpHeader, providerKey, vaultSecret, vault.placeholder]) expect(admittedTree).not.toContain(secret);

    expect((await forker.agent.listSlates()).slates).toEqual([{ id: fork.slate, title: 'Issue triage', bindings: ['GITHUB', 'FILES', 'NOTES', 'PEER'], port: undefined }]);

    // Bindings resolve in the forker's workspace, where the owner's MCP connection is absent.
    expect(await forker.agent.slateBindingCallAs(ROOT_SLATE_CALLER, fork.slate, 'GITHUB', { member: 'read_issue', args: [{}], invocation: null }))
      .toMatchObject({ ok: false, reason: 'missing' });

    // S6 for blueprints.
    const revoked = answered(await owner.agent.slate({ op: 'unshare', share: published.share.id }), SlateShareRecordSchema);
    expect(revoked.revokedAt).not.toBeNull();
    expect(await owner.agent.readBlueprint(published.share.id)).toMatchObject({ ok: false, reason: 'denied', error: expect.stringContaining('no longer shared') });
    expect(await owner.agent.blueprintBundle(published.share.id)).toMatchObject({ ok: false, reason: 'denied' });
    expect(await owner.agent.readBlueprint('never-minted')).toMatchObject({ ok: false, reason: 'missing' });
  } finally {
    user.close();
    forkerUser.close();
    resetRecordedMcp();
  }
});

test('the export warns about secret-shaped text and stays silent on a clean tree', async () => {
  const owner = orchestratorHarness();
  const files = workspaceFiles(owner.agent);
  const pasted = ['AKIA', 'QRSTUVWXYZABCDEF'].join('');
  await authorIssuesSlate(files, { 'src/config.ts': `export const AWS = "${pasted}";\n` });
  const committed = answered(await owner.agent.slate({ op: 'commit', id: 'issues' }), v.object({ id: v.string() }));

  const flagged = answered(await owner.agent.slate({ op: 'inspect', id: 'issues', version: committed.id }), BlueprintInspectionSchema);
  expect(flagged.warnings).toEqual([{ path: 'src/config.ts', line: 1, pattern: 'aws-access-key', message: 'AWS access key id' }]);
  expect(JSON.stringify(flagged)).not.toContain(pasted);

  await files.writeFile('/slates/issues/src/config.ts', 'export const AWS = process.env.AWS_KEY;\n');
  const clean = answered(await owner.agent.slate({ op: 'commit', id: 'issues' }), v.object({ id: v.string() }));
  expect(answered(await owner.agent.slate({ op: 'inspect', id: 'issues', version: clean.id }), BlueprintInspectionSchema).warnings).toEqual([]);
  // Published bytes are scanned: the warning follows the version, not the working tree.
  expect(answered(await owner.agent.slate({ op: 'publish', id: 'issues', version: committed.id }), PublishedBlueprintSchema).inspection.warnings.length).toBe(1);
  expect(answered(await owner.agent.slate({ op: 'inspect', id: 'issues', version: committed.id, include: ['scratch'] }), BlueprintInspectionSchema).warnings).toEqual([]);
});

test('a hosted actor cannot publish, and plan mode may inspect but not publish', async () => {
  const owner = orchestratorHarness();
  await authorIssuesSlate(workspaceFiles(owner.agent));
  const committed = answered(await owner.agent.slate({ op: 'commit', id: 'issues' }), v.object({ id: v.string() }));
  const root: SlateCaller = { ...ROOT_SLATE_CALLER, workMode: 'plan' };
  expect(await owner.agent.slateAs(root, { op: 'inspect', id: 'issues', version: committed.id })).toMatchObject({ ok: true });
  expect(await owner.agent.slateAs(root, { op: 'publish', id: 'issues', version: committed.id })).toMatchObject({ ok: false, reason: 'denied' });
  const hosted: SlateCaller = { ...ROOT_SLATE_CALLER, path: [{ name: 'helper' }] };
  expect(await owner.agent.slateAs(hosted, { op: 'publish', id: 'issues', version: committed.id })).toMatchObject({ ok: false, reason: 'denied' });
  expect(await owner.agent.slateAs(hosted, { op: 'shares' })).toMatchObject({ ok: false, reason: 'denied' });
});

test('naming users on a blueprint records them with the owner and projects the row to each user', async () => {
  const ownerUserId = '0123456789abcdef0123456789abcdef';
  const user = createTestUserDO({ durableObjectId: ownerUserId });
  const recipient = createTestUserDO({ durableObjectId: 'fedcba9876543210fedcba9876543210' });

  try {
    const capability = await provisionTestWorkspace(user, 'issues-owner');
    const owner = orchestratorHarness(undefined, { userDO: user.userDO, workspace: 'issues-owner', ownerUserId });
    await owner.agent.installWorkspaceCapability(capability);
    await authorIssuesSlate(workspaceFiles(owner.agent));
    const committed = answered(await owner.agent.slate({ op: 'commit', id: 'issues' }), v.object({ id: v.string() }));
    const published = answered(await owner.agent.slate({ op: 'publish', id: 'issues', version: committed.id }), PublishedBlueprintSchema);

    const shared = answered(await owner.agent.shareBlueprintWith(published.share.id, [{ userId: 'fedcba9876543210fedcba9876543210', email: 'pat@example.test' }]), SlateShareRecordSchema);
    expect(shared.users).toEqual(['pat@example.test']);
    const caller = await testOwner();
    await recipient.userDO.sharesReceived_add(caller, { ownerUserId, ownerEmail: 'owner@example.test', workspace: 'issues-owner', shareId: published.share.id, title: 'Issue triage' });
    await recipient.userDO.sharesReceived_add(caller, { ownerUserId, ownerEmail: 'owner@example.test', workspace: 'issues-owner', shareId: published.share.id, title: 'Issue triage, renamed' });
    expect(await recipient.userDO.sharesReceived_list(caller)).toEqual([
      { ownerUserId, ownerEmail: 'owner@example.test', workspace: 'issues-owner', shareId: published.share.id, title: 'Issue triage, renamed', createdAt: expect.any(Number) },
    ]);
    await expect(recipient.userDO.sharesReceived_list({ workspaceToken: 'not-an-owner' })).rejects.toThrow();
    answered(await owner.agent.slate({ op: 'unshare', share: published.share.id }), SlateShareRecordSchema);
    expect(await owner.agent.shareBlueprintWith(published.share.id, [{ userId: 'x', email: 'x@example.test' }])).toMatchObject({ ok: false, reason: 'denied' });
    expect(answered(await owner.agent.slate({ op: 'shares' }), v.array(SlateShareRecordSchema))[0]?.users).toEqual(['pat@example.test']);
  } finally {
    user.close();
    recipient.close();
  }
});
