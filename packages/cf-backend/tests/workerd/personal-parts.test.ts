import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import type { PartRunAnswer } from '@kinu.run/core/slates';
import type { SlateShareProbeRpc } from './env';

type Probe = DurableObjectStub<SlateShareProbeRpc>;

// SAFETY: the binding is the probe worker's own class; the Rpc interface is its exact surface.
const subject = (name: string): Probe => env.SLATE_SHARE_PROBE.get(env.SLATE_SHARE_PROBE.idFromName(name));

const REPO = { owner: 'acme', repo: 'notes' };

const ALICES = 'alice@probe.test-private-17';

/** A probe with the notes slate shared, and each person named here allowed to read their own issue in it. */
async function started(name: string, readers: readonly string[] = ['alice']): Promise<{ probe: Probe; revision: string }> {
  const probe = subject(name);
  const revision = await probe.startParts();

  for (const reader of readers) await probe.consent(reader, { server: 'mcp.GitHub', root: REPO, tools: ['read_issue'], effects: false, revision });

  return { probe, revision };
}

function shown(answer: PartRunAnswer | null): Extract<PartRunAnswer, { kind: 'shown' }> {
  if (answer?.kind !== 'shown') return expect.unreachable(`a drawn part, not ${JSON.stringify(answer)}`);

  return answer;
}

it("a viewer's part shows them their own data, drawn by Kinu with no script, link or resource, and no one else's", async () => {
  const { probe } = await started('parts-own');
  const alice = shown(await probe.runPart('alice', 'mine'));

  expect(alice.html).toContain(ALICES);
  expect(alice.html).toContain(`Content-Security-Policy" content="default-src 'none'`);

  for (const gone of ['<script', 'steal()', '<img', 'href', 'onclick', 'author.example']) expect(alice.html).not.toContain(gone);
  expect(alice.actions).toEqual([{ id: 'refresh', label: 'Refresh' }]);
  expect(alice.show).toEqual({ label: 'My issue', value: ALICES });

  // Bob has not let the slate read his issue: he is asked, and sees nothing of Alice's.
  expect(await probe.runPart('bob', 'mine')).toMatchObject({ kind: 'needs-consent', ask: { server: 'mcp.GitHub', root: REPO, tools: ['read_issue'] } });
  // Carol is not shared the slate: nothing at all, as for a slate that does not exist. Signed out: sign in.
  expect(await probe.runPart('carol', 'mine')).toBeNull();
  expect(await probe.runPart(null, 'mine')).toMatchObject({ kind: 'stub', reason: 'signed-out' });
});

it('H1, H5, H11. what a part reads reaches no shared state, network, owner namespace or browser, and nothing of the workspace', async () => {
  const { probe } = await started('parts-leak');
  const leaky = shown(await probe.runPart('alice', 'leaky'));

  expect(leaky.html).toContain(JSON.stringify({ storage: 'refused', file: 'refused', network: 'refused', slates: 'refused', browser: 'refused' }));
  // The shared server holds none of it: not in its storage, not in its own SQL.
  expect(await probe.notesCall('board')).toEqual({ ok: true, value: null });
  expect(await probe.notesCall('serverKept')).toEqual({ ok: true, value: 0 });
  // Nor does any row of the owner's workspace.
  expect(await probe.workspaceHolds(ALICES)).toEqual([]);
});

it('H1. read private data, then hand it to a tool that may reach any address: nothing leaves until she approves that exact call', async () => {
  const { probe, revision } = await started('parts-egress');

  await probe.consent('alice', { server: 'mcp.Fetch', root: {}, tools: ['get'], effects: true, revision });
  const asked = await probe.runPart('alice', 'egress');
  const url = `https://author.example/?d=${ALICES}`;

  expect(asked).toMatchObject({ kind: 'needs-approval', ask: { server: 'mcp.Fetch', tool: 'get', root: {}, payload: { url } } });
  expect((await probe.dispatched()).filter((call) => call.includes('mcp.Fetch'))).toEqual([]);

  if (asked?.kind !== 'needs-approval') return;
  expect(await probe.decide('alice', asked.ask.id, true)).toBe(true);
  expect(shown(await probe.runPart('alice', 'egress')).html).toContain('get done');
  // Approved once, dispatched once: the next run asks again.
  expect((await probe.dispatched()).filter((call) => call.includes('mcp.Fetch'))).toEqual([`alice@probe.test mcp.Fetch.get ${JSON.stringify({ url })}`]);
  expect(await probe.runPart('alice', 'egress')).toMatchObject({ kind: 'needs-approval' });
});

it('a run keeps nothing: the next run of the image starts clean, and a call after a run ended is refused', async () => {
  const { probe } = await started('parts-stash', ['alice', 'bob']);

  expect(shown(await probe.runPart('alice', 'stash')).html).toContain('<p>none</p>');
  expect(shown(await probe.runPart('bob', 'stash')).html).toContain('<p>none</p>');
  // Bob's run's own name, replayed after it ended: refused, and his issue is read no more.
  const reads = (await probe.dispatched()).length;

  expect(await probe.lateCall()).toMatchObject({ ok: false, reason: 'denied', error: expect.stringContaining('run has ended') });
  expect(await probe.dispatched()).toHaveLength(reads);
});

it('H2, H3. a send with her grant runs only once she approves that payload, once', async () => {
  const { probe, revision } = await started('parts-act');

  // Read-only consent: a send is asked for, as a send.
  expect(await probe.runPart('alice', 'act', ['hello'])).toMatchObject({ kind: 'needs-consent', ask: { tools: ['read_issue', 'create_issue'], effects: true } });
  await probe.consent('alice', { server: 'mcp.GitHub', root: REPO, tools: ['read_issue', 'create_issue'], effects: true, revision });
  const asked = await probe.runPart('alice', 'act', ['hello']);

  expect(asked).toMatchObject({ kind: 'needs-approval', ask: { tool: 'create_issue', payload: { ...REPO, title: 'hello' } } });

  if (asked?.kind !== 'needs-approval') return;
  await probe.decide('alice', asked.ask.id, true);
  // Another payload is not what she approved.
  expect(await probe.runPart('alice', 'act', ['other'])).toMatchObject({ kind: 'needs-approval' });
  expect(shown(await probe.runPart('alice', 'act', ['hello'])).html).toContain('acted');
  expect(await probe.runPart('alice', 'act', ['hello'])).toMatchObject({ kind: 'needs-approval' });
  expect((await probe.dispatched()).filter((call) => call.includes('create_issue'))).toHaveLength(1);
});

it('H4. a consent names the revision it was given for: an edit asks again', async () => {
  const { probe, revision } = await started('parts-edit');

  shown(await probe.runPart('alice', 'mine'));
  const edited = await probe.editParts();

  expect(edited).not.toBe(revision);
  expect(await probe.runPart('alice', 'mine')).toMatchObject({ kind: 'needs-consent', ask: { revision: edited } });
});

it("what she shows everyone is exactly the value she confirmed, into the slate's declared method, at the revision she saw", async () => {
  const { probe, revision } = await started('parts-show');
  const drawn = shown(await probe.runPart('alice', 'mine'));

  expect(await probe.showPart('alice', drawn.revision, ALICES)).toEqual({ ok: true, value: 'kept' });
  expect(await probe.notesCall('board')).toEqual({ ok: true, value: { value: ALICES, by: 'alice@probe.test' } });
  expect(drawn.revision).toBe(revision);
  expect(await probe.showPart('alice', 'stale', ALICES)).toMatchObject({ ok: false, error: expect.stringContaining('changed since') });
});
