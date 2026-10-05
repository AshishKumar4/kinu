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
import { Cause, Effect } from 'effect';
import { KinuError } from '../obs/index';
import { settle } from '../obs/effect';

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

/** Frames after V8's `name: message` header. */
function errorFrames(error: Error): string {
  const stack = error.stack ?? '';
  const header = String(error);

  return stackFrames(stack.startsWith(header) ? stack.slice(header.length) : stack, STACK_FRAME).join('\n');
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
    stack: errorFrames(error),
    componentStack: stackFrames(componentStack, COMPONENT_STACK_FRAME).join('\n'),
  };

  return fitClientErrorReport(page.release === null ? report : { ...report, release: page.release });
}

export function reportRenderFailure(
  error: Error, componentStack: string, page: PageIdentity,
): Promise<void> {
  return settle(Effect.suspend(() => send(renderFailureReport(error, componentStack, page))));
}

/** Once per error; a protocol error adds its part. */
export function reportChatStreamFailure(
  error: Error, pane: ChatStreamFailureReport['pane'], page: PageIdentity,
): Promise<void> {
  return settle(Effect.gen(function* () {
    const part = v.safeParse(StreamPartErrorSchema, error);

    const report: ChatStreamFailureReport = {
      event: CLIENT_CHAT_STREAM_FAILED,
      errorName: IDENTIFIER.test(error.name) ? error.name : 'Error',
      route: page.route,
      pane,
      stack: errorFrames(error),
      ...(part.success && { part: { type: part.output.chunkType, id: part.output.chunkId } }),
    };

    return yield* send(fitChatStreamFailureReport(page.release === null ? report : { ...report, release: page.release }));
  }));
}

/** Never rejects on the network; `keepalive` outlives a reload. A refused report rejects. */
function send(report: ClientErrorReport | ChatStreamFailureReport): Effect.Effect<void, KinuError> {
  const posted = Effect.promise(async () => fetch(CLIENT_ERROR_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report),
    keepalive: true,
  }));

  return Effect.catchCause(posted, (failed) => (isTolerableSendFailure({ cause: Cause.squash(failed) }) ? Effect.succeed(null) : Effect.failCause(failed))).pipe(
    Effect.flatMap((answer) => Effect.gen(function* () {
      if (answer === null || answer.ok) return;

      return yield* new KinuError('io', `the error report was refused: ${String(answer.status)} ${(yield* Effect.promise(async () => answer.text())).slice(0, 160)}`);
    })),
  );
}
