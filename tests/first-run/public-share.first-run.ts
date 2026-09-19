/**
 * A public live share, opened signed out. The owner shares a slate whose one
 * binding has a read member and a mutating member, approves nothing, and a
 * visitor with no account opens the share URL, calls the read member over
 * Cap'n Web and is refused the mutating one. No model; the CLI operator plan.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import { callSharedSlate, consentToShare, type EvalObservation, type SlateViewerAnswer } from '@kinu.run/test-utils';
import { JsonValueSchema, LiveShareCreatedSchema, type JsonValue } from '@kinu.run/core';
import { FIRST_RUN_DEFECTS, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { operatorFirstRunPlan } from './operator-session';

const CASE = 'public-share';

const SUITE = 'First-run · public-share (CLI operator, no model, signed-out visitor)';

const PLAN = operatorFirstRunPlan();

const observations: EvalObservation[] = [];

const Exec = v.object({ stdout: v.string(), exitCode: v.number() });

const Answered = v.object({ ok: v.literal(true), value: v.unknown() });

const Refused = v.object({ ok: v.literal(false), reason: v.string(), error: v.string() });

const SLATE = 'public-share';

afterAll(() => publishFirstRunRecord(SUITE, undefined, [CASE], observations));

/** The visitor's Cap'n Web batch against the share origin, parsed as JSON,
 *  carrying the consent the credentialed share asks for first. */
function viewerCall(url: string, method: 'probe' | 'mutate', cookie: string): Promise<SlateViewerAnswer<JsonValue>> {
  return callSharedSlate(url, method, JsonValueSchema, cookie);
}

describe(SUITE, () => {
  test.skipIf(PLAN === null)('MEASURED: public-share', async () => {
    if (PLAN === null) throw new Error('Explicit operator plan required');
    await runFirstRunCase(PLAN, {
      id: CASE, modelCalls: 'none', purpose: 'Disposable public live-share probe; no model task.',
      async run({ session }) {
        const setup = v.parse(Exec, await session.rpcAt(session.workspace, 'executeInExecutor', ['workspace', `mkdir -p /home/user/slates/${SLATE}
cat > /home/user/slates/${SLATE}/package.json <<'END'
{"main":"server.ts","slate":{"title":"Public share probe","bindings":{"FILES":{"kind":"namespace","namespace":"workspace","members":["exists","writeFile"]}}}}
END
cat > /home/user/slates/${SLATE}/server.ts <<'END'
import { SlateObject } from "kinu:slate";
export class Slate extends SlateObject {
  async probe() { return { exists: await this.env.FILES.exists("/home/user/slates") }; }
  async mutate() { return await this.env.FILES.writeFile("/home/user/slates/${SLATE}/mark", "x"); }
  async fetch() { return new Response("public-share-probe-ok"); }
}
END`]));

        if (setup.exitCode !== 0) throw new Error('Could not author the probe slate: ' + setup.stdout);
        // The RED direction on a build with no share route: the op is refused
        // as unknown and nothing below has a URL to open.
        const shared = await session.rpcAt(session.workspace, 'slate', [{ op: 'share', id: SLATE, visibility: 'public', approved: [] }]);
        const answered = v.safeParse(Answered, shared);
        const created = answered.success ? v.safeParse(LiveShareCreatedSchema, answered.output.value) : null;
        const url = created?.success === true ? created.output.url : null;
        const refusal = v.safeParse(Refused, shared);
        let served: { status: number; body: string } | null = null;
        let probe: SlateViewerAnswer<JsonValue> | null = null;
        let mutate: SlateViewerAnswer<JsonValue> | null = null;

        if (url !== null) {
          // Signed out: no identity, no bearer — only the consent the share
          // asks every viewer for.
          const cookie = await consentToShare(url);
          const response = await fetch(url, { headers: { cookie } });
          served = { status: response.status, body: (await response.text()).slice(0, 200) };
          probe = await viewerCall(url, 'probe', cookie);
          mutate = await viewerCall(url, 'mutate', cookie);
        }

        return [
          { what: 'share-op-answers-url', reached: url !== null,
            detail: JSON.stringify({ deployedSha: session.deployedSha, refused: refusal.success ? refusal.output : null, url: url !== null }) },
          { what: 'public-share-serves-signed-out', reached: served?.status === 200 && served.body === 'public-share-probe-ok',
            detail: JSON.stringify(served) },
          { what: 'read-only-member-answers', reached: probe !== null && 'value' in probe && v.is(v.object({ exists: v.literal(true) }), probe.value),
            detail: JSON.stringify(probe) },
          { what: 'mutating-member-refused', reached: mutate !== null && 'error' in mutate && mutate.error.includes('does not grant'),
            detail: JSON.stringify(mutate) },
        ];
      },
    }, observations);
  });
});

export const DEFECT = FIRST_RUN_DEFECTS[CASE];
