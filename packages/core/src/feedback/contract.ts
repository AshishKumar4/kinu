// Imports nothing so the browser client and the Worker handler enforce the same limits without sharing a graph.

export const FEEDBACK_ENDPOINT = '/api/feedback';

/** Leaves room for a long transcript at high DPI while still bounding one request. */
export const FEEDBACK_MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

/** Slack for note, route, and multipart framing; checked against `content-length` before buffering. */
export const FEEDBACK_MAX_REQUEST_BYTES = FEEDBACK_MAX_SCREENSHOT_BYTES + 64 * 1024;

export const FEEDBACK_MAX_NOTE_CHARS = 4000;

export const FEEDBACK_MAX_ROUTE_CHARS = 512;

export const FEEDBACK_MAX_USER_AGENT_CHARS = 512;

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

/** Authoritative column list for the control-plane table. Screenshot columns are null together
 *  for note-only reports; bytes live in R2, `objectKey` points there. */
export interface FeedbackRecord {
  id: string;
  createdAt: number;
  userId: string;
  email: string;
  /** Trimmed; may be empty when a screenshot carries the report. */
  note: string;
  route: string;
  workspace: string | null;
  objectKey: string | null;
  contentType: string | null;
  bytes: number | null;
  /** From the request header, not the body. */
  userAgent: string | null;
}
