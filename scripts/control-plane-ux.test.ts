/**
 * The admin control plane, driven in a real browser.
 *
 * WHY A BROWSER AND NOT A COMPONENT TEST. Every claim this page makes is about
 * what an operator can SEE, and the three that matter most are all invisible
 * from source:
 *
 *   1. A NON-OPERATOR MUST NOT SEE AN EMPTY TABLE. The server answers 404 to a
 *      caller who is not on the allowlist, so a page that treated a failed read
 *      as "no rows" would show a plausible, wrong, and completely silent answer.
 *      The refusal has to reach the screen as a sentence.
 *   2. THE LIST HAS TO BE WALKABLE. Paging is a cursor the server issues and the
 *      page hands back; a page that dropped it would look correct on any fixture
 *      smaller than one page, which is every fixture anyone writes by hand.
 *   3. A DESTRUCTIVE ACTION HAS TO BE HARD TO DO BY ACCIDENT. The typed-name
 *      confirmation is a property of the rendered form, not of the schema — the
 *      schema check behind it is already covered by
 *      `packages/cf-backend/tests/unit-control-plane-routes.test.ts`.
 *
 * `/api/control/*` does not exist under the gallery's Vite server, so every read
 * is answered by request interception. Everything on the browser side of that
 * boundary — the client in `lib/control-api.ts`, the five read states, the cursor
 * walk, the confirmation form — is the shipped code path.
 */
import { describe, expect, test } from 'bun:test';
import type { HTTPRequest, Page } from 'puppeteer';
import type { JsonValue } from '@kinu.run/core';
import { withGallery } from './gallery-harness';

/** One canned answer for an intercepted read. `JsonValue` because a fixture IS
 *  the bytes the route would have serialized. */
interface CannedAnswer {
  status: number;
  body: JsonValue;
}

const OPERATOR = 'ops@kinu.run';
const USER_ID = 'a'.repeat(32);
const OTHER_ID = 'b'.repeat(32);

/**
 * What the page is told, per path suffix.
 *
 * A function of the REQUEST, never of a call count: the gallery mounts under
 * `StrictMode`, so every effect-driven read fires twice, and a fixture that
 * answered "the second call" differently would hand page two to a page-one
 * request. The cursor walk is driven off the cursor in the query string, which
 * is also how the real store decides.
 */
type Answer = (url: URL) => CannedAnswer;

function page(status: number, body: JsonValue): Answer {
  return () => answer(status, body);
}

/** One answer, checked as `JsonValue` at the point it is built. Named so a
 *  request-dependent fixture checks each BRANCH independently: a bare ternary
 *  unions the branches first, and the union of two object literals carries
 *  `undefined`-valued members that no JSON body can hold. */
function answer(status: number, body: JsonValue): CannedAnswer {
  return { status, body };
}


interface Fixture {
  [suffix: string]: Answer;
}

/** Serve `/api/control/*` from a fixture, and count what was asked. */
async function serveControl(
  browserPage: Page, fixture: Fixture,
): Promise<{ asked: string[] }> {
  const asked: string[] = [];
  await browserPage.setRequestInterception(true);
  browserPage.on('request', (request: HTTPRequest) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/control/')) {
      void request.continue();
      return;
    }
    asked.push(url.pathname + url.search);
    const suffix = url.pathname.replace('/api/control/', '');
    // Longest declared prefix wins, so `users/<id>` beats `users`.
    const key = Object.keys(fixture)
      .filter((candidate) => suffix === candidate || suffix.startsWith(`${candidate}/`))
      .sort((a, b) => b.length - a.length)[0];
    const answer = key === undefined ? undefined : fixture[key];
    if (answer === undefined) {
      void request.respond({
        status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not found' }),
      });
      return;
    }
    const { status, body } = answer(url);
    void request.respond({
      status, contentType: 'application/json', body: JSON.stringify(body),
    });
  });
  return { asked };
}

