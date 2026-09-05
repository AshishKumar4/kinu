/**
 * `POST /api/feedback` — one authenticated multipart submission becomes one R2
 * object plus one control-plane row.
 *
 * Auth is upstream: server.ts resolves the identity and runs the CSRF gate
 * before this module sees a request. The 401 arm here is the module's own trust
 * boundary rather than a second gate — a caller that hands us no identity gets
 * refused by the code that would otherwise write a row with nobody's name on it.
 *
 * ORDER OF REFUSAL IS THE DESIGN. `content-length` is checked before the body is
 * read, the body is COUNTED as it arrives, the declared part type is checked
 * before its bytes, and the bytes before storage, so an oversized or forged
 * report costs a header parse rather than 8 MiB of buffering and an R2 write.
 * A declared length is an optimisation and never the gate: an absent one parses
 * as zero, so the only bound that holds for a body whose length is not announced
 * is the counter the stream is read through.
 *
 * WHO A REPORT IS ABOUT IS PROVEN, NOT ACCEPTED. The workspace field is a name
 * the browser read off a URL, so it is checked against the reporter's own
 * registry before anything is stored, written or counted as accepted. A report
 * that names no workspace asks nothing and is unchanged.
 *
 * THE COMMIT POINT IS THE ROW, NOT THE OBJECT. R2 is written first because the
 * row has to carry a pointer to something, which means a failed row write leaves
 * an object nothing references. That object is deleted here before the request
 * is answered, so a lost report never leaves paid-for bytes behind — and the
 * failure is recorded as `row_write_failed`, kept apart from client errors
 * because it is the only outcome that means we accepted a report and then lost it.
 *
 * NOTHING IS RETRIED. A retry would double-write an object or a row, and the
 * client already holds the capture in memory and offers the reporter an explicit
 * retry. One attempt here, one honest answer.
 */

import type { AuthIdentity } from '../auth/session';
import { diagnostics, KinuError, toKinuError } from '@kinu.run/core/obs';
import { err, json, readBounded } from '../lib/http';
import { sanitizePng, type PngFault } from './png';
import {
  feedbackRouteFamily,
  type FeedbackMarker,
  type FeedbackRejectReason,
} from '../analytics/feedback-marker';
import {
  FEEDBACK_ENDPOINT,
  FEEDBACK_FIELDS,
  FEEDBACK_MAX_NOTE_CHARS,
  FEEDBACK_MAX_REQUEST_BYTES,
  FEEDBACK_MAX_ROUTE_CHARS,
  FEEDBACK_MAX_SCREENSHOT_BYTES,
  FEEDBACK_MAX_USER_AGENT_CHARS,
  FEEDBACK_SCREENSHOT_TYPE,
  type FeedbackAccepted,
  type FeedbackRecord,
} from './contract';

/** Where the screenshot bytes go. Two methods, because two are used: the write
 *  and the orphan delete. Narrower than `R2Bucket` so the policy below can be
 *  driven without one. */
export interface FeedbackStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * What the ownership authority answered about a workspace a report names.
 *
 * THREE ARMS, NOT TWO. "Not yours" and "we could not ask" are different facts
 * with different owners: the first is the reporter's attribution to fix, the
 * second is our outage, and folding them together would either blame a reporter
 * for our downtime or accept an unproven attribution during it.
 *
 * `owned` carries the name BACK rather than being a boolean, so the row is
 * written from the authority's answer and never from the submitted string. The
 * registry keys a workspace by that name — there is no second identifier to
 * canonicalise to — so what this guarantees is that nothing unproven can reach
 * the row: a caller cannot write through this type without an answer.
 *
 * A name that is not a workspace name at all, and a name that is somebody
 * else's, are ONE arm on purpose: telling them apart would answer "does this
 * workspace exist" for any string a prober cares to send.
 */
export type WorkspaceAttribution =
  | { kind: 'owned'; workspace: string }
  | { kind: 'refused' }
  | { kind: 'unavailable'; error: string };

