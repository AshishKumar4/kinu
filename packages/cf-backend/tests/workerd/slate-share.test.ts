import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { expect, it } from 'vitest';
import * as v from 'valibot';
import { LiveShareRecordSchema, ViewerRequestRecordSchema } from '@kinu.run/core';
import type { SlateShareProbeRpc } from './env';

type Probe = DurableObjectStub<SlateShareProbeRpc>;

const subject = (name: string): Probe =>
  // SAFETY: the binding is the probe worker's own class; the Rpc interface is its exact surface.
  env.SLATE_SHARE_PROBE.get(env.SLATE_SHARE_PROBE.idFromName(name));

const ShareCreated = v.object({ share: LiveShareRecordSchema, url: v.nullable(v.string()) });

const Requests = v.object({ ok: v.literal(true), value: v.array(ViewerRequestRecordSchema) });

const CLAIM = { userId: null, source: 'vitest', consented: true };

it('a public share serves the slate, admits the granted member, refuses the rest and audits all of it', async () => {
  const probe = subject('live-share');
  await probe.start();
  const shared = await probe.share();
  expect(shared, JSON.stringify(shared)).toMatchObject({ ok: true });
  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }), shared).value);
  const handle = created.share.handle;

  // Its one link is the app's page for it, which frames its host: never the bare host.
  expect(created.url).toBe(`https://app.test/shared/live/probe/${created.share.id}`);

  expect(await probe.viewerFetch(handle, CLAIM)).toEqual({ status: 200, body: 'share-ok' });

  // probe() reads the granted member; mutate() is refused at the grant, before the member runs.
  const batch = await probe.viewerBatch(handle, CLAIM);
  expect(batch.probe).toBe('fixture-bytes');
  // Refused at the slate's server-wide bound, which every share of it meets, before its own share's grant is read.
  expect(batch.mutateError).toContain('does not reach workspace.writeFile');

  // The invocation retires on socket close; a replay refuses 'not running'.
  const socket = await probe.viewerSocket(handle, CLAIM);
  expect(socket.probe).toBe('fixture-bytes');
  expect(socket.mutateError).toContain('does not reach workspace.writeFile');

  // A call under a share must name the running invocation it rides.
  expect(await probe.unnamedShareCall(created.share.id)).toMatchObject({ ok: false, reason: 'denied' });

  const replay = await probe.replay(created.share.id);
  expect(replay).toMatchObject({ ok: false, reason: 'denied' });

  const rows = v.parse(Requests, await probe.requests(created.share.id)).value;

  expect(rows.map((row) => [row.viewer, row.path, row.outcome])).toEqual([
    ['source:vitest', '/__rpc', 'closed'],
    ['source:vitest', '/__rpc', 'ok'],
    ['source:vitest', '/', 'ok'],
  ]);
  expect(rows[0]?.calls).toEqual([
    { slate: 'board', namespace: 'workspace', member: 'readFile', impact: 'observe', ok: true },
    { slate: 'board', namespace: 'workspace', member: 'writeFile', impact: 'mutate', ok: false },
  ]);
  expect(rows[1]?.calls).toEqual(rows[0]?.calls);
  expect(rows[2]?.calls).toEqual([]);
});

const GraphSchema = v.object({
  slate: v.string(),
  slates: v.array(v.string()),
  namespaces: v.array(v.looseObject({
    slate: v.string(), namespace: v.string(), problem: v.optional(v.string()),
    members: v.array(v.object({ member: v.string(), impact: v.string(), risk: v.object({ public: v.string(), users: v.string() }) })),
  })),
});

const AnsweredSchema = v.object({ ok: v.literal(true), value: v.unknown() });

const answer = (result: Awaited<ReturnType<Probe['operationAs']>>) => v.parse(AnsweredSchema, result).value;

