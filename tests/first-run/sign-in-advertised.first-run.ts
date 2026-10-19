/**
 * The signed-out page a visitor lands on advertises a way to sign in, and that way signs them in. A fresh browser opens
 * the deployment's home, follows the sign-in it links, reads the ways the sign-in page offers, signs in through its
 * password form as a built-in account kept on staging, reaches a signed-in page, and signs out; the session it made is
 * revoked, so the account ends as it began. No model.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { openBrowser } from '../../evals/src/browser';

const SUITE = 'First-run · sign-in-advertised';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: 'The owner, on staging: "staging latest but I still dont see any sign in options" (m1922a). Staging declares no OAuth provider, and its first-owner setup drew no control without a setup token, so a signed-out visitor met no way in.',
  missedBecause: 'packages/cf-backend/tests/unit-builtin-auth.test.ts:132 drives the built-in routes over a configured harness; nothing opened a deployment\'s signed-out page and signed in the way it advertises.',
  provedRedAt: null,
  redDirection: 'Green requires the home page to link a sign-in, that page to offer at least one way in, its password form to sign the account in to a signed-in page, and sign-out to revoke that session. A home with no sign-in, a sign-in page with no way in, a sign-in that lands signed out, or a session left alive reads red. Not proved red on a deployed build: the build the owner reported on is gone from staging.',
};

const PLAN = firstRunCasePlan(SUITE, 'signin');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

/** A built-in account kept on staging for good, made once by an invite of the deployment's owner; its password is an
 *  armada secret (docs/DEPLOYMENT.md, the upgrade fixtures). Signing in and out leaves it as it was. */
const ACCOUNT = { email: 'upgrade-fixture@kinu.run', secret: 'KINU_UPGRADE_FIXTURE_PASSWORD' } as const;

/** `/api/auth/me`: the signed-in user, or null with a 401. */
const MeSchema = v.object({ user: v.nullable(v.looseObject({ email: v.optional(v.nullable(v.string())) })) });

/** The session cookie every sign-in sets (`SESSION_COOKIE_NAME`). */
const SESSION_COOKIE = '__Host-kinu_session';

/** The ways in the sign-in page draws: its password form, its passkey button, and each provider's link. */
const WAYS_IN = `[...document.querySelectorAll('#builtin-sign-in input[name="password"], #passkey, a.provider[href^="/auth/"]')]
  .map((element) => element.id === 'passkey' ? 'passkey' : element instanceof HTMLInputElement ? 'password' : (element.getAttribute('href') ?? ''))`;

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    const password = process.env[ACCOUNT.secret] ?? '';

    if (password === '') throw new Error(`${ACCOUNT.secret} is not set, so ${ACCOUNT.email} cannot sign in: armada secret set ${ACCOUNT.secret}`);

    await runFirstRunCase(PLAN, {
      id: CASE, defect: DEFECT, modelCalls: 'none', budgetMs: 3 * 60_000, genesis: false,
      purpose: 'Disposable sign-in probe; no model task.',
      async run({ plan }) {
        const chrome = await openBrowser();

        try {
          const page = await (await chrome.browser.createBrowserContext()).newPage();

          const me = async (cookie?: string) => {
            const answer = await fetch(`${plan.origin}/api/auth/me`, { headers: cookie === undefined ? {} : { cookie } });
            const body = v.safeParse(MeSchema, await answer.json());

            return { status: answer.status, email: body.success ? body.output.user?.email ?? null : null };
          };

          await page.goto(`${plan.origin}/`);
          const linked = await page.$$eval('a[href="/login"], a[href^="/login?"]', (links) => links.map((link) => (link.textContent ?? '').trim()));

          await page.goto(`${plan.origin}/login`);
          const ways = v.parse(v.array(v.string()), await page.evaluate(WAYS_IN));

          await page.type('#builtin-sign-in input[name="email"]', ACCOUNT.email);
          await page.type('#builtin-sign-in input[name="password"]', password);
          await Promise.all([page.waitForNavigation(), page.click('#builtin-sign-in button[type="submit"]')]);
          const landed = new URL(page.url()).pathname;
          const session = (await page.cookies(plan.origin)).find((each) => each.name === SESSION_COOKIE && each.value !== '');
          const cookie = session === undefined ? undefined : `${session.name}=${session.value}`;
          const signedIn = await me(cookie);

          await page.goto(`${plan.origin}/logout`);
          const afterSignOut = await me(cookie);

          return [
            { what: 'home-links-sign-in', reached: linked.length > 0, detail: JSON.stringify({ linked }) },
            { what: 'sign-in-offers-a-way-in', reached: ways.includes('password') || ways.includes('passkey') || ways.some((way) => way.startsWith('/auth/')), detail: JSON.stringify({ ways }) },
            {
              what: 'password-sign-in-signs-in',
              reached: signedIn.status === 200 && signedIn.email === ACCOUNT.email && landed !== '/login',
              detail: JSON.stringify({ landed, me: signedIn, cookie: session?.name ?? null }),
            },
            { what: 'sign-out-revokes-the-session', reached: cookie !== undefined && afterSignOut.status === 401 && afterSignOut.email === null, detail: JSON.stringify({ me: afterSignOut }) },
          ] satisfies EvalSubgoal[];
        } finally {
          await chrome.close();
        }
      },
    }, observations);
  });
});