/**
 * The heading a tab is expected to render.
 *
 * A lookup over the closed record's own entries rather than a subscript: a tab
 * name this file does not declare throws HERE, naming itself, instead of reading
 * `undefined` and turning into a `waitForFunction` that times out for a reason
 * nobody can see.
 */
function headingFor(tab: string): string {
  const heading = Object.entries(TAB_HEADINGS).find(([label]) => label === tab)?.[1];
  if (heading === undefined) throw new Error(`no heading declared for control tab ${tab}`);
  return heading;
}

async function openControl(
  browserPage: Page, origin: string, tab = 'overview',
): Promise<void> {
  await browserPage.goto(`${origin}/gallery.html?frame=control`, { waitUntil: 'networkidle0' });
  if (tab !== 'overview') {
    const clicked = await browserPage.evaluate((label: string) => {
      const button = [...document.querySelectorAll('nav button')]
        .find((node) => node.textContent?.trim() === label);
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    }, tab);
    // A tab that was not found is a failure here, not later: the alternative is a
    // test that reads the OVERVIEW body and reports a missing string from the tab
    // it never opened, which is the least useful failure a browser test can give.
    if (!clicked) throw new Error(`no control-plane tab labelled ${tab}`);
    // The tab's own heading, not network idle. An intercepted read settles before
    // React commits, so idleness is not readiness — the same class of flake a
    // sibling gate hit by sampling a canvas that existed but was not painted.
    await browserPage.waitForFunction(
      (heading: string) => document.body.innerText.includes(heading),
      { timeout: 10_000 }, headingFor(tab),
    );
  }
}

/**
 * The heading each tab renders once its read has committed.
 *
 * A readiness signal the page itself produces, so a test never samples a body
 * belonging to the tab it navigated away from.
 */
const TAB_HEADINGS = {
  Overview: 'Fleet',
  Users: 'Accounts',
  Workspaces: 'Across every account',
  Incidents: 'Open incidents',
  Feedback: 'In-product reports',
  Metrics: 'Fleet metrics',
  Audit: 'Admin audit',
} satisfies Record<string, string>;

function userRow(userId: string, email: string, at: number): JsonValue {
  return {
    userId, email, displayName: null, firstSeenAt: at - 1_000, lastSeenAt: at, workspaces: 2,
  };
}

const OVERVIEW = {
  users: 3, workspaces: 7, workspacesRemoved: 1, feedback: 4, auditEntries: 12,
  lastAdminActionAt: 1_700_000_000_000, activeUsers24h: 2, activeUsers7d: 3,
};

