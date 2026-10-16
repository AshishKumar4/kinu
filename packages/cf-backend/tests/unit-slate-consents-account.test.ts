import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as v from 'valibot';
import type { JsonValue } from '@kinu.run/core';
import type { SlateConsent } from '@kinu.run/core/slates';
import { createTestUserDO, provisionTestWorkspace, testOwner, type TestUserDO } from './helpers/user-do';
import { recordedMcpToolCalls, resetRecordedMcp, seedConfiguredMcpServer, seedMcpAnswer, seedMcpTools } from './helpers/agents-sdk';

/** What an approval is named by in an ask. */
const AskId = v.object({ id: v.string() });

const users: TestUserDO[] = [];

afterEach(() => {
  for (const user of users) user.close();
  users.length = 0;
  resetRecordedMcp();
});

const ADDRESS = { workspace: 'someone-elses-workspace', slate: 'issues', revision: 'revision-a' };

const ROOT = { owner: 'viewer', repo: 'kinu' };

const CONSENT: SlateConsent = { ...ADDRESS, server: 'mcp.github', root: ROOT, tools: ['list_issues', 'create_issue'], effects: true };

function account() {
  const user = createTestUserDO();
  users.push(user);

  return user;
}

async function connection() {
  resetRecordedMcp();
  const user = account();
  const caller = await testOwner();
  await user.userDO.userMcp_list(caller);
  seedConfiguredMcpServer(user.sql, 'viewer-connection', { name: 'github', url: 'https://viewer-github.example/sse', transport: 'auto' });
  await user.userDO.userMcp_list(caller);
  seedMcpTools('viewer-connection', [
    { name: 'list_issues', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, openWorldHint: false } },
    { name: 'create_issue', inputSchema: { type: 'object' } },
  ]);
  const answer = { content: [{ type: 'text' as const, text: 'viewer-only issue' }], structuredContent: { issue: 3 } };
  seedMcpAnswer(answer);
  const read = { ...ADDRESS, server: CONSENT.server, tool: 'list_issues', args: [{ ...ROOT }] };
  const effect = { ...read, tool: 'create_issue', args: [{ ...ROOT, title: 'Approved title' }] };

  return { user, caller, read, effect, answer };
}

