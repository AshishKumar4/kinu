/**
 * Cursored-page contract (precedent: `readWorkspaceArchivePage`). Keyset, not offset; a stale anchor is an
 * error, not an empty page. `Page` is a variant on `status` so a caller must narrow to observe `end`.
 */

import * as v from 'valibot';

/**
 * A row identity, not a rowid: the chat pane anchors on SDK-seeded messages it got no cursor for, and a
 * missing id is detectable where a missing rowid silently yields nothing.
 */
export interface SeekCursor {
  readonly after: string;
}

/** Reads needing more extend this rather than respelling the pair. */
export interface PageRequest {
  /** Omitted asks for the first page; otherwise the previous page's `next`. */
  cursor?: SeekCursor | undefined;
  limit?: number | undefined;
}

/** `items` is in presentation order, which may differ from traversal order (the chat presents oldest-first). */
export type Page<Item, Cursor = SeekCursor> =
  | { readonly status: 'more'; readonly items: readonly Item[]; readonly next: Cursor }
  | { readonly status: 'end'; readonly items: readonly Item[] };

export const SeekCursorSchema: v.GenericSchema<SeekCursor> = v.object({
  after: v.pipe(v.string(), v.nonEmpty()),
});

export function pageSchema<Input, Item = Input>(
  item: v.GenericSchema<Input, Item>,
): v.GenericSchema<Page<Input>, Page<Item>> {
  return v.variant('status', [
    v.object({ status: v.literal('more'), items: v.array(item), next: SeekCursorSchema }),
    v.object({ status: v.literal('end'), items: v.array(item) }),
  ]);
}

/** `fetched` MUST be `limit + 1` rows in traversal order: the extra row is the evidence that more exist. */
export function seekPage<Item>(
  fetched: readonly Item[],
  limit: number,
  anchorOf: (item: Item) => string,
): Page<Item> {
  if (fetched.length <= limit) return { status: 'end', items: fetched };
  const items = fetched.slice(0, limit);

  return { status: 'more', items, next: { after: anchorOf(items[items.length - 1]) } };
}

/** `project` maps the whole array: the chat reverses it, and the exploration canvas resolves a page in one batched read. */
export function mapPage<In, Out>(
  page: Page<In>,
  project: (items: readonly In[]) => Out[],
): Page<Out> {
  const items = project(page.items);

  return page.status === 'more' ? { status: 'more', items, next: page.next } : { status: 'end', items };
}

/** Distinct from transport failure: a stale cursor restarts the walk; a transport failure retries. */
export class StaleCursorError extends Error {
  /** `options.cause` carries the parse failure of a malformed cursor; recovery is the same restart. */
  constructor(what: string, anchor: string, options?: ErrorOptions) {
    super(`Cannot resume this ${what}: ${JSON.stringify(anchor)} is no longer in it.`, options);
    this.name = 'StaleCursorError';
  }
}
