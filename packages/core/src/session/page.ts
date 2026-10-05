/**
 * Cursored-page contract (precedent: `readWorkspaceArchivePage`). Keyset, not offset; a stale anchor is an
 * error, not an empty page. `Page` is a variant on `status` so a caller must narrow to observe `end`.
 */

import { Data } from 'effect';
import * as v from 'valibot';

/**
 * A row identity, not a rowid: the chat pane anchors on SDK-seeded messages it got no cursor for, and a
 * missing id is detectable where a missing rowid silently yields nothing.
 */
export interface SeekCursor {
  readonly after: string;
}

/** A cursor into an ordered list: the page ends just before this position, so any stretch is one indexed read. */
export interface PositionCursor {
  readonly before: number;
}

export const PositionCursorSchema: v.GenericSchema<PositionCursor> = v.object({
  before: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

/** Strict, so a caller still sending an id cursor is refused rather than re-read the newest page forever. */
export const PositionPageRequestSchema = v.strictObject({
  cursor: v.optional(PositionCursorSchema),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200))),
});

export type PositionPageRequest = v.InferOutput<typeof PositionPageRequestSchema>;

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

function pageVariant<Input, Item, Cursor>(
  item: v.GenericSchema<Input, Item>,
  cursor: v.GenericSchema<Cursor>,
): v.GenericSchema<Page<Input, Cursor>, Page<Item, Cursor>> {
  return v.variant('status', [
    v.object({ status: v.literal('more'), items: v.array(item), next: cursor }),
    v.object({ status: v.literal('end'), items: v.array(item) }),
  ]);
}

export function pageSchema<Input, Item = Input>(item: v.GenericSchema<Input, Item>): v.GenericSchema<Page<Input>, Page<Item>> {
  return pageVariant(item, SeekCursorSchema);
}

export function positionPageSchema<Input, Item = Input>(
  item: v.GenericSchema<Input, Item>,
): v.GenericSchema<Page<Input, PositionCursor>, Page<Item, PositionCursor>> {
  return pageVariant(item, PositionCursorSchema);
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
export function mapPage<In, Out, Cursor = SeekCursor>(
  page: Page<In, Cursor>,
  project: (items: readonly In[]) => Out[],
): Page<Out, Cursor> {
  const items = project(page.items);

  return page.status === 'more' ? { status: 'more', items, next: page.next } : { status: 'end', items };
}

/** Distinct from transport failure: a stale cursor restarts the walk; a transport failure retries. */
export class StaleCursorError extends Data.TaggedError('StaleCursorError')<{ readonly message: string }> {
  /** `options.cause` carries the parse failure of a malformed cursor; recovery is the same restart. */
  constructor(what: string, anchor: string, options?: ErrorOptions) {
    super({ message: `Cannot resume this ${what}: ${JSON.stringify(anchor)} is no longer in it.` });
    this.name = 'StaleCursorError';

    if (options !== undefined && 'cause' in options) Object.defineProperty(this, 'cause', { value: options.cause, writable: true, configurable: true });
  }
}
