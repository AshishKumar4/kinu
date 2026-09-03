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
import { JsonValueSchema, type JsonValue } from '@kinu.run/core';
import * as v from 'valibot';
import { diagnosticsSettled, recordDiagnostics, withGallery } from './gallery-harness';

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

/** What the page did over the wire: which reads it issued, and the body of every
 *  action it POSTed. The bodies are the point for the action controls — a button
 *  that opened a modal and sent nothing would satisfy a click-only assertion. */
interface Probe {
  asked: string[];
  posted: JsonValue[];
}

/** Serve `/api/control/*` from a fixture, and record what was asked. */
async function serveControl(browserPage: Page, fixture: Fixture): Promise<Probe> {
  const probe: Probe = { asked: [], posted: [] };
  await browserPage.setRequestInterception(true);
  browserPage.on('request', async (request: HTTPRequest) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/control/')) {
      await request.continue();
      return;
    }
    if (request.method() === 'POST') {
      const body = request.postData();
      if (body !== undefined) probe.posted.push(v.parse(JsonValueSchema, JSON.parse(body)));
    }
    probe.asked.push(url.pathname + url.search);
    const suffix = url.pathname.replace('/api/control/', '');
    // Longest declared prefix wins, so `users/<id>` beats `users`.
    const key = Object.keys(fixture)
      .filter((candidate) => suffix === candidate || suffix.startsWith(`${candidate}/`))
      .sort((a, b) => b.length - a.length)[0];
    const answer = key === undefined ? undefined : fixture[key];
    if (answer === undefined) {
      await request.respond({
        status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not found' }),
      });
      return;
    }
    const { status, body } = answer(url);
    await request.respond({
      status, contentType: 'application/json', body: JSON.stringify(body),
    });
  });
  return probe;
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

/** The one workspace every drilldown test opens, as the list row names it. The
 *  row is what supplies the OWNER, which is what makes the name an address. */
function workspaceRow(): JsonValue {
  return {
    userId: OTHER_ID, email: 'owner@example.com', name: 'checkout-fixes',
    displayName: 'Checkout fixes', createdAt: 1_000, lastSeenAt: 2_000, removedAt: null,
  };
}

/** A background job with the fields the row view reads. */
const JOB = {
  id: 'job-7', kind: 'research', label: 'read the changelog', status: 'running',
  error: null, createdAt: 1_700_000_000_000, settledAt: null,
};

/** One command parked on the owner. `queued` is the only status whose answers
 *  are offered — a decided one has nothing left to decide. */
const APPROVAL = {
  id: 'ap-1', command: 'rm -rf /tmp/build', executor: 'sandbox',
  reason: 'a destructive path outside the workspace', status: 'queued',
  requestedAt: 1_700_000_000_000, decidedAt: null,
};

/** The drilldown body, with every panel healthy unless a test overrides one. */
function detailBody(over: Record<string, JsonValue>): JsonValue {
  return {
    workspace: 'checkout-fixes',
    userId: OTHER_ID,
    runs: { status: 'ok', value: [] },
    activity: { status: 'ok', value: { spend: { usd: 0 } } },
    jobs: { status: 'ok', value: [] },
    approvals: { status: 'ok', value: [] },
    consents: { status: 'ok', value: [] },
    executors: { status: 'ok', value: [] },
    shellGrants: { status: 'ok', value: { grants: [] } },
    ...over,
  };
}

/** Open the drilldown the way an operator does: click the list row, then wait
 *  for the panel grid the read produces. Network idle is not readiness — the
 *  intercepted answer settles before React commits. */
async function openWorkspaceRow(browserPage: Page): Promise<void> {
  await browserPage.evaluate(() => {
    const row = [...document.querySelectorAll('tbody tr')]
      .find((node) => node.textContent?.includes('checkout-fixes'));
    if (row instanceof HTMLElement) row.click();
  });
  // Lowercased, because `innerText` is RENDERED text and the panel titles carry
  // an `uppercase` class — the same reason the assertions below compare in lower
  // case rather than pinning a CSS transform.
  await browserPage.waitForFunction(
    () => document.body.innerText.toLowerCase().includes('recent runs'), { timeout: 15_000 },
  );
}

/** Click the first enabled button whose label matches, and report whether there
 *  was one. A missing control is a failure to name here rather than a later
 *  assertion about a body nobody sent. */
