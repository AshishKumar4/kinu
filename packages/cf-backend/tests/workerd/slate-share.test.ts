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

  expect(created.url).toBe(`https://${handle}.share.test/`);

  expect(await probe.viewerFetch(handle, CLAIM)).toEqual({ status: 200, body: 'share-ok' });

  // probe() reads the granted member; mutate() is refused at the grant, before the member runs.
  const batch = await probe.viewerBatch(handle, CLAIM);
  expect(batch.probe).toBe('fixture-bytes');
  expect(batch.mutateError).toContain('does not grant');

  // The invocation retires on socket close; a replay refuses 'not running'.
  const socket = await probe.viewerSocket(handle, CLAIM);
  expect(socket.probe).toBe('fixture-bytes');
  expect(socket.mutateError).toContain('does not grant');

  // A call under a share must name the running invocation it rides.
  expect(await probe.unnamedShareCall(created.share.id)).toMatchObject({ ok: false, reason: 'denied', error: expect.stringContaining('invocation') });

  const replay = await probe.replay(created.share.id);
  expect(replay).toMatchObject({ ok: false, reason: 'denied' });
  expect('error' in replay && replay.error).toContain('not running');

  const rows = v.parse(Requests, await probe.requests(created.share.id)).value;

  expect(rows.map((row) => [row.viewer, row.path, row.outcome])).toEqual([
    ['source:vitest', '/__rpc', 'closed'],
    ['source:vitest', '/__rpc', 'ok'],
    ['source:vitest', '/', 'ok'],
  ]);
  expect(rows[0]?.calls).toEqual([
    { slate: 'board', binding: 'FILES', member: 'readFile', effect: 'read', ok: true },
    { slate: 'board', binding: 'FILES', member: 'writeFile', effect: 'mutate', ok: false },
  ]);
  expect(rows[1]?.calls).toEqual(rows[0]?.calls);
  expect(rows[2]?.calls).toEqual([]);
});

const GraphSchema = v.object({
  slate: v.string(),
  slates: v.array(v.string()),
  bindings: v.array(v.looseObject({
    slate: v.string(), name: v.string(), capability: v.unknown(), problem: v.optional(v.nullable(v.string())),
    members: v.optional(v.array(v.object({ member: v.string(), effect: v.string(), risk: v.object({ public: v.string(), users: v.string() }) }))),
  })),
});

const AnsweredSchema = v.object({ ok: v.literal(true), value: v.unknown() });

const answer = (result: Awaited<ReturnType<Probe['operationAs']>>) => v.parse(AnsweredSchema, result).value;