describe('the control plane in a browser', () => {
  test('an operator sees the fleet counts, not a spinner that never resolves', async () => {
    await withGallery(async ({ browser, origin }) => {
      const browserPage = await browser.newPage();
      await serveControl(browserPage, { overview: page(200, OVERVIEW) });
      await openControl(browserPage, origin);

      // `innerText` returns RENDERED text, and the stat labels carry an
      // `uppercase` class — so the comparison is case-insensitive rather than
      // pinned to a CSS transform this test has no business asserting.
      const text = (await browserPage.evaluate(() => document.body.innerText)).toLowerCase();
      expect(text).toContain('control plane');
      expect(text).toContain('accounts');
      // The numbers, not just the labels: a card rendering its label and an em
      // dash would satisfy a label-only assertion.
      expect(text).toContain('workspaces\n7');
      expect(text).toContain('2 in 24h');
      await browserPage.close();
    });
  }, 120_000);

  test('a non-operator is told so, and never shown an empty table', async () => {
    // The defect this rules out: the server answers 404 to hide the surface, so
    // a client that mapped 404 to "no rows" would render a convincing,
    // completely wrong, and silent page.
    await withGallery(async ({ browser, origin }) => {
      const browserPage = await browser.newPage();
      await serveControl(browserPage, {
        users: page(404, { error: 'Not found' }),
        overview: page(404, { error: 'Not found' }),
      });
      await openControl(browserPage, origin, 'Users');

      const text = await browserPage.evaluate(() => document.body.innerText);
      expect(text).toContain('not on the control-plane operator list');
      expect(text).not.toContain('No accounts have been observed yet');
      await browserPage.close();
    });
  }, 120_000);

  test('a stale sign-in is a way back in, not a red box', async () => {
    await withGallery(async ({ browser, origin }) => {
      const browserPage = await browser.newPage();
      await serveControl(browserPage, {
        overview: page(403, {
          error: 'This action needs a fresh sign-in. Sign in again, then retry within five minutes.',
        }),
      });
      await openControl(browserPage, origin);

      const text = await browserPage.evaluate(() => document.body.innerText);
      expect(text).toContain('fresh sign-in');
      // The remedy has to be reachable, or the message is just an apology.
      const href = await browserPage.evaluate(() =>
        [...document.querySelectorAll('a')].map((a) => a.getAttribute('href')));
      expect(href).toContain('/login');
      await browserPage.close();
    });
  }, 120_000);

  test('a deployment with no analytics says which settings are missing', async () => {
    await withGallery(async ({ browser, origin }) => {
      const browserPage = await browser.newPage();
      await serveControl(browserPage, {
        overview: page(200, OVERVIEW),
        metrics: page(200, {
          windowHours: 24,
          missing: ['CLOUDFLARE_ACCOUNT_ID', 'ANALYTICS_SQL_API_TOKEN'],
          panels: {},
        }),
      });
      await openControl(browserPage, origin, 'Metrics');

      const text = await browserPage.evaluate(() => document.body.innerText);
      expect(text).toContain('Analytics is not configured');
      expect(text).toContain('ANALYTICS_SQL_API_TOKEN');
      // And it says the rest of the plane still works, so nobody goes looking
      // for an outage that does not exist.
      expect(text).toContain('Every other view here is unaffected');
      await browserPage.close();
    });
  }, 120_000);

  test('the account list is walkable: the cursor the server issued comes back', async () => {
    await withGallery(async ({ browser, origin }) => {
      const browserPage = await browser.newPage();
      const probe = await serveControl(browserPage, {
        overview: page(200, OVERVIEW),
        users: (url) => url.searchParams.get('cursor') === null
          ? answer(200, {
            status: 'more',
            items: [userRow(USER_ID, OPERATOR, 3_000)],
            next: { after: `3000\u0000${USER_ID}` },
          })
          : answer(200, {
            status: 'end',
            items: [userRow(OTHER_ID, 'later@example.com', 2_000)],
          }),
      });
      await openControl(browserPage, origin, 'Users');

      expect(await browserPage.evaluate(() => document.body.innerText)).toContain(OPERATOR);

      await browserPage.evaluate(() => {
        const next = [...document.querySelectorAll('button')]
          .find((node) => node.textContent?.includes('Next page'));
        if (next instanceof HTMLElement) next.click();
      });
      await browserPage.waitForNetworkIdle();

      const text = await browserPage.evaluate(() => document.body.innerText);
      expect(text).toContain('later@example.com');
      expect(text).toContain('end of list');
      // The page asked for exactly TWO distinct reads: one with no cursor, and
      // one carrying the cursor the first answer issued. Asserted as a SET, not a
      // call count, because the gallery mounts under `StrictMode` and a repeated
      // identical read is the runtime's business rather than this page's. Without
      // the second entry the page would have re-read page one and looked like it
      // was working.
      const walk = new Set(probe.asked
        .filter((path) => path.startsWith('/api/control/users'))
        .map((path) => new URL(path, 'https://x').searchParams.get('cursor') ?? 'first'));
      expect(walk).toEqual(new Set(['first', `3000\u0000${USER_ID}`]));
      await browserPage.close();
    });
  }, 120_000);

  test('a workspace drilldown reports a down panel instead of blanking the page', async () => {
    await withGallery(async ({ browser, origin }) => {
      const browserPage = await browser.newPage();
      await serveControl(browserPage, {
        overview: page(200, OVERVIEW),
        workspaces: (url) => url.pathname.endsWith('/workspaces')
          ? answer(200, {
            status: 'end',
            items: [{
              userId: OTHER_ID, email: 'owner@example.com', name: 'checkout-fixes',
              displayName: 'Checkout fixes', createdAt: 1_000, lastSeenAt: 2_000, removedAt: null,
            }],
          })
          : answer(200, {
            workspace: 'checkout-fixes',
            runs: { status: 'ok', value: [] },
            activity: { status: 'ok', value: { spend: { usd: 0 } } },
            jobs: { status: 'ok', value: [] },
            approvals: { status: 'ok', value: [] },
            consents: { status: 'ok', value: [] },
            executors: { status: 'failed', reason: 'the sandbox is not reachable' },
            shellGrants: { status: 'ok', value: { grants: [] } },
          }),
      });
      await openControl(browserPage, origin, 'Workspaces');

      await browserPage.evaluate(() => {
        const row = [...document.querySelectorAll('tbody tr')]
          .find((node) => node.textContent?.includes('checkout-fixes'));
        if (row instanceof HTMLElement) row.click();
      });
      await browserPage.waitForNetworkIdle();

      const text = (await browserPage.evaluate(() => document.body.innerText)).toLowerCase();
      expect(text).toContain('recent runs');
      // The one panel that failed says why. A workspace whose sandbox is down
      // still has runs, jobs and approvals worth reading, and that is exactly the
      // workspace an operator is looking at.
      expect(text).toContain('the sandbox is not reachable');
      expect(text).toContain('clear settled jobs');
      await browserPage.close();
    });
  }, 120_000);

  test('removing a workspace stays disabled until the name is retyped', async () => {
    await withGallery(async ({ browser, origin }) => {
      const browserPage = await browser.newPage();
      await serveControl(browserPage, {
        overview: page(200, OVERVIEW),
        users: page(200, { status: 'end', items: [userRow(OTHER_ID, 'owner@example.com', 3_000)] }),
        workspaces: (url) => url.pathname.endsWith('/workspaces')
          ? answer(200, {
            status: 'end',
            items: [{
              userId: OTHER_ID, email: 'owner@example.com', name: 'checkout-fixes',
              displayName: 'Checkout fixes', createdAt: 1_000, lastSeenAt: 2_000, removedAt: null,
            }],
          })
          : answer(200, {
            workspace: 'checkout-fixes',
            runs: { status: 'ok', value: [] },
            activity: { status: 'ok', value: {} },
            jobs: { status: 'ok', value: [] },
            approvals: { status: 'ok', value: [] },
            consents: { status: 'ok', value: [] },
            executors: { status: 'ok', value: [] },
            shellGrants: { status: 'ok', value: { grants: [] } },
          }),
      });
      // Reached the way an operator reaches it: the workspaces list, then the
      // row. The removal is offered only where the OWNER is known, because the
      // action needs the owning UserDO — and clicking a row is what supplies it.
      await openControl(browserPage, origin, 'Workspaces');
      await browserPage.evaluate(() => {
        const row = [...document.querySelectorAll('tbody tr')]
          .find((node) => node.textContent?.includes('checkout-fixes'));
        if (row instanceof HTMLElement) row.click();
      });
      await browserPage.waitForNetworkIdle();

      const opened = await browserPage.evaluate(() => {
        const button = [...document.querySelectorAll('button')]
          .find((node) => node.textContent?.includes('Remove workspace'));
        if (button instanceof HTMLElement) button.click();
        return button instanceof HTMLElement;
      });
      expect(opened).toBe(true);
      await browserPage.waitForSelector('input');

      const disabledEmpty = await browserPage.evaluate(() =>
        [...document.querySelectorAll('button')]
          .find((node) => node.textContent?.trim() === 'Remove')
          ?.hasAttribute('disabled'));
      expect(disabledEmpty).toBe(true);

      await browserPage.type('input', 'checkout-fix');
      const disabledPartial = await browserPage.evaluate(() =>
        [...document.querySelectorAll('button')]
          .find((node) => node.textContent?.trim() === 'Remove')
          ?.hasAttribute('disabled'));
      // A prefix is not the name. The gate is equality, not "looks close".
      expect(disabledPartial).toBe(true);

      await browserPage.type('input', 'es');
      const enabled = await browserPage.evaluate(() =>
        [...document.querySelectorAll('button')]
          .find((node) => node.textContent?.trim() === 'Remove')
          ?.hasAttribute('disabled'));
      expect(enabled).toBe(false);
      await browserPage.close();
    });
  }, 120_000);

  test('the audit tab shows refusals as clearly as it shows successes', async () => {
    // An audit log that rendered only the successes would hide exactly the rows
    // an operator reads it for.
    await withGallery(async ({ browser, origin }) => {
      const browserPage = await browser.newPage();
      await serveControl(browserPage, {
        overview: page(200, OVERVIEW),
        audit: page(200, {
          status: 'end',
          items: [
            {
              id: '1', at: 1_700_000_000_000, actorEmail: OPERATOR, actorUserId: USER_ID,
              operation: 'workspace_remove', targetKind: 'workspace', target: 'checkout-fixes',
              outcome: 'denied', detail: 'refused: the sign-in was not fresh',
            },
            {
              id: '2', at: 1_699_999_000_000, actorEmail: OPERATOR, actorUserId: USER_ID,
              operation: 'job_cancel', targetKind: 'job', target: 'checkout-fixes/j-7',
              outcome: 'ok', detail: 'cancelled j-7',
            },
          ],
        }),
      });
      await openControl(browserPage, origin, 'Audit');

      const text = await browserPage.evaluate(() => document.body.innerText);
      expect(text).toContain('workspace_remove');
      expect(text).toContain('denied');
      expect(text).toContain('refused: the sign-in was not fresh');
      expect(text).toContain('job_cancel');
      expect(text).toContain('ok');
      await browserPage.close();
    });
  }, 120_000);

  test('incidents are readable at all, which they never were before', async () => {
    await withGallery(async ({ browser, origin }) => {
      const browserPage = await browser.newPage();
      await serveControl(browserPage, {
        overview: page(200, OVERVIEW),
        incidents: page(200, {
          incidents: [{
            probe: 'download-checksum', detail: 'sha256 mismatch', openedAt: 1_700_000_000_000,
            alertedAt: null, failures: 4,
          }],
        }),
      });
      await openControl(browserPage, origin, 'Incidents');

      const text = await browserPage.evaluate(() => document.body.innerText);
      expect(text).toContain('download-checksum');
      expect(text).toContain('sha256 mismatch');
      // An incident whose alert never went out is the one worth surfacing.
      expect(text).toContain('alert owed');
      await browserPage.close();
    });
  }, 120_000);

  test('feedback shows a note-only report without pretending it had a screenshot', async () => {
    await withGallery(async ({ browser, origin }) => {
      const browserPage = await browser.newPage();
      await serveControl(browserPage, {
        overview: page(200, OVERVIEW),
        feedback: page(200, {
          status: 'end',
          items: [
            {
              id: 'f1', createdAt: 1_700_000_000_000, userId: USER_ID, email: 'reporter@example.com',
              note: 'the sidebar overlaps at 640px', route: '/workspace/alpha', workspace: 'alpha',
              objectKey: null, contentType: null, bytes: null, userAgent: 'Mozilla/5.0',
            },
            {
              id: 'f2', createdAt: 1_699_999_000_000, userId: OTHER_ID, email: 'other@example.com',
              note: '', route: '/', workspace: null,
              objectKey: 'feedback/x/f2.png', contentType: 'image/png', bytes: 512_000,
              userAgent: null,
            },
          ],
        }),
      });
      await openControl(browserPage, origin, 'Feedback');

      const text = await browserPage.evaluate(() => document.body.innerText);
      expect(text).toContain('the sidebar overlaps at 640px');
      expect(text).toContain('note only');
      // The byte count of the one that has an image, so the two rows are
      // distinguishable at a glance.
      expect(text).toContain('500.0 KB');
      await browserPage.close();
    });
  }, 120_000);
});
