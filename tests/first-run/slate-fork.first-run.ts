/**
 * FIRST RUN: one slate, listed in the Gallery and forked by a second account, on the deployed product.
 *
 * The owner's workspace builds a slate and calls it, which publishes it to its room. The owner turns its link on and
 * lists it; the second eval account finds the listing in the Gallery, and the listing carries the link. Without the
 * link's key the fork is refused; with it the second account sees what a fork brings, is refused a fork into the
 * owner's workspace, and forks into a workspace of its own. The fork is its code alone: called there, it starts from
 * empty state, not the owner's. The owner turns the link off: the listing is gone, and the key forks nothing.
 * No model call.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import { ForkPreviewSchema, ForkedSchema, galleryPath, GalleryPageSchema, roomForkPath, roomSocketPath } from '@kinu.run/core';
import { evalWorkspaceName, type EvalObservation, type EvalSubgoal } from '@kinu.run/test-utils';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { webHeaders, type PublicWebIdentity } from '../../evals/src/workspace-roster';
import { openRoom, type RoomSocket } from './room-socket';
import { openPublicSession, type KinuPublicSession, type PublicSessionPlan } from '../../evals/src/session';

const SUITE = 'First-run · slate-fork';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: 'A published blueprint forked the owner\'s slate by name to anyone who asked for it, and a fork\'s first run read the owner\'s state and connections through its bindings.',
  missedBecause: 'The blueprint proofs checked the bundle\'s bytes against its skeleton; none asked who may fork, or what a fork carries beyond its code.',
  provedRedAt: null,
  redDirection: 'Green requires a listed slate to be found in the Gallery with its link, a fork without the key and a fork into another\'s workspace to be refused, the forker\'s own fork to start from empty state, and the link\'s end to unlist it and refuse the key.',
};

const PLAN = firstRunCasePlan(SUITE, 'fork');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const Exec = v.object({ stdout: v.optional(v.string()), exitCode: v.optional(v.number()), error: v.optional(v.string()) });

const SLATE = 'forkprobe';

/** The listing's line: searched for by the second account, unique to this run. */
const LINE = `Fork probe ${crypto.randomUUID().slice(0, 8)}`;

const PROBE_SOURCE = `mkdir -p /slates/${SLATE}
cat > /slates/${SLATE}/package.json <<'END'
{"main":"server.ts","slate":{"title":"Fork probe"}}
END
cat > /slates/${SLATE}/server.ts <<'END'
import { SlateObject } from "kinu:slate";
export class Slate extends SlateObject {
  async add(who) {
    const people = (await this.storage.get("people")) ?? [];
    people.push(who);
    await this.storage.put("people", people);
    return people.length;
  }
}
END`;

/** The listing as the second account finds it in the Gallery: its link's key, or null when it is not listed. */
async function listedKey(origin: string, headers: Record<string, string>, workspace: string): Promise<string | null> {
  const answer = await fetch(`${origin}${galleryPath({ q: LINE, sort: 'new', category: null, page: 0 })}`, { headers });
  const page = v.parse(GalleryPageSchema, await answer.json());
  const listing = page.listings.find((each) => each.workspace === workspace && each.slate === SLATE);

  return listing === undefined ? null : new URL(listing.url, origin).searchParams.get('k');
}

/** The fork's route as the second account reaches it, with the link's key or without. */
function forkUrl(origin: string, workspace: string, key: string | null): string {
  return `${origin}${roomForkPath(workspace, SLATE)}${key === null ? '' : `?k=${encodeURIComponent(key)}`}`;
}

async function forkInto(at: { origin: string; workspace: string; key: string }, headers: Record<string, string>, into: string): Promise<Response> {
  return await fetch(forkUrl(at.origin, at.workspace, at.key), {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ workspace: into }),
  });
}

/** The second account forks with the key: refused into the owner's workspace, landed in its own, and called there. */
async function forkedAlone(at: { origin: string; workspace: string; key: string }, forker: { headers: Record<string, string>; session: KinuPublicSession }): Promise<EvalSubgoal[]> {
  const intoOwners = await forkInto(at, forker.headers, at.workspace);
  const intoOwn = await forkInto(at, forker.headers, forker.session.workspace);
  const forked = intoOwn.ok ? v.parse(ForkedSchema, await intoOwn.json()) : null;
  const called = forked === null ? null : await forker.session.slateOp({ op: 'call', id: forked.slate, method: 'add', args: ['forker'] });

  return [
    {
      what: 'fork-lands-in-the-forkers-workspace',
      reached: intoOwners.status === 403 && forked?.workspace === forker.session.workspace,
      detail: JSON.stringify({ intoOwners: intoOwners.status, intoOwn: intoOwn.status, forked }),
    },
    { what: 'fork-starts-from-its-code-alone', reached: JSON.stringify(called) === JSON.stringify(1), detail: JSON.stringify(called).slice(0, 200) },
  ];
}