/**
 * Everything the submission policy reaches outside itself. Injected rather than
 * imported so the policy is drivable without R2, a Durable Object or an
 * analytics binding — the three things a unit test cannot have and the three
 * this endpoint is otherwise made of.
 */
export interface FeedbackDeps {
  /** Absent when the deployment has no feedback bucket bound. A note-only
   *  report still succeeds; a screenshot is refused with a reason that names
   *  the deployment rather than blaming the reporter. */
  store: FeedbackStore | null;
  record(row: FeedbackRecord): Promise<{ id: string } | { error: string }>;
  /** Whether the reporter owns the workspace their report names. Asked before
   *  any byte is stored, any row is written and any marker says `accepted`, so
   *  an attribution nobody proved cannot reach triage. Never asked at all when
   *  a report names no workspace — general feedback is not a workspace claim. */
  attributeWorkspace(userId: string, workspace: string): Promise<WorkspaceAttribution>;
  mark(marker: FeedbackMarker): void;
  newId(): string;
  now(): number;
}

/**
 * What the marker gets to say about a submission, accumulated as the request is
 * read so a refusal can describe what it refused.
 *
 * `screenshotAttempted` is separate from `screenshotBytes` because a size is not
 * a presence: it is set the moment a screenshot part is seen, which is what lets
 * every screenshot-refusal arm report that a screenshot was carried. Derived
 * from the byte count instead, the bad-type and PNG-fault arms all claimed
 * `hasScreenshot: false` for submissions that demonstrably had one — under-
 * counting exactly the population the screenshot dimensions exist to describe.
 */
interface Observed {
  route: string;
  noteLength: number;
  screenshotAttempted: boolean;
  screenshotBytes: number;
  annotated: boolean;
}

/** A rejected submission still produces its marker, because a rejection rate is
 *  the number that says the endpoint is refusing real reports. */
function refuse(
  deps: FeedbackDeps,
  status: number,
  message: string,
  reason: Exclude<FeedbackRejectReason, ''>,
  observed: Observed,
): Response {
  deps.mark({
    feedbackId: deps.newId(),
    outcome: 'rejected',
    rejectReason: reason,
    routeFamily: feedbackRouteFamily(observed.route),
    hasScreenshot: observed.screenshotAttempted,
    screenshotBytes: observed.screenshotBytes,
    noteLength: observed.noteLength,
    annotated: observed.annotated,
  });
  return err(status, message);
}

/** How a structural PNG fault is answered. Named rather than anonymous, so the
 *  mapping below is checked against one contract instead of restating a shape
 *  at each arm. */
interface PngRefusal {
  status: number;
  reason: Exclude<FeedbackRejectReason, ''>;
}

/** Only `dimensions` is a size refusal; every other fault says the bytes are
 *  not the image they claimed to be. */
function pngRefusalFor(fault: PngFault): PngRefusal {
  switch (fault) {
    case 'dimensions': return { status: 413, reason: 'too_large' };
    case 'not-png':
    case 'truncated':
    case 'bad-crc':
    case 'bad-structure': return { status: 400, reason: 'malformed' };
  }
}

/** A text field, trimmed and clamped. `FormData.get` answers with a file, a
 *  string or nothing; a file under a text field's name is not a value this
 *  endpoint has a use for, so it reads as absent. */
function readField(form: FormData, name: string, max: number): string {
  const raw = form.get(name);
  return raw === null || raw instanceof Blob ? '' : raw.trim().slice(0, max);
}

/** The two fixed sentences this endpoint answers a whole unusable request with.
 *  Declared once because each is now reachable from two arms, and two copies of
 *  a refusal drift into two different messages for one refusal. */
const OVER_REQUEST_LIMIT = `Feedback is limited to ${String(FEEDBACK_MAX_SCREENSHOT_BYTES >> 20)} MiB. Send the note without the screenshot, or capture a smaller area.`;
const UNREADABLE_FORM = 'Could not read the feedback form.';

