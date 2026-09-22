/**
 * `POST /api/feedback`: one authenticated multipart submission becomes one R2 object plus one
 * control-plane row. Auth and CSRF run upstream in server.ts; the 401 here is this module's own boundary.
 * Refusal order is the design: length, counted body, part type, bytes, then storage. The workspace is
 * proven against the reporter's registry before anything is stored. The row is the commit point: a
 * failed row write deletes the orphan object. Nothing is retried; the client offers an explicit retry.
 */

import type { AuthIdentity } from '../auth/session';
import { diagnostics, KinuError, toKinuError } from '@kinu.run/core/obs';
import { err, json, readBounded } from '@kinu.run/core';
import { sanitizePng, type PngFault } from '@kinu.run/core';
import {
  feedbackRouteFamily,
  type FeedbackMarker,
  type FeedbackRejectReason,
} from '@kinu.run/core/analytics';
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
} from '@kinu.run/core';

/** Narrower than `R2Bucket` so the policy can be driven without one. */
export interface FeedbackStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * "Not yours" and "could not ask" are different arms: one is the reporter's to fix, the other our outage.
 * `owned` carries the name back so the row is written from the authority's answer, never the submitted
 * string. Non-workspace names and others' workspaces share one arm so probing cannot test existence.
 */
export type WorkspaceAttribution =
  | { kind: 'owned'; workspace: string }
  | { kind: 'refused' }
  | { kind: 'unavailable'; error: string };

/** Injected so the policy is drivable without R2, a Durable Object or analytics. */
export interface FeedbackDeps {
  /** Absent when no feedback bucket is bound: note-only reports succeed; screenshots are refused. */
  store: FeedbackStore | null;
  record(row: FeedbackRecord): Promise<{ id: string } | { error: string }>;
  /** Asked before any byte is stored, row written or marker says `accepted`; never asked when a
   *  report names no workspace. */
  attributeWorkspace(userId: string, workspace: string): Promise<WorkspaceAttribution>;
  mark(marker: FeedbackMarker): void;
  newId(): string;
  now(): number;
}

/** `screenshotAttempted` is separate from `screenshotBytes` so every refusal arm reports that a
 *  screenshot was carried, even when its bytes were never counted. */
interface Observed {
  route: string;
  noteLength: number;
  screenshotAttempted: boolean;
  screenshotBytes: number;
  annotated: boolean;
}

interface FeedbackRefusal {
  deps: FeedbackDeps;
  status: number;
  message: string;
  reason: Exclude<FeedbackRejectReason, ''>;
  observed: Observed;
}

