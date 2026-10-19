/**
 * The Gallery (sharing v7 `gallery`): slates people listed for anyone to use, this week's top two first. Sort, category
 * and search live in the URL and ask the Gallery again; a page at a time, the next one joining it.
 */
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Effect } from "effect";
import { Button, Loader } from "@cloudflare/kumo";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { GALLERY_CATEGORIES, GALLERY_SORTS, type GalleryPage as Listings, type GallerySort } from "@kinu.run/core";
import { detach, showing } from "@kinu.run/core/obs";
import { GRID } from "@/components/drive/DriveTiles";
import { FeaturedListing, ListingTile } from "@/components/gallery/GalleryTiles";
import { CATEGORY_WORDS } from "@/components/sharing/words";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { readGallery } from "@/lib/gallery-api";

const SORT_WORDS: Record<GallerySort, string> = { trending: "Trending", new: "New", stars: "Most starred" };

const chip = (on: boolean) => `rounded-full px-3 py-1 text-xs font-medium transition-colors ${on ? "bg-[var(--c-accent-subtle)] p-accent" : "p-text-2 hover:bg-[var(--c-elevated)]"}`;

const categoryChip = (on: boolean) => `rounded-full border px-3 py-1 text-xs transition-colors ${on ? "border-[var(--c-text-3)] p-text" : "p-border p-text-2 hover:bg-[var(--c-elevated)]"}`;

export default function GalleryPage() {
  const [search, setSearch] = useSearchParams();
  const sort = GALLERY_SORTS.find((each) => each === search.get("sort")) ?? "trending";
  const category = GALLERY_CATEGORIES.find((each) => each === search.get("category")) ?? null;
  const q = search.get("q") ?? "";
  // The field's own text: the URL follows it a render later, and keystrokes in between must not be lost.
  const [typed, setTyped] = useState(q);
  const [shown, setShown] = useState<Listings | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [tries, setTries] = useState(0);

  // Each query reads its first page afresh, keeping the last one drawn until it answers; an answer to an earlier query
  // is dropped.
  useEffect(() => {
    let current = true;

    detach(Effect.catchCause(
      Effect.map(Effect.promise(() => readGallery({ q, sort, category, page: 0 })), (page) => { if (current) { setShown(page); setFailure(null); } }),
      showing((chain) => { if (current) setFailure(chain); }),
    ));

    return () => { current = false; };
  }, [q, sort, category, tries]);

  const choose = useCallback((key: "sort" | "category" | "q", value: string | null) => {
    setSearch((prior) => {
      const next = new URLSearchParams(prior);

      if (value === null || value === "") next.delete(key);
      else next.set(key, value);

      return next;
    }, { replace: key === "q" });
  }, [setSearch]);

  const more = useCallback((page: number) => {
    detach(Effect.catchCause(
      Effect.map(Effect.promise(() => readGallery({ q, sort, category, page })), (read) => setShown((prior) => ({ listings: [...(prior?.listings ?? []), ...read.listings], next: read.next }))),
      showing(setFailure),
    ));
  }, [q, sort, category]);

  const unfiltered = q === "" && category === null;
  const featured = unfiltered ? (shown?.listings ?? []).filter((listing) => listing.featured).slice(0, 2) : [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1120px] px-4 pb-16 pt-6 sm:px-8 sm:pt-8">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1">
            <h1 className="p-display text-2xl">Gallery</h1>
            <p className="mt-1 p-row-text p-text-3">Slates people made for anyone to use. Fork one to make it yours.</p>
          </div>
          <label className="flex h-9 w-full items-center gap-2 rounded-lg border p-border bg-[var(--c-input-bg)] px-3 sm:w-80">
            <MagnifyingGlassIcon size={15} className="shrink-0 p-text-3" />
            <input value={typed} onChange={(event) => { setTyped(event.target.value); choose("q", event.target.value); }} type="search" placeholder="Search slates" aria-label="Search slates" data-gallery-search
              className="min-w-0 flex-1 bg-transparent p-row-text p-text outline-none placeholder:text-[var(--c-text-4)]" />
          </label>
        </div>
        {featured.length > 0 && <div className="mt-6 grid gap-4 lg:grid-cols-2">{featured.map((listing) => <FeaturedListing key={listing.slate} listing={listing} />)}</div>}
        <div className="mt-8 flex flex-wrap items-center gap-2">
          {GALLERY_SORTS.map((each) => (
            <button key={each} type="button" aria-pressed={each === sort} data-gallery-sort={each} onClick={() => choose("sort", each === "trending" ? null : each)} className={chip(each === sort)}>
              {SORT_WORDS[each]}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-[var(--c-border)]" />
          <button type="button" aria-pressed={category === null} data-gallery-category="all" onClick={() => choose("category", null)} className={categoryChip(category === null)}>All</button>
          {GALLERY_CATEGORIES.map((each) => (
            <button key={each} type="button" aria-pressed={each === category} data-gallery-category={each} onClick={() => choose("category", each)} className={categoryChip(each === category)}>
              {CATEGORY_WORDS[each]}
            </button>
          ))}
        </div>
        {failure !== null && <LoadFailure what="the Gallery" message={failure} onRetry={() => setTries((count) => count + 1)} className="mt-4" />}
        {shown === null && failure === null && <div className="flex justify-center py-16"><Loader size="base" /></div>}
        {shown !== null && shown.listings.length === 0 && (
          <p className="py-12 text-center p-text-3" data-gallery-no-match>{q === "" ? "Nothing is listed here yet" : `Nothing matches “${q}”`}</p>
        )}
        {shown !== null && shown.listings.length > 0 && <ul className={`mt-4 ${GRID}`}>{shown.listings.map((listing) => <ListingTile key={`${listing.workspace}/${listing.slate}`} listing={listing} />)}</ul>}
        {shown?.next !== null && shown?.next !== undefined && (
          <div className="mt-6 flex justify-center">
            <Button size="sm" variant="secondary" data-gallery-more onClick={() => { if (shown.next !== null) more(shown.next); }}>Show more</Button>
          </div>
        )}
      </div>
    </div>
  );
}
