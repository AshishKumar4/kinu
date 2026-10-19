/**
 * A public live share, opened signed out. The owner shares a slate whose one
 * binding has a read member and a mutating member, approves nothing, and a
 * visitor with no account opens the share URL and calls both over Cap'n Web.
 * A share starts on each viewer's own access (docs/SLATE-SHARING-NIMBUS.md §2),
 * so neither reads or writes anything of the owner's, and each refusal says who
 * can turn on "my access". No model; the CLI operator plan.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import { callSharedSlate, consentToShare, type EvalObservation, type SlateViewerAnswer } from '@kinu.run/test-utils';
import { JsonValueSchema, LiveShareCreatedSchema, type JsonValue } from '@kinu.run/core';
import { firstRunCaseId, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { operatorFirstRunPlan } from './operator-session';
import { shareHost } from './share-entry';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: 'The owner asked for a live share a stranger can open without an account and call one read-only member of, with every mutating member refused unless approved by name.',
  missedBecause: 'No deployed route served a share origin: the share label parser, the grant cut and the viewer path existed in no build, so every unit and workerd proof ran against code production never had.',
  provedRedAt: '0415e0f93',
  redDirection: 'RED against the deployed 0415e0f93 on 2026-09-15: the `share` slate op was refused as bad_input ("Expected (list | preview | … | shares) but received share"), so no URL existed to open and every later subgoal missed. Green requires the op to answer a URL a signed-out fetch serves, and, the share being on each viewer\'s own access, `probe()` and `mutate()` each refused over a Cap\'n Web batch with the words naming who can turn on My access: a build before share modes answers the probe with the owner\'s own workspace.',
};

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
      id: CASE, defect: DEFECT, modelCalls: 'none', budgetMs: 5 * 60_000, genesis: false, purpose: 'Disposable public live-share probe; no model task.',
      async run({ session }) {
        const setup = v.parse(Exec, await session.rpcAt(session.workspace, 'executeInExecutor', ['workspace', `mkdir -p /slates/${SLATE}
cat > /slates/${SLATE}/package.json <<'END'
{"main":"server.ts","slate":{"title":"Public share probe"}}
END
cat > /slates/${SLATE}/server.ts <<'END'
import { SlateObject } from "kinu:slate";
export class Slate extends SlateObject {
  async probe() { return { exists: await this.env.workspace.exists("/slates") }; }
  async mutate() { return await this.env.workspace.writeFile("/slates/${SLATE}/mark", "x"); }
  async fetch() { return new Response("public-share-probe-ok"); }
}
END`]));

        if (setup.exitCode !== 0) throw new Error('Could not author the probe slate: ' + setup.stdout);

        // A share is cut from what the owner's own calls reached: run each method once, then take the owner's mark back.
        for (const method of ['probe', 'mutate']) await session.rpcAt(session.workspace, 'slate', [{ op: 'call', id: SLATE, method, args: [] }]);
        await session.rpcAt(session.workspace, 'executeInExecutor', ['workspace', `rm -f /slates/${SLATE}/mark`]);
        // The RED direction on a build with no share route: the op is refused
        // as unknown and nothing below has a URL to open.
        const shared = await session.rpcAt(session.workspace, 'slate', [{ op: 'share', id: SLATE, visibility: 'public', approved: [] }]);
        const answered = v.safeParse(Answered, shared);
        const created = answered.success ? v.safeParse(LiveShareCreatedSchema, answered.output.value) : null;
        // Its link is the app's page for it; the visitor here drives the host that page frames.
        const url = await shareHost(session.origin, session.workspace, created?.success === true ? created.output.share.id : undefined);
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
          { what: 'own-access-reads-nothing-of-the-owner', reached: probe !== null && 'error' in probe && probe.error.includes('can turn on My access'),
            detail: JSON.stringify(probe) },
          { what: 'own-access-writes-nothing-of-the-owner', reached: mutate !== null && 'error' in mutate && mutate.error.includes('can turn on My access'),
            detail: JSON.stringify(mutate) },
        ];
      },
    }, observations);
  });
});
