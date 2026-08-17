/**
 * Failure modes a caller may legitimately tolerate, and the one place their signatures are pinned.
 *
 * The pattern is ~/Nimbus's `oom-classify.ts`: without a classifier, every site stringify-matches
 * its own error text, and the match drifts per site. Here the signature is pinned once, named, and
 * reused — so `tolerate(() => read(), 'enoent')` says in code which failure is a domain value, and
 * every other failure propagates instead of becoming an empty result nobody can tell from success.
 *
 * Every pattern below was measured against the engines that raise it, not copied from memory:
 * SQLite via `bun:sqlite` (the same SQLite that backs Durable Object storage) and Node's `code`
 * property. The transcript is in the suite beside this file, which re-provokes each error rather
 * than asserting against a hardcoded string.
 */

/** A failure a caller may declare as expected. Closed: an unnamed failure is not tolerable. */
export type ExpectedFailure =
  | 'sqlite-missing-table'
  | 'sqlite-duplicate-column'
  | 'sqlite-table-exists'
  | 'enoent'
  | 'esrch'
  | 'malformed-input';

/**
 * `no such table: X`. SQLite raises this for a read *and* for `ALTER TABLE` against an absent
 * table, so it cannot distinguish "not created yet" from "the wrong database" — which is why
 * tolerating it is almost always the wrong answer and creating the table is the right one.
 */
const SQLITE_MISSING_TABLE = /\bno such table\b/u;
/** `duplicate column name: X` — the one genuinely idempotent-by-exception schema case. */
const SQLITE_DUPLICATE_COLUMN = /\bduplicate column name\b/u;
/** `there is already another table or index with this name: X`, raised by `RENAME TO`. */
const SQLITE_TABLE_EXISTS = /\bthere is already another table or index with this name\b/u;
/** `"x" cannot be parsed as a URL.` — WHATWG URL's TypeError, which carries no `code` in browsers. */
const UNPARSEABLE_URL = /cannot be parsed as a URL/u;

function errnoCode(error: Error): string | null {
  if (!('code' in error)) return null;
  const code = error.code;
  return code === undefined || code === null ? null : String(code);
}

/**
 * Names the failure a caught value represents, or null when it is not one this module recognises.
 *
 * Public because classification is not only for tolerating: a retry policy or an OOM detector needs
 * the same pinned signatures, and a second copy of them would drift from this one.
 */
export function classify(options: { cause: unknown }): ExpectedFailure | null {
  const caught = options.cause;
  if (caught instanceof SyntaxError) return 'malformed-input';
  if (!(caught instanceof Error)) return null;

  const code = errnoCode(caught);
  if (code === 'ENOENT') return 'enoent';
  if (code === 'ESRCH') return 'esrch';
  if (code === 'ERR_INVALID_URL') return 'malformed-input';

  const message = caught.message;
  if (SQLITE_MISSING_TABLE.test(message)) return 'sqlite-missing-table';
  if (SQLITE_DUPLICATE_COLUMN.test(message)) return 'sqlite-duplicate-column';
  if (SQLITE_TABLE_EXISTS.test(message)) return 'sqlite-table-exists';
  if (UNPARSEABLE_URL.test(message)) return 'malformed-input';
  return null;
}

/**
 * Runs `operation`, returning `undefined` only for the failure the caller named. Anything else
 * propagates unchanged.
 *
 * This is the whole difference from `try { … } catch { return undefined }`: the tolerance is
 * declared, narrow, and enforced at runtime, so a genuine failure on the same line still reaches
 * the caller. Note the caught value is rethrown as-is rather than wrapped — wrapping here would
 * insert this helper into every stack trace and hide the frame that actually failed.
 */
export function tolerate<T>(operation: () => T, expected: ExpectedFailure): T | undefined {
  try {
    return operation();
  } catch (caught) {
    if (classify({ cause: caught }) !== expected) throw caught;
    return undefined;
  }
}

/** `tolerate` for an operation that rejects rather than throws. */
export async function tolerateAsync<T>(
  operation: () => Promise<T>,
  expected: ExpectedFailure,
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (caught) {
    if (classify({ cause: caught }) !== expected) throw caught;
    return undefined;
  }
}
