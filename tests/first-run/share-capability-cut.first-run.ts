/**
 * A public live share under a cut that admits one read member and no mutating
 * member. The owner shares a slate whose one namespace binding offers a read
 * and a mutation, approves nothing, and a signed-out visitor drives the share
 * origin: the read answers, the mutation is refused with the grant's own
 * classified code, and the owner's tree shows no effect. An agent-namespace
 * call from the slate is refused outright.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import { callSharedSlate, consentToShare, type EvalObservation, type EvalSubgoal, type SlateViewerAnswer } from '@kinu.run/test-utils';
import { JsonValueSchema, LiveShareCreatedSchema, ViewerRequestRecordSchema, type JsonValue } from '@kinu.run/core';
import { ERROR_CODES } from '@kinu.run/core/obs';
import { FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase } from './first-run';

const SUITE = 'First-run · share-capability-cut';

const CASE = 'share-capability-cut' as const;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const Answered = v.object({ ok: v.literal(true), value: v.unknown() });

const Refused = v.object({ ok: v.literal(false), reason: v.picklist(ERROR_CODES), error: v.string() });

const Exec = v.object({ stdout: v.optional(v.string()), exitCode: v.optional(v.number()), error: v.optional(v.string()) });

const ViewerRequest = v.array(ViewerRequestRecordSchema);

const SLATE = 'cutshare';

const CONTROL_SLATE = 'cutagent';

const MARK = `/slates/${SLATE}/mark`;

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    await runFirstRunCase(PLAN, {
      id: CASE, modelCalls: 'none', genesis: false,
      purpose: 'Disposable public live-share capability-cut probe; no model task.',
      async run({ session, plan }) {
        const goals: EvalSubgoal[] = [];

        const setup = v.parse(Exec, await session.execute('workspace', `mkdir -p /slates/${SLATE} /slates/${CONTROL_SLATE}
cat > /slates/${SLATE}/package.json <<'END'
{"main":"server.ts","slate":{"title":"Capability cut probe","bindings":{"FILES":{"kind":"namespace","namespace":"workspace","members":["exists","writeFile"]}}}}
END
cat > /slates/${SLATE}/server.ts <<'END'
import { SlateObject } from "kinu:slate";
export class Slate extends SlateObject {
  async probe() { return { exists: await this.env.FILES.exists("/slates") }; }
  async mutate() { return await this.env.FILES.writeFile("/slates/${SLATE}/mark", "x"); }
  async fetch() { return new Response("cut-share-probe-ok"); }
}
END
cat > /slates/${CONTROL_SLATE}/package.json <<'END'
{"main":"server.ts","slate":{"title":"Agent control probe","bindings":{"FILES":{"kind":"namespace","namespace":"workspace","members":["exists"]},"CONTROL":{"kind":"namespace","namespace":"agents"}}}}
END
cat > /slates/${CONTROL_SLATE}/server.ts <<'END'
import { SlateObject } from "kinu:slate";
export class Slate extends SlateObject {
  async probe() { return { exists: await this.env.FILES.exists("/slates") }; }
  async ctrl() { return await this.env.CONTROL.msg("x"); }
  async fetch() { return new Response("cut-agent-probe-ok"); }
}
END`));

        if ((setup.exitCode ?? 1) !== 0) throw new Error('Could not author the probe slates: ' + (setup.error ?? setup.stdout ?? ''));
        const shared = await session.slateOp({ op: 'share', id: SLATE, visibility: 'public', approved: [] });
        const answered = v.safeParse(Answered, shared);
        const created = answered.success ? v.safeParse(LiveShareCreatedSchema, answered.output.value) : null;
        const url = created?.success === true ? created.output.url : null;
        const refusal = v.safeParse(Refused, shared);
        let served: { status: number; body: string } | null = null;
        let probe: SlateViewerAnswer<JsonValue> | null = null;
        let mutate: SlateViewerAnswer<JsonValue> | null = null;
        let ctrl: SlateViewerAnswer<JsonValue> | null = null;
        let controlUrl: string | null = null;

        if (url !== null) {
          // Both probe slates reach the owner's workspace, so the share fronts
          // them with its consent page; the viewer presses Continue once and
          // carries the cookie, as a person would.
          const cookie = await consentToShare(url);
          const response = await fetch(url, { headers: { cookie } });
          served = { status: response.status, body: (await response.text()).slice(0, 200) };
          probe = await callSharedSlate(url, 'probe', JsonValueSchema, cookie);
          mutate = await callSharedSlate(url, 'mutate', JsonValueSchema, cookie);
        }

        const controlShared = await session.slateOp({ op: 'share', id: CONTROL_SLATE, visibility: 'public', approved: [] });
        const controlAnswered = v.safeParse(Answered, controlShared);
        const controlCreated = controlAnswered.success ? v.safeParse(LiveShareCreatedSchema, controlAnswered.output.value) : null;
        controlUrl = controlCreated?.success === true ? controlCreated.output.url : null;

        if (controlUrl !== null) ctrl = await callSharedSlate(controlUrl, 'ctrl', JsonValueSchema, await consentToShare(controlUrl));

        const mark = v.parse(Exec, await session.execute('workspace', `cat ${MARK} 2>&1 || echo CUTSHARE-NO-MARK`));
        const markText = mark.stdout ?? mark.error ?? '';

        const auditRaw = created?.success === true
          ? v.parse(Answered, await session.slateOp({ op: 'viewerRequests', share: created.output.share.id }))
          : null;

        const audit = auditRaw === null ? [] : v.parse(ViewerRequest, auditRaw.value);
        const mutateCode = mutate !== null && 'error' in mutate ? mutate.error.split(':')[0]?.trim() ?? '' : '';
        const ctrlCode = ctrl !== null && 'error' in ctrl ? ctrl.error.split(':')[0]?.trim() ?? '' : '';
        const mutateClassified = v.safeParse(v.picklist(ERROR_CODES), mutateCode).success ? mutateCode : '';
        const ctrlClassified = v.safeParse(v.picklist(ERROR_CODES), ctrlCode).success ? ctrlCode : '';

        goals.push({
          what: 'share-op-answers-url', reached: url !== null,
          detail: JSON.stringify({ origin: plan.origin, refused: refusal.success ? refusal.output : null, hasUrl: url !== null }),
        });
        goals.push({
          what: 'public-share-serves-signed-out', reached: served?.status === 200 && served.body === 'cut-share-probe-ok',
          detail: JSON.stringify(served),
        });
        goals.push({
          what: 'read-only-member-answers', reached: probe !== null && 'value' in probe,
          detail: JSON.stringify(probe),
        });
        goals.push({
          what: 'mutating-member-refused-with-code-and-no-effect',
          reached: mutateClassified === 'denied' && markText.includes('CUTSHARE-NO-MARK'),
          detail: JSON.stringify({ code: mutateClassified, answer: mutate, ownerMark: markText.slice(0, 120) }),
        });
        goals.push({
          what: 'agent-namespace-call-refused',
          reached: ctrlClassified === 'denied',
          detail: JSON.stringify({ code: ctrlClassified, answer: ctrl }),
        });
        goals.push({
          what: 'audit-records-admission',
          reached: audit.some((row) => row.calls.some((call) => call.member === 'exists' && call.effect === 'read' && call.ok === true))
            && audit.some((row) => row.calls.some((call) => call.member === 'writeFile' && call.ok === false)),
          detail: JSON.stringify(audit.map((row) => row.calls)),
        });

        return goals;
      },
    }, observations);
  });
});

export const DEFECT = FIRST_RUN_DEFECTS[CASE];
