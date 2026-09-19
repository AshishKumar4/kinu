/**
 * Live slate shares, driven through `orchestratorHarness` and a real owner
 * UserDO the way `unit-slate-sharing.test.ts` drives blueprints: the graph is
 * cut from the workspace's own catalog, the grant lives on the share row, and
 * every viewer call is admitted, routed and audited by the host — so this file
 * asserts the S-rules end to end rather than mocking them.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  LiveShareRecordSchema, SlateCapabilityGraphSchema, ViewerRequestRecordSchema,
  type AgentRuntime, type SlateAnswer,
} from '@kinu.run/core';
import { orchestratorHarness, hostedSubordinateHarness, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import { createTestUserDO, provisionTestWorkspace, testOwner } from './helpers/user-do';
import { resetRecordedMcp, seedMcpTools } from './helpers/agents-sdk';
import { ROOT_SLATE_CALLER, type SlateCaller } from '../src/slates/bindings';

function answered<Schema extends v.GenericSchema>(result: SlateAnswer<unknown>, schema: Schema): v.InferOutput<Schema> {
  if (!result.ok) throw new Error(result.reason + ': ' + result.error);

  return v.parse(schema, result.value);
}

/** The fixture slate: every grant-relevant binding kind, plus the `digest`
 *  slate the PEER app hop walks into (which hops back, proving the cycle guard). */
async function authorIssuesSlate(files: AgentRuntime['storage']['vfs']) {
  await files.mkdir('/home/user/slates/issues', { recursive: true });
  await files.writeFile('/home/user/slates/issues/package.json', JSON.stringify({
    name: 'issues', description: 'Triage the open issues', main: 'src/server.ts',
    slate: { title: 'Issue triage', bindings: {
      GITHUB: { kind: 'mcp', server: 'connection-id', tools: ['read_issue', 'create_issue'] },
      FILES: { kind: 'namespace', namespace: 'workspace', members: ['readFile', 'writeFile'] },
      NOTES: { kind: 'memory', members: ['recall', 'remember'] },
      ASK: { kind: 'agent' },
      PEER: { kind: 'app', id: 'digest' },
    } },
  }));
  await files.writeFile('/home/user/slates/issues/src/server.ts', 'export default {};');
  await files.mkdir('/home/user/slates/digest', { recursive: true });
  await files.writeFile('/home/user/slates/digest/package.json', JSON.stringify({
    name: 'digest', main: 'server.ts',
    slate: { title: 'Digest', bindings: {
      DIGEST_FILES: { kind: 'namespace', namespace: 'workspace', members: ['readFile'] },
      BACK: { kind: 'app', id: 'issues' },
    } },
  }));
  await files.writeFile('/home/user/slates/digest/server.ts', 'export default {};');
}

interface World {
  readonly owner: ActorHarness<HarnessOrchestratorAgent>;
  readonly close: () => void;
}

async function ownerWorld(): Promise<World> {
  resetRecordedMcp();
  const ownerUserId = '0123456789abcdef0123456789abcdef';
  const user = createTestUserDO({ durableObjectId: ownerUserId });
  const capability = await provisionTestWorkspace(user, 'issues-owner');
  const owner = orchestratorHarness(undefined, { userDO: user.userDO, workspace: 'issues-owner', ownerUserId });
  await owner.agent.installWorkspaceCapability(capability);
  const caller = await testOwner();
  await user.userDO.userMcp_list(caller);
  user.sql.exec(`INSERT INTO user_mcp_servers (id, name, server_url, transport, headers, allowed_tools, created_at, updated_at)
    VALUES ('connection-id', 'github', 'https://github.example/sse', 'auto', NULL, NULL, 0, 0)`);
  seedMcpTools('connection-id', [
    { name: 'read_issue', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'create_issue', inputSchema: { type: 'object' } },
  ]);
  await authorIssuesSlate(owner.agent.observeRuntime().storage.vfs);

  return { owner, close: () => { user.close(); resetRecordedMcp(); } };
}

