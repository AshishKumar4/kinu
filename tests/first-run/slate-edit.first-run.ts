/**
 * FIRST RUN: one slate, edited by someone its owner added to edit it, from that person's own workspace, on the deployed
 * product.
 *
 * The owner's workspace builds a slate and calls it. The second eval account, from a workspace of its own, cannot read
 * or change it. The owner adds them to edit it over the room's socket; their workspace reads the slate's files and
 * changes its server through the room, and the owner's workspace builds the change and publishes it: the owner's next
 * call answers what the editor wrote. The owner removes them, and their next change is refused. No model call.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import { roomSocketPath, SharedSlateFilesSchema, type JsonValue } from '@kinu.run/core';
import { evalWorkspaceName, type EvalObservation, type EvalSubgoal } from '@kinu.run/test-utils';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { webHeaders, type PublicWebIdentity } from '../../evals/src/workspace-roster';
import { openPublicSession, type KinuPublicSession } from '../../evals/src/session';
import { openRoom } from './room-socket';

const SUITE = 'First-run · slate-edit';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: 'Someone added to edit a slate had no way to change it: only its owner\'s workspace held its files, so the Edit role granted nothing beyond use.',
  missedBecause: 'The room\'s proofs checked what an edit does to grants; none drove an edit made by anyone but the owner.',
  provedRedAt: null,
  redDirection: 'Green requires the second account\'s workspace to be refused before it is added, to read and change the slate once added to edit it, the owner\'s next call to answer its change, and its change to be refused once removed.',
};

const PLAN = firstRunCasePlan(SUITE, 'edit');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const Exec = v.object({ stdout: v.optional(v.string()), exitCode: v.optional(v.number()), error: v.optional(v.string()) });

const Profile = v.object({ email: v.string() });

/** A slate operation's answer: `{ ok: true, value }` when it went through, its refusal's reason when not. */
const Answer = v.union([v.object({ ok: v.literal(true), value: v.unknown() }), v.object({ ok: v.literal(false), reason: v.string() })]);

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

/** What a slate operation answered: its value, or its refusal's reason. */
function answered(answer: JsonValue): { readonly ok: boolean; readonly value: unknown } {
  const parsed = v.parse(Answer, answer);

  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, value: parsed.reason };
}

/** The editor's own workspace: the change is made from there, as their agent makes it. */
async function editorSession(origin: string, identity: PublicWebIdentity, llm: NonNullable<typeof PLAN>['llm']): Promise<KinuPublicSession> {
  return await openPublicSession({
    origin, identity, workspace: evalWorkspaceName('first-run-slate-edit-editor'), purpose: 'Edits a slate another account shared with it.', genesis: false, llm,
  });
}

async function editedAndRemoved(owner: { session: KinuPublicSession; headers: Record<string, string> }, editor: KinuPublicSession, email: string): Promise<EvalSubgoal[]> {
  const shared = { workspace: owner.session.workspace, slate: SLATE };
  const before = answered(await editor.slateOp({ op: 'sharedFiles', ...shared }));
  const room = await openRoom(owner.session.web.origin, owner.headers, roomSocketPath(owner.session.workspace, SLATE));

  try {
    await room.call({ op: 'invite', email, role: 'edit' });
    const read = answered(await editor.slateOp({ op: 'sharedFiles', ...shared }));
    const files = read.ok ? v.parse(SharedSlateFilesSchema, read.value).files.map((file) => file.path) : [];
    const edit = answered(await editor.slateOp({ op: 'sharedEdit', ...shared, files: { 'server.ts': serverAnswering('editor-wrote-this') } }));
    const after = answered(await owner.session.slateOp({ op: 'call', id: SLATE, method: 'word', args: [] }));

    await room.call({ op: 'remove', email });
    const removed = answered(await editor.slateOp({ op: 'sharedEdit', ...shared, files: { 'server.ts': serverAnswering('removed') } }));

    return [
      {
        what: 'unshared-cannot-read', reached: !before.ok && before.value === 'denied', detail: JSON.stringify(before),
      },
      {
        what: 'editor-reads-and-changes-it', reached: files.includes('server.ts') && edit.ok && after.ok && after.value === 'editor-wrote-this',
        detail: JSON.stringify({ files, edit, after }).slice(0, 400),
      },
      { what: 'removed-editor-is-refused', reached: !removed.ok, detail: JSON.stringify(removed) },
    ];
  } finally {
    room.close();
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
        const editor = await editorSession(plan.origin, identity, plan.llm);

        try {
          return [
            { what: 'owner-call-publishes', reached: first.ok && first.value === 'owner-wrote-this', detail: JSON.stringify(first) },
            ...await editedAndRemoved({ session, headers: webHeaders(plan.identity) }, editor, email.toLowerCase()),
          ];
        } finally {
          await editor.teardown();
        }
      },
    }, observations);
  });
});