async function clickButton(browserPage: Page, label: string): Promise<boolean> {
  return await browserPage.evaluate((wanted: string) => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.textContent?.trim() === wanted && !node.hasAttribute('disabled'));
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  }, label);
}

/** Wait until a control with this label exists AND is enabled. Every action
 *  reloads the panel it lives in, so between two actions the control is briefly
 *  absent — a click fired into that window finds nothing and reads as a missing
 *  control rather than as the race it is. */
async function waitForEnabled(browserPage: Page, label: string): Promise<void> {
  await browserPage.waitForFunction(
    (wanted: string) => [...document.querySelectorAll('button')]
      .some((node) => node.textContent?.trim() === wanted && !node.hasAttribute('disabled')),
    { timeout: 15_000 }, label,
  );
}

/**
 * Open a control's confirmation, read it, and answer it.
 *
 * Every wait here is on a state the page produces rather than on the network:
 * the click that opens the dialog only schedules a React commit, and answering
 * it reloads the panel the control lives in. Returns the dialog's own text, so a
 * caller can assert what the operator was shown before they agreed.
 */
async function confirmControl(
  browserPage: Page, open: string, answer: string,
): Promise<string> {
  await waitForEnabled(browserPage, open);
  if (!await clickButton(browserPage, open)) throw new Error(`no enabled control labelled ${open}`);
  await browserPage.waitForSelector('[role="dialog"]', { timeout: 15_000 });
  const shown = await browserPage.evaluate(() =>
    document.querySelector('[role="dialog"]')?.textContent ?? '');
  await waitForEnabled(browserPage, answer);
  if (!await clickButton(browserPage, answer)) throw new Error(`the ${open} dialog offered no ${answer}`);
  await browserPage.waitForSelector('[role="dialog"]', { hidden: true, timeout: 15_000 });
  return shown;
}