test('graph walks every binding, classifies members, and follows the app hop', async () => {
  const world = await ownerWorld();

  try {
    const graph = answered(await world.owner.agent.slate({ op: 'graph', id: 'issues' }), SlateCapabilityGraphSchema);

    expect(graph.slate).toBe('issues');
    expect(graph.slates).toEqual(['issues', 'digest']);
    const byName = new Map(graph.bindings.map((b) => [`${b.slate}.${b.name}`, b]));
    const github = byName.get('issues.GITHUB');

    expect(github?.capability).toEqual({ kind: 'mcp', server: 'connection-id', title: 'github' });
    expect(github?.members).toEqual([
      { member: 'read_issue', effect: 'read', risk: { public: '', users: '' } },
      { member: 'create_issue', effect: 'mutate', risk: {
        public: 'Calls create_issue on github with your credentials. The server does not mark it read-only, so it can create or change data there. Anyone who opens this share can trigger it.',
        users: 'Calls create_issue on github with your credentials. The server does not mark it read-only, so it can create or change data there. Anyone you named on this share can trigger it.',
      } },
    ]);
    const files = byName.get('issues.FILES');

    expect(files?.capability).toEqual({ kind: 'executor', namespace: 'workspace' });
    expect(files?.members?.map((m) => [m.member, m.effect])).toEqual([['readFile', 'read'], ['writeFile', 'mutate']]);
    const ask = byName.get('issues.ASK');

    expect(ask?.members?.[0]?.risk.users).toBe('Sends a message to your agent\'s inbox as this slate. Your agent reads it and acts on it in workspace issues-owner. Anyone you named on this share can trigger it.');
    // The cycle: PEER walks digest, digest's BACK would re-enter issues, and
    // both of digest's own rows are appended under the digest slate.
    const digestFiles = byName.get('digest.DIGEST_FILES');

    expect(digestFiles?.members?.map((m) => m.member)).toEqual(['readFile']);
    expect(byName.get('digest.BACK')?.capability).toEqual({ kind: 'slate', id: 'issues' });
    expect(byName.get('digest.BACK')?.members).toEqual([]);
    expect(byName.get('issues.PEER')?.members).toEqual([]);
  } finally { world.close(); }
});

test('S3/S1: no share row means a 404 admission; a share caller must name its invocation', async () => {
  const world = await ownerWorld();

  try {
    const admission = await world.owner.agent.observeSlateHost().admitViewerRequest({ handle: '0123456789', claim: { userId: null, source: 's', consented: true }, pathname: '/' });

    expect(admission).toBeInstanceOf(Response);

    if (!(admission instanceof Response)) throw new Error('expected a refused admission');
    expect(admission.status).toBe(404);

    const created = answered(await world.owner.agent.slate({ op: 'share', id: 'issues', visibility: 'public', approved: [] }),
      v.object({ share: LiveShareRecordSchema, url: v.nullable(v.string()) }));

    const shareCaller: SlateCaller = { ...ROOT_SLATE_CALLER, share: created.share.id };

    expect(await world.owner.agent.slateBindingCallAs(shareCaller, 'issues', 'FILES', { member: 'readFile', args: ['/x'], invocation: null }))
      .toMatchObject({ ok: false, reason: 'denied', error: expect.stringContaining('invocation') });
  } finally { world.close(); }
});

test('a public share admits read members, refuses mutating ones, and audits every call', async () => {
  const world = await ownerWorld();

  try {
    const created = answered(await world.owner.agent.slate({ op: 'share', id: 'issues', visibility: 'public', approved: [] }),
      v.object({ share: LiveShareRecordSchema, url: v.nullable(v.string()) }));

    expect(created.share.handle).toMatch(/^[0-9a-f]{10}$/);
    // The default grant is exactly the graph's read members.
    expect(created.share.grant.members.every((m) => m.effect === 'read')).toBe(true);
    expect(created.share.grant.members.map((m) => `${m.binding}.${m.member}`).sort()).toEqual(
      ['DIGEST_FILES.readFile', 'FILES.readFile', 'GITHUB.read_issue', 'NOTES.recall'].sort());
    expect(created.share.grant.slates).toEqual(['issues', 'digest']);

    const host = world.owner.agent.observeSlateHost();
    const admission = await host.admitViewerRequest({ handle: created.share.handle, claim: { userId: null, source: 'deadbeef', consented: true }, pathname: '/' });

    if (admission instanceof Response) throw new Error(`admission refused: ${admission.status}`);
    const viewerCaller: SlateCaller = { ...ROOT_SLATE_CALLER, share: created.share.id };

    const call = (binding: string, member: string, args: unknown[] = []) =>
      // SAFETY: `JsonValue[]` is the request's args field; `unknown[]` narrows to it through the schema the call is parsed under.
      world.owner.agent.slateBindingCallAs(viewerCaller, 'issues', binding, { member, args: args as never[], invocation: admission.invocation });

    expect(await call('FILES', 'readFile', ['/home/user/slates/issues/package.json'])).toMatchObject({ ok: true });
    const refused = await call('FILES', 'writeFile', ['/tmp/x', 'y']);

    expect(refused).toMatchObject({ ok: false, reason: 'denied', error: expect.stringContaining('does not grant') });
    // Same shape as a binding that was never declared.
    expect(await call('NOPE', 'readFile')).toMatchObject({ ok: false, reason: 'denied' });
    expect(await call('GITHUB', 'create_issue', [{}])).toMatchObject({ ok: false, reason: 'denied' });
    expect(await call('GITHUB', 'read_issue', [{}])).toMatchObject({ ok: true });
    expect(await call('ASK', 'send', [{ text: 'hi' }])).toMatchObject({ ok: false, reason: 'denied', error: expect.stringContaining('does not grant') });

    admission.settle('ok');

    const rows = answered(await world.owner.agent.slate({ op: 'viewerRequests', share: created.share.id }), v.array(ViewerRequestRecordSchema));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ viewer: 'source:deadbeef', slate: 'issues', path: '/', outcome: 'ok' });
    expect(rows[0].calls.map((c) => [c.binding, c.member, c.effect, c.ok])).toEqual([
      ['FILES', 'readFile', 'read', true],
      ['FILES', 'writeFile', 'mutate', false],
      ['NOPE', 'readFile', 'mutate', false],
      ['GITHUB', 'create_issue', 'mutate', false],
      ['GITHUB', 'read_issue', 'read', true],
      ['ASK', 'send', 'mutate', false],
    ]);
  } finally { world.close(); }
});