it('a share is granted what its graph observes, across the app hop and its cycle, and what its owner approved', async () => {
  const probe = subject('triage');

  await probe.start();
  await probe.authorTriage();
  const graph = v.parse(GraphSchema, answer(await probe.operationAs('root', { op: 'graph', id: 'issues' })));
  const row = (name: string) => graph.namespaces.find((each) => `${each.slate}:${each.namespace}` === name);
  const impacts = (name: string) => row(name)?.members.map((member) => [member.member, member.impact]);

  // The hop into the digest is walked once: its way back names the slate and walks nothing more.
  expect(graph.slates).toEqual(['issues', 'triage-digest']);
  expect(impacts('triage-digest:slates.issues')).toEqual([['refresh', 'observe']]);
  expect(impacts('issues:mcp.github')).toEqual([['add_issue_comment', 'externalSend'], ['issue_read', 'observe']]);
  expect(impacts('issues:workspace')).toEqual([['readFile', 'observe'], ['writeFile', 'mutate']]);

  const ShareSchema = v.object({ share: LiveShareRecordSchema, url: v.nullable(v.string()) });

  const granted = async (visibility: 'public' | 'users', approved: Array<{ slate: string; namespace: string; member: string }>) => v.parse(
    ShareSchema, answer(await probe.operationAs('root', { op: 'share', id: 'issues', visibility, approved })),
  ).share.grant.members.map((member) => `${member.slate}:${member.namespace}.${member.member}`).sort();

  expect(await granted('public', [])).toEqual([
    'issues:mcp.github.issue_read', 'issues:memory.recall', 'issues:slates.triage-digest.summary', 'issues:workspace.readFile',
    'triage-digest:slates.issues.refresh', 'triage-digest:workspace.readFile',
  ]);
  expect(await granted('users', [{ slate: 'issues', namespace: 'agent', member: 'send' }])).toContain('issues:agent.send');

  // What only the agent does is refused where the host routes it, so it never enters a graph or a grant. Helpers the
  // owner's own slate hired are in its graph, as delegating, and no share carries them or may be approved them.
  const overreach = v.parse(GraphSchema, answer(await probe.operationAs('root', { op: 'graph', id: 'overreach' })));

  expect(overreach.namespaces.map((each) => [each.namespace, each.members.map((member) => [member.member, member.impact])])).toEqual([
    ['agents', [['hire', 'delegate']]],
  ]);
  expect(v.parse(ShareSchema, answer(await probe.operationAs('root', { op: 'share', id: 'overreach', visibility: 'public', approved: [] })))
    .share.grant.members).toEqual([]);
  expect(await probe.operationAs('root', {
    op: 'share', id: 'overreach', visibility: 'public', approved: [{ slate: 'overreach', namespace: 'agents', member: 'hire' }],
  })).toMatchObject({ ok: false, reason: 'bad_input' });
});

it('Plan mode may read a graph but not share, and a hired agent may do neither', async () => {
  const probe = subject('triage-callers');

  await probe.start();
  await probe.authorTriage();
  const share = { op: 'share', id: 'issues', visibility: 'public', approved: [] };

  expect(await probe.operationAs('plan', { op: 'graph', id: 'issues' })).toMatchObject({ ok: true });
  expect(await probe.operationAs('plan', share)).toMatchObject({ ok: false, reason: 'denied' });
  expect(await probe.operationAs('hire', share)).toMatchObject({ ok: false, reason: 'denied' });
  expect(await probe.operationAs('hire', { op: 'liveShares' })).toMatchObject({ ok: false, reason: 'denied' });
});

it('a hired agent previews a slate it made where slates live, then removes it as the main agent would', async () => {
  const { preview, removed, left } = await subject('hire-preview').previewAsHire();

  expect(preview, JSON.stringify(preview)).toMatchObject({ ok: true, value: { url: expect.stringMatching(/^https:\/\/\d+\.preview\.test\/$/) } });
  expect(removed, JSON.stringify(removed)).toMatchObject({ ok: true, value: { id: 'widgets', removed: true } });
  expect(left).toBe(false);
});

it('a revoked share refuses the route and stops the process it carried', async () => {
  const probe = subject('live-revoke');
  await probe.start();
  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }), await probe.share()).value);

  expect((await probe.viewerFetch(created.share.handle, CLAIM)).status).toBe(200);

  await probe.revoke(created.share.id);

  expect((await probe.viewerFetch(created.share.handle, CLAIM)).status).toBe(404);
  expect(await probe.stopped()).toBe(true);
});


it('a shared slate still serves after the object that ran it is evicted', async () => {
  // S6 durability: share row and source live in object storage, so a cold request re-boots the slate.
  const probe = () => subject('live-evict');
  await probe().start();
  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }), await probe().share()).value);

  expect(await probe().viewerFetch(created.share.handle, CLAIM)).toEqual({ status: 200, body: 'share-ok' });

  await abortAllDurableObjects();

  expect(await probe().viewerFetch(created.share.handle, CLAIM)).toEqual({ status: 200, body: 'share-ok' });
});

