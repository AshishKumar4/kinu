/**
 * The signed-out page a visitor lands on advertises a way to sign in, and that way works. A fresh browser opens the
 * deployment's home, follows the sign-in it links, and reads the ways the sign-in page offers; each is tried as far as a
 * visitor without the owner's own provider login can go. A password form signs a built-in account kept on the
 * deployment in, reaches a signed-in page and signs out, its session revoked, so the account ends as it began; on a
 * deployment with no owner yet it is the first owner's, and the case reads that it asks for the setup token. A
 * provider's link starts that provider's sign-in for this deployment: it sends the visitor to the provider with a
 * return to this deployment's callback, and the provider answers with its own sign-in, not an error (an unknown client
 * answers `/oauth/error?error=invalid_client`, measured at Cloudflare 2026-10-19). No model.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { openBrowser } from '../../evals/src/browser';
import type { Page } from 'puppeteer';

const SUITE = 'First-run · sign-in-advertised';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: 'The owner, on staging: "staging latest but I still dont see any sign in options" (m1922a). Staging declares no OAuth provider, and its first-owner setup drew no control without a setup token, so a signed-out visitor met no way in.',
  missedBecause: 'packages/cf-backend/tests/unit-builtin-auth.test.ts:132 drives the built-in routes over a configured harness; nothing opened a deployment\'s signed-out page and signed in the way it advertises.',
  provedRedAt: null,
  redDirection: 'Green requires the home page to link a sign-in, that page to offer at least one way in, and every way it offers to work: a password form signs the account in to a signed-in page and sign-out revokes that session; a provider\'s link reaches that provider\'s own sign-in with a return to this deployment. A home with no sign-in, a sign-in page with no way in, a sign-in that lands signed out, a session left alive, or a provider that answers an error reads red. Not proved red on a deployed build: the build the owner reported on is gone from staging.',
};

const PLAN = firstRunCasePlan(SUITE, 'signin');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

/** A built-in account kept on a deployment whose sign-in offers a password, made once by an invite of its owner; its
 *  password is an armada secret (docs/DEPLOYMENT.md, the upgrade fixtures). Signing in and out leaves it as it was. */
const ACCOUNT = { email: 'upgrade-fixture@kinu.run', secret: 'KINU_UPGRADE_FIXTURE_PASSWORD' } as const;

/** The password form's mode (`sign-in`, or `register` for the first owner or an invite) and whether it asks for the
 *  setup token, as the page draws it (packages/core/src/http/public-pages.ts). */
const FORM = `({ mode: document.querySelector('#builtin-sign-in')?.getAttribute('data-mode') ?? null,
  setup: document.querySelector('#builtin-sign-in [name="setup"]') !== null })`;

/** `/api/auth/me`: the signed-in user, or null with a 401. */
const MeSchema = v.object({ user: v.nullable(v.looseObject({ email: v.optional(v.nullable(v.string())) })) });

/** The session cookie every sign-in sets (`SESSION_COOKIE_NAME`). */
const SESSION_COOKIE = '__Host-kinu_session';

/** The ways in the sign-in page draws: its password form, its passkey button, and each provider's link. */
const WAYS_IN = `[...document.querySelectorAll('#builtin-sign-in input[name="password"], #passkey, a.provider[href^="/auth/"]')]
  .map((element) => element.id === 'passkey' ? 'passkey' : element instanceof HTMLInputElement ? 'password' : (element.getAttribute('href') ?? ''))`;

type Me = (cookie?: string) => Promise<{ status: number; email: string | null }>;

