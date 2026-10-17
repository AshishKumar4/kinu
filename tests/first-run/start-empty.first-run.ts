/**
 * A slate's first share started empty (H7, docs/SLATE-SHARING-NIMBUS.md §2). The owner's slate holds state; its share
 * made with "Start the shared copy empty" shares a copy made then, code only: named as a copy, its state starting
 * empty for a signed-out visitor, and the owner's own slate keeping its state. No model.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import { callSharedSlate, consentToShare, type EvalObservation, type EvalSubgoal, type SlateViewerAnswer } from '@kinu.run/test-utils';
import { JsonValueSchema, LiveShareCreatedSchema, type JsonValue } from '@kinu.run/core';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { webHeaders } from '../../evals/src/workspace-roster';
import { shareHost } from './share-entry';

const SUITE = 'First-run · start-empty';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: 'A slate shared live showed every visitor its owner\'s own state, with no way to share it starting empty.',
  missedBecause: 'A share always served the slate itself; a fresh copy was the client\'s to chain (commit, fork, share), which a failure partway left as an orphan in the owner\'s workspace.',
  provedRedAt: null,
  redDirection: 'RED on every deployment before H7: POST /api/shared/live ignores `start` and shares the slate itself, so the visitor reads the owner\'s count. '
    + 'Green requires the share to serve a slate other than the original, named as a shared copy, a visitor\'s count on it to be 0, and the owner\'s own slate to keep its count.',
};

const PLAN = firstRunCasePlan(SUITE, 'copy');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const Answered = v.object({ ok: v.literal(true), value: v.unknown() });

const Exec = v.object({ stdout: v.optional(v.string()), exitCode: v.optional(v.number()), error: v.optional(v.string()) });

const SLATE = 'emptystart';

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    await runFirstRunCase(PLAN, {
      id: CASE, defect: DEFECT, modelCalls: 'none', budgetMs: 5 * 60_000, genesis: false,
      purpose: 'Disposable slate whose first share starts as an empty copy; no model task.',
      async run({ session, plan }) {
        const goals: EvalSubgoal[] = [];

        const setup = v.parse(Exec, await session.execute('workspace', `mkdir -p /slates/${SLATE}
cat > /slates/${SLATE}/package.json <<'END'
{"main":"server.ts","slate":{"title":"Start empty probe"}}
END
cat > /slates/${SLATE}/server.ts <<'END'
import { SlateObject } from "kinu:slate";
export class Slate extends SlateObject {
  async bump() { const n = ((await this.storage.get("n")) ?? 0) + 1; await this.storage.put("n", n); return n; }
  async count() { return (await this.storage.get("n")) ?? 0; }
  async fetch() { return new Response("start-empty-probe-ok"); }
}
END`));

        if ((setup.exitCode ?? 1) !== 0) throw new Error('Could not author the probe slate: ' + (setup.error ?? setup.stdout ?? ''));

        // The owner's own use leaves its slate holding state.
        await session.slateOp({ op: 'call', id: SLATE, method: 'bump', args: [] });

        const made = await fetch(`${plan.origin}/api/shared/live`, {
          method: 'POST', headers: { ...webHeaders(plan.identity), 'content-type': 'application/json' },
          body: JSON.stringify({ workspace: session.workspace, slate: SLATE, visibility: 'public', start: 'empty' }),
        });

        const created = made.ok ? v.safeParse(LiveShareCreatedSchema, await made.json()) : null;
        const copy = created?.success === true ? created.output.share.slate : null;
        const url = await shareHost(plan.origin, session.workspace, created?.success === true ? created.output.share.id : undefined);
        const titled = (await session.listSlates()).slates.find((slate) => slate.id === copy)?.title ?? null;
        const visitor: SlateViewerAnswer<JsonValue> | null = url === null ? null : await callSharedSlate(url, 'count', JsonValueSchema, await consentToShare(url));
        const own = v.safeParse(Answered, await session.slateOp({ op: 'call', id: SLATE, method: 'count', args: [] }));

        goals.push({ what: 'share-serves-a-copy', reached: copy !== null && copy !== SLATE && url !== null, detail: JSON.stringify({ status: made.status, copy }) });
        goals.push({ what: 'copy-named-as-a-copy', reached: titled === 'Start empty probe (shared copy)', detail: JSON.stringify(titled) });
        goals.push({ what: 'copy-state-starts-empty', reached: visitor !== null && 'value' in visitor && visitor.value === 0, detail: JSON.stringify(visitor) });
        goals.push({ what: 'owner-slate-keeps-its-state', reached: own.success && own.output.value === 1, detail: JSON.stringify(own) });

        return goals;
      },
    }, observations);
  });
});
