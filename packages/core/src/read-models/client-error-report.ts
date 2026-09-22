/** Best-effort browser render-failure report: one POST, arranged so trying cannot add a second error. */

import {
  CLIENT_ERROR_ENDPOINT,
  CLIENT_RENDER_FAILED,
  COMPONENT_STACK_FRAME,
  STACK_FRAME,
  fitClientErrorReport,
  stackFrames,
  type ClientErrorReport,
} from "./client-error-contract";
import type { ReportedRoute } from './app-routes';

export interface PageIdentity {
  /** The build this page loaded (not the live one), or null when unidentified. */
  release: string | null;
  route: ReportedRoute;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]{0,63}$/u;

/**
 * TypeError (never left or refused) or a DOMException abort. No parse-failure arm: nothing reads the
 * body, so a SyntaxError here is a bug and must propagate.
 */
function isTolerableSendFailure(input: { cause: unknown }): boolean {
  return input.cause instanceof TypeError || input.cause instanceof DOMException;
}

/**
 * Pure: no message, path, or user content, fitted to the bound before send. `release` is the build
 * this page loaded, not the live one; the route compares the two.
 */
function renderFailureReport(
  error: Error,
  componentStack: string,
  page: PageIdentity,
): ClientErrorReport {
  const report: ClientErrorReport = {
    event: CLIENT_RENDER_FAILED,
    // Never `error.message` (may be user or model text); `name` is writable, so re-check its shape.
    errorName: IDENTIFIER.test(error.name) ? error.name : 'Error',
    route: page.route,
    // The frame filter drops V8's `name: message` first line.
    stack: stackFrames(error.stack ?? '', STACK_FRAME).join('\n'),
    componentStack: stackFrames(componentStack, COMPONENT_STACK_FRAME).join('\n'),
  };

  return fitClientErrorReport(page.release === null ? report : { ...report, release: page.release });
}

/**
 * Never rejects for a network reason. `keepalive` so the report survives the reload of a broken view.
 * No deadline: nothing waits on it, and a timer would turn a late report into a lost one.
 */
export async function reportRenderFailure(
  error: Error, componentStack: string, page: PageIdentity,
): Promise<void> {
  const report = renderFailureReport(error, componentStack, page);

  try {
    await fetch(CLIENT_ERROR_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
      keepalive: true,
    });
  } catch (cause) {
    if (!isTolerableSendFailure({ cause })) throw cause;
  }
}