it("a listed share is told to the Gallery when listed, when its slate builds anew, and at each start of the slates", async () => {
  const probe = () => subject('live-listed');
  await probe().start();
  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }), await probe().share([], 'own')).value);

  expect(await probe().listShare(created.share.id)).toMatchObject({ ok: true, value: { gallery: { line: 'A board', category: 'work' } } });
  expect(await probe().told()).toEqual([created.share.id]);

  // A new revision may carry a new title for its card.
  await probe().editBoard();
  expect(await probe().told()).toEqual([created.share.id]);

  // The Gallery's index is a copy that a repair may drop: a fresh start of the workspace's slates refills it.
  await abortAllDurableObjects();
  expect(await probe().told()).toEqual([created.share.id]);
});

it("shared on each viewer's own access, the slate's server uses no one's connections, and says who can change that", async () => {
  const probe = subject('own-access-share');
  await probe.start();
  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }), await probe.share([], 'own')).value);
  const refused = await probe.viewerRefusals(created.share.handle, CLAIM);

  // The owner's file is the owner's: the server refuses to read or write it for anyone, and names the way to "My access".
  expect(refused.probe).toContain('can turn on My access');
  expect(refused.mutate).toContain('can turn on My access');
});

it("a mutating member is granted by approval only, and on its owner's access each call of it waits for the owner's word", async () => {
  const probe = subject('live-approved');
  await probe.start();

  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }),
    await probe.share([{ namespace: 'workspace', member: 'writeFile' }])).value);

  // The unapproved share above refuses the same call: the approval is the grant. Granted, it acts with the owner's
  // access, so it waits on them, with what it would write; the read beside it runs.
  expect(await probe.viewerBatch(created.share.handle, CLAIM)).toEqual({ probe: 'fixture-bytes', mutateError: expect.stringContaining('waits for the owner to approve it: writeFile on workspace') });
  expect(await probe.ownerQueue()).toEqual([{ tool: 'writeFile', server: 'workspace', viewer: 'source:vitest', payload: ['/x', 'y'], revision: expect.any(String) }]);

  // On their word it runs, once: the same call made again asks again.
  expect(await probe.ownerDecides(true)).toBe(1);
  expect(await probe.viewerBatch(created.share.handle, CLAIM)).toEqual({ probe: 'fixture-bytes', mutateError: 'mutate answered' });
  expect((await probe.viewerBatch(created.share.handle, CLAIM)).mutateError).toContain('waits for the owner to approve it');
  expect(await probe.ownerQueue()).toHaveLength(1);

  // Declined, it is refused while the decline stands.
  expect(await probe.ownerDecides(false)).toBe(1);
  expect((await probe.viewerBatch(created.share.handle, CLAIM)).mutateError).toContain('The owner declined this call');
});

it("a viewer's approved write held while its dispatch prepares is never made once its share is revoked or turned to each viewer's own access", async () => {
  for (const change of ['revoke', 'own'] as const) {
    const probe = subject(`live-held-${change}`);
    await probe.start();

    const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }),
      await probe.share([{ namespace: 'workspace', member: 'writeFile' }])).value);

    await probe.viewerBatch(created.share.handle, CLAIM);
    expect(await probe.ownerDecides(true)).toBe(1);

    // Approved and dispatched; the share changes before the write is sent, so the write is never made.
    const held = await probe.heldWrite(created.share.handle, CLAIM, created.share.id, change);

    expect({ change, written: held.written, answered: held.mutateError === 'mutate answered' }).toEqual({ change, written: false, answered: false });
  }
});

it("the owner's 'Always for this slate' on a viewer's write lets every such write run unasked, until their edit", async () => {
  const probe = subject('live-always');
  await probe.start();

  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }),
    await probe.share([{ namespace: 'workspace', member: 'writeFile' }])).value);

  await probe.viewerBatch(created.share.handle, CLAIM);
  expect(await probe.ownerAlways()).toBe(1);

  // Every later write of that tool on that root runs with nothing asked.
  expect([await probe.viewerBatch(created.share.handle, CLAIM), await probe.viewerBatch(created.share.handle, CLAIM)])
    .toEqual([{ probe: 'fixture-bytes', mutateError: 'mutate answered' }, { probe: 'fixture-bytes', mutateError: 'mutate answered' }]);
  expect(await probe.ownerQueue()).toEqual([]);
  expect((await probe.preapprovals()).members).toEqual(['writeFile']);

  // The owner's edit is new code: it asks again.
  await probe.editBoard();
  expect((await probe.viewerBatch(created.share.handle, CLAIM)).mutateError).toContain('waits for the owner to approve it');
});

