/**
 * Explore: apps to open and workspaces to install, in one feed ranked by what people use now. Kinu's own come first,
 * the personal assistant leading; kind, category and sort are light chips, and search reads both kinds. Query and
 * filters live in the URL, as the Gallery's do. Its header and left edge are every page's (ui/PageHeader.tsx).
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Effect } from "effect";
import { Button, Loader } from "@cloudflare/kumo";
import { CheckIcon, CompassIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { GALLERY_CATEGORIES, GALLERY_SORTS, type GalleryCategory, type GallerySort } from "@kinu.run/core";
import { detach, showing } from "@kinu.run/core/obs";
import { CATEGORY_WORDS } from "@/components/sharing/words";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { ExploreCard, exploreWorkspaceHref, KindBadge, Maker, Needs, kinuBlueprintPicture } from "@/components/explore/ExploreCard";
import { EXPLORE_KINDS, readExplore, type ExploreItem, type ExploreKind, type ExplorePage, type WorkspaceCard } from "@/lib/explore-api";
import { PAGE_BODY, PageHeader } from "@/components/ui/PageHeader";
import { useSearchChoice } from "@/hooks/use-search-choice";

const SORT_WORDS: Record<GallerySort, string> = { trending: "Trending", new: "New", stars: "Most starred" };

const KIND_FILTER_WORDS: Record<ExploreKind, string> = { app: "Apps", workspace: "Workspaces" };

const chip = (on: boolean) => `rounded-full px-3 py-1 text-xs font-medium transition-colors ${on ? "bg-[var(--c-accent-subtle)] p-accent" : "p-text-2 hover:bg-[var(--c-elevated)]"}`;

const quietChip = (on: boolean) => `rounded-full border px-3 py-1 text-xs transition-colors ${on ? "border-[var(--c-text-3)] p-text" : "p-border p-text-2 hover:bg-[var(--c-elevated)]"}`;

const GRID = "grid grid-cols-1 gap-4 min-[520px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

/** Kinu's lead blueprint, wide: what it is, what it needs, and Install. */
function Hero({ workspace, highlights }: { workspace: WorkspaceCard; highlights: readonly string[] }) {
  return (
    <Link to={exploreWorkspaceHref(workspace.id)} data-explore-hero={workspace.id}
      className="group flex min-w-0 flex-col overflow-hidden rounded-[18px] border p-border p-surface p-card-lift md:flex-row">
      <span className="relative block aspect-[16/10] shrink-0 overflow-hidden border-b p-border md:aspect-auto md:w-[56%] md:border-b-0 md:border-r">
        {workspace.picture !== null && <img src={kinuBlueprintPicture(workspace.picture)} alt="" className="absolute inset-0 size-full object-cover object-left-top" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-3 p-5">
        <span className="flex items-center gap-2"><KindBadge kind="workspace" /><span className="p-meta p-text-3">Featured</span></span>
        <span className="p-display text-[24px] leading-tight p-text">{workspace.title}</span>
        <span className="p-row-text p-text-2">{workspace.line}</span>
        <ul className="space-y-1.5">
          {highlights.map((line) => (
            <li key={line} className="flex items-start gap-2 p-meta p-text-2"><CheckIcon size={13} weight="bold" className="mt-0.5 shrink-0 p-accent" />{line}</li>
          ))}
        </ul>
        <span className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 pt-2 p-meta p-text-3">
          <Maker maker={workspace.maker} />
          <Needs needs={workspace.needs} />
          <span className="ml-auto rounded-full bg-[var(--c-accent)] px-4 py-1.5 text-[13px] font-semibold text-[var(--c-accent-on)]">Install</span>
        </span>
      </span>
    </Link>
  );
}

/** The rest of Kinu's own, as rows beside the lead. */
function AlsoFromKinu({ workspaces }: { workspaces: readonly WorkspaceCard[] }) {
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-[18px] border p-border p-surface">
      <span className="border-b p-border px-4 pb-2.5 pt-3.5 p-eyebrow">Also from Kinu</span>
      {workspaces.map((workspace) => (
        <Link key={workspace.id} to={exploreWorkspaceHref(workspace.id)} data-explore-also={workspace.id}
          className="flex items-center gap-3 border-b p-border px-4 py-3 transition-colors last:border-b-0 p-card-hover">
          <span className="relative block h-12 w-[76px] shrink-0 overflow-hidden rounded-lg border p-border">
            {workspace.picture !== null && <img src={kinuBlueprintPicture(workspace.picture)} alt="" className="absolute inset-0 size-full object-cover object-left-top" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate p-row-text font-medium p-text">{workspace.title}</span>
            <span className="line-clamp-2 p-meta p-text-3">{workspace.line}</span>
          </span>
        </Link>
      ))}
    </div>
  );
}

/** What the lead blueprint does, in three lines: the page's own words for it, ahead of its page. */
const HERO_HIGHLIGHTS = new Map([
  ["personal-assistant", [
    "Reads your mail and GitHub, and marks what matters",
    "A brief every weekday morning, on Home",
    "Starts workspaces for bigger work, and checks on them",
  ]],
]);

type Filter = "sort" | "category" | "kind" | "q";

/** Kind, category and sort as light chips, and search at the row's end. */
function Filters({ kind, category, sort, q, choose }: {
  kind: ExploreKind | null; category: GalleryCategory | null; sort: GallerySort; q: string; choose: (key: Filter, value: string | null) => void;
}) {
  const [typed, setTyped] = useState(q);

  return (
    <div className="flex flex-wrap items-center gap-2" data-explore-filters>
      <button type="button" aria-pressed={kind === null} onClick={() => choose("kind", null)} className={chip(kind === null)}>All</button>
      {EXPLORE_KINDS.map((each) => (
        <button key={each} type="button" aria-pressed={each === kind} data-explore-kind-filter={each} onClick={() => choose("kind", each)} className={chip(each === kind)}>
          {KIND_FILTER_WORDS[each]}
        </button>
      ))}
      <span className="mx-1 h-4 w-px bg-[var(--c-border)]" />
      {GALLERY_CATEGORIES.map((each) => (
        <button key={each} type="button" aria-pressed={each === category} data-explore-category={each} onClick={() => choose("category", each === category ? null : each)} className={quietChip(each === category)}>
          {CATEGORY_WORDS[each]}
        </button>
      ))}
      <span className="ml-auto flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1">
          {GALLERY_SORTS.map((each) => (
            <button key={each} type="button" aria-pressed={each === sort} data-explore-sort={each} onClick={() => choose("sort", each === "trending" ? null : each)}
              className={`rounded-md px-2 py-1 text-xs transition-colors ${each === sort ? "font-semibold p-text" : "p-text-3 hover:p-text"}`}>
              {SORT_WORDS[each]}
            </button>
          ))}
        </span>
        <label className="flex h-8 w-full items-center gap-2 rounded-lg border p-border bg-[var(--c-input-bg)] px-3 sm:w-64">
          <MagnifyingGlassIcon size={14} className="shrink-0 p-text-3" />
          <input value={typed} onChange={(event) => { setTyped(event.target.value); choose("q", event.target.value); }} type="search" placeholder="Search apps and workspaces" aria-label="Search apps and workspaces" data-explore-search
            className="min-w-0 flex-1 bg-transparent p-row-text p-text outline-none placeholder:text-[var(--c-text-4)]" />
        </label>
      </span>
    </div>
  );
}

/** The feed after Kinu's own, and the next page. */
function Feed({ items, next, q, more }: { items: readonly ExploreItem[]; next: number | null; q: string; more: (page: number) => void }) {
  return (
    <>
      {items.length === 0 && <p className="py-12 text-center p-text-3" data-explore-no-match>{q === "" ? "Nothing here yet" : `Nothing matches “${q}”`}</p>}
      {items.length > 0 && <ul className={`mt-4 ${GRID}`}>{items.map((item) => <ExploreCard key={item.kind === "app" ? `a/${item.app.workspace}/${item.app.slate}` : `w/${item.workspace.id}`} item={item} />)}</ul>}
      {next !== null && (
        <div className="mt-6 flex justify-center">
          <Button size="sm" variant="secondary" data-explore-more onClick={() => more(next)}>Show more</Button>
        </div>
      )}
    </>
  );
}

export default function ExplorePage() {
  const [search, choose] = useSearchChoice();
  const sort = GALLERY_SORTS.find((each) => each === search.get("sort")) ?? "trending";
  const category = GALLERY_CATEGORIES.find((each) => each === search.get("category")) ?? null;
  const kind = EXPLORE_KINDS.find((each) => each === search.get("kind")) ?? null;
  const q = search.get("q") ?? "";
  const [shown, setShown] = useState<ExplorePage | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let current = true;

    detach(Effect.catchCause(
      Effect.map(Effect.promise(() => readExplore({ q, kind, sort, category, page: 0 })), (page) => { if (current) { setShown(page); setFailure(null); } }),
      showing((chain) => { if (current) setFailure(chain); }),
    ));

    return () => { current = false; };
  }, [q, kind, sort, category, tries]);

  const more = useCallback((page: number) => {
    detach(Effect.catchCause(
      Effect.map(Effect.promise(() => readExplore({ q, kind, sort, category, page })), (read) => setShown((prior) => ({ items: [...(prior?.items ?? []), ...read.items], next: read.next }))),
      showing(setFailure),
    ));
  }, [q, kind, sort, category]);

  // Kinu's own lead an unfiltered page; any filter shows the feed alone.
  const kinus = q === "" && category === null && kind === null
    ? (shown?.items ?? []).flatMap((item) => (item.kind === "workspace" && item.workspace.maker.kinu ? [item.workspace] : []))
    : [];

  const [lead, ...also] = kinus;

  return (
    <div className="h-full overflow-y-auto">
      <div className={`space-y-6 ${PAGE_BODY}`}>
        <PageHeader icon={<CompassIcon size={22} />} title="Explore" />
        {lead !== undefined && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Hero workspace={lead} highlights={HERO_HIGHLIGHTS.get(lead.id) ?? []} />
            {also.length > 0 && <AlsoFromKinu workspaces={also} />}
          </div>
        )}
        <div>
          <Filters kind={kind} category={category} sort={sort} q={q} choose={choose} />
          {failure !== null && <LoadFailure what="Explore" message={failure} onRetry={() => setTries((n) => n + 1)} className="mt-4" />}
          {shown === null && failure === null && <div className="flex justify-center py-16"><Loader size="base" /></div>}
          {shown !== null && (
            <Feed items={shown.items.filter((item) => !(item.kind === "workspace" && kinus.includes(item.workspace)))} next={shown.next} q={q} more={more} />
          )}
        </div>
      </div>
    </div>
  );
}