/** The listing found, the fork's preview behind the key, and the fork itself. */
async function listedAndForked(at: { origin: string; workspace: string }, forker: { headers: Record<string, string>; session: KinuPublicSession }): Promise<EvalSubgoal[]> {
  const key = await listedKey(at.origin, forker.headers, at.workspace);
  const keyless = await fetch(forkUrl(at.origin, at.workspace, null), { headers: forker.headers });
  const keyed = key === null ? null : await fetch(forkUrl(at.origin, at.workspace, key), { headers: forker.headers });
  const preview = keyed?.ok === true ? v.parse(ForkPreviewSchema, await keyed.json()) : null;

  const found: EvalSubgoal[] = [
    { what: 'listed-with-its-link', reached: key !== null, detail: JSON.stringify({ line: LINE, key: key !== null }) },
    {
      what: 'fork-needs-the-link', reached: keyless.status === 403 && preview?.title === 'Fork probe',
      detail: JSON.stringify({ keyless: keyless.status, keyed: keyed?.status ?? null, preview }),
    },
  ];

  return key === null ? found : [...found, ...await forkedAlone({ ...at, key }, forker)];
}

/** The owner ends the link: the listing goes, and the key the second account held forks nothing. */
async function linkEnded(at: { origin: string; workspace: string }, owner: RoomSocket, forker: Record<string, string>, key: string | null): Promise<EvalSubgoal> {
  await owner.call({ op: 'setAudience', audience: 'only-you' });
  const listed = await listedKey(at.origin, forker, at.workspace);
  const after = await fetch(forkUrl(at.origin, at.workspace, key), { headers: forker });

  return {
    what: 'link-off-unlists', reached: listed === null && after.status >= 400,
    detail: JSON.stringify({ listed: listed !== null, fork: after.status }),
  };
}

/** The second account's own workspace, opened as its session: the fork lands there and is called there. */
async function forkerSession(plan: PublicSessionPlan, identity: PublicWebIdentity): Promise<KinuPublicSession> {
  return await openPublicSession({
    origin: plan.origin, identity, workspace: evalWorkspaceName('first-run-slate-fork-forker'),
    purpose: 'Receives a fork of another account\'s slate.', genesis: false, llm: plan.llm,
  });
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    await runFirstRunCase(PLAN, {
      id: CASE, defect: DEFECT, modelCalls: 'none', genesis: false,
      purpose: 'A slate listed in the Gallery and forked by a second account into its own workspace; no model task.',
      async run({ session, plan }) {
        const identity: PublicWebIdentity = { ...plan.identity, account: 'devices' };
        const at = { origin: plan.origin, workspace: session.workspace };
        const setup = v.parse(Exec, await session.execute('workspace', PROBE_SOURCE));

        if ((setup.exitCode ?? 1) !== 0) throw new Error('Could not author the probe slate: ' + (setup.error ?? setup.stdout ?? ''));
        const first = await session.slateOp({ op: 'call', id: SLATE, method: 'add', args: ['owner'] });
        const owner = await openRoom(plan.origin, webHeaders(plan.identity), roomSocketPath(session.workspace, SLATE));
        const forker = await forkerSession(plan, identity);

        try {
          await owner.call({ op: 'setAudience', audience: 'anyone' });
          await owner.view((view) => view.sheet?.url !== null && view.sheet?.url !== undefined);
          const listed = await owner.call({ op: 'list', line: LINE, category: 'fun' });
          const headers = webHeaders(identity);
          const forked = await listedAndForked(at, { headers, session: forker });
          const key = await owner.view((view) => view.sheet?.url !== null && view.sheet?.url !== undefined);

          return [
            { what: 'owner-call-publishes', reached: JSON.stringify(first) === JSON.stringify(1), detail: JSON.stringify({ first, listed }).slice(0, 300) },
            ...forked,
            await linkEnded(at, owner, headers, new URL(key.sheet?.url ?? '', plan.origin).searchParams.get('k')),
          ];
        } finally {
          await owner.call({ op: 'unlist' });
          await owner.call({ op: 'setAudience', audience: 'only-you' });
          owner.close();
          await forker.teardown();
        }
      },
    }, observations);
  });
});