it("an approval taken back on the sheet leaves no approved ask of its shape to run on: the same write asks again", async () => {
  const probe = subject('live-withdrawn');
  await probe.start();

  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }),
    await probe.share([{ namespace: 'workspace', member: 'writeFile' }])).value);

  const write = async () => (await probe.viewerBatch(created.share.handle, CLAIM)).mutateError;

  // 'Always', the write runs on it, and it is taken back: the very write it was given on asks again.
  await write();
  expect(await probe.ownerAlways()).toBe(1);
  expect(await write()).toBe('mutate answered');
  await probe.withdrawWrites();
  expect(await write()).toContain('waits for the owner to approve it');

  // An ask of that shape approved once and not yet run is retired with the standing approval it lay beside.
  expect(await probe.ownerDecides(true)).toBe(1);
  expect(await probe.preapproveWrites()).toEqual([created.share.id]);
  await probe.withdrawWrites();
  expect(await write()).toContain('waits for the owner to approve it');
});

it("a standing approval stands at the revision it was given at, and an owner's edit leaves it void", async () => {
  const probe = subject('live-preapproved');
  await probe.start();

  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }),
    await probe.share([{ namespace: 'workspace', member: 'writeFile' }])).value);

  expect(await probe.preapproveWrites()).toEqual([created.share.id]);
  const given = await probe.preapprovals();

  expect(given).toEqual({ revision: expect.any(String), members: ['writeFile'] });

  // The owner's edit is a new revision: what was approved for the old code stands for none of the new.
  const edited = await probe.editBoard();

  expect(edited).not.toBe(given.revision);
  expect(await probe.preapprovals()).toEqual({ revision: edited, members: [] });
});

it("an owner share's approval moves with its owner's own edit, and a review read at the old revision turns nothing on", async () => {
  const probe = subject('live-owner-edit');
  await probe.start();

  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }),
    await probe.share([{ namespace: 'workspace', member: 'writeFile' }])).value);

  const shares = async () => v.parse(v.object({ ok: v.literal(true), value: v.array(LiveShareRecordSchema) }), await probe.liveShares()).value;
  const before = (await shares()).find((row) => row.id === created.share.id);

  expect(before).toMatchObject({ mode: 'owner', grantRevision: expect.any(String), stale: false });
  await probe.viewerBatch(created.share.handle, CLAIM);
  expect(await probe.ownerQueue()).toHaveLength(1);

  // The owner's edit is a new revision their approval carries to; what was asked at the old one is retired.
  const edited = await probe.editBoard();

  expect(edited).not.toBe(before?.grantRevision);
  expect((await shares()).find((row) => row.id === created.share.id)).toMatchObject({ mode: 'owner', grantRevision: edited, stale: false });
  expect(await probe.ownerQueue()).toEqual([]);
  expect((await probe.viewerBatch(created.share.handle, CLAIM)).probe).toBe('fixture-bytes');
  expect(await probe.setMode(created.share.id, before?.grantRevision ?? '')).toMatchObject({ ok: false, reason: 'bad_input' });
});

it("revoking a share refuses the next call of a session it admitted", async () => {
  const probe = subject('live-revoke-mid');
  await probe.start();
  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }), await probe.share()).value);

  const session = await probe.viewerSocketAcross(created.share.handle, CLAIM, created.share.id, 'revoke');

  expect(session.before).toBe('fixture-bytes');
  // The revoke stops the slate, so the session's own next call dies with it; one already in flight is refused.
  expect(session.after).not.toBe('fixture-bytes');
  expect(JSON.parse(session.late)).toMatchObject({ ok: false, reason: 'denied' });
});