describe('personal part calls on the viewer\'s own account', () => {
  test('no consent and a consent for another revision both ask, without calling the MCP server', async () => {
    const { user, caller, read } = await connection();

    // Named as the person knows the connection and the tool: their own server name, the tool's.
    const ask = {
      kind: 'needs-consent' as const,
      ask: { server: CONSENT.server, root: ROOT, tools: ['list_issues'], effects: false, revision: ADDRESS.revision, serverTitle: 'github', toolTitle: 'list_issues' },
    };

    expect(await user.userDO.slatePartTool(caller, read)).toEqual(ask);
    await user.userDO.consentSlate(caller, { ...CONSENT, revision: 'older-revision' });
    expect(await user.userDO.slatePartTool(caller, read)).toEqual(ask);
    expect(recordedMcpToolCalls()).toEqual([]);
  });

  test('a consented read runs through this account\'s MCP connection and returns the parsed answer; withdrawal stops it', async () => {
    const { user, caller, read, answer } = await connection();

    expect(await user.userDO.consentSlate(caller, CONSENT)).toEqual(CONSENT);
    expect(await user.userDO.slateConsents(caller, ADDRESS)).toEqual([CONSENT]);
    expect(await user.userDO.slatePartTool(caller, read)).toEqual({ kind: 'ran', value: answer });
    expect(recordedMcpToolCalls()).toEqual([{ serverId: 'viewer-connection', name: 'list_issues', arguments: ROOT }]);
    expect(await user.userDO.withdrawSlateConsent(caller, CONSENT)).toBe(true);
    expect(await user.userDO.withdrawSlateConsent(caller, CONSENT)).toBe(false);
    expect(await user.userDO.slatePartTool(caller, read)).toMatchObject({ kind: 'needs-consent' });
    expect(recordedMcpToolCalls()).toHaveLength(1);
  });

  test('an effect asks with its exact payload; one approval admits one identical call, never a third call', async () => {
    const { user, caller, effect, answer } = await connection();
    await user.userDO.consentSlate(caller, CONSENT);
    const asked = await user.userDO.slatePartTool(caller, effect);
    expect(asked).toMatchObject({ kind: 'needs-approval', ask: { server: CONSENT.server, tool: 'create_issue', root: ROOT, payload: effect.args[0] } });
    expect(recordedMcpToolCalls()).toEqual([]);

    if (asked.kind !== 'needs-approval') return;

    expect(await user.userDO.decideSlateEffect(caller, { id: asked.ask.id, decision: 'approve' })).toBe(true);
    expect(await user.userDO.slatePartTool(caller, effect)).toEqual({ kind: 'ran', value: answer });
    expect(await user.userDO.decideSlateEffect(caller, { id: asked.ask.id, decision: 'approve' })).toBe(false);
    expect(await user.userDO.slatePartTool(caller, effect)).toMatchObject({ kind: 'needs-approval', ask: { id: asked.ask.id } });
    expect(recordedMcpToolCalls()).toEqual([{ serverId: 'viewer-connection', name: 'create_issue', arguments: effect.args[0] }]);
  });

  test('an approved payload cannot approve a different payload, slate, workspace or revision', async () => {
    const { user, caller, effect } = await connection();
    await user.userDO.consentSlate(caller, CONSENT);
    const asked = await user.userDO.slatePartTool(caller, effect);
    expect(asked.kind).toBe('needs-approval');

    if (asked.kind !== 'needs-approval') return;
    await user.userDO.decideSlateEffect(caller, { id: asked.ask.id, decision: 'approve' });
    const different = { ...effect, args: [{ ...ROOT, title: 'Not approved' }] };
    expect(await user.userDO.slatePartTool(caller, different)).toMatchObject({ kind: 'needs-approval', ask: { payload: different.args[0] } });

    for (const changed of [{ slate: 'other-slate' }, { workspace: 'other-workspace' }, { revision: 'other-revision' }]) {
      await user.userDO.consentSlate(caller, { ...CONSENT, ...changed });
      expect(await user.userDO.slatePartTool(caller, { ...effect, ...changed })).toMatchObject({ kind: 'needs-approval' });
    }

    expect(recordedMcpToolCalls()).toEqual([]);
    await user.userDO.consentSlate(caller, CONSENT);
    expect(await user.userDO.slatePartTool(caller, effect)).toMatchObject({ kind: 'ran' });
    expect(recordedMcpToolCalls()).toHaveLength(1);
  });

  test('declining forgets a pending approval; unknown and consumed ids cannot be decided', async () => {
    const { user, caller, effect } = await connection();
    await user.userDO.consentSlate(caller, CONSENT);
    const asked = await user.userDO.slatePartTool(caller, effect);
    expect(asked.kind).toBe('needs-approval');

    if (asked.kind !== 'needs-approval') return;

    expect(await user.userDO.decideSlateEffect(caller, { id: asked.ask.id, decision: 'decline' })).toBe(true);
    expect(await user.userDO.decideSlateEffect(caller, { id: asked.ask.id, decision: 'approve' })).toBe(false);
    expect(await user.userDO.decideSlateEffect(caller, { id: 'unknown', decision: 'decline' })).toBe(false);
    expect(await user.userDO.slatePartTool(caller, effect)).toMatchObject({ kind: 'needs-approval' });
    expect(recordedMcpToolCalls()).toEqual([]);
  });

  test('concurrent identical calls consume one approval only once', async () => {
    const { user, caller, effect } = await connection();
    await user.userDO.consentSlate(caller, CONSENT);
    const asked = await user.userDO.slatePartTool(caller, effect);
    expect(asked.kind).toBe('needs-approval');

    if (asked.kind !== 'needs-approval') return;
    await user.userDO.decideSlateEffect(caller, { id: asked.ask.id, decision: 'approve' });
    const answers = await Promise.all([user.userDO.slatePartTool(caller, effect), user.userDO.slatePartTool(caller, effect)]);

    expect(answers.map((answer) => answer.kind).sort()).toEqual(['needs-approval', 'ran']);
    expect(recordedMcpToolCalls()).toHaveLength(1);
  });

  test('consents survive an activation but pending approvals belong only to the account instance that asked', async () => {
    const { user, caller, effect } = await connection();
    await user.userDO.consentSlate(caller, CONSENT);
    const asked = await user.userDO.slatePartTool(caller, effect);
    expect(asked.kind).toBe('needs-approval');

    if (asked.kind !== 'needs-approval') return;
    await user.userDO.decideSlateEffect(caller, { id: asked.ask.id, decision: 'approve' });
    const revived = createTestUserDO({ storage: user.db });
    users.push(revived);

    expect(await revived.userDO.slateConsents(caller, ADDRESS)).toEqual([CONSENT]);
    expect(await revived.userDO.decideSlateEffect(caller, { id: asked.ask.id, decision: 'approve' })).toBe(false);
    const anotherViewer = account();
    expect(await anotherViewer.userDO.slateConsents(caller, ADDRESS)).toEqual([]);
    expect(await anotherViewer.userDO.decideSlateEffect(caller, { id: asked.ask.id, decision: 'approve' })).toBe(false);
    expect(recordedMcpToolCalls()).toEqual([]);
  });

  test('tools, roots and effects must each be consented; an unknown or removed tool is missing', async () => {
    const { user, caller, read, effect } = await connection();
    await user.userDO.consentSlate(caller, { ...CONSENT, tools: ['list_issues'], effects: false });

    expect(await user.userDO.slatePartTool(caller, effect)).toMatchObject({ kind: 'needs-consent', ask: { tools: ['list_issues', 'create_issue'], effects: true } });
    await user.userDO.consentSlate(caller, { ...CONSENT, effects: false });
    expect(await user.userDO.slatePartTool(caller, effect)).toMatchObject({ kind: 'needs-consent', ask: { effects: true } });
    expect(await user.userDO.slatePartTool(caller, { ...read, args: [{ ...ROOT, repo: 'not-consented' }] })).toMatchObject({ kind: 'needs-consent' });
    expect(await user.userDO.slatePartTool(caller, { ...read, tool: 'unknown' })).toMatchObject({ kind: 'missing' });
    expect(await user.userDO.slatePartTool(caller, { ...read, server: 'github' })).toMatchObject({ kind: 'missing' });
    user.sql.exec("UPDATE user_mcp_servers SET allowed_tools = '[]' WHERE id = 'viewer-connection'");
    expect(await user.userDO.slatePartTool(caller, read)).toMatchObject({ kind: 'missing' });
    expect(recordedMcpToolCalls()).toEqual([]);
  });

  test('reads need exact-payload approval unless both read-only and closed-world annotations are present', async () => {
    const { user, caller, read, answer } = await connection();

    const tools = [
      { name: 'open_read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, openWorldHint: true } },
      { name: 'unbounded_read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'closed_write', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, openWorldHint: false } },
      { name: 'unmarked_closed', inputSchema: { type: 'object' }, annotations: { openWorldHint: false } },
      { name: 'unmarked', inputSchema: { type: 'object' } },
    ];

    seedMcpTools('viewer-connection', tools);
    const consent = { ...CONSENT, tools: tools.map((tool) => tool.name) };

    for (const tool of tools) {
      const call = { ...read, tool: tool.name, args: [{ ...ROOT, private: 'viewer-only input' }] };
      await user.userDO.consentSlate(caller, { ...consent, effects: false });
      expect(await user.userDO.slatePartTool(caller, call)).toMatchObject({ kind: 'needs-consent', ask: { effects: true } });
      await user.userDO.consentSlate(caller, consent);
      const asked = await user.userDO.slatePartTool(caller, call);
      expect(asked).toMatchObject({ kind: 'needs-approval', ask: { tool: tool.name, payload: call.args[0] } });
      const ask = v.parse(AskId, 'ask' in asked ? asked.ask : null);
      await user.userDO.decideSlateEffect(caller, { id: ask.id, decision: 'approve' });
      seedMcpAnswer(answer);

      expect(await user.userDO.slatePartTool(caller, call)).toEqual({ kind: 'ran', value: answer });
      expect(await user.userDO.slatePartTool(caller, call)).toMatchObject({ kind: 'needs-approval' });
    }

    expect(recordedMcpToolCalls()).toHaveLength(tools.length);
  });

  test('MCP arguments must be exactly one JSON object, and malformed consents are refused', async () => {
    const { user, caller, read } = await connection();
    await user.userDO.consentSlate(caller, CONSENT);

    for (const args of [[], [null], [ROOT, ROOT], ['text'], [[]]] satisfies JsonValue[][]) {
      await expect(user.userDO.slatePartTool(caller, { ...read, args })).rejects.toMatchObject({ code: 'bad_input' });
    }

    await expect(user.userDO.consentSlate(caller, { ...CONSENT, revision: '' })).rejects.toMatchObject({ code: 'bad_input' });
    expect(recordedMcpToolCalls()).toEqual([]);
  });

  test('AI consent names run or stream at this revision and delegates only to this account\'s slateAi', async () => {
    const user = account();
    const caller = await testOwner();
    const answer = { text: 'private model answer' };
    const ai = spyOn(user.userDO, 'slateAi').mockResolvedValue(answer);
    const request = { ...ADDRESS, route: { kind: 'ai' as const, prompt: 'Private prompt', tier: 'fast' } };
    const consent = { ...ADDRESS, server: 'ai', root: {}, tools: ['run'], effects: false };

    expect(await user.userDO.slatePartAi(caller, request)).toMatchObject({ kind: 'needs-consent', ask: { server: 'ai', root: {}, tools: ['run'], effects: false } });
    await user.userDO.consentSlate(caller, { ...consent, revision: 'older' });
    expect(await user.userDO.slatePartAi(caller, request)).toMatchObject({ kind: 'needs-consent' });
    expect(ai).not.toHaveBeenCalled();
    await user.userDO.consentSlate(caller, consent);
    expect(await user.userDO.slatePartAi(caller, request)).toEqual({ kind: 'ran', value: answer });
    expect(ai).toHaveBeenCalledWith(caller, request);
    const streamRequest = { ...request, route: { ...request.route, stream: true as const } };
    expect(await user.userDO.slatePartAi(caller, streamRequest)).toMatchObject({ kind: 'needs-consent', ask: { tools: ['run', 'stream'] } });
    await user.userDO.consentSlate(caller, { ...consent, tools: ['run', 'stream'] });
    const stream = new ReadableStream<Uint8Array>();
    ai.mockResolvedValueOnce(stream);
    expect(await user.userDO.slatePartAi(caller, streamRequest)).toEqual({ kind: 'ran', value: stream });
    await user.userDO.withdrawSlateConsent(caller, consent);
    expect(await user.userDO.slatePartAi(caller, request)).toMatchObject({ kind: 'needs-consent' });
    expect(ai).toHaveBeenCalledTimes(2);
    ai.mockRestore();
  });

  test('workspace tokens cannot read, grant, withdraw or decide the viewer\'s consents', async () => {
    const user = account();
    const workspaceToken = await provisionTestWorkspace(user, 'token-holder');
    const caller = { workspaceToken };

    await expect(user.userDO.slateConsents(caller, ADDRESS)).rejects.toThrow();
    await expect(user.userDO.consentSlate(caller, CONSENT)).rejects.toThrow();
    await expect(user.userDO.withdrawSlateConsent(caller, CONSENT)).rejects.toThrow();
    await expect(user.userDO.decideSlateEffect(caller, { id: 'unknown', decision: 'approve' })).rejects.toThrow();
    expect(await user.userDO.slateConsents(await testOwner(), ADDRESS)).toEqual([]);
  });

  test('invalid callers cannot reach either personal connection path', async () => {
    const { user, read } = await connection();
    const caller = { workspaceToken: 'not-a-valid-token' };

    await expect(user.userDO.slatePartTool(caller, read)).rejects.toThrow();
    await expect(user.userDO.slatePartAi(caller, { ...ADDRESS, route: { kind: 'ai', prompt: 'private' } })).rejects.toThrow();
    expect(recordedMcpToolCalls()).toEqual([]);
  });
});
