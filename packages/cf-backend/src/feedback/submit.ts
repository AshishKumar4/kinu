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
 * read, the declared part type before its bytes, and the bytes before storage,
 * so an oversized or forged report costs a header parse rather than 8 MiB of
 * buffering and an R2 write.
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
import { diagnostics, toKinuError, tolerateAsync } from '@kinu.run/core/obs';
import { err, json } from '../lib/http';
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
  mark(marker: FeedbackMarker): void;
  newId(): string;
  now(): number;
}

/** A rejected submission still produces its marker, because a rejection rate is
 *  the number that says the endpoint is refusing real reports. */
function refuse(
  deps: FeedbackDeps,
  status: number,
  message: string,
  reason: Exclude<FeedbackRejectReason, ''>,
  observed: { route: string; noteLength: number; screenshotBytes: number; annotated: boolean },
): Response {
  deps.mark({
    feedbackId: deps.newId(),
    outcome: 'rejected',
    rejectReason: reason,
    routeFamily: feedbackRouteFamily(observed.route),
    hasScreenshot: observed.screenshotBytes > 0,
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

/**
 * The whole submission policy, over injected effects. Answers every request it
 * is handed; the caller has already decided this is a POST to the endpoint.
 */
export async function handleFeedbackSubmission(
  request: Request,
  identity: AuthIdentity | null,
  deps: FeedbackDeps,
): Promise<Response> {
  const blank = { route: '', noteLength: 0, screenshotBytes: 0, annotated: false };
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
    return refuse(
      deps, 413,
      `Feedback is limited to ${String(FEEDBACK_MAX_SCREENSHOT_BYTES >> 20)} MiB. Send the note without the screenshot, or capture a smaller area.`,
      'too_large', blank,
    );
  }

  const form = await tolerateAsync(() => request.formData(), 'malformed-input');
  if (form === undefined) {
    return refuse(deps, 400, 'Could not read the feedback form.', 'malformed', blank);
  }

  const note = readField(form, FEEDBACK_FIELDS.note, FEEDBACK_MAX_NOTE_CHARS);
  const route = readField(form, FEEDBACK_FIELDS.route, FEEDBACK_MAX_ROUTE_CHARS);
  const workspaceField = readField(form, FEEDBACK_FIELDS.workspace, FEEDBACK_MAX_ROUTE_CHARS);
  const annotated = form.get(FEEDBACK_FIELDS.annotated) === '1';
  const observed = { route, noteLength: note.length, screenshotBytes: 0, annotated };

  const part = form.get(FEEDBACK_FIELDS.screenshot);
  // A string in the screenshot field is not a degenerate file, it is a caller
  // sending something else under that name.
  const shot = part instanceof Blob ? part : null;
  if (part !== null && shot === null) {
    return refuse(deps, 415, 'The screenshot must be a PNG file.', 'bad_content_type', observed);
  }

  if (shot === null && note.length === 0) {
    return refuse(deps, 400, 'Add a note or a screenshot before sending.', 'no_content', observed);
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
      observed.screenshotBytes = shot.size;
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
    await deps.store.put(screenshot.key, screenshot.bytes);
  }

  const row: FeedbackRecord = {
    id,
    createdAt: deps.now(),
    userId: identity.userId,
    email: identity.email,
    note,
    route,
    workspace: workspaceField.length > 0 ? workspaceField : null,
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
  return json({ id: written.id }, { status: 201 });
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