/** A rejection still emits its marker: the rejection rate shows the endpoint refusing real reports. */
function refuse({ deps, status, message, reason, observed }: FeedbackRefusal): Response {
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

interface PngRefusal {
  status: number;
  reason: Exclude<FeedbackRejectReason, ''>;
}

/** Only `dimensions` is a size refusal; every other fault says the bytes are not a PNG. */
function pngRefusalFor(fault: PngFault): PngRefusal {
  switch (fault) {
    case 'dimensions': return { status: 413, reason: 'too_large' };
    case 'not-png':
    case 'truncated':
    case 'bad-crc':
    case 'bad-structure': return { status: 400, reason: 'malformed' };
  }
}

/** A file under a text field's name reads as absent. */
function readField(form: FormData, name: string, max: number): string {
  const raw = form.get(name);

  return raw === null || raw instanceof Blob ? '' : raw.trim().slice(0, max);
}

const OVER_REQUEST_LIMIT = `Feedback is limited to ${String(FEEDBACK_MAX_SCREENSHOT_BYTES >> 20)} MiB. Send the note without the screenshot, or capture a smaller area.`;

const UNREADABLE_FORM = 'Could not read the feedback form.';

/**
 * A new request because the bounded read spent the original body. `formData()` throws `TypeError` on
 * a malformed body; that failure is returned classified (`bad_input` unless the platform names its own)
 * so the policy answers 400, distinct from an absent form.
 */
async function parseMultipart(
  url: string,
  contentType: string,
  bytes: Uint8Array,
): Promise<FormData | KinuError> {
  // `RequestInit.body` needs `Uint8Array<ArrayBuffer>`; `readBounded` promises `ArrayBufferLike`.
  const exact = new Uint8Array(bytes.byteLength);
  exact.set(bytes);

  const carrier = new Request(url, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: exact,
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

/** The whole submission policy over injected effects; `routeFeedback` is its one entry, tests included. */
async function handleFeedbackSubmission(
  request: Request,
  identity: AuthIdentity | null,
  deps: FeedbackDeps,
): Promise<Response> {
  const blank: Observed = {
    route: '', noteLength: 0, screenshotAttempted: false, screenshotBytes: 0, annotated: false,
  };

  if (identity === null) {
    return refuse({ deps, status: 401, message: 'Sign in to send feedback.', reason: 'unauthenticated', observed: blank });
  }

  const contentType = request.headers.get('content-type') ?? '';

  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return refuse({ deps, status: 415, message: 'Send feedback as multipart/form-data.', reason: 'bad_content_type', observed: blank });
  }

  // A declared length that cannot fit is refused before buffering; the counted read is the real bound.
  const declared = Number(request.headers.get('content-length') ?? '');

  if (Number.isFinite(declared) && declared > FEEDBACK_MAX_REQUEST_BYTES) {
    return refuse({ deps, status: 413, message: OVER_REQUEST_LIMIT, reason: 'too_large', observed: blank });
  }

  const bounded = await readBounded(request, FEEDBACK_MAX_REQUEST_BYTES);

  if (bounded === 'too_large') {
    return refuse({ deps, status: 413, message: OVER_REQUEST_LIMIT, reason: 'too_large', observed: blank });
  }

  if (bounded instanceof KinuError) {
    diagnostics.failure('feedback.body_unreadable', bounded);

    return refuse({ deps, status: 400, message: UNREADABLE_FORM, reason: 'malformed', observed: blank });
  }

  const form = await parseMultipart(request.url, contentType, bounded);

  if (form instanceof KinuError) {
    // Recorded here: the byte count belongs to this frame, not the decoder.
    diagnostics.failure('feedback.body_unparseable', form, { bytes: bounded.byteLength });

    return refuse({ deps, status: 400, message: UNREADABLE_FORM, reason: 'malformed', observed: blank });
  }

  const note = readField(form, FEEDBACK_FIELDS.note, FEEDBACK_MAX_NOTE_CHARS);
  const route = readField(form, FEEDBACK_FIELDS.route, FEEDBACK_MAX_ROUTE_CHARS);
  const workspaceField = readField(form, FEEDBACK_FIELDS.workspace, FEEDBACK_MAX_ROUTE_CHARS);
  const annotated = form.get(FEEDBACK_FIELDS.annotated) === '1';

  const observed: Observed = {
    route, noteLength: note.length, screenshotAttempted: false, screenshotBytes: 0, annotated,
  };

  const part = form.get(FEEDBACK_FIELDS.screenshot);
  const shot = part instanceof Blob ? part : null;

  if (part !== null && shot === null) {
    return refuse({ deps, status: 415, message: 'The screenshot must be a PNG file.', reason: 'bad_content_type', observed });
  }

  if (shot !== null) {
    // Before any refusal, so every rejection marker states a screenshot was carried.
    observed.screenshotAttempted = true;
    observed.screenshotBytes = shot.size;
  }

  if (shot === null && note.length === 0) {
    return refuse({ deps, status: 400, message: 'Add a note or a screenshot before sending.', reason: 'no_content', observed });
  }

  // The workspace field is browser-supplied, so ownership is proven before storage, row or `accepted`
  // marker. A report naming no workspace is not a claim and is not checked.
  const attribution = workspaceField.length === 0
    ? null
    : await deps.attributeWorkspace(identity.userId, workspaceField);

  if (attribution?.kind === 'refused') {
    return refuse({
      deps, status: 403,
      message: 'That workspace is not one of yours. Send the report without a workspace, or file it from the workspace it is about.',
      reason: 'unowned_workspace', observed,
    });
  }

  if (attribution?.kind === 'unavailable') {
    // Our outage: refused rather than filed silently unattributed, so the reporter can resend.
    diagnostics.failure('feedback.workspace_unverified', toKinuError({
      doing: 'confirming the reporter owns the workspace their report names',
      cause: attribution.error,
      otherwise: 'unavailable',
    }), { feedbackRoute: feedbackRouteFamily(route) });

    return refuse({
      deps, status: 503,
      message: 'That workspace could not be confirmed right now. Try again in a moment.',
      reason: 'workspace_unverified', observed,
    });
  }

  let screenshot: { key: string; bytes: Uint8Array } | null = null;
  const id = deps.newId();

  if (shot !== null) {
    // Courtesy only: measured 2026-08-24, the runtime derives `File.type` from the filename, so the
    // declared type proves nothing. `sanitizePng` below is the gate.
    if (shot.type.toLowerCase() !== FEEDBACK_SCREENSHOT_TYPE) {
      return refuse({ deps, status: 415, message: 'The screenshot must be a PNG.', reason: 'bad_content_type', observed });
    }

    if (shot.size > FEEDBACK_MAX_SCREENSHOT_BYTES) {
      return refuse({
        deps, status: 413,
        message: `That screenshot is ${String(Math.ceil(shot.size / (1024 * 1024)))} MiB, over the ${String(FEEDBACK_MAX_SCREENSHOT_BYTES >> 20)} MiB limit. Send the note on its own, or capture a smaller area.`,
        reason: 'too_large', observed,
      });
    }

    if (deps.store === null) {
      return refuse({
        deps, status: 503,
        message: 'Screenshots are unavailable on this deployment. Your note can still be sent on its own.',
        reason: 'storage_unavailable', observed,
      });
    }

    // The gate: the bytes must be a PNG, and the same pass drops every metadata chunk.
    const clean = sanitizePng(new Uint8Array(await shot.arrayBuffer()));

    if ('fault' in clean) {
      const { status, reason } = pngRefusalFor(clean.fault);

      return refuse({ deps, status, message: `That screenshot could not be read: ${clean.error}`, reason, observed });
    }

    observed.screenshotBytes = clean.bytes.length;
    screenshot = { key: `feedback/${identity.userId}/${id}.png`, bytes: clean.bytes };

    // A rejected put is a lost report: answer `storage_unavailable`, never an unmarked 500.
    try {
      await deps.store.put(screenshot.key, screenshot.bytes);
    } catch (cause) {
      diagnostics.failure('feedback.screenshot_store_failed', toKinuError({
        doing: 'writing a feedback screenshot to the object store',
        cause,
        otherwise: 'unavailable',
      }), { objectKey: screenshot.key, feedbackId: id });

      return refuse({
        deps, status: 503,
        message: 'The screenshot could not be stored. Try again, or send the note on its own.',
        reason: 'storage_unavailable', observed,
      });
    }
  }

  const row: FeedbackRecord = {
    id,
    createdAt: deps.now(),
    userId: identity.userId,
    email: identity.email,
    note,
    route,
    // The authority's answer, never the submitted string.
    workspace: attribution?.workspace ?? null,
    objectKey: screenshot?.key ?? null,
    contentType: screenshot === null ? null : FEEDBACK_SCREENSHOT_TYPE,
    bytes: screenshot?.bytes.length ?? null,
    userAgent: (request.headers.get('user-agent') ?? '').slice(0, FEEDBACK_MAX_USER_AGENT_CHARS) || null,
  };

  const written = await deps.record(row);

  if ('error' in written) {
    // Delete the now-unreferenced object; a failed delete is recorded with its key so it stays
    // findable, and must not change the answer.
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

    return refuse({ deps, status: 500, message: 'Feedback could not be saved. Try sending it again.', reason: 'row_write_failed', observed });
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

  // `satisfies` checks the literal against the declared wire shape.
  return json({ body: { id: written.id } satisfies FeedbackAccepted }, { status: 201 });
}

export async function routeFeedback(
  request: Request,
  identity: AuthIdentity | null,
  deps: FeedbackDeps,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== FEEDBACK_ENDPOINT) return null;

  if (request.method !== 'POST') return err(405, 'use POST');

  return handleFeedbackSubmission(request, identity, deps);
}
