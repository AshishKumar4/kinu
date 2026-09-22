/**
 * Failure modes a caller may tolerate, with signatures pinned once. The suite re-provokes each
 * error against its engine (`bun:sqlite`, Node `code`) rather than asserting hardcoded strings.
 */

import * as v from 'valibot';

/** A failure a caller may declare as expected. Closed: an unnamed failure is not tolerable. */
export type ExpectedFailure =
  | 'sqlite-missing-table'
  | 'sqlite-duplicate-column'
  | 'sqlite-table-exists'
  | 'enoent'
  | 'eexist'
  | 'esrch'
  | 'malformed-input';

/** `no such table: X`, raised for reads and `ALTER TABLE`; usually create the table, not tolerate. */
const SQLITE_MISSING_TABLE = /\bno such table\b/u;

const SQLITE_DUPLICATE_COLUMN = /\bduplicate column name\b/u;

/** Raised by `RENAME TO`. */
const SQLITE_TABLE_EXISTS = /\bthere is already another table or index with this name\b/u;

/** WHATWG URL's TypeError carries no `code` in browsers. */
const UNPARSEABLE_URL = /cannot be parsed as a URL/u;

/** Only a scalar has words: `String()` on an object yields `[object Object]`. */
const ScalarSchema = v.union([v.string(), v.number(), v.boolean()]);

/** What a caught value says for itself, or null. Scalar, not string: a DOMException `code` is a number. */
export function scalarText(input: { value: unknown }): string | null {
  const scalar = v.safeParse(ScalarSchema, input.value);

  return scalar.success ? String(scalar.output) : null;
}

/** The one reader of a caught error's `code` property, shared with `error.ts`. */
export function errnoCode(error: Error): string | null {
  if (!('code' in error)) return null;

  return scalarText({ value: error.code });
}

/** Names the failure a caught value represents, or null when unrecognised. */
export function classify(options: { cause: unknown }): ExpectedFailure | null {
  const caught = options.cause;

  if (caught instanceof SyntaxError) return 'malformed-input';

  if (!(caught instanceof Error)) return null;
  const code = errnoCode(caught);

  if (code === 'ENOENT') return 'enoent';

  // Raised by both node fs and the workspace VfsError.
  if (code === 'EEXIST') return 'eexist';

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
 * Runs `operation`, returning `undefined` only for the named failure; anything else is rethrown
 * as-is, unwrapped, to keep the failing frame on top.
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