/** The password form signs the built-in account in, to a signed-in page, and sign-out revokes the session it made. */
async function passwordSignIn(page: Page, origin: string, me: Me): Promise<EvalSubgoal[]> {
  const password = process.env[ACCOUNT.secret] ?? '';

  if (password === '') throw new Error(`${origin}'s sign-in offers a password, and ${ACCOUNT.secret} is not set, so ${ACCOUNT.email} cannot sign in: armada secret set ${ACCOUNT.secret}`);
  await page.type('#builtin-sign-in input[name="email"]', ACCOUNT.email);
  await page.type('#builtin-sign-in input[name="password"]', password);
  await Promise.all([page.waitForNavigation(), page.click('#builtin-sign-in button[type="submit"]')]);
  const landed = new URL(page.url()).pathname;
  const session = (await page.cookies(origin)).find((each) => each.name === SESSION_COOKIE && each.value !== '');
  const cookie = session === undefined ? undefined : `${session.name}=${session.value}`;
  const signedIn = await me(cookie);

  await page.goto(`${origin}/logout`);
  const afterSignOut = await me(cookie);

  return [
    {
      what: 'password-sign-in-signs-in',
      reached: signedIn.status === 200 && signedIn.email === ACCOUNT.email && landed !== '/login',
      detail: JSON.stringify({ landed, me: signedIn, cookie: session?.name ?? null }),
    },
    { what: 'sign-out-revokes-the-session', reached: cookie !== undefined && afterSignOut.status === 401 && afterSignOut.email === null, detail: JSON.stringify({ me: afterSignOut }) },
  ];
}

/** The password form, by what it is for: signing an account in, or a first owner's setup, which the case reads only. */
async function passwordWay(page: Page, at: { origin: string; form: { mode: string | null; setup: boolean }; me: Me }): Promise<EvalSubgoal[]> {
  if (at.form.mode === 'sign-in') return await passwordSignIn(page, at.origin, at.me);

  return [{ what: 'first-owner-setup-offered', reached: at.form.setup, detail: JSON.stringify(at.form) }];
}

/**
 * A provider's link starts its sign-in for this deployment: it redirects to the provider with a return to this
 * deployment, and the provider answers with its own sign-in rather than an error. Read redirect by redirect, as a
 * browser would follow them; the provider's login itself is the owner's, past what a check can reach.
 */
async function providerSignIn(origin: string, way: string): Promise<EvalSubgoal> {
  const provider = /^\/auth\/([^/?]+)/u.exec(way)?.[1] ?? way;
  const started = await fetch(new URL(way, origin), { redirect: 'manual' });
  const authorize = started.headers.get('location');
  const returnsTo = authorize === null ? null : new URL(authorize).searchParams.get('redirect_uri');
  const answered = authorize === null ? null : await fetch(authorize, { redirect: 'manual' });
  const next = answered?.headers.get('location') ?? null;
  const refused = answered === null || answered.status >= 400 || (next !== null && /\/error\b|[?&]error=/u.test(next));

  return {
    what: `${provider}-sign-in-reaches-the-provider`,
    reached: started.status >= 300 && started.status < 400 && authorize?.startsWith('https://') === true
      && returnsTo?.startsWith(`${origin}/auth/`) === true && !refused,
    detail: JSON.stringify({ started: started.status, authorize: authorize?.split('?')[0] ?? null, returnsTo, provider: answered?.status ?? null, next: next?.split('?')[0] ?? null }),
  };
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
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
          // A Kinu of its owner's opens on its own sign-in (landing-route.ts); the product's page links to it.
          const home = new URL(page.url()).pathname;
          const linked = await page.$$eval('a[href="/login"], a[href^="/login?"]', (links) => links.map((link) => (link.textContent ?? '').trim()));

          await page.goto(`${plan.origin}/login`);
          const ways = v.parse(v.array(v.string()), await page.evaluate(WAYS_IN));
          const form = v.parse(v.object({ mode: v.nullable(v.string()), setup: v.boolean() }), await page.evaluate(FORM));

          const offered = [
            { what: 'home-links-sign-in', reached: linked.length > 0 || home === '/login', detail: JSON.stringify({ home, linked }) },
            { what: 'sign-in-offers-a-way-in', reached: ways.includes('password') || ways.includes('passkey') || ways.some((way) => way.startsWith('/auth/')), detail: JSON.stringify({ ways }) },
          ];

          // Each way the page offers, tried; one the page does not offer is not this deployment's to prove. A deployment
          // with no owner yet (a reset empties it) offers its password form to the first owner, with the setup token
          // its deployer holds: no account exists to sign in, and the case does not claim the deployment.
          const password = ways.includes('password') ? await passwordWay(page, { origin: plan.origin, form, me }) : [];
          const providers = await Promise.all(ways.filter((way) => way.startsWith('/auth/')).map(async (way) => await providerSignIn(plan.origin, way)));

          return [...offered, ...password, ...providers] satisfies EvalSubgoal[];
        } finally {
          await chrome.close();
        }
      },
    }, observations);
  });
});
