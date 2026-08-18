/**
 * One cursored-page contract for every read that used to answer with a bare
 * array under a `LIMIT`.
 *
 * ── What this generalises ────────────────────────────────────────────────────
 * `readWorkspaceArchivePage` (identity/archive.ts) already got this right and
 * is the precedent. Kept from it, unchanged in spirit:
 *
 *   - Keyset, not offset. The archive's `ArchiveSqlCursor.after` is a rowid,
 *     with the reason spelled out in its own doc comment: an offset costs a
 *     full scan per page. It is also the only thing that survives concurrent
 *     writes — an offset shifts under an insert and the reader sees a row twice
 *     or never.
 *   - A cursor is a resume ANCHOR, and a stale anchor is an error, not an empty
 *     page. The archive throws `Cannot resume this export: table "x" no longer
 *     exists`. Answering "no rows" to an unresolvable anchor is the same lie as
 *     a bare `LIMIT`: it reports completeness it never established.
 *   - The caller drives the walk. Ask with no cursor, then with the page's own
 *     `next`, until the read says it is done.
 *
 * ── What this changes ────────────────────────────────────────────────────────
 * `ArchivePage` says `next: ArchiveCursor | null`, and a caller can destructure
 * `lines` and never look at `next`. Exhaustion is therefore ignorable, and the
 * one thing a capped read must not do is let a caller assume completeness by
 * omission. `Page` is a variant on `status` instead: `next` is unreachable
 * without narrowing, so "that was everything" is a fact the caller had to
 * observe. The third state — the read failed — is the rejection, and it is
 * distinct from `end` precisely because `end` cannot be produced by accident.
 *
 * `ArchiveCursor` stays a valibot VARIANT because the archive genuinely
 * resumes in two different modes (rows, then files). A keyset seek has one
 * mode, so `SeekCursor` is not a variant; making it one "in case" would be the
 * speculative half of the pattern rather than the load-bearing half.
 */

import * as v from 'valibot';

/**
 * Where a page resumes: the identity of the last row the previous page already
 * delivered, in that read's own traversal order.
 *
 * A row IDENTITY rather than a raw rowid or an offset. The rowid is what the
 * SQL then seeks on, but it is not what crosses the wire, for two reasons that
 * both showed up in the chat:
 *
 *   1. A client does not always get its first anchor from us. The chat pane is
 *      seeded by the agents SDK's `get-messages` route, which hands it UI
 *      messages with ids and no cursor; the pane has to be able to say "older
 *      than this one" about a row it never received a cursor for.
 *   2. An id is checkable. A rowid that no longer exists still compares fine
 *      and silently yields nothing; an id that no longer exists is a resolvable
 *      question with a `no` answer, which is what makes a stale cursor
 *      raisable instead of indistinguishable from exhaustion.
 */
export interface SeekCursor {
  readonly after: string;
}

/**
 * What every cursored read is asked: a position and a size.
 *
 * A read needing more than those two EXTENDS this rather than respelling them,
 * so the pair never drifts across the reads that share the contract.
 */
export interface PageRequest {
  /** Omitted asks for the first page; otherwise the previous page's `next`. */
  cursor?: SeekCursor | undefined;
  limit?: number | undefined;
}

/**
 * A page of a cursored read.
 *
 * `items` is in the read's own presentation order, which is not necessarily its
 * traversal order — the chat traverses newest-first and presents each page
 * oldest-first, because that is the block the UI prepends.
 */
export type Page<Item, Cursor = SeekCursor> =
  | { readonly status: 'more'; readonly items: readonly Item[]; readonly next: Cursor }
  | { readonly status: 'end'; readonly items: readonly Item[] };

export const SeekCursorSchema: v.GenericSchema<SeekCursor> = v.object({
  after: v.pipe(v.string(), v.nonEmpty()),
});

/** The wire schema for `Page<Item>`, for the client side of an RPC. */
export function pageSchema<Item>(
  item: v.GenericSchema<Item>,
): v.GenericSchema<Page<Item>> {
  return v.variant('status', [
    v.object({ status: v.literal('more'), items: v.array(item), next: SeekCursorSchema }),
    v.object({ status: v.literal('end'), items: v.array(item) }),
  ]);
}

/**
 * Turn an over-fetched batch into a page.
 *
 * `fetched` MUST be the result of asking storage for `limit + 1` rows in
 * traversal order. The extra row is the whole mechanism: its presence is direct
 * evidence that a further row exists, so `end` is only ever reported about a
 * query that actually ran off the end of the data. No `COUNT(*)`, and — unlike
 * comparing `rows.length` to `limit` — no way to mistake "the page happened to
 * be exactly full" for "there is more".
 */
export function seekPage<Item>(
  fetched: readonly Item[],
  limit: number,
  anchorOf: (item: Item) => string,
): Page<Item> {
  if (fetched.length <= limit) return { status: 'end', items: fetched };
  const items = fetched.slice(0, limit);
  return { status: 'more', items, next: { after: anchorOf(items[items.length - 1]!) } };
}

/**
 * Re-project a page's rows, keeping its `status` and cursor intact.
 *
 * Exists so no read model rebuilds the variant by hand. The failure mode of
 * doing that is dropping `next` on the `more` branch, which turns a truncated
 * read back into an exhausted one — the exact claim this whole contract is
 * here to stop a read from making by accident.
 *
 * `project` takes the whole array rather than one row, and both callers need
 * that. The chat transcript reverses, because its traversal order is not its
 * presentation order, and a filter that drops rows must run after `seekPage`
 * has already anchored the cursor on the raw ones. The exploration canvas is
 * the reason not to "simplify" this to an item-wise map: it resolves a page of
 * forks against their dispatch parameters with ONE `readForkRunParams` call
 * for the batch (exploration-canvas.ts:55-57), and mapping per item would turn
 * that into one read per fork.
 */
export function mapPage<In, Out>(
  page: Page<In>,
  project: (items: readonly In[]) => Out[],
): Page<Out> {
  const items = project(page.items);
  return page.status === 'more' ? { status: 'more', items, next: page.next } : { status: 'end', items };
}

/**
 * Raised when a cursor names a row the read can no longer see.
 *
 * Its own type because the client has to tell it apart from a transport
 * failure: a stale cursor is recovered by restarting the walk, and a transport
 * failure is recovered by retrying the same one.
 */
export class StaleCursorError extends Error {
  constructor(what: string, anchor: string) {
    super(`Cannot resume this ${what}: ${JSON.stringify(anchor)} is no longer in it.`);
    this.name = 'StaleCursorError';
  }
}
