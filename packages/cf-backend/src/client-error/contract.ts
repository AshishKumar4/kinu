/**
 * The browser render-failure wire contract, shared by the ErrorBoundary that
 * sends and the Worker route that parses.
 *
 * ## What this endpoint exists for
 *
 * A render-time throw in the SPA was, until this, invisible to whoever operates
 * the deployment. `ErrorBoundary` wrote the error to `console`, which reaches a
 * developer with devtools open and nobody else; its comment claimed "production
 * builds get the same stack via the browser's existing error reporting", and
 * there was no such reporting. A whitescreened tab in front of a user produced
 * no line anywhere an operator reads.
 *
 * ## Why the payload is this small
 *
 * The destination is Workers Logs: a shared operational sink with a different
 * audience and a different retention from a user's session. So the report
 * carries only what an operator needs in order to REPRODUCE the fault, and
 * every field is either a fixed vocabulary or a machine-shaped coordinate:
 *
 *   - the event name, which the server pins to one literal;
 *   - the build the page was running, so the stack's coordinates mean something;
 *   - the route TEMPLATE, never a path (`../app-routes.ts` states why);
 *   - the error's CLASS name, never its message;
 *   - stack frames, with V8's `Error: <message>` header stripped;
 *   - React's component stack, which is component names and coordinates.
 *
 * No message, no props, no state, no query string, no headers, no cookies, no
 * user agent, and no error object handed over whole. That list is not caution:
 * an exception's message is routinely the model's text, a file the agent read,
 * or a credential a provider echoed back, which is the same reason
 * `RESERVED_LOG_FIELDS` refuses `content` and `prompt` by type.
 *
 * ## Why the frame grammar is enforced twice
 *
 * `error.stack` in V8 BEGINS with `${name}: ${message}` — the one thing that
 * must not travel. Dropping that line in the sender is necessary and not
 * sufficient, because the sender is a browser and the route trusts none of it.
 * So the frame shapes below are the filter the client applies AND the schema the
 * Worker enforces: a line that is not a coordinate is refused at the boundary
 * rather than written to a log and regretted.
 *
 * ## How a report becomes a line of source
 *
 * The client bundle ships with NO source map, on purpose: `vite.config.ts`
 * excludes the client environment because a map there is original TypeScript
 * served from the public origin. So the frames a report carries are positions in
 * a minified, content-hashed asset, and they are useless without the build they
 * belong to. That is the whole reason `release` exists and the whole reason the
 * route does not take the browser's word for it.
 *
 * With the exact sha, the recipe is closed: check that commit out, build the
 * client, and the emitted map — generated locally, never published — resolves the
 * reported `line:column` to the original file. `releaseMatch` is what says
 * whether `HEAD` is that commit. Nothing about that path requires a map on the
 * origin, which is why one is not served.
 *
 * ## One bound, and no suballocations
 *
 * There is a single size in this contract, and it is not a choice made here:
 * see {@link CLIENT_ERROR_MAX_REQUEST_BYTES}. The two stacks are fitted into
 * whatever room the fixed fields leave, proportionally, by
 * {@link fitClientErrorReport}. Per-field character caps were deliberately not
 * added — they would be two more numbers nobody measured, and they would let a
 * report pass both of them and still not fit the one bound that is real.
 */

import * as v from 'valibot';
import { MAX_BLOB_BYTES } from '../analytics/limits';
import { REPORTED_ROUTES } from '../app-routes';

export const CLIENT_ERROR_ENDPOINT = '/api/client-errors';

/**
 * The one event name this endpoint writes, spelled once for the emitter and the
 * query. `client` rather than `browser`: the subsystem is this app's own client
 * half, which is what a reader filtering the family is asking about.
 */
export const CLIENT_RENDER_FAILED = 'client.render_failed';

/**
 * The only size in this contract.
 *
 * Not a number chosen here, and deliberately not a second spelling of one: it IS
 * Analytics Engine's per-data-point blob budget, quoted from the platform in
 * `analytics/limits.ts`. `diagnostics` fans out to `console` and to Analytics
 * Engine, so a report that cannot fit one telemetry data point is a report the
 * sink could not carry whole; refusing it at ingress is honest where truncating
 * it silently downstream is not — and AE drops an oversized point with no error
 * on any surface, which is exactly the failure this endpoint exists to end.
 *
 * Checked as a count of ARRIVING bytes by `readBounded`, never as a declared
 * `content-length`; the reasoning for that lives on the bound itself in
 * `lib/http.ts`.
 */
export const CLIENT_ERROR_MAX_REQUEST_BYTES = MAX_BLOB_BYTES;

/**
 * One stack frame, in the two shapes browsers write it:
 *
 *   V8                  `    at ChatMessages (https://host/assets/index-a1b2c3.js:1:2345)`
 *   JSC / SpiderMonkey  `ChatMessages@https://host/assets/index-a1b2c3.js:1:2345`
 *
 * Both END in `:<line>:<column>`, optionally inside V8's parentheses, and that
 * tail is what makes a line a coordinate rather than prose. Anonymous frames
 * (`    at https://host/…:1:2`), constructor frames (`at new Foo (…)`), async
 * frames and `eval` frames all satisfy it. A message does not, unless it was
 * written to look exactly like a frame.
 */
export const STACK_FRAME = /^(?:\s*at\s+.+|\S*@\S+):\d+:\d+\)?$/u;

