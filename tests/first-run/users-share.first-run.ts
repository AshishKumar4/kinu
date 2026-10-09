/**
 * A live share for named people, entered through its one link. The owner shares a slate naming a second eval account;
 * the link sends a visitor with no viewer cookie to the app's page for the share, where the named account, signed in,
 * is handed its ticket and comes back to the share as itself. No model.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import { LiveShareCreatedSchema, liveSharePagePath } from '@kinu.run/core';
import { FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { webHeaders } from '../../evals/src/session';

const SUITE = 'First-run · users-share';

const CASE = 'users-share' as const;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const Exec = v.object({ stdout: v.optional(v.string()), exitCode: v.optional(v.number()), error: v.optional(v.string()) });

const Profile = v.object({ email: v.string() });

const Opened = v.object({ url: v.string() });

const SLATE = 'usershare';

const BODY = 'users-share-probe-ok';

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    await runFirstRunCase(PLAN, {
      id: CASE, modelCalls: 'none', genesis: false,
      purpose: 'Disposable users share entered by a second account through its link; no model task.',
      async run({ session, plan }) {
        const goals: EvalSubgoal[] = [];
        const owner = webHeaders(plan.identity);
        const recipient = webHeaders({ ...plan.identity, account: 'devices' });

        const setup = v.parse(Exec, await session.execute('workspace', `mkdir -p /slates/${SLATE}
cat > /slates/${SLATE}/package.json <<'END'
{"main":"server.ts","slate":{"title":"Users share probe"}}
END
cat > /slates/${SLATE}/server.ts <<'END'
import { SlateObject } from "kinu:slate";
export class Slate extends SlateObject {
  async fetch() { return new Response("${BODY}"); }
}
END`));

        if ((setup.exitCode ?? 1) !== 0) throw new Error('Could not author the probe slate: ' + (setup.error ?? setup.stdout ?? ''));
        const { email } = v.parse(Profile, await (await fetch(`${plan.origin}/api/user/profile`, { headers: recipient })).json());

        const made = await fetch(`${plan.origin}/api/shared/live`, {
          method: 'POST', headers: { ...owner, 'content-type': 'application/json' },
          body: JSON.stringify({ workspace: session.workspace, slate: SLATE, visibility: 'users', emails: [email] }),
        });

        const created = v.safeParse(LiveShareCreatedSchema, await made.json());

        if (!created.success || created.output.url === null) throw new Error(`The users share was not made: ${String(made.status)}`);
        const { share, url } = created.output;

        try {
          goals.push({ what: 'answer-names-recipient', reached: share.users.includes(email), detail: JSON.stringify(share.users) });

          // The link, followed with no viewer cookie, leads to the app's page for this share.
          const first = await fetch(url, { redirect: 'manual' });
          const page = `${plan.origin}${liveSharePagePath(session.workspace, share.id)}`;

          goals.push({
            what: 'link-sends-visitor-to-sign-in', reached: first.status === 303 && first.headers.get('location') === page,
            detail: JSON.stringify({ status: first.status, location: first.headers.get('location') }),
          });

          // Signed in there as the named account, the page's open hands it a ticket the share exchanges for its cookie.
          const shown = await fetch(page, { headers: recipient });

          const opened = await fetch(`${plan.origin}/api/shared/live/open`, {
            method: 'POST', headers: { ...recipient, 'content-type': 'application/json' },
            body: JSON.stringify({ workspace: session.workspace, share: share.id }),
          });

          const ticket = v.safeParse(Opened, await opened.json());
          const exchanged = ticket.success ? await fetch(ticket.output.url, { redirect: 'manual' }) : null;
          const cookie = exchanged?.headers.get('set-cookie')?.split(';')[0] ?? null;
          const served = cookie === null ? null : await fetch(url, { headers: { cookie }, redirect: 'manual' });
          const body = served === null ? null : await served.text();

          goals.push({
            what: 'named-account-enters-as-itself', reached: shown.status === 200 && served?.status === 200 && body === BODY,
            detail: JSON.stringify({ page: shown.status, opened: opened.status, exchanged: exchanged?.status ?? null, served: served?.status ?? null, body: body?.slice(0, 200) ?? null }),
          });
        } finally {
          await fetch(`${plan.origin}/api/shared/revoke`, {
            method: 'POST', headers: { ...owner, 'content-type': 'application/json' },
            body: JSON.stringify({ workspace: session.workspace, share: share.id }),
          });
        }

        return goals;
      },
    }, observations);
  });
});

export const DEFECT = FIRST_RUN_DEFECTS[CASE];