test('a mutating member is granted by approval only, on public and users shares alike', async () => {
  const world = await ownerWorld();

  try {
    const created = answered(await world.owner.agent.slate({
      op: 'share', id: 'issues', visibility: 'users', approved: [{ slate: 'issues', binding: 'ASK', member: 'send' }],
    }), v.object({ share: LiveShareRecordSchema, url: v.nullable(v.string()) }));

    expect(created.share.grant.members.map((m) => `${m.binding}.${m.member}`)).toContain('ASK.send');
    const host = world.owner.agent.observeSlateHost();
    // An unnamed viewer is refused before any audit row exists.

    for (const claim of [{ userId: null, source: 's', consented: true }, { userId: 'f'.repeat(32), source: 's', consented: true }]) {
      const refused = await host.admitViewerRequest({ handle: created.share.handle, claim, pathname: '/' });

      if (!(refused instanceof Response)) throw new Error('expected a refused admission');
      expect(refused.status).toBe(404);
    }

    const named = 'a'.repeat(32);
    await world.owner.agent.shareLiveWith(created.share.id, [{ userId: named, email: 'pat@example.test' }]);
    const admission = await host.admitViewerRequest({ handle: created.share.handle, claim: { userId: named, source: 's', consented: true }, pathname: '/' });

    if (admission instanceof Response) throw new Error(`admission refused: ${admission.status}`);
    const viewerCaller: SlateCaller = { ...ROOT_SLATE_CALLER, share: created.share.id };

    expect(await world.owner.agent.slateBindingCallAs(viewerCaller, 'issues', 'ASK', { member: 'send', args: [{ text: 'hi' }], invocation: admission.invocation }))
      .toMatchObject({ ok: true });
    expect(await world.owner.agent.slateBindingCallAs(viewerCaller, 'issues', 'FILES', { member: 'writeFile', args: ['/x', 'y'], invocation: admission.invocation }))
      .toMatchObject({ ok: false, reason: 'denied' });
    admission.settle('ok');
  } finally { world.close(); }
});

test('S6: revoking between two calls refuses the second and stops new admissions', async () => {
  const world = await ownerWorld();

  try {
    const created = answered(await world.owner.agent.slate({ op: 'share', id: 'issues', visibility: 'public', approved: [] }),
      v.object({ share: LiveShareRecordSchema, url: v.nullable(v.string()) }));

    const host = world.owner.agent.observeSlateHost();
    const admission = await host.admitViewerRequest({ handle: created.share.handle, claim: { userId: null, source: 's', consented: true }, pathname: '/' });

    if (admission instanceof Response) throw new Error(`admission refused: ${admission.status}`);
    const viewerCaller: SlateCaller = { ...ROOT_SLATE_CALLER, share: created.share.id };

    expect(await world.owner.agent.slateBindingCallAs(viewerCaller, 'issues', 'FILES', { member: 'readFile', args: ['/home/user/slates/issues/package.json'], invocation: admission.invocation }))
      .toMatchObject({ ok: true });

    answered(await world.owner.agent.slate({ op: 'unshare', share: created.share.id }), LiveShareRecordSchema);
    expect(await world.owner.agent.slateBindingCallAs(viewerCaller, 'issues', 'FILES', { member: 'readFile', args: ['/x'], invocation: admission.invocation }))
      .toMatchObject({ ok: false, reason: 'denied', error: expect.stringContaining('no longer shared') });
    const postRevoke = await host.admitViewerRequest({ handle: created.share.handle, claim: { userId: null, source: 's', consented: true }, pathname: '/' });

    if (!(postRevoke instanceof Response)) throw new Error('expected a refused admission');
    expect(postRevoke.status).toBe(404);
  } finally { world.close(); }
});

