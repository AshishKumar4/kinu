/**
 * The feedback wire contract, shared by the browser client and the Worker
 * handler. It imports nothing: the client bundle must not pull the handler's
 * dependency graph in to learn a byte limit, and the handler must not learn one
 * from the client, so both read the same module and neither owns it.
 *
 * Keeping the limits here is what makes the client's refusal and the server's
 * refusal the same number. A client that guessed a smaller cap would refuse
 * reports the server would have taken; a client that guessed a larger one would
 * upload 8 MiB to be told no.
 */

export const FEEDBACK_ENDPOINT = '/api/feedback';

/**
 * Screenshot ceiling. A full-page PNG of this app at device-pixel-ratio 2 runs
 * a few hundred kilobytes to low single-digit megabytes; 8 MiB leaves room for
 * a long transcript on a high-DPI display and still bounds one request.
 */
export const FEEDBACK_MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

/**
 * Slack above the screenshot for the note, the route, and multipart framing.
 * A 4,000-character note is at most 16 KB of UTF-8; the rest is boundaries and
 * part headers. Checked against `content-length` before the body is read, so an
 * oversized request is refused without being buffered.
 */
export const FEEDBACK_MAX_REQUEST_BYTES = FEEDBACK_MAX_SCREENSHOT_BYTES + 64 * 1024;

export const FEEDBACK_MAX_NOTE_CHARS = 4000;
export const FEEDBACK_MAX_ROUTE_CHARS = 512;
export const FEEDBACK_MAX_USER_AGENT_CHARS = 512;

/** The only content type the screenshot part may declare, and the only one the
 *  bytes are then checked against. */
export const FEEDBACK_SCREENSHOT_TYPE = 'image/png';

/**
 * Opt-in redaction marker. Any element carrying this attribute is blocked out
 * in the CLONE the screenshot is rasterised from, so its content never reaches
 * an image. Password inputs are redacted without it — see `redactClone` —
 * because a secret must not depend on someone remembering to annotate it.
 */
export const FEEDBACK_REDACT_ATTR = 'data-feedback-redact';

/**
 * The feedback UI's own marker. A node carrying it is REMOVED from the clone
 * rather than blocked out, so retaking a shot with the dialog open photographs
 * the page underneath instead of the dialog covering it.
 */
export const FEEDBACK_OMIT_ATTR = 'data-feedback-omit';

/** Multipart field names. One spelling, read by both halves. */
export const FEEDBACK_FIELDS = Object.freeze({
  screenshot: 'screenshot',
  note: 'note',
  route: 'route',
  workspace: 'workspace',
  annotated: 'annotated',
});

/** What the endpoint answers with on success. Failures use the app-wide
 *  `{ error }` shape every other route returns. */
export interface FeedbackAccepted {
  id: string;
}

/**
 * The metadata row a submission becomes. This is the authoritative column list
 * for the control-plane table — the producer owns the shape so there is exactly
 * one declaration of it, and the store imports this type rather than restating
 * the columns beside its DDL.
 *
 * The three screenshot columns are nullable together: a note-only report is a
 * first-class row, not a degraded one. Screenshot BYTES live in R2 and never
 * here; `objectKey` is the pointer.
 */
export interface FeedbackRecord {
  id: string;
  createdAt: number;
  userId: string;
  email: string;
  /** Trimmed, at most FEEDBACK_MAX_NOTE_CHARS. May be empty when a screenshot
   *  carries the whole report. */
  note: string;
  /** The app route the reporter was on, at most FEEDBACK_MAX_ROUTE_CHARS. */
  route: string;
  workspace: string | null;
  objectKey: string | null;
  contentType: string | null;
  bytes: number | null;
  /** From the request header, not from the body. */
  userAgent: string | null;
}

// The analytics marker's own types — `FeedbackMarker`, `FeedbackRouteFamily`,
// `FeedbackRejectReason` — are NOT declared here. They are the parameter type of
// `writeFeedbackMarker`, and a callee owning its own parameter type is the
// direction that cannot drift: were they declared here, the analytics module
// would have to import the feedback route to type its own signature. Import them
// from `../analytics/feedback-marker`.
