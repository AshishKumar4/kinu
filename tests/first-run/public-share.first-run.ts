/**
 * A public live share, opened signed out. The owner shares a slate whose one
 * binding has a read member and a mutating member, approves nothing, and a
 * visitor with no account opens the share URL, calls the read member over
 * Cap'n Web and is refused the mutating one. No model; the CLI operator plan.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import { newHttpBatchRpcSession } from 'capnweb';
import type { EvalObservation } from '@kinu.run/test-utils';
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

/** What one visitor call settled to: the answer the guest returned, parsed as
 *  JSON, or the message of the refusal its binding proxy threw. */
interface ViewerAnswer {
  readonly value?: JsonValue;
  readonly error?: string;
}

afterAll(() => publishFirstRunRecord(SUITE, undefined, [CASE], observations));

/** The visitor's Cap'n Web batch against the share origin: one call, one
 *  settled answer — a refusal arrives as the rejection the guest's binding
 *  proxy threw, whose message names the share's own reason. */
async function viewerCall(url: string, method: 'probe' | 'mutate'): Promise<ViewerAnswer> {
  const stub = newHttpBatchRpcSession<Record<'probe' | 'mutate', () => Promise<JsonValue>>>(new URL('/__rpc', url).toString());

  try {
    return { value: v.parse(JsonValueSchema, await stub[method]()) };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
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
        let probe: ViewerAnswer | null = null;
        let mutate: ViewerAnswer | null = null;

        if (url !== null) {
          // Signed out: no cookie, no bearer, the bare share origin.
          const response = await fetch(url);
          served = { status: response.status, body: (await response.text()).slice(0, 200) };
          probe = await viewerCall(url, 'probe');
          mutate = await viewerCall(url, 'mutate');
        }

        return [
          { what: 'share-op-answers-url', reached: url !== null,
            detail: JSON.stringify({ deployedSha: session.deployedSha, refused: refusal.success ? refusal.output : null, url: url !== null }) },
          { what: 'public-share-serves-signed-out', reached: served?.status === 200 && served.body === 'public-share-probe-ok',
            detail: JSON.stringify(served) },
          { what: 'read-only-member-answers', reached: v.is(v.object({ exists: v.literal(true) }), probe?.value),
            detail: JSON.stringify(probe) },
          { what: 'mutating-member-refused', reached: mutate?.error?.includes('does not grant') === true,
            detail: JSON.stringify(mutate) },
        ];
      },
    }, observations);
  });
});

export const DEFECT = FIRST_RUN_DEFECTS[CASE];
