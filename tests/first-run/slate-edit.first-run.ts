/**
 * FIRST RUN: a live share's editor changes its slate from a workspace of their own, on the deployed product
 * (docs/SLATE-SHARING-NIMBUS.md §2, Edit and Use).
 *
 * The owner builds a slate and calls it. The second eval account, from its own workspace, cannot read it. The owner
 * shares it with them to edit and turns on their own access; the editor reads its files and changes its server against
 * the digest they read, and the owner's next call answers the change. The change suspends the owner's access, naming
 * the editor, until the owner turns it on again; a change against a digest that moved is refused whole. Once the share
 * is revoked, the editor's next change is refused. No model call.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import { LiveShareCreatedSchema, OwnedLiveShareSchema, SharedSlateFilesSchema, type JsonValue } from '@kinu.run/core';
import { evalWorkspaceName, type EvalObservation, type EvalSubgoal } from '@kinu.run/test-utils';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { turnOnMyAccess } from './my-access';
import { webHeaders, type PublicWebIdentity } from '../../evals/src/workspace-roster';
import { openPublicSession, type KinuPublicSession } from '../../evals/src/session';

const SUITE = 'First-run · slate-edit';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: 'An editor\'s change to a slate shared on its owner\'s access ran on that access with nothing for the owner to review: the share lent the owner\'s connections to code its owner never saw.',
  missedBecause: 'The editor proofs ran in workerd against probe workspaces; no deployed row drove a second account\'s edit through its own workspace into the owner\'s, or read the owner\'s share after it.',
  provedRedAt: null,
  redDirection: 'RED on any build without editors on live shares: the share answers no editors and the editor\'s read is refused. '
    + 'Green requires the second account to be refused before it is added, to read and change the slate once added to edit it, the owner\'s next call to answer its change, '
    + 'the owner\'s access to be suspended naming the editor until the owner turns it on again, a change against a moved digest to be refused, and the editor\'s change to be refused once the share is revoked.',
};

const PLAN = firstRunCasePlan(SUITE, 'edit');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const Exec = v.object({ stdout: v.optional(v.string()), exitCode: v.optional(v.number()), error: v.optional(v.string()) });

const Profile = v.object({ email: v.string() });

/** A slate operation's answer: `{ ok: true, value }` when it went through, its refusal's reason and words when not. */
const Answer = v.union([v.object({ ok: v.literal(true), value: v.unknown() }), v.object({ ok: v.literal(false), reason: v.string(), error: v.optional(v.string()) })]);

const SLATE = 'editprobe';

const serverAnswering = (word: string): string => `import { SlateObject } from "kinu:slate";
export class Slate extends SlateObject {
  async word() { return "${word}"; }
}
`;

const PROBE_SOURCE = `mkdir -p /slates/${SLATE}
cat > /slates/${SLATE}/package.json <<'END'
{"main":"server.ts","slate":{"title":"Edit probe"}}
END
cat > /slates/${SLATE}/server.ts <<'END'
${serverAnswering('owner-wrote-this')}END`;

/** What a slate operation answered: its value, or its refusal's reason and words. */
function answered(answer: JsonValue): { readonly ok: boolean; readonly value: unknown } {
  const parsed = v.parse(Answer, answer);

  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, value: `${parsed.reason}: ${parsed.error ?? ''}` };
}

/** The share as its owner's sheet lists it now. */
async function shareNow(owner: KinuPublicSession, share: string): Promise<v.InferOutput<typeof OwnedLiveShareSchema> | null> {
  const listed = answered(await owner.slateOp({ op: 'liveShares' }));

  return listed.ok ? v.parse(v.array(OwnedLiveShareSchema), listed.value).find((row) => row.id === share) ?? null : null;
}

interface Owner {
  readonly session: KinuPublicSession;
  readonly origin: string;
  readonly headers: Record<string, string>;
}

/** The share made for the editor, on the owner's access: its id, or why it was not made. */
async function sharedToEdit(owner: Owner, email: string): Promise<{ readonly share: string; readonly on: boolean; readonly detail: string }> {
  const made = await fetch(`${owner.origin}/api/shared/live`, {
    method: 'POST', headers: { ...owner.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: owner.session.workspace, slate: SLATE, visibility: 'users', editors: [email] }),
  });

  const created = v.safeParse(LiveShareCreatedSchema, await made.json());

  if (!created.success) throw new Error(`The share to edit was not made: ${String(made.status)}`);
  const share = created.output.share.id;
  const lent = await turnOnMyAccess({ origin: owner.origin, headers: owner.headers, workspace: owner.session.workspace, share, graph: await owner.session.slateOp({ op: 'graph', id: SLATE }), approved: [] });

  return { share, on: 'on' in lent && lent.on.mode === 'owner' && created.output.share.editors.includes(email), detail: JSON.stringify({ editors: created.output.share.editors, lent }).slice(0, 400) };
}

