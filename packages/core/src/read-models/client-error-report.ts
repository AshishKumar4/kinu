/** Best-effort browser render-failure report: one POST, arranged so trying cannot add a second error. */

import * as v from 'valibot';
import {
  CLIENT_CHAT_STREAM_FAILED,
  CLIENT_ERROR_ENDPOINT,
  CLIENT_RENDER_FAILED,
  COMPONENT_STACK_FRAME,
  STACK_FRAME,
  StreamPartErrorSchema,
  fitChatStreamFailureReport,
  fitClientErrorReport,
  stackFrames,
  type ChatStreamFailureReport,
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

/** Pure: no message, path or user content. `release` is this page's build, which the route compares. */
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

export async function reportRenderFailure(
  error: Error, componentStack: string, page: PageIdentity,
): Promise<void> {
  await send(renderFailureReport(error, componentStack, page));
}

/** Once per error; a protocol error adds its part. */
export async function reportChatStreamFailure(
  error: Error, pane: ChatStreamFailureReport['pane'], page: PageIdentity,
): Promise<void> {
  const part = v.safeParse(StreamPartErrorSchema, error);

  const report: ChatStreamFailureReport = {
    event: CLIENT_CHAT_STREAM_FAILED,
    errorName: IDENTIFIER.test(error.name) ? error.name : 'Error',
    route: page.route,
    pane,
    stack: stackFrames(error.stack ?? '', STACK_FRAME).join('\n'),
    ...(part.success && { part: { type: part.output.chunkType, id: part.output.chunkId } }),
  };

  await send(fitChatStreamFailureReport(page.release === null ? report : { ...report, release: page.release }));
}

/** Never rejects on the network; `keepalive` outlives a reload. */
async function send(report: ClientErrorReport | ChatStreamFailureReport): Promise<void> {
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
