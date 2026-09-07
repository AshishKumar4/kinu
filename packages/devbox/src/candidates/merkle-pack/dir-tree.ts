/**
 * Directory page trees: entries beyond one node's capacity live in pages,
 * and pages beyond one row live in pages of pages. Every node holds at most
 * `DIR_ENTRIES_PER_PAGE` items, so lookup and update touch one root-to-leaf
 * path whose height grows with the logarithm of the entry count.
 *
 * The tree shape is a function of the sorted entry list alone. Each level
 * packs full nodes left to right. A generation that keeps a page's entries
 * unchanged reuses the published page by reference instead of writing it.
 */

import { MerklePackError } from './errors';
import { encodeNodeV2, hashNodeV2Bytes, sortDirEntriesV2, DIR_ENTRIES_PER_PAGE } from './wire';
import type { DirEntriesV2, DirEntryV2, DirPageRefV2, RecordRefV2 } from './wire';
import type { PackWriter, ResolvePack, Slot } from './pack-layout';

/** A page already published: reused when its entries are unchanged. */
export interface KnownDirPage {
  readonly ref: DirPageRefV2;
  readonly entries: DirEntriesV2;
}

export interface DirTreeBuild {
  /** The root's own entries or child refs, resolved for the record naming them. */
  readonly entries: (resolve: ResolvePack) => DirEntriesV2;
  /** Pages this build wrote, from the leaves upward. */
  readonly pagesWritten: number;
  /** Pages reused by reference from the parent tree. */
  readonly pagesReused: number;
}

interface PlacedPage {
  readonly slot: Slot;
  readonly id: string;
  readonly firstName: string;
  readonly entries: number;
  readonly height: number;
}

type PageItem =
  | { readonly kind: 'placed'; readonly page: PlacedPage }
  | { readonly kind: 'known'; readonly ref: DirPageRefV2 };

function sameRef(a: RecordRefV2, b: RecordRefV2): boolean {
  return a.id === b.id && a.sha256 === b.sha256 && a.pack === b.pack && a.offset === b.offset && a.length === b.length;
}

function sameEntry(a: DirEntryV2, b: DirEntryV2): boolean {
  return a.name === b.name && a.kind === b.kind && sameRef(a.ref, b.ref);
}

function samePageRef(a: DirPageRefV2, b: DirPageRefV2): boolean {
  return sameRef(a, b) && a.firstName === b.firstName && a.entries === b.entries && a.height === b.height;
}

/**
 * Lay out one directory's entries as a page tree, writing each page into
 * `writer`. `known` are the parent generation's pages keyed by first name
 * and height. A page whose entries are all sealed parent references, equal
 * to the known page, is referenced rather than written; a page holding a
 * fresh same-generation reference is always written.
 */
