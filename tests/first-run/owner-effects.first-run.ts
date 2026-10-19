/**
 * A public live share on its owner's access, its one acting member approved. A signed-out visitor's write waits for
 * the owner (docs/SLATE-SHARING-NIMBUS.md §2): it parks on the owner's decision stack as that exact call, runs once
 * on their approval, and the same write made again asks again. No model.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import { callSharedSlate, consentToShare, type EvalObservation, type EvalSubgoal, type SlateViewerAnswer } from '@kinu.run/test-utils';
import { approvalKindOf, JsonValueSchema, LiveShareCreatedSchema, type JsonValue } from '@kinu.run/core';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { turnOnMyAccess } from './my-access';
import { shareHost } from './share-entry';
import { webHeaders } from '../../evals/src/workspace-roster';

const SUITE = 'First-run · owner-effects';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: 'A share on its owner\'s access let anyone holding its link act with that access, every call of an approved acting member running with no word from the owner.',
  missedBecause: 'Approving a member at share time was the only approval: the grant admitted the member, and nothing asked the owner about the call a stranger made with it.',
  provedRedAt: null,
  redDirection: 'RED on every deployment before share modes: POST /api/shared/live/mode answers 404, so the share stays on each viewer\'s own access and the write is refused for that instead of waiting. '
    + 'Green requires the write to be refused as waiting for the owner, one parked action naming this slate\'s server and its visitor, the write to run once on its approval and leave its mark in the owner\'s tree, and the same write made again to wait again.',
};

const PLAN = firstRunCasePlan(SUITE, 'effects');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const Answered = v.object({ ok: v.literal(true), value: v.unknown() });

const Exec = v.object({ stdout: v.optional(v.string()), exitCode: v.optional(v.number()), error: v.optional(v.string()) });

const SLATE = 'effectshare';

// Outside the slate's own tree: a slate's write into its own files is an edit of its code, which releases its process
// under the very call that made it.
const MARK = `${SLATE}-mark.txt`;

const WRITE = { slate: SLATE, namespace: 'workspace', member: 'writeFile' };

const waiting = (answer: SlateViewerAnswer<JsonValue> | null) => answer !== null && 'error' in answer && answer.error.includes('waits for the owner to approve it');

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    await runFirstRunCase(PLAN, {
      id: CASE, defect: DEFECT, modelCalls: 'none', budgetMs: 5 * 60_000, genesis: false,
      purpose: 'Disposable live share on its owner\'s access whose write waits for the owner; no model task.',
      async run({ session, plan }) {
        const goals: EvalSubgoal[] = [];

        const setup = v.parse(Exec, await session.execute('workspace', `mkdir -p /slates/${SLATE}
cat > /slates/${SLATE}/package.json <<'END'
{"main":"server.ts","slate":{"title":"Owner effects probe"}}
END
cat > /slates/${SLATE}/server.ts <<'END'
import { SlateObject } from "kinu:slate";
export class Slate extends SlateObject {
  async mark() { return await this.env.workspace.writeFile("${MARK}", "visitor"); }
  async fetch() { return new Response("owner-effects-probe-ok"); }
}
END`));

        if ((setup.exitCode ?? 1) !== 0) throw new Error('Could not author the probe slate: ' + (setup.error ?? setup.stdout ?? ''));

        // A share is cut from what the owner's own calls reached: run the write once, then take the owner's mark back.
        await session.slateOp({ op: 'call', id: SLATE, method: 'mark', args: [] });
        await session.execute('workspace', `rm -f ${MARK}`);
        const shared = v.safeParse(Answered, await session.slateOp({ op: 'share', id: SLATE, visibility: 'public', approved: [WRITE] }));
        const created = shared.success ? v.safeParse(LiveShareCreatedSchema, shared.output.value) : null;
        const share = created?.success === true ? created.output.share.id : null;
        const url = await shareHost(plan.origin, session.workspace, share ?? undefined);

        const lent = share === null ? null : await turnOnMyAccess({
          origin: plan.origin, headers: webHeaders(plan.identity), workspace: session.workspace, share,
          graph: await session.slateOp({ op: 'graph', id: SLATE }), approved: [WRITE],
        });

        const cookie = url === null ? null : await consentToShare(url);
        const write = async () => (url === null || cookie === null ? null : callSharedSlate(url, 'mark', JsonValueSchema, cookie));
        const marked = async () => v.parse(Exec, await session.execute('workspace', `cat ${MARK} 2>&1 || echo EFFECTS-NO-MARK`)).stdout ?? '';
        const asked = await write();
        const markBefore = await marked();

        // The owner's decision stack, as the Work tab lists it: the asks this slate's server made, read as the Work tab reads
        // them (one shared slate's server is one principal, so its asks are its slate's, whichever share they came through).
        const parked = (await session.parkedCommands()).filter((row) => {
          const kind = approvalKindOf({ command: row.command, executor: row.executor });

          return row.status === 'queued' && kind.kind === 'slate-effect' && kind.effect.slate === SLATE;
        });

        const decided = parked.length === 1 ? await session.decideParkedCommands(parked.map((row) => row.id), 'approved') : [];
        const ran = await write();
        const markAfter = await marked();
        const again = await write();
        const effect = parked.map((row) => approvalKindOf({ command: row.command, executor: row.executor }));

        goals.push({ what: 'share-on-my-access', reached: lent !== null && 'on' in lent && lent.on.mode === 'owner', detail: JSON.stringify({ url: url !== null, lent }) });
        goals.push({ what: 'visitor-write-waits-for-owner', reached: waiting(asked) && markBefore.includes('EFFECTS-NO-MARK'), detail: JSON.stringify({ asked, markBefore }) });
        goals.push({
          what: 'owner-sees-the-exact-call-parked',
          reached: effect.length === 1 && effect[0]?.kind === 'slate-effect' && effect[0].effect.tool === 'writeFile' && JSON.stringify(effect[0].effect.payload).includes(MARK),
          detail: JSON.stringify(effect),
        });
        goals.push({ what: 'approved-write-runs-once', reached: decided.length === 1 && ran !== null && 'value' in ran && markAfter.includes('visitor'), detail: JSON.stringify({ decided, ran, markAfter }) });
        goals.push({ what: 'same-write-asks-again', reached: waiting(again), detail: JSON.stringify(again) });

        return goals;
      },
    }, observations);
  });
});
