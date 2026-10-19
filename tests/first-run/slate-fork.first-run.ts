/**
 * FIRST RUN: a live share forked by the account it names, into a workspace of its own, on the deployed product
 * (docs/SLATE-SHARING-NIMBUS.md §2).
 *
 * The owner builds a slate that keeps a list and calls it, so its state holds the owner's entry. A share that does not
 * allow forking forks nothing. A share that does is forked by the second eval account, not into the owner's workspace
 * but into its own: the fork is the slate's code alone, so called there it starts from empty state, and the owner's
 * slate keeps its own. Once the owner revokes the share, it forks nothing. No model call.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import { BlueprintForkSchema, LiveShareCreatedSchema, type JsonValue } from '@kinu.run/core';
import { evalWorkspaceName, type EvalObservation, type EvalSubgoal } from '@kinu.run/test-utils';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { webHeaders, type PublicWebIdentity } from '../../evals/src/workspace-roster';
import { openPublicSession, type KinuPublicSession } from '../../evals/src/session';

const SUITE = 'First-run · slate-fork';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: 'A live share\'s fork was proved only through the rooms that are gone: no deployed row forked a live share at all once slates ran as Nimbus durable apps again.',
  missedBecause: 'The rooms-era fork row was deleted with the rooms, and the blueprint row forks a published blueprint, not a live share; the live fork path was proved only in workerd.',
  provedRedAt: null,
  redDirection: 'Green requires a share that does not allow forking to fork nothing, a fork into the owner\'s workspace to be refused, the named account\'s fork into its own workspace '
    + 'to run the slate\'s code from empty state while the owner\'s keeps its own, and the revoked share to fork nothing.',
};

const PLAN = firstRunCasePlan(SUITE, 'fork');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const Exec = v.object({ stdout: v.optional(v.string()), exitCode: v.optional(v.number()), error: v.optional(v.string()) });

const Profile = v.object({ email: v.string() });

/** A slate operation's answer: `{ ok: true, value }` when it went through, its refusal's reason when not. */
const Answer = v.union([v.object({ ok: v.literal(true), value: v.unknown() }), v.object({ ok: v.literal(false), reason: v.string() })]);

const SLATE = 'forkprobe';

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
    return people;
  }
}
END`;

/** What a slate operation answered: its value, or its refusal's reason. */
function answered(answer: JsonValue): { readonly ok: boolean; readonly value: unknown } {
  const parsed = v.parse(Answer, answer);

  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, value: parsed.reason };
}

interface Owner {
  readonly session: KinuPublicSession;
  readonly origin: string;
  readonly headers: Record<string, string>;
}

/** A share of the probe naming `email`, forking or not: its id. */
async function sharedWith(owner: Owner, email: string, fork: boolean): Promise<string> {
  const made = await fetch(`${owner.origin}/api/shared/live`, {
    method: 'POST', headers: { ...owner.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: owner.session.workspace, slate: SLATE, visibility: 'users', emails: [email], fork }),
  });

  const created = v.safeParse(LiveShareCreatedSchema, await made.json());

  if (!created.success) throw new Error(`The share was not made: ${String(made.status)}`);

  return created.output.share.id;
}

/** The forker's fork of `share` into `workspace`: its status, and the fork when it was made. */
async function forked(owner: Owner, forker: Record<string, string>, share: string, workspace: string) {
  const response = await fetch(`${owner.origin}/api/shared/fork`, {
    method: 'POST', headers: { ...forker, 'content-type': 'application/json' },
    body: JSON.stringify({ live: share, ownerWorkspace: owner.session.workspace, workspace }),
  });

  const text = await response.text();
  const fork = response.ok ? v.safeParse(BlueprintForkSchema, JSON.parse(text)) : null;

  return { status: response.status, fork: fork?.success === true ? fork.output : null, text: text.slice(0, 200) };
}

async function forkedAndRevoked(owner: Owner, forker: { readonly session: KinuPublicSession; readonly headers: Record<string, string> }, email: string): Promise<EvalSubgoal[]> {
  const closed = await sharedWith(owner, email, false);
  const open = await sharedWith(owner, email, true);
  const live = new Set([closed, open]);

  const revoke = async (share: string): Promise<void> => {
    live.delete(share);
    await fetch(`${owner.origin}/api/shared/revoke`, {
      method: 'POST', headers: { ...owner.headers, 'content-type': 'application/json' }, body: JSON.stringify({ workspace: owner.session.workspace, share }),
    });
  };

  try {
    const refused = await forked(owner, forker.headers, closed, forker.session.workspace);
    const intoOwners = await forked(owner, forker.headers, open, owner.session.workspace);
    const made = await forked(owner, forker.headers, open, forker.session.workspace);
    const theirs = made.fork === null ? null : answered(await forker.session.slateOp({ op: 'call', id: made.fork.slate, method: 'add', args: ['forker'] }));
    const owners = answered(await owner.session.slateOp({ op: 'call', id: SLATE, method: 'add', args: ['owner-again'] }));

    await revoke(open);
    const afterRevoke = await forked(owner, forker.headers, open, forker.session.workspace);

    return [
      { what: 'no-fork-share-forks-nothing', reached: refused.status >= 400 && refused.fork === null, detail: JSON.stringify(refused) },
      { what: 'fork-into-owners-workspace-refused', reached: intoOwners.status >= 400 && intoOwners.fork === null, detail: JSON.stringify(intoOwners) },
      {
        what: 'fork-starts-from-empty-state',
        reached: theirs?.ok === true && JSON.stringify(theirs.value) === '["forker"]'
          && owners.ok && JSON.stringify(owners.value) === '["owner","owner-again"]',
        detail: JSON.stringify({ made, theirs, owners }).slice(0, 400),
      },
      { what: 'revoked-share-forks-nothing', reached: afterRevoke.status >= 400 && afterRevoke.fork === null, detail: JSON.stringify(afterRevoke) },
    ];
  } finally {
    await Promise.all([...live].map(revoke));
  }
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    await runFirstRunCase(PLAN, {
      id: CASE, defect: DEFECT, modelCalls: 'none', budgetMs: 5 * 60_000, genesis: false,
      purpose: 'A live share forked by the second account it names into a workspace of its own; no model task.',
      async run({ session, plan }) {
        const identity: PublicWebIdentity = { ...plan.identity, account: 'devices' };
        const setup = v.parse(Exec, await session.execute('workspace', PROBE_SOURCE));

        if ((setup.exitCode ?? 1) !== 0) throw new Error('Could not author the probe slate: ' + (setup.error ?? setup.stdout ?? ''));
        const first = answered(await session.slateOp({ op: 'call', id: SLATE, method: 'add', args: ['owner'] }));
        const { email } = v.parse(Profile, await (await fetch(`${plan.origin}/api/user/profile`, { headers: webHeaders(identity) })).json());

        const forker = await openPublicSession({
          origin: plan.origin, identity, workspace: evalWorkspaceName('first-run-slate-fork-forker'), purpose: 'Forks a slate another account shared with it.', genesis: false, llm: plan.llm,
        });

        try {
          return [
            { what: 'owner-state-holds-its-entry', reached: first.ok && JSON.stringify(first.value) === '["owner"]', detail: JSON.stringify(first) },
            ...await forkedAndRevoked({ session, origin: plan.origin, headers: webHeaders(plan.identity) }, { session: forker, headers: webHeaders(identity) }, email.toLowerCase()),
          ];
        } finally {
          await forker.teardown();
        }
      },
    }, observations);
  });
});
