/**
 * The browser half of the render-failure report.
 *
 * One POST, best effort, from a page that has just failed to render. Everything
 * about it is arranged so that trying cannot make the situation worse: the
 * fallback UI is already on screen by the time this runs (React sets the
 * boundary's state before calling `componentDidCatch`), the request is fitted to
 * the one bound in `contract.ts` before it leaves, and a transport failure is
 * tolerated by name rather than allowed to become a second error on a page that
 * already has one.
 */

import {
  CLIENT_ERROR_ENDPOINT,
  CLIENT_RENDER_FAILED,
  COMPONENT_STACK_FRAME,
  STACK_FRAME,
  fitClientErrorReport,
  stackFrames,
  type ClientErrorReport,
} from './contract';
import { routeTemplateOf, type ReportedRoute } from '../app-routes';
import { pageDeployedBuildSha } from '../hooks/session-recovery';

/**
 * What the PAGE contributes to a report, as opposed to what the error does.
 *
 * Both are read at the I/O boundary in {@link reportRenderFailure}, which keeps
 * {@link renderFailureReport} a pure function of its inputs — the claim worth
 * testing about it is "nothing but these fields ever leaves", and a builder that
 * reaches for `location` itself cannot be asked that question directly.
 */
export interface PageIdentity {
  /** The build this page LOADED, or null when it could not be identified. */
  release: string | null;
  route: ReportedRoute;
}

/** A JavaScript identifier, which is what an error's CLASS name is. */
const IDENTIFIER = /^[A-Za-z_$][\w$]{0,63}$/u;

/**
 * Transport-level failures of a best-effort write: the request never left the
 * process or was refused before an answer (TypeError), or it was aborted and the
 * abort travelled as a DOMException — the browser tearing down a keepalive
 * request as the document goes away, for instance. Both are the network rather
 * than a defect here, and both are the ordinary case for a page whose origin has
 * just gone away.
 *
 * There is deliberately no third arm for a parse failure: nothing here reads the
 * response body, so a SyntaxError from this call would be a bug in this file and
 * has no business being silenced. Anything outside the two propagates.
 */
function isTolerableSendFailure<Failure>(cause: Failure): boolean {
  return cause instanceof TypeError || cause instanceof DOMException;
}

/**
 * The report a caught render error becomes.
 *
 * Pure, and exported, because two different claims live here and only one of
 * them needs a network: that the payload carries no message, no path and no user
 * content, and that it is fitted to the bound before it is sent.
 *
 * `release` is the build this PAGE loaded, never the one live now. That
 * distinction is the whole value of the field — a tab open across a deploy is
 * running code the origin no longer serves — and the route compares the two.
 */
export function renderFailureReport(
  error: Error,
  componentStack: string,
  page: PageIdentity,
): ClientErrorReport {
  const report: ClientErrorReport = {
    event: CLIENT_RENDER_FAILED,
    // `Error` when nothing set one, a class name when something did. Never
    // `error.message`, which is whatever threw and is routinely a user's or a
    // model's own text. Re-checked against the identifier shape rather than
    // trusted: `name` is a writable property and anything can be assigned to it.
    errorName: IDENTIFIER.test(error.name) ? error.name : 'Error',
    route: page.route,
    // V8 puts `${name}: ${message}` on the first line of `stack`; the frame
    // filter drops it, and every other line that is not a coordinate with it.
    stack: stackFrames(error.stack ?? '', STACK_FRAME).join('\n'),
    componentStack: stackFrames(componentStack, COMPONENT_STACK_FRAME).join('\n'),
  };
  return fitClientErrorReport(page.release === null ? report : { ...report, release: page.release });
}

/**
 * Send one report for a caught render error.
 *
 * Never rejects for a network reason, so a caller may `void` it. The dedupe that
 * keeps repeated React rendering of one error to one report lives in the
 * ErrorBoundary instance, not here: this function sends what it is given.
 *
 * `keepalive` because the reader of a broken view reloads it, and without the
 * flag a report in flight dies with the document. Its 64 KiB body ceiling is
 * four times the bound this payload is already fitted to.
 *
 * NO DEADLINE, deliberately. This promise is voided by the ErrorBoundary and the
 * fallback is on screen before it is created, so nothing on the page waits for
 * it: a timer could only abort a request the browser is already managing, and it
 * would turn a slow origin into a report that never arrives instead of one that
 * arrives late. A send that never settles is left to the document's own
 * lifetime, which is exactly what `keepalive` is for.
 */
export async function reportRenderFailure(error: Error, componentStack: string): Promise<void> {
  const report = renderFailureReport(error, componentStack, {
    release: await pageDeployedBuildSha(),
    route: routeTemplateOf(location.pathname),
  });
  try {
    await fetch(CLIENT_ERROR_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
      keepalive: true,
    });
  } catch (cause) {
    if (!isTolerableSendFailure(cause)) throw cause;
  }
}