test('S1: agent-control and eval bindings surface as problems and admit no members', async () => {
  const world = await ownerWorld();

  try {
    const files = world.owner.agent.observeRuntime().storage.vfs;
    await files.writeFile('/home/user/slates/issues/package.json', JSON.stringify({
      name: 'issues', main: 'src/server.ts',
      slate: { title: 'Issue triage', bindings: {
        CONTROL: { kind: 'namespace', namespace: 'agents' },
        TOOLS: { kind: 'tool', name: 'eval' },
        HIRE: { kind: 'tool', name: 'agents' },
      } },
    }));
    const graph = answered(await world.owner.agent.slate({ op: 'graph', id: 'issues' }), SlateCapabilityGraphSchema);

    for (const name of ['CONTROL', 'TOOLS', 'HIRE']) {
      const row = graph.bindings.find((b) => b.name === name);

      expect(row?.problem).toBeTruthy();
      expect(row?.members).toEqual([]);
    }

    const created = answered(await world.owner.agent.slate({ op: 'share', id: 'issues', visibility: 'public', approved: [] }),
      v.object({ share: LiveShareRecordSchema, url: v.nullable(v.string()) }));

    expect(created.share.grant.members).toEqual([]);
    const host = world.owner.agent.observeSlateHost();
    const admission = await host.admitViewerRequest({ handle: created.share.handle, claim: { userId: null, source: 's', consented: true }, pathname: '/' });

    if (admission instanceof Response) throw new Error(`admission refused: ${admission.status}`);
    const viewerCaller: SlateCaller = { ...ROOT_SLATE_CALLER, share: created.share.id };

    expect(await world.owner.agent.slateBindingCallAs(viewerCaller, 'issues', 'CONTROL', { member: 'msg', args: ['x'], invocation: admission.invocation }))
      .toMatchObject({ ok: false, reason: 'denied' });
    admission.settle('ok');
  } finally { world.close(); }
});

test('an app hop under a share is admitted by grant.slates and audited under its effect', async () => {
  const world = await ownerWorld();

  try {
    const created = answered(await world.owner.agent.slate({ op: 'share', id: 'issues', visibility: 'public', approved: [] }),
      v.object({ share: LiveShareRecordSchema, url: v.nullable(v.string()) }));

    expect(created.share.grant.slates).toContain('digest');
    const host = world.owner.agent.observeSlateHost();
    const admission = await host.admitViewerRequest({ handle: created.share.handle, claim: { userId: null, source: 's', consented: true }, pathname: '/' });

    if (admission instanceof Response) throw new Error(`admission refused: ${admission.status}`);
    const viewerCaller: SlateCaller = { ...ROOT_SLATE_CALLER, share: created.share.id };
    // The PEER hop passes the grant; it fails for the real reason — the harness
    // cannot boot the digest process — never for 'does not grant'.
    const hop = await world.owner.agent.slateBindingCallAs(viewerCaller, 'issues', 'PEER', { member: 'probe', args: [], invocation: admission.invocation });

    expect(hop).toMatchObject({ ok: false });
    expect(hop.ok ? '' : hop.error).not.toContain('does not grant');
    admission.settle('ok');
    const rows = answered(await world.owner.agent.slate({ op: 'viewerRequests', share: created.share.id }), v.array(ViewerRequestRecordSchema));

    expect(rows[0]?.calls[0]).toMatchObject({ binding: 'PEER', member: 'probe', effect: 'read' });
  } finally { world.close(); }
});

test('a hosted actor cannot share, and plan mode may graph but not share', async () => {
  const world = await ownerWorld();

  try {
    const plan: SlateCaller = { ...ROOT_SLATE_CALLER, workMode: 'plan' };

    expect(await world.owner.agent.slateAs(plan, { op: 'graph', id: 'issues' })).toMatchObject({ ok: true });
    expect(await world.owner.agent.slateAs(plan, { op: 'share', id: 'issues', visibility: 'public', approved: [] }))
      .toMatchObject({ ok: false, reason: 'denied' });

    const child = await hostedSubordinateHarness(world.owner, {
      name: 'helper', displayName: 'Helper', nameOrigin: 'user', roleId: 'task', mission: 'Help',
    });

    const hosted: SlateCaller = { ...ROOT_SLATE_CALLER, path: [{ name: 'helper' }] };
    void child;
    expect(await world.owner.agent.slateAs(hosted, { op: 'share', id: 'issues', visibility: 'public', approved: [] }))
      .toMatchObject({ ok: false, reason: 'denied' });
    expect(await world.owner.agent.slateAs(hosted, { op: 'liveShares' })).toMatchObject({ ok: false, reason: 'denied' });
  } finally { world.close(); }
});