async function removeDisabled(browserPage: Page): Promise<boolean | undefined> {
  return await browserPage.evaluate(() =>
    [...document.querySelectorAll('button')]
      .find((node) => node.textContent?.trim() === 'Remove')
      ?.hasAttribute('disabled'));
}

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
      expect(text).toContain('This account is not a control-plane operator.');
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

  test('a read the transport refuses settles to a visible failure, recorded once per attempt, and Refresh retries', async () => {
    // `control()` names HTTP-level failures in its answer; this is the arm
    // UNDER that — `fetch` itself rejecting. The defect ruled out: an
    // unhandled rejection and a spinner that never resolves.
    await withGallery(async ({ browser, origin }) => {
      const browserPage = await browser.newPage();
      const diagnostics = recordDiagnostics(browserPage);
      let serveOk = false;
      let refused = 0;
      await browserPage.setRequestInterception(true);
      browserPage.on('request', async (request: HTTPRequest) => {
        if (!new URL(request.url()).pathname.startsWith('/api/control/')) {
          await request.continue();
          return;
        }
        if (!serveOk) {
          refused += 1;
          await request.abort('connectionrefused');
          return;
        }
        await request.respond({
          status: 200, contentType: 'application/json', body: JSON.stringify(OVERVIEW),
        });
      });
      await openControl(browserPage, origin);

      // The failure is a sentence in the panel, not an eternal spinner.
      await browserPage.waitForFunction(
        () => document.body.innerText.includes('Failed to fetch'),
        { timeout: 10_000 },
      );

      // One classified record per refused attempt — StrictMode re-runs the
      // mount read, so the attempt count is the runtime's business; the
      // equality is what holds. Each record carries the class and the WHOLE
      // chain, the `doing` frame first.
      await diagnosticsSettled(diagnostics, refused);
      expect(refused).toBeGreaterThanOrEqual(1);
      expect(diagnostics).toHaveLength(refused);
      for (const line of diagnostics) {
        expect(line.event).toBe('control.read_failed');
        expect(line.code).toBe('io');
        expect(line.cause).toBe('run a control-plane read: Failed to fetch');
      }

      // Refresh is the retry: the read that failed re-runs and lands.
      serveOk = true;
      const recordedBeforeRetry = diagnostics.length;
      await browserPage.click('button[title="Refresh"]');
      await browserPage.waitForFunction(
        () => document.body.innerText.toLowerCase().includes('workspaces\n7'),
        { timeout: 10_000 },
      );
      // The retry that succeeded records nothing.
      expect(diagnostics).toHaveLength(recordedBeforeRetry);
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
      const probe = await serveControl(browserPage, {
        overview: page(200, OVERVIEW),
        workspaces: (url) => url.pathname.endsWith('/workspaces')
          ? answer(200, { status: 'end', items: [workspaceRow()] })
          : answer(200, detailBody({ executors: { status: 'failed', reason: 'the sandbox is not reachable' } })),
      });
      await openControl(browserPage, origin, 'Workspaces');
      await openWorkspaceRow(browserPage);

      const text = (await browserPage.evaluate(() => document.body.innerText)).toLowerCase();
      expect(text).toContain('recent runs');
      // The one panel that failed says why. A workspace whose sandbox is down
      // still has runs, jobs and approvals worth reading, and that is exactly the
      // workspace an operator is looking at.
      expect(text).toContain('the sandbox is not reachable');
      expect(text).toContain('clear settled jobs');
      // The read named the account that owns it. A workspace name is unique
      // inside one UserDO and `OrchestratorAgent` is addressed globally, so a
      // page that asked by name alone would be asking about whichever account
      // registered that string first.
      const detailAsk = probe.asked.find((path) => path.includes('/workspaces/checkout-fixes'));
      expect(detailAsk).toContain(`userId=${OTHER_ID}`);
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
          ? answer(200, { status: 'end', items: [workspaceRow()] })
          : answer(200, detailBody({})),
      });
      // Reached the way an operator reaches it: the workspaces list, then the
      // row. Clicking a row is what supplies the owning account, and the plane
      // refuses to read a workspace without one.
      await openControl(browserPage, origin, 'Workspaces');
      await openWorkspaceRow(browserPage);

      expect(await clickButton(browserPage, 'Remove workspace')).toBe(true);
      await browserPage.waitForSelector('input');

      expect(await removeDisabled(browserPage)).toBe(true);
      await browserPage.type('input', 'checkout-fix');
      // A prefix is not the name. The gate is equality, not "looks close".
      expect(await removeDisabled(browserPage)).toBe(true);
      await browserPage.type('input', 'es');
      expect(await removeDisabled(browserPage)).toBe(false);
      await browserPage.close();
    });
  }, 120_000);

  /**
   * The four verbs that used to be API-only.
   *
   * `job.cancel`, `job.retry`, `job.dismiss` and `approvals.decide` were declared
   * in the action union, proxied, and audited — and reachable from nothing but
   * curl, because the jobs and approvals panels rendered a count and a
   * `JSON.stringify`. This is the repo's built-but-unwired defect class, and the
   * assertion that closes it is the SENT BODY: a button that opened a
   * confirmation and posted nothing would satisfy a click-only check.
   */
  test('every job and approval control sends its action, bound to the owning account', async () => {
    await withGallery(async ({ browser, origin }) => {
      const browserPage = await browser.newPage();
      const probe = await serveControl(browserPage, {
        overview: page(200, OVERVIEW),
        workspaces: (url) => url.pathname.endsWith('/workspaces')
          ? answer(200, { status: 'end', items: [workspaceRow()] })
          : answer(200, detailBody({
            jobs: { status: 'ok', value: [JOB] },
            approvals: { status: 'ok', value: [APPROVAL] },
          })),
        actions: page(200, { outcome: 'ok', detail: 'done' }),
      });
      await openControl(browserPage, origin, 'Workspaces');
      await openWorkspaceRow(browserPage);

      // The rows themselves, not a JSON blob: an operator has to be able to read
      // which job and which command they are about to act on.
      const rendered = await browserPage.evaluate(() => document.body.innerText);
      expect(rendered).toContain('rm -rf /tmp/build');
      expect(rendered).toContain('research');

      for (const [label, confirmLabel] of [
        ['Cancel', 'Confirm'], ['Retry', 'Confirm'], ['Dismiss', 'Confirm'],
        ['Approve', 'Confirm'], ['Deny', 'Confirm'], ['Always', 'Remove'],
      ] as const) {
        // Every control asks first, and the dialog names the account — this panel
        // is reached from a list where the row above belongs to somebody else.
        const shown = await confirmControl(browserPage, label, confirmLabel);
        expect(shown, label).toContain(OTHER_ID);
      }

      expect(probe.posted).toEqual([
        { action: 'job.cancel', userId: OTHER_ID, workspace: 'checkout-fixes', jobId: 'job-7' },
        { action: 'job.retry', userId: OTHER_ID, workspace: 'checkout-fixes', jobId: 'job-7' },
        { action: 'job.dismiss', userId: OTHER_ID, workspace: 'checkout-fixes', jobId: 'job-7' },
        { action: 'approvals.decide', userId: OTHER_ID, workspace: 'checkout-fixes', ids: ['ap-1'], decision: 'approved' },
        { action: 'approvals.decide', userId: OTHER_ID, workspace: 'checkout-fixes', ids: ['ap-1'], decision: 'denied' },
        { action: 'approvals.decide', userId: OTHER_ID, workspace: 'checkout-fixes', ids: ['ap-1'], decision: 'always' },
      ]);
      await browserPage.close();
    });
  }, 180_000);

  test('the two workspace-wide controls also confirm before they act', async () => {
    await withGallery(async ({ browser, origin }) => {
      const browserPage = await browser.newPage();
      const probe = await serveControl(browserPage, {
        overview: page(200, OVERVIEW),
        workspaces: (url) => url.pathname.endsWith('/workspaces')
          ? answer(200, { status: 'end', items: [workspaceRow()] })
          : answer(200, detailBody({})),
        actions: page(200, { outcome: 'ok', detail: 'done' }),
      });
      await openControl(browserPage, origin, 'Workspaces');
      await openWorkspaceRow(browserPage);

      for (const label of ['Clear settled jobs', 'Revoke shell grants']) {
        await confirmControl(browserPage, label, 'Confirm');
      }

      expect(probe.posted).toEqual([
        { action: 'jobs.clear', userId: OTHER_ID, workspace: 'checkout-fixes' },
        { action: 'shell_grants.revoke', userId: OTHER_ID, workspace: 'checkout-fixes' },
      ]);
      await browserPage.close();
    });
  }, 120_000);

  test("250 of one account's workspaces are reachable, page by page", async () => {
    // The defect: the drilldown rendered `detail.workspaces.items` with no walk,
    // so row 201 and later were unreachable while the copy above the table said
    // it had been reconciled against the registry.
    await withGallery(async ({ browser, origin }) => {
      const browserPage = await browser.newPage();
      const rows = Array.from({ length: 250 }, (_, i) => ({
        userId: OTHER_ID, email: 'owner@example.com',
        name: `w${String(i).padStart(3, '0')}`, displayName: `Workspace ${String(i)}`,
        createdAt: 1_000, lastSeenAt: 2_000_000 - i, removedAt: null,
      }));
      await serveControl(browserPage, {
        overview: page(200, OVERVIEW),
        users: page(200, { status: 'end', items: [userRow(OTHER_ID, 'owner@example.com', 3_000)] }),
        [`users/${OTHER_ID}`]: (url) => {
          const cursor = url.searchParams.get('cursor');
          const start = cursor === null ? 0 : Number(cursor.split('\u0000')[1]);
          const slice = rows.slice(start, start + 200);
          const end = start + slice.length;
          return answer(200, {
            user: userRow(OTHER_ID, 'owner@example.com', 3_000),
            // The server reconciles only on the first page, because the
            // reconcile rewrites the column the cursor orders on.
            reconcile: cursor === null
              ? { status: 'ok' }
              : { status: 'skipped', reason: 'a later page of the same walk' },
            workspaces: end < rows.length
              ? { status: 'more', items: slice, next: { after: `2000000\u0000${String(end)}` } }
              : { status: 'end', items: slice },
            viewer: OPERATOR,
          });
        },
      });
      await openControl(browserPage, origin, 'Users');
      await browserPage.evaluate(() => {
        const row = [...document.querySelectorAll('tbody tr')]
          .find((node) => node.textContent?.includes('owner@example.com'));
        if (row instanceof HTMLElement) row.click();
      });
      await browserPage.waitForNetworkIdle();

      const first = await browserPage.evaluate(() => document.body.innerText);
      expect(first).toContain('w000');
      expect(first).not.toContain('w200');

      // `PageWalker`'s own label, arrow included: an exact match is what keeps
      // the job row's Cancel apart from the modal's.
      expect(await clickButton(browserPage, 'Next page \u2192')).toBe(true);
      await browserPage.waitForNetworkIdle();

      const second = await browserPage.evaluate(() => document.body.innerText);
      // The rows that were unreachable before, and the honest statement that this
      // page did not re-reconcile.
      expect(second).toContain('w200');
      expect(second).toContain('w249');
      expect(second).toContain('end of list');
      expect(second).toContain('later page of the walk');
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