it('a share is granted what its graph reads, across the app hop and its cycle, and what its owner approved', async () => {
  const probe = subject('triage');

  await probe.start();
  await probe.authorTriage();
  const graph = v.parse(GraphSchema, answer(await probe.operationAs('root', { op: 'graph', id: 'issues' })));
  const binding = (name: string) => graph.bindings.find((row) => `${row.slate}.${row.name}` === name);

  // The hop into the digest is walked once: its way back names the slate and grants nothing more.
  expect(graph.slates).toEqual(['issues', 'triage-digest']);
  expect(binding('triage-digest.BACK')).toMatchObject({ capability: { kind: 'slate', id: 'issues' }, members: [] });
  expect(binding('issues.GITHUB')?.members?.map((member) => [member.member, member.effect])).toEqual([['read_issue', 'read'], ['create_issue', 'mutate']]);
  expect(binding('issues.GITHUB')?.members?.[1]?.risk.public).toContain('Anyone who opens this share can trigger it.');
  expect(binding('issues.FILES')?.members?.map((member) => [member.member, member.effect])).toEqual([['readFile', 'read'], ['writeFile', 'mutate']]);

  const ShareSchema = v.object({ share: LiveShareRecordSchema, url: v.nullable(v.string()) });

  const granted = async (visibility: 'public' | 'users', approved: Array<{ slate: string; binding: string; member: string }>) => v.parse(
    ShareSchema, answer(await probe.operationAs('root', { op: 'share', id: 'issues', visibility, approved })),
  ).share.grant.members.map((member) => `${member.binding}.${member.member}`).sort();

  expect(await granted('public', [])).toEqual(['DIGEST_FILES.readFile', 'FILES.readFile', 'GITHUB.read_issue', 'NOTES.recall']);
  expect(await granted('users', [{ slate: 'issues', binding: 'ASK', member: 'send' }])).toContain('ASK.send');

  // A slate may not hold its calling agent, or its eval and hiring tools: each is a problem, and none is granted.
  const overreach = v.parse(GraphSchema, answer(await probe.operationAs('root', { op: 'graph', id: 'overreach' })));

  expect(overreach.bindings.map((row) => [row.name, Boolean(row.problem), row.members ?? []])).toEqual([
    ['CONTROL', true, []], ['TOOLS', true, []], ['HIRE', true, []],
  ]);
  expect(v.parse(ShareSchema, answer(await probe.operationAs('root', { op: 'share', id: 'overreach', visibility: 'public', approved: [] })))
    .share.grant.members).toEqual([]);
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

it('a mutating member is granted by approval only', async () => {
  const probe = subject('live-approved');
  await probe.start();

  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }),
    await probe.share([{ binding: 'FILES', member: 'writeFile' }])).value);

  // The unapproved share above refuses the same call: the approval is the grant.
  expect(await probe.viewerBatch(created.share.handle, CLAIM)).toEqual({ probe: 'fixture-bytes', mutateError: 'mutate answered' });
});

it("revoking a share refuses the next call of a session it admitted", async () => {
  const probe = subject('live-revoke-mid');
  await probe.start();
  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }), await probe.share()).value);

  const session = await probe.viewerSocketAcross(created.share.handle, CLAIM, created.share.id, 'revoke');

  expect(session.before).toBe('fixture-bytes');
  // The revoke stops the slate, so the session's own next call dies with it; one already in flight is refused.
  expect(session.after).not.toBe('fixture-bytes');
  expect(JSON.parse(session.late)).toMatchObject({ ok: false, reason: 'denied', error: expect.stringContaining('no longer shared') });
});

it('a share past its daily spend refuses calls as budget and shows paused', async () => {
  const probe = subject('live-spent');
  await probe.start();
  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }), await probe.share()).value);

  const session = await probe.viewerSocketAcross(created.share.handle, CLAIM, created.share.id, 'spend');

  expect(session).toMatchObject({ before: 'fixture-bytes', after: expect.stringContaining('paused for today') });

  const shares = v.parse(v.object({ ok: v.literal(true), value: v.array(v.looseObject({ id: v.string(), paused: v.optional(v.boolean()) })) }),
    await probe.liveShares()).value;

  expect(shares.find((row) => row.id === created.share.id)?.paused).toBe(true);
  const rows = v.parse(Requests, await probe.requests(created.share.id)).value;
  expect(rows[0]?.calls.map((call) => call.ok)).toEqual([true, false, false]);
});

it('an app hop under a share runs the slate it names and is audited under its effect', async () => {
  const probe = subject('live-hop');
  await probe.start();
  const created = v.parse(ShareCreated, v.parse(v.object({ ok: v.literal(true), value: v.unknown() }), await probe.share()).value);

  expect(created.share.grant.slates).toContain('digest');
  expect(await probe.viewerHop(created.share.handle, CLAIM)).toBe('"digest-ok"');
  const rows = v.parse(Requests, await probe.requests(created.share.id)).value;
  expect(rows[0]?.calls).toEqual([{ slate: 'board', binding: 'PEER', member: 'digest', effect: 'read', ok: true }]);
});

it('a blueprint import brings the code and runs none of it', async () => {
  const probe = subject('blueprint-import');
  await probe.start();

  expect(await probe.importBlueprint()).toEqual({ fork: expect.not.stringMatching(/^board$/u), running: 0 });
});
