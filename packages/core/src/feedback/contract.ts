// Imports only valibot, so the browser client and the Worker handler enforce the same limits without sharing a graph.
import * as v from 'valibot';

export const FEEDBACK_ENDPOINT = '/api/feedback';

/** Leaves room for a long transcript at high DPI while still bounding one request. */
export const FEEDBACK_MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

/** Slack for note, route, and multipart framing; checked against `content-length` before buffering. */
export const FEEDBACK_MAX_REQUEST_BYTES = FEEDBACK_MAX_SCREENSHOT_BYTES + 64 * 1024;

export const FEEDBACK_MAX_NOTE_CHARS = 4000;

export const FEEDBACK_MAX_ROUTE_CHARS = 512;

/** The screenshot bytes are also checked against this type. */
export const FEEDBACK_SCREENSHOT_TYPE = 'image/png';

/** Opt-in: blocked out in the rasterised clone. Password inputs are redacted without it (`redactClone`). */
export const FEEDBACK_REDACT_ATTR = 'data-feedback-redact';

/** Removed from the clone, so a retake photographs the page under the open dialog. */
export const FEEDBACK_OMIT_ATTR = 'data-feedback-omit';

export const FEEDBACK_FIELDS = Object.freeze({
  screenshot: 'screenshot',
  note: 'note',
  route: 'route',
  workspace: 'workspace',
  annotated: 'annotated',
});

/** Failures use the app-wide `{ error }` shape. */
export interface FeedbackAccepted {
  id: string;
}

/** Authoritative column list for the control-plane table. `bytes` is null for a note-only report; a screenshot's PNG
 *  lives in R2 under its reporter and report (`feedback/<userId>/<id>.png`), where only its submission reaches it. */
export const FeedbackRecordSchema = v.object({
  id: v.string(),
  createdAt: v.number(),
  userId: v.string(),
  email: v.string(),
  /** Trimmed; may be empty when a screenshot carries the report. */
  note: v.string(),
  route: v.string(),
  workspace: v.nullable(v.string()),
  bytes: v.nullable(v.number()),
});

export type FeedbackRecord = v.InferOutput<typeof FeedbackRecordSchema>;