/**
 * One line of React's component stack: `    at Foo (url:1:2)`, or the bare
 * `    at div` React writes for a host element. A bare frame carries no
 * coordinate and is still worth keeping — the component NAMES are the path
 * through the tree — and a component name is a code identifier, so the shape
 * stays closed without admitting prose.
 */
export const COMPONENT_STACK_FRAME = /^\s*at\s+[A-Za-z_$][\w$.]*(?:\s+\(\S+:\d+:\d+\))?$/u;

/** The lines of `text` that are frames of the given shape, in order. */
export function stackFrames(text: string, frame: RegExp): string[] {
  return text.split('\n').filter((line) => frame.test(line));
}

/**
 * A block of frames, of any length the one request bound allows.
 *
 * Empty is admitted: a browser that produced no stack for a throw still has a
 * fault worth reporting, with one field missing. Every line that IS present must
 * be a frame, which is the half that keeps a message out.
 */
function framesSchema(frame: RegExp) {
  return v.pipe(
    v.string(),
    v.check(
      (text) => text.length === 0 || text.split('\n').every((line) => frame.test(line)),
      'every line must be a stack frame; prose is refused so a message cannot ride in',
    ),
  );
}

/**
 * The report, as the browser sends it and the Worker parses it.
 *
 * `release` is OPTIONAL because a page whose build could not be identified — a
 * `vite dev` server publishes no build stamp — still has a fault worth
 * reporting. It is also the one field the server does not take the browser's
 * word for: see `route.ts`.
 */
export const ClientErrorReportSchema = v.object({
  event: v.literal(CLIENT_RENDER_FAILED),
  release: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-z]{1,64}$/u))),
  route: v.picklist(REPORTED_ROUTES),
  // The error's CLASS, which is a JavaScript identifier, and never its message.
  errorName: v.pipe(v.string(), v.regex(/^[A-Za-z_$][\w$]{0,63}$/u)),
  stack: framesSchema(STACK_FRAME),
  componentStack: framesSchema(COMPONENT_STACK_FRAME),
});

export type ClientErrorReport = v.InferOutput<typeof ClientErrorReportSchema>;

const ENCODER = new TextEncoder();

/** The encoded size of one report, which is the quantity the bound is on. */
export function reportBytes(report: ClientErrorReport): number {
  return ENCODER.encode(JSON.stringify(report)).byteLength;
}

/** What a string costs INSIDE the envelope: its JSON form without the quotes,
 *  which the empty-field envelope has already paid for. */
function contentBytes(text: string): number {
  return ENCODER.encode(JSON.stringify(text)).byteLength - 2;
}

/**
 * The longest leading run of `lines` whose encoded content fits `budget`.
 *
 * Whole lines, never a byte slice: a frame is the smallest unit that means
 * anything, cutting one in half can produce a line the schema then refuses, and
 * dropping lines cannot split a code point into invalid UTF-8. Frames are shed
 * from the DEEP end, so the throw site — the frames anyone reads first — is what
 * survives a squeeze.
 */
function fitFrames(lines: readonly string[], budget: number): string {
  let kept = '';
  for (const line of lines) {
    const next = kept === '' ? line : `${kept}\n${line}`;
    if (contentBytes(next) > budget) break;
    kept = next;
  }
  return kept;
}

/**
 * Fit a report inside {@link CLIENT_ERROR_MAX_REQUEST_BYTES}.
 *
 * The fixed fields are paid first and never dropped: the build sha, the error's
 * class and the route are what make a report actionable, and a truncated stack
 * with all three is worth incomparably more than a whole stack with none. What
 * is left over is split between the two stacks IN PROPORTION to what each asked
 * for, so a deep React tree does not starve the JavaScript stack and a long
 * minified stack does not starve the component path.
 *
 * Measured on the ENCODED report rather than on character counts, because the
 * bound is on bytes and JSON escaping is not free: one newline inside a string
 * is two bytes on the wire, and a non-ASCII identifier is up to four.
 *
 * This is the only place either stack is shortened. The route re-checks the same
 * total against arriving bytes and refuses anything over it, so a sender that
 * skips this — or lies — is answered rather than trusted.
 */
export function fitClientErrorReport(report: ClientErrorReport): ClientErrorReport {
  if (reportBytes(report) <= CLIENT_ERROR_MAX_REQUEST_BYTES) return report;

  const bare: ClientErrorReport = { ...report, stack: '', componentStack: '' };
  const room = CLIENT_ERROR_MAX_REQUEST_BYTES - reportBytes(bare);
  if (room <= 0) return bare;

  const wantedStack = contentBytes(report.stack);
  const wantedComponent = contentBytes(report.componentStack);
  const wanted = wantedStack + wantedComponent;
  // Both empty and still over the bound is impossible here: `room > 0` says the
  // envelope fits, and an over-bound report with nothing in either stack would
  // have returned at the first check.
  const stackShare = wanted === 0 ? 0 : Math.floor((room * wantedStack) / wanted);

  return {
    ...bare,
    stack: fitFrames(report.stack.split('\n'), stackShare),
    componentStack: fitFrames(report.componentStack.split('\n'), room - stackShare),
  };
}

/**
 * How the reported build compares to the one this deployment is serving. Four
 * arms because four states are distinguishable, and collapsing them would throw
 * away the interesting one: `stale` is a tab that rode through a deploy and is
 * running code the origin no longer serves, which is a whole class of render
 * failure that reads as a mystery until this field names it.
 */
export const RELEASE_MATCHES = ['match', 'stale', 'unreported', 'undeployed'] as const;
export type ReleaseMatch = (typeof RELEASE_MATCHES)[number];
