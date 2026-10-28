/**
 * What left a page blank, for the harnesses that wait on pages (product-flows.ts, gallery-harness.ts): an app script
 * that failed to load, and why, or an uncaught error. A module the entry imports that fails to fetch fails the entry
 * script itself, and a page whose entry never ran draws nothing: 2026-09-24, the host's network changed mid-load,
 * Chrome aborted the module graph with net::ERR_NETWORK_CHANGED, and a row waited on a page that would never draw. A
 * render that throws outside every boundary leaves React's root empty: 2026-09-30, CI run 36754331407, the landing
 * page threw `useAgentsNav requires AgentsNavProvider` and its row waited out its 480 s bound.
 */
import type { CDPSession, Page } from 'puppeteer';

/** Records, on `window.__scriptFailures`, every script element whose load failed, and on `window.__uncaughtErrors`
 *  every error nothing caught, a promise's rejection nothing handled among them. Installed before each document's
 *  scripts run, in every frame of the page, so the scripts the app and the apps it frames load are the recorded ones.
 *  A module a lazy import fails rejects its import and fails no element: the page's error boundary draws that one,
 *  and a boundary's catch is no uncaught error. */
const RECORD_SCRIPT_FAILURES = `(() => {
  window.__scriptFailures = [];
  window.__uncaughtErrors = [];
  window.addEventListener('error', (event) => {
    if (event.target instanceof HTMLScriptElement) window.__scriptFailures.push(event.target.src || 'an inline script');
    else if (event instanceof ErrorEvent) window.__uncaughtErrors.push(event.message);
  }, true);
  window.addEventListener('unhandledrejection', (event) => {
    window.__uncaughtErrors.push('Uncaught (in promise) ' + (event.reason instanceof Error ? event.reason.message : String(event.reason)));
  });
})()`;

/** A script request of a page that failed: its URL, why (the browser's error text, or the status a server
 *  answered), when this process saw it, and the document it was made for (CDP's `loaderId`). */
export interface ScriptFailure {
  readonly at: number;
  readonly url: string;
  readonly reason: string;
  readonly loader: string;
}

/** A request the page or the browser cancelled, such as a navigation leaving: the effect of a failure, never its
 *  cause. */
export const CANCELLED = 'net::ERR_ABORTED';

/** A navigation a page's frame started, committed or not: one that never commits (a 204, a download, an external
 *  protocol) stops the document's loads all the same, which then read as cancelled with nothing failing. */
interface StartedNavigation {
  readonly at: number;
  readonly url: string;
  readonly how: string;
}

const scriptFailures = new WeakMap<Page, { readonly failures: ScriptFailure[]; readonly navigations: StartedNavigation[]; readonly cdp: CDPSession }>();

/** Installs {@link RECORD_SCRIPT_FAILURES} on every document `page` loads, and records why each of its script
 *  requests failed: the page sees only that a module graph failed, the browser's network events say why. */
export async function recordScriptFailures(page: Page): Promise<void> {
  const failures: ScriptFailure[] = [];
  const navigations: StartedNavigation[] = [];
  const requests = new Map<string, { readonly url: string; readonly loader: string }>();
  const cdp = await page.createCDPSession();

  scriptFailures.set(page, { failures, navigations, cdp });
  cdp.on('Page.frameRequestedNavigation', (event) => {
    navigations.push({ at: Date.now(), url: event.url, how: `${event.reason}, ${event.disposition}` });
  });
  cdp.on('Page.frameStartedNavigating', (event) => {
    navigations.push({ at: Date.now(), url: event.url, how: event.navigationType });
  });

  cdp.on('Network.requestWillBeSent', (event) => {
    if (event.type === 'Script') requests.set(event.requestId, { url: event.request.url, loader: event.loaderId });
  });
  // Cancelled module responses can omit ExtraInfo, which Puppeteer's response event waits for.
  cdp.on('Network.responseReceived', (event) => {
    if (event.type !== 'Script' || event.response.status < 400) return;

    failures.push({ at: Date.now(), url: event.response.url, reason: `HTTP ${String(event.response.status)}`, loader: event.loaderId });
    requests.delete(event.requestId);
  });
  cdp.on('Network.loadingFailed', (event) => {
    const request = requests.get(event.requestId);
    requests.delete(event.requestId);

    if (event.type !== 'Script' || request === undefined) return;
    failures.push({ at: Date.now(), ...request, reason: event.errorText });
  });
  cdp.on('Network.loadingFinished', (event) => {
    requests.delete(event.requestId);
  });

  await cdp.send('Network.enable');
  await cdp.send('Page.enable');
  await page.evaluateOnNewDocument(RECORD_SCRIPT_FAILURES);
}

