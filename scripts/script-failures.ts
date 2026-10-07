/**
 * What left a page blank, for the harnesses that wait on pages (product-flows.ts, gallery-harness.ts): an app script
 * that failed to load, and why, or an uncaught error. A module the entry imports that fails to fetch fails the entry
 * script itself, and a page whose entry never ran draws nothing: 2026-09-24, the host's network changed mid-load,
 * Chrome aborted the module graph with net::ERR_NETWORK_CHANGED, and a row waited on a page that would never draw. A
 * render that throws outside every boundary leaves React's root empty: 2026-09-30, CI run 36754331407, the landing
 * page threw `useAgentsNav requires AgentsNavProvider` and its row waited out its 480 s bound.
 */
import type { Page } from 'puppeteer';
import * as v from 'valibot';

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
 *  answered), and when this process saw it. */
export interface ScriptFailure {
  readonly at: number;
  readonly url: string;
  readonly reason: string;
}

const scriptFailures = new WeakMap<Page, ScriptFailure[]>();

/** Installs {@link RECORD_SCRIPT_FAILURES} on every document `page` loads, and records why each of its script
 *  requests failed: the page sees only that a module graph failed, the browser's network events say why. */
export async function recordScriptFailures(page: Page): Promise<void> {
  const failures: ScriptFailure[] = [];
  const requests = new Map<string, string>();

  scriptFailures.set(page, failures);

  const cdp = await page.createCDPSession();

  cdp.on('Network.requestWillBeSent', (event) => {
    if (event.type === 'Script') requests.set(event.requestId, event.request.url);
  });
  // Cancelled module responses can omit ExtraInfo, which Puppeteer's response event waits for.
  cdp.on('Network.responseReceived', (event) => {
    if (event.type !== 'Script' || event.response.status < 400) return;

    failures.push({ at: Date.now(), url: event.response.url, reason: `HTTP ${String(event.response.status)}` });
    requests.delete(event.requestId);
  });
  cdp.on('Network.loadingFailed', (event) => {
    const url = requests.get(event.requestId);
    requests.delete(event.requestId);

    if (event.type !== 'Script' || url === undefined) return;
    failures.push({ at: Date.now(), url, reason: event.errorText });
  });
  cdp.on('Network.loadingFinished', (event) => {
    requests.delete(event.requestId);
  });

  await cdp.send('Network.enable');
  await page.evaluateOnNewDocument(RECORD_SCRIPT_FAILURES);
}

/** Why the current document's script requests failed, as this process saw them: those since its navigation
 *  started. */
export async function documentScriptFailures(page: Page): Promise<ScriptFailure[]> {
  const started = v.parse(v.number(), await page.evaluate('performance.timeOrigin'));

  return (scriptFailures.get(page) ?? []).filter((failure) => failure.at >= started);
}

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

  const shown = failures.slice(0, 5).map((failure) => `${failure.url} (${failure.reason})`);
  const more = failures.length > shown.length ? ` and ${String(failures.length - shown.length)} more` : '';

  return `${deadEnd}; its script requests failed: ${shown.join(', ')}${more}`;
}
