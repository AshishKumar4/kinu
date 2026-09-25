/**
 * Browser render-failure wire contract, shared by the ErrorBoundary sender and the Worker route.
 * Reports go to Workers Logs, so they carry only reproduction coordinates: never an error message,
 * props, state, query, headers, or user agent. Frame shapes are both the client filter and the
 * server schema, keeping V8's `Name: message` stack header out. `release` exists because the
 * client ships no public source map; build that commit locally to resolve frames.
 */

import * as v from 'valibot';
import { MAX_BLOB_BYTES } from "../obs/analytics/index";
import { REPORTED_ROUTES } from "./app-routes";

export const CLIENT_ERROR_ENDPOINT = '/api/client-errors';

export const CLIENT_RENDER_FAILED = 'client.render_failed';

export const CLIENT_CHAT_STREAM_FAILED = 'client.chat_stream_failed';

/** The only size in this contract: Analytics Engine's per-point blob budget, which silently drops
 *  oversized points. Checked against arriving bytes, never `content-length`. */
export const CLIENT_ERROR_MAX_REQUEST_BYTES = MAX_BLOB_BYTES;

/** A V8 (`    at Foo (url:1:2)`) or JSC/SpiderMonkey (`Foo@url:1:2`) frame; the
 *  `:<line>:<column>` tail is what separates a coordinate from prose. */
export const STACK_FRAME = /^(?:\s*at\s+.+|\S*@\S+):\d+:\d+\)?$/u;

/** A React component-stack line, with or without coordinates; names are identifiers, so no prose
 *  fits. */
export const COMPONENT_STACK_FRAME = /^\s*at\s+[A-Za-z_$][\w$.]*(?:\s+\(\S+:\d+:\d+\))?$/u;

export function stackFrames(text: string, frame: RegExp): string[] {
  return text.split('\n').filter((line) => frame.test(line));
}

function framesSchema(frame: RegExp) {
  return v.pipe(
    v.string(),
    v.check(
      (text) => text.length === 0 || text.split('\n').every((line) => frame.test(line)),
      'every line must be a stack frame; prose is refused so a message cannot ride in',
    ),
  );
}

/** `release` is optional (`vite dev` has no build stamp); the server does not trust it. */
const ClientErrorReportSchema = v.object({
  event: v.literal(CLIENT_RENDER_FAILED),
  release: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-z]{1,64}$/u))),
  route: v.picklist(REPORTED_ROUTES),
  // The error's class, never its message.
  errorName: v.pipe(v.string(), v.regex(/^[A-Za-z_$][\w$]{0,63}$/u)),
  stack: framesSchema(STACK_FRAME),
  componentStack: framesSchema(COMPONENT_STACK_FRAME),
});

export type ClientErrorReport = v.InferOutput<typeof ClientErrorReportSchema>;

/** A part's type and the id its provider gave it (`reasoning-0`, `call_x`): coordinates, never its text. */
const PartTokenSchema = v.pipe(v.string(), v.regex(/^[\w.:-]{1,64}$/u));

/** A `useChat` stream the tab could not read, from the root pane or an actor's. */
const ChatStreamFailureReportSchema = v.object({
  event: v.literal(CLIENT_CHAT_STREAM_FAILED),
  release: ClientErrorReportSchema.entries.release,
  route: ClientErrorReportSchema.entries.route,
  pane: v.picklist(['root', 'actor']),
  errorName: ClientErrorReportSchema.entries.errorName,
  stack: framesSchema(STACK_FRAME),
  part: v.optional(v.object({ type: PartTokenSchema, id: PartTokenSchema })),
});

export type ChatStreamFailureReport = v.InferOutput<typeof ChatStreamFailureReportSchema>;

export const ClientReportSchema = v.variant('event', [ClientErrorReportSchema, ChatStreamFailureReportSchema]);

/** The protocol-error fields `ai`'s `UIMessageStreamError` carries, when the part tokens are well-formed. */
export const StreamPartErrorSchema = v.looseObject({ chunkType: PartTokenSchema, chunkId: PartTokenSchema });

const ENCODER = new TextEncoder();

function reportBytes(report: ClientErrorReport): number {
  return ENCODER.encode(JSON.stringify(report)).byteLength;
}

/** JSON-encoded size minus the quotes the empty-field envelope already paid for. */
function contentBytes(text: string): number {
  return ENCODER.encode(JSON.stringify(text)).byteLength - 2;
}

/** Longest leading run of whole lines fitting `budget`; a half frame would fail the schema. */
function fitFrames(lines: readonly string[], budget: number): string {
  let kept = '';

  for (const line of lines) {
    const next = kept === '' ? line : `${kept}\n${line}`;

    if (contentBytes(next) > budget) break;
    kept = next;
  }

  return kept;
}

/** Fit a report inside {@link CLIENT_ERROR_MAX_REQUEST_BYTES} by encoded bytes: fixed fields are
 *  kept, and the remaining room is split between the two stacks in proportion to their size. */
export function fitClientErrorReport(report: ClientErrorReport): ClientErrorReport {
  if (reportBytes(report) <= CLIENT_ERROR_MAX_REQUEST_BYTES) return report;

  const bare: ClientErrorReport = { ...report, stack: '', componentStack: '' };
  const room = CLIENT_ERROR_MAX_REQUEST_BYTES - reportBytes(bare);

  if (room <= 0) return bare;

  const wantedStack = contentBytes(report.stack);
  const wantedComponent = contentBytes(report.componentStack);
  const wanted = wantedStack + wantedComponent;
  const stackShare = wanted === 0 ? 0 : Math.floor((room * wantedStack) / wanted);

  return {
    ...bare,
    stack: fitFrames(report.stack.split('\n'), stackShare),
    componentStack: fitFrames(report.componentStack.split('\n'), room - stackShare),
  };
}

export function fitChatStreamFailureReport(report: ChatStreamFailureReport): ChatStreamFailureReport {
  const bare = { ...report, stack: '' };
  const room = CLIENT_ERROR_MAX_REQUEST_BYTES - ENCODER.encode(JSON.stringify(bare)).byteLength;

  return room <= 0 ? bare : { ...report, stack: fitFrames(report.stack.split('\n'), room) };
}

/** `stale`: a tab that rode through a deploy and runs code the origin no longer serves. */
export type ReleaseMatch = 'match' | 'stale' | 'unreported' | 'undeployed';