/** The editor's side, from their own workspace: the slate's `server.ts` digest as they read it now, and a change to it. */
function editing(editor: KinuPublicSession, workspace: string) {
  const shared = { workspace, slate: SLATE };

  return {
    files: async () => answered(await editor.slateOp({ op: 'sharedFiles', ...shared })),
    digest: async (): Promise<string | null> => {
      const read = answered(await editor.slateOp({ op: 'sharedFiles', ...shared }));

      return read.ok ? v.parse(SharedSlateFilesSchema, read.value).files.find((file) => file.path === 'server.ts')?.sha256 ?? null : null;
    },
    change: async (word: string, base: string | null) => answered(await editor.slateOp({ op: 'sharedEdit', ...shared, files: { 'server.ts': { text: serverAnswering(word), base } } })),
  };
}

/** The editor's change, what the owner's next call and share sheet then show, and the owner turning their access on again. */
async function editedAndReviewed(owner: Owner, edits: ReturnType<typeof editing>, input: { readonly share: string; readonly email: string }): Promise<EvalSubgoal[]> {
  const word = async () => answered(await owner.session.slateOp({ op: 'call', id: SLATE, method: 'word', args: [] }));
  const read = await edits.digest();
  const edit = await edits.change('editor-wrote-this', read);
  const after = await word();
  const suspended = await shareNow(owner.session, input.share);
  const again = await turnOnMyAccess({ ...owner, workspace: owner.session.workspace, share: input.share, graph: await owner.session.slateOp({ op: 'graph', id: SLATE }), approved: [] });
  const cleared = await shareNow(owner.session, input.share);
  // Against the digest it read before its own change: that file has moved since, so nothing of it is written.
  const stale = await edits.change('stale', read);
  const stays = await word();

  return [
    { what: 'editor-reads-and-changes-it', reached: read !== null && edit.ok && after.ok && after.value === 'editor-wrote-this', detail: JSON.stringify({ read, edit, after }).slice(0, 400) },
    {
      what: 'edit-suspends-owner-access-naming-editor', reached: suspended?.editedBy === input.email,
      detail: JSON.stringify({ editedBy: suspended?.editedBy ?? null, mode: suspended?.mode ?? null }),
    },
    {
      what: 'owner-turns-it-on-again', reached: 'on' in again && again.on.mode === 'owner' && cleared?.mode === 'owner' && cleared.editedBy === null,
      detail: JSON.stringify({ again, editedBy: cleared?.editedBy ?? null }).slice(0, 400),
    },
    { what: 'moved-digest-refused-whole', reached: !stale.ok && stays.ok && stays.value === 'editor-wrote-this', detail: JSON.stringify({ stale, stays }).slice(0, 400) },
  ];
}

async function editedAndRevoked(owner: Owner, editor: KinuPublicSession, email: string): Promise<EvalSubgoal[]> {
  const edits = editing(editor, owner.session.workspace);
  const before = await edits.files();
  const { share, on, detail } = await sharedToEdit(owner, email);
  let live = true;

  const revoke = async (): Promise<void> => {
    live = false;
    await fetch(`${owner.origin}/api/shared/revoke`, {
      method: 'POST', headers: { ...owner.headers, 'content-type': 'application/json' }, body: JSON.stringify({ workspace: owner.session.workspace, share }),
    });
  };

  try {
    const reviewed = await editedAndReviewed(owner, edits, { share, email });
    // The digest as it stands, read while still an editor: refused after the revoke for that, not for a stale base.
    const base = await edits.digest();

    await revoke();
    const revoked = await edits.change('revoked', base);

    return [
      { what: 'unshared-cannot-read', reached: !before.ok, detail: JSON.stringify(before) },
      { what: 'shared-to-edit-on-owner-access', reached: on, detail },
      ...reviewed,
      { what: 'revoked-editor-is-refused', reached: base !== null && !revoked.ok && String(revoked.value).includes('not shared with'), detail: JSON.stringify({ base, revoked }) },
    ];
  } finally {
    if (live) await revoke();
  }
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    await runFirstRunCase(PLAN, {
      id: CASE, defect: DEFECT, modelCalls: 'none', budgetMs: 5 * 60_000, genesis: false,
      purpose: 'A slate edited by a second account it was shared with to edit, from that account\'s own workspace; no model task.',
      async run({ session, plan }) {
        const identity: PublicWebIdentity = { ...plan.identity, account: 'devices' };
        const setup = v.parse(Exec, await session.execute('workspace', PROBE_SOURCE));

        if ((setup.exitCode ?? 1) !== 0) throw new Error('Could not author the probe slate: ' + (setup.error ?? setup.stdout ?? ''));
        const first = answered(await session.slateOp({ op: 'call', id: SLATE, method: 'word', args: [] }));
        const { email } = v.parse(Profile, await (await fetch(`${plan.origin}/api/user/profile`, { headers: webHeaders(identity) })).json());

        const editor = await openPublicSession({
          origin: plan.origin, identity, workspace: evalWorkspaceName('first-run-slate-edit-editor'), purpose: 'Edits a slate another account shared with it.', genesis: false, llm: plan.llm,
        });

        try {
          return [
            { what: 'owner-call-runs', reached: first.ok && first.value === 'owner-wrote-this', detail: JSON.stringify(first) },
            ...await editedAndRevoked({ session, origin: plan.origin, headers: webHeaders(plan.identity) }, editor, email.toLowerCase()),
          ];
        } finally {
          await editor.teardown();
        }
      },
    }, observations);
  });
});