it('a share past its daily spend refuses calls as budget and shows paused', async () => {
  const probe = subject('live-spent');
  await probe.start();
  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }), await probe.share()).value);

  const session = await probe.viewerSocketAcross(created.share.handle, CLAIM, created.share.id, 'spend');

  expect(session.before).toBe('fixture-bytes');
  expect(JSON.parse(session.late)).toMatchObject({ ok: false, reason: 'budget' });

  const shares = v.parse(v.object({ ok: v.literal(true), value: v.array(v.looseObject({ id: v.string(), paused: v.optional(v.boolean()) })) }),
    await probe.liveShares()).value;

  expect(shares.find((row) => row.id === created.share.id)?.paused).toBe(true);
  const rows = v.parse(Requests, await probe.requests(created.share.id)).value;
  expect(rows[0]?.calls.map((call) => call.ok)).toEqual([true, false, false]);
});

it('an app hop under a share runs the slate it names and is audited under its impact', async () => {
  const probe = subject('live-hop');
  await probe.start();
  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }), await probe.share()).value);

  expect(created.share.grant.slates).toContain('digest');
  expect(await probe.viewerHop(created.share.handle, CLAIM)).toBe('"digest-ok"');
  const rows = v.parse(Requests, await probe.requests(created.share.id)).value;
  expect(rows[0]?.calls).toEqual([{ slate: 'board', namespace: 'slates.digest', member: 'digest', impact: 'observe', ok: true }]);
});

it('a blueprint import brings the code and runs none of it', async () => {
  const probe = subject('blueprint-import');
  await probe.start();

  expect(await probe.importBlueprint()).toEqual({ fork: expect.not.stringMatching(/^board$/u), running: 0 });
});

it("a slate's class connects the browser its caller opened, through the eval program's gate, and no other", async () => {
  const probe = subject('driver');
  await probe.start();

  // The gate admitted the caller's own session and reached Browser Run for it, where the CDP socket would answer.
  expect(await probe.drive('owned-session')).toContain('Browser Run reached session owned-session');
  expect(await probe.drive('not-mine')).toContain('browser not-mine is not one this agent opened');
  // A Kitesurf browser is opened for the call itself.
  expect(await probe.drive('kitesurf')).toContain('Browser Run started a Kitesurf browser');
  // Each was authorized at the host before the class dialed, so the slate's graph names it as any call it made.
  const graph = v.parse(GraphSchema, answer(await probe.operationAs('root', { op: 'graph', id: 'driver' })));

  expect(graph.namespaces.find((row) => row.namespace === 'web')?.members).toContainEqual(expect.objectContaining({ member: 'connectBrowser', impact: 'execute' }));
});

it("a share's viewer drives a browser from the class only as the grant allows, and never the owner's session", async () => {
  const ungranted = subject('driver-ungranted');
  await ungranted.start();

  // Not granted: refused at the host before the class dials, so no browser opens on the owner's account.
  expect(await ungranted.driveShared('kitesurf', [], CLAIM)).toMatchObject({ dialed: 0 });

  const granted = subject('driver-granted');
  await granted.start();

  // Granted: a new Kitesurf browser, and still none of the owner's own sessions.
  expect(await granted.driveShared('kitesurf', ['connectBrowser'], CLAIM)).toEqual({ answer: expect.stringContaining('Browser Run started a Kitesurf browser'), dialed: 1 });
  expect(await granted.driveShared('owned-session', ['connectBrowser'], CLAIM)).toMatchObject({ dialed: 0 });
});

it('a slate\'s class reads ai.stream a piece at a time, as the model writes it, through the binding its calls cross', async () => {
  const probe = env.SLATE_SHARE_PROBE.get(env.SLATE_SHARE_PROBE.idFromName('typist'));

  const pieces: unknown = JSON.parse(await probe.typed('live'));

  // Whole and in order, in more than one read: the model's last piece came only once the class held the first.
  expect(v.parse(v.array(v.string()), pieces).join('')).toBe('Typing live');
  expect(v.parse(v.array(v.string()), pieces).length).toBeGreaterThan(1);
});

it('a slate\'s class reads agent.ask\'s reply a piece at a time, the answer\'s stream carried across the binding', async () => {
  const probe = env.SLATE_SHARE_PROBE.get(env.SLATE_SHARE_PROBE.idFromName('asker'));
  const pieces = v.parse(v.array(v.string()), JSON.parse(await probe.typed('hello', 'ask')));

  expect(pieces.join('')).toBe('The agent says hello');
  expect(pieces.length).toBeGreaterThan(1);
});