/**
 * The bounded bytes as the multipart form they claim to be, or the classified
 * failure that says they are not.
 *
 * A NEW request rather than the original: the original's body is spent by the
 * bounded read, and the parser needs nothing else from it but the content type
 * that carries the boundary. `formData()` is the Body mixin's own multipart
 * parser either way — the same one the incoming request would have used — so the
 * only thing that changed is which object holds the bytes.
 *
 * `formData()` rejects with a `TypeError` on a body that is not the multipart it
 * declared. Left to propagate that was a platform 500 for a request this
 * endpoint has a 400 for. Returned as `null` it was the opposite defect: `null`
 * is what an ABSENT form reads as too, so the policy could not tell a body it
 * should refuse from one it never got, and it recorded the fault under a class
 * (`unavailable`) that blamed the platform for a caller's bytes.
 *
 * So the failure travels, classified, and the policy records it and refuses from
 * it. `bad_input` is the class for an unrecognised failure at a decoder: these
 * bytes are not the shape they were declared to be. A fault the platform names
 * for itself — an abort, a memory wall — keeps that class through
 * `classifyErrorCode`, so the diagnostic separates our failures from theirs even
 * though the answer is the one 400 this endpoint has for an unusable body.
 */
async function parseMultipart(
  url: string,
  contentType: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<FormData | KinuError> {
  const carrier = new Request(url, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: bytes,
  });
  try {
    return await carrier.formData();
  } catch (cause) {
    return toKinuError({
      doing: 'parsing a feedback submission as multipart/form-data',
      cause,
      otherwise: 'bad_input',
    });
  }
}

/**
 * The whole submission policy, over injected effects. Answers every request it
 * is handed; the caller has already decided this is a POST to the endpoint.
 *
 * Module-private: `routeFeedback` below is the one way in, and it is what the
 * tests drive, so the policy has exactly one entry rather than one for the
 * Worker and one for a test.
 */