export function buildDirTree(
  writer: PackWriter,
  sorted: readonly DirEntryV2[],
  known: readonly KnownDirPage[],
  resolveEntries: (entries: readonly DirEntryV2[], resolve: ResolvePack) => readonly DirEntryV2[],
  isSealed: (entry: DirEntryV2) => boolean,
): DirTreeBuild {
  const entries = sortDirEntriesV2(sorted);
  if (entries.length <= DIR_ENTRIES_PER_PAGE) {
    return {
      entries: (resolve) => ({ kind: 'inline', entries: resolveEntries(entries, resolve) }),
      pagesWritten: 0,
      pagesReused: 0,
    };
  }
  const knownByStart = new Map<string, KnownDirPage>();
  for (const page of known) knownByStart.set(`${page.ref.height}:${page.ref.firstName}`, page);
  let pagesWritten = 0;
  let pagesReused = 0;

  const place = (
    firstName: string,
    count: number,
    height: number,
    build: (resolve: ResolvePack) => DirEntriesV2,
  ): PageItem => {
    let id = '';
    const slot = writer.placeRecord((resolve) => {
      const bytes = encodeNodeV2({ kind: 'dirpage', entries: build(resolve) });
      id = hashNodeV2Bytes(bytes);
      return bytes;
    });
    pagesWritten += 1;
    return { kind: 'placed', page: { slot, id, firstName, entries: count, height } };
  };

  const refOf = (item: PageItem, resolve: ResolvePack): DirPageRefV2 =>
    item.kind === 'known'
      ? item.ref
      : {
          id: item.page.id,
          sha256: item.page.slot.sha256,
          pack: resolve(item.page.slot),
          offset: item.page.slot.offset,
          length: item.page.slot.length,
          firstName: item.page.firstName,
          entries: item.page.entries,
          height: item.page.height,
        };

  let row: PageItem[] = [];
  for (let at = 0; at < entries.length; at += DIR_ENTRIES_PER_PAGE) {
    const slice = entries.slice(at, at + DIR_ENTRIES_PER_PAGE);
    const first = slice[0];
    if (first === undefined) throw new MerklePackError('malformed-node', 'a directory page cannot be empty');
    const held = knownByStart.get(`0:${first.name}`);
    const reusable = held !== undefined && held.entries.kind === 'inline'
      && held.entries.entries.length === slice.length
      && slice.every((entry, index) => {
        const other = held.entries.kind === 'inline' ? held.entries.entries[index] : undefined;
        return other !== undefined && isSealed(entry) && sameEntry(entry, other);
      });
    if (reusable) {
      pagesReused += 1;
      row.push({ kind: 'known', ref: held.ref });
      continue;
    }
    row.push(place(first.name, slice.length, 0, (resolve) => ({ kind: 'inline', entries: resolveEntries(slice, resolve) })));
  }

  let height = 1;
  while (row.length > DIR_ENTRIES_PER_PAGE) {
    const next: PageItem[] = [];
    for (let at = 0; at < row.length; at += DIR_ENTRIES_PER_PAGE) {
      const group = row.slice(at, at + DIR_ENTRIES_PER_PAGE);
      const first = group[0];
      if (first === undefined) throw new MerklePackError('malformed-node', 'a directory page row cannot be empty');
      const firstName = first.kind === 'known' ? first.ref.firstName : first.page.firstName;
      const count = group.reduce((sum, item) => sum + (item.kind === 'known' ? item.ref.entries : item.page.entries), 0);
      const held = knownByStart.get(`${height}:${firstName}`);
      const reusable = held !== undefined && held.entries.kind === 'paged'
        && held.entries.pages.length === group.length
        && group.every((item, index) => {
          const other = held.entries.kind === 'paged' ? held.entries.pages[index] : undefined;
          return other !== undefined && item.kind === 'known' && samePageRef(item.ref, other);
        });
      if (reusable) {
        pagesReused += 1;
        next.push({ kind: 'known', ref: held.ref });
        continue;
      }
      const rowHeight = height;
      next.push(place(firstName, count, rowHeight, (resolve) => ({
        kind: 'paged',
        pages: group.map((item) => refOf(item, resolve)),
      })));
    }
    row = next;
    height += 1;
  }
  const top = row;
  return {
    entries: (resolve) => ({ kind: 'paged', pages: top.map((item) => refOf(item, resolve)) }),
    pagesWritten,
    pagesReused,
  };
}

/** Flatten the pages of a parent directory tree for reuse matching. */
export async function knownDirPages(
  entries: DirEntriesV2,
  load: (entries: DirEntriesV2) => Promise<readonly { readonly ref: DirPageRefV2; readonly entries: DirEntriesV2 }[]>,
): Promise<KnownDirPage[]> {
  const out: KnownDirPage[] = [];
  const walk = async (level: DirEntriesV2): Promise<void> => {
    for (const page of await load(level)) {
      out.push({ ref: page.ref, entries: page.entries });
      await walk(page.entries);
    }
  };
  await walk(entries);
  return out;
}