/** Why the current document's script requests failed, as this process saw them: those made for it, by its loader. A
 *  reload cancels the leaving document's requests, and when the browser reports that is no part of the new one's. */
export async function documentScriptFailures(page: Page): Promise<ScriptFailure[]> {
  const recorded = scriptFailures.get(page);

  if (recorded === undefined) return [];
  const { frameTree } = await recorded.cdp.send('Page.getFrameTree');

  return recorded.failures.filter((failure) => failure.loader === frameTree.frame.loaderId);
}

/** The navigations `page` started since its document began, which may be what cancelled its loads. */
async function navigationsSince(page: Page): Promise<string> {
  const started: unknown = await page.evaluate('performance.timeOrigin');
  const since = (scriptFailures.get(page)?.navigations ?? []).filter((navigation) => typeof started === 'number' && navigation.at >= started);

  return since.length === 0 ? '; the page started no navigation since it began'
    : `; since it began the page started ${since.map((navigation) => `${navigation.url} (${navigation.how})`).join(', ')}`;
}

/** In a page or any frame of it: what {@link RECORD_SCRIPT_FAILURES} recorded in that document, the errors nothing
 *  caught and the scripts that did not load. */
export const DOCUMENT_FAULTS = '({ errors: window.__uncaughtErrors ?? [], scripts: window.__scriptFailures ?? [] })';

/** The prefix {@link FAILED_APP_SCRIPT} names a failed app script with. */
export const SCRIPT_FAILED = 'the app script ';

/** In the page: the dead end the last failed app script leaves, or null when none failed. */
export const FAILED_APP_SCRIPT = `((script) => script === undefined ? null
  : ${JSON.stringify(SCRIPT_FAILED)} + script + ' failed to load, which leaves the page blank')((window.__scriptFailures ?? []).at(-1))`;

/** In the page: the dead end a page is at when its root holds nothing, by the last app script that failed to load or,
 *  failing that, the last uncaught error; null while the root holds something or nothing failed. An uncaught error
 *  beside a drawn page is its own fault and no dead end. */
export const BLANK_PAGE = `document.querySelectorAll('#root *').length > 0 ? null : ${FAILED_APP_SCRIPT}
  ?? ((error) => error === undefined ? null
    : 'an uncaught error, ' + error + ', with nothing drawn, which leaves the page blank')((window.__uncaughtErrors ?? []).at(-1))`;

/** `deadEnd`, and when an app script never loaded, why the document's script requests failed. */
export async function explained(page: Page, deadEnd: string): Promise<string> {
  if (!deadEnd.startsWith(SCRIPT_FAILED)) return deadEnd;
  const failures = await documentScriptFailures(page);

  if (failures.length === 0) return `${deadEnd}; no script request of this document failed on the wire`;
  // A cancelled request is the effect of a failure, so a cause is named first.
  const causes = failures.filter((failure) => failure.reason !== CANCELLED);
  const shown = (causes.length > 0 ? causes : failures).slice(0, 5).map((failure) => `${failure.url} (${failure.reason})`);
  const cancelled = failures.length - causes.length;
  const more = causes.length > shown.length ? ` and ${String(causes.length - shown.length)} more` : '';
  const alongside = causes.length > 0 && cancelled > 0 ? `, with ${String(cancelled)} cancelled (${CANCELLED})` : '';

  const only = causes.length === 0
    ? ` (${String(failures.length)} of them, every one cancelled and none failing on its own${await navigationsSince(page)})` : '';

  return `${deadEnd}; its script requests failed: ${shown.join(', ')}${more}${alongside}${only}`;
}