async function handleFeedbackSubmission(
  request: Request,
  identity: AuthIdentity | null,
  deps: FeedbackDeps,
): Promise<Response> {
  const blank: Observed = {
    route: '', noteLength: 0, screenshotAttempted: false, screenshotBytes: 0, annotated: false,
  };
  if (identity === null) {
    return refuse(deps, 401, 'Sign in to send feedback.', 'unauthenticated', blank);
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return refuse(deps, 415, 'Send feedback as multipart/form-data.', 'bad_content_type', blank);
  }

  // Before the body is read: a declared length that cannot fit one screenshot
  // plus its fields is refused without buffering it.
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > FEEDBACK_MAX_REQUEST_BYTES) {
    return refuse(deps, 413, OVER_REQUEST_LIMIT, 'too_large', blank);
  }

  const bounded = await readBounded(request, FEEDBACK_MAX_REQUEST_BYTES);
  if (bounded === 'too_large') {
    return refuse(deps, 413, OVER_REQUEST_LIMIT, 'too_large', blank);
  }
  if (bounded instanceof KinuError) {
    diagnostics.failure('feedback.body_unreadable', bounded);
    return refuse(deps, 400, UNREADABLE_FORM, 'malformed', blank);
  }

  const form = await parseMultipart(request.url, contentType, bounded);
  if (form instanceof KinuError) {
    // Recorded HERE rather than inside the decoder, because the byte count that
    // makes the line worth reading belongs to this frame and a decoder that
    // logged would be deciding what its caller's failure means.
    diagnostics.failure('feedback.body_unparseable', form, { bytes: bounded.byteLength });
    return refuse(deps, 400, UNREADABLE_FORM, 'malformed', blank);
  }

  const note = readField(form, FEEDBACK_FIELDS.note, FEEDBACK_MAX_NOTE_CHARS);
  const route = readField(form, FEEDBACK_FIELDS.route, FEEDBACK_MAX_ROUTE_CHARS);
  const workspaceField = readField(form, FEEDBACK_FIELDS.workspace, FEEDBACK_MAX_ROUTE_CHARS);
  const annotated = form.get(FEEDBACK_FIELDS.annotated) === '1';
  const observed: Observed = {
    route, noteLength: note.length, screenshotAttempted: false, screenshotBytes: 0, annotated,
  };

  const part = form.get(FEEDBACK_FIELDS.screenshot);
  // A string in the screenshot field means a caller sent something else under
  // that name.
  const shot = part instanceof Blob ? part : null;
  if (part !== null && shot === null) {
    return refuse(deps, 415, 'The screenshot must be a PNG file.', 'bad_content_type', observed);
  }
  if (shot !== null) {
    // Recorded BEFORE any refusal below it, so a rejection marker states that a
    // screenshot was carried and how big the part was, whatever the arm — the
    // attribution refusals included, which happen before the bytes are read.
    observed.screenshotAttempted = true;
    observed.screenshotBytes = shot.size;
  }

  if (shot === null && note.length === 0) {
    return refuse(deps, 400, 'Add a note or a screenshot before sending.', 'no_content', observed);
  }

  // WHO THE REPORT IS ABOUT IS NOT THE REPORTER'S TO ASSERT. The workspace field
  // is a string the browser derived from a URL, so a caller can put any name in
  // it; attributing a report to somebody else's workspace corrupts triage and
  // the audit trail of an account that never filed it. The authority answers
  // before the screenshot is stored, before the row is written and before any
  // marker says `accepted` — the three things an unproven claim must not reach.
  //
  // A report that names NO workspace is untouched: general feedback is not a
  // claim about anything, and nothing is asked about it.
  const attribution = workspaceField.length === 0
    ? null
    : await deps.attributeWorkspace(identity.userId, workspaceField);
  if (attribution?.kind === 'refused') {
    return refuse(
      deps, 403,
      'That workspace is not one of yours. Send the report without a workspace, or file it from the workspace it is about.',
      'unowned_workspace', observed,
    );
  }
  if (attribution?.kind === 'unavailable') {
    // OUR outage, and said as one. The report is refused rather than filed
    // unattributed: a report silently stripped of the workspace it was about is
    // a worse answer than one the reporter can send again.
    diagnostics.failure('feedback.workspace_unverified', toKinuError({
      doing: 'confirming the reporter owns the workspace their report names',
      cause: attribution.error,
      otherwise: 'unavailable',
    }), { feedbackRoute: feedbackRouteFamily(route) });
    return refuse(
      deps, 503,
      'That workspace could not be confirmed right now. Try again in a moment.',
      'workspace_unverified', observed,
    );
  }

  let screenshot: { key: string; bytes: Uint8Array } | null = null;
  const id = deps.newId();

  if (shot !== null) {
    // A COURTESY REFUSAL, NOT THE GATE. Measured 2026-08-24: a multipart part
    // sent with `Content-Type: image/jpeg` and the filename `shot.png` parses
    // back with `File.type === 'image/png'` — the runtime derives the type from
    // the FILENAME, so the declaration is caller-controlled and proves nothing.
    // It is still checked, because an honest client that picked the wrong file
    // deserves "that is not a PNG" rather than "those bytes are corrupt". The
    // gate is `sanitizePng` below, which reads the bytes.
    if (shot.type.toLowerCase() !== FEEDBACK_SCREENSHOT_TYPE) {
      return refuse(deps, 415, 'The screenshot must be a PNG.', 'bad_content_type', observed);
    }
    if (shot.size > FEEDBACK_MAX_SCREENSHOT_BYTES) {
      return refuse(
        deps, 413,
        `That screenshot is ${String(Math.ceil(shot.size / (1024 * 1024)))} MiB, over the ${String(FEEDBACK_MAX_SCREENSHOT_BYTES >> 20)} MiB limit. Send the note on its own, or capture a smaller area.`,
        'too_large', observed,
      );
    }
    if (deps.store === null) {
      return refuse(
        deps, 503,
        'Screenshots are unavailable on this deployment. Your note can still be sent on its own.',
        'storage_unavailable', observed,
      );
    }

    // The gate. Whatever the part was declared or named, these bytes have to be
    // a PNG — and the walk that proves it is the same pass that drops every
    // metadata chunk.
    const clean = sanitizePng(new Uint8Array(await shot.arrayBuffer()));
    if ('fault' in clean) {
      const { status, reason } = pngRefusalFor(clean.fault);
      return refuse(deps, status, `That screenshot could not be read: ${clean.error}`, reason, observed);
    }
    observed.screenshotBytes = clean.bytes.length;
    screenshot = { key: `feedback/${identity.userId}/${id}.png`, bytes: clean.bytes };
    // A REJECTED PUT IS A LOST REPORT, and `storage_unavailable` is the arm that
    // says so — the same arm an unbound bucket answers with. Uncaught, this was
    // a platform 500 with no marker and no row: the one outcome the rejection
    // rate exists to catch, invisible to it.
    try {
      await deps.store.put(screenshot.key, screenshot.bytes);
    } catch (cause) {
      diagnostics.failure('feedback.screenshot_store_failed', toKinuError({
        doing: 'writing a feedback screenshot to the object store',
        cause,
        otherwise: 'unavailable',
      }), { objectKey: screenshot.key, feedbackId: id });
      return refuse(
        deps, 503,
        'The screenshot could not be stored. Try again, or send the note on its own.',
        'storage_unavailable', observed,
      );
    }
  }

  const row: FeedbackRecord = {
    id,
    createdAt: deps.now(),
    userId: identity.userId,
    email: identity.email,
    note,
    route,
    // The authority's answer, never the submitted string: the two refusal arms
    // above are the only other ways past this line.
    workspace: attribution?.workspace ?? null,
    objectKey: screenshot?.key ?? null,
    contentType: screenshot === null ? null : FEEDBACK_SCREENSHOT_TYPE,
    bytes: screenshot?.bytes.length ?? null,
    userAgent: (request.headers.get('user-agent') ?? '').slice(0, FEEDBACK_MAX_USER_AGENT_CHARS) || null,
  };

  const written = await deps.record(row);
  if ('error' in written) {
    // The object is now referenced by nothing, so it is deleted before the
    // request is answered. A failing delete is not a tolerable class — there is
    // no named failure for "R2 would not take a delete" — so it is caught and
    // RECORDED with the key, which is the only thing that makes the leftover
    // object findable. It must not mask the row failure that caused it, so the
    // answer below is the same either way.
    const store = deps.store;
    if (screenshot !== null && store !== null) {
      try {
        await store.delete(screenshot.key);
      } catch (cause) {
        diagnostics.failure('feedback.orphan_retained', toKinuError({
          doing: 'deleting the screenshot of a feedback row that failed to write',
          cause,
          otherwise: 'unavailable',
        }), { objectKey: screenshot.key, feedbackId: id });
      }
    }
    return refuse(deps, 500, 'Feedback could not be saved. Try sending it again.', 'row_write_failed', observed);
  }

  deps.mark({
    feedbackId: written.id,
    outcome: 'accepted',
    rejectReason: '',
    routeFamily: feedbackRouteFamily(route),
    hasScreenshot: screenshot !== null,
    screenshotBytes: observed.screenshotBytes,
    noteLength: note.length,
    annotated,
  });
  // `satisfies` rather than an annotation: the success shape is DECLARED beside
  // the wire limits both halves read, and checking the literal against it here
  // is what makes that declaration load-bearing instead of documentation.
  return json({ id: written.id } satisfies FeedbackAccepted, { status: 201 });
}

/** Path and method routing only; the policy is `handleFeedbackSubmission`. */
export async function routeFeedback(
  request: Request,
  identity: AuthIdentity | null,
  deps: FeedbackDeps,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== FEEDBACK_ENDPOINT) return null;
  if (request.method !== 'POST') return err(405, 'use POST');
  return handleFeedbackSubmission(request, identity, deps);
}
