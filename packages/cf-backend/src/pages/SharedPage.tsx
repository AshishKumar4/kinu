/**
 * The shared library, drawn as one grid of previews: what I shared, what
 * others shared with me, what is public, and what the people I have exchanged
 * a share with have made public — one `kind:id`-deduped union under All, the
 * four lists beside it as segments. A row is either a live share — the
 * owner's slate running in the owner's workspace under the members they
 * granted, opened in a new tab — or a blueprint — a committed version with
 * every binding unmapped, forked into a workspace of mine.
 *
 * There is no user-level file list here, because there is no user-level file
 * or blob store to list: `user-schema.ts` declares none, and every file lives
 * in the workspace that owns it.
 */
import { startTransition, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, GitBranchIcon, GlobeIcon, LinkIcon, LockIcon, ShareNetworkIcon } from "@phosphor-icons/react";
import { blueprintPagePath, seededRandom, type SharedLibrary, type SharedRow } from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import { getSharedLibrary, openLiveShare } from "@/lib/shared-api";
import { ForkDialog } from "@/components/shared/ForkDialog";
import { Segmented } from "@/components/ui/Segmented";
import { inputCls } from "@/components/ui/form";
import type { WorkspaceEntry } from "@/lib/user-api";

function when(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** The five lists one library answers to, in strip order. All is the union,
 *  deduped by kind:id — a public row you were also named on shows once. */
type SegmentId = "all" | "mine" | "received" | "public" | "known";

const SEGMENTS: readonly { id: SegmentId; label: string; empty: string }[] = [
  { id: "all", label: "All", empty: "Nothing shared yet" },
  { id: "mine", label: "Mine", empty: "Nothing shared yet" },
  { id: "received", label: "With me", empty: "Nothing shared with you" },
  { id: "public", label: "Public", empty: "Nothing public" },
  { id: "known", label: "People I know", empty: "Nothing from people you know" },
];

function rowsFor(library: SharedLibrary, segment: SegmentId): SharedRow[] {
  if (segment !== "all") return [...library[segment]];

  const seen = new Set<string>();
  const union: SharedRow[] = [];

  for (const row of [...library.mine, ...library.received, ...library.public, ...library.known]) {
    const key = `${row.kind}:${row.id}`;

    if (seen.has(key)) continue;
    seen.add(key);
    union.push(row);
  }

  return union;
}

type Sort = "recent" | "used";

const SORTS: readonly { id: Sort; label: string }[] = [
  { id: "recent", label: "Recent" },
  { id: "used", label: "Most used" },
];

/** A live row opens the running slate in a new tab; the URL is minted per
 *  open because a share that names people carries a short-lived ticket. */
function OpenLive({ row }: { row: SharedRow }) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const open = useCallback(async () => {
    if (row.workspace === undefined || pending) return;
    setPending(true);
    setFailure(null);

    try {
      const { url } = await openLiveShare({ workspace: row.workspace, share: row.share });
      window.open(url, "_blank", "noopener");
    } catch (cause) {
      setFailure(renderThrownChain({ cause }));
    } finally {
      setPending(false);
    }
  }, [row.workspace, row.share, pending]);

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button type="button" onClick={open} disabled={pending || row.workspace === undefined} data-open-live
        className="p-btn-quiet inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs">
        {pending ? <Loader size="sm" /> : <ArrowSquareOutIcon size={13} />} Open
      </button>
      {failure !== null && <span className="p-notice-danger max-w-[16rem] truncate rounded px-2 py-0.5 text-[11px]" title={failure}>{failure}</span>}
    </div>
  );
}

function KindBadge({ row }: { row: SharedRow }) {
  if (row.kind === "live") {
    return <span className="p-badge-info rounded px-1.5 py-0.5 text-[10px]">live{row.visibility === "public" ? " · public" : row.visibility === "users" ? " · people" : ""}</span>;
  }

  return <span className="p-badge-neutral rounded px-1.5 py-0.5 text-[10px]">blueprint</span>;
}

/** FNV-1a over the share id: the tile's seed, stable across renders and runs. */
function shareSeed(id: string): number {
  let hash = 2166136261;

  for (const character of id) {
    hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  }

  return hash >>> 0;
}

interface TilePoint {
  readonly x: number;
  readonly y: number;
}

/** The card's deterministic generative tile: 7–11 seeded nodes and each
 *  node's nearest neighbour, drawn in percent so the SVG stretches to the
 *  preview at pixel-true dot and line sizes. One node carries the accent —
 *  the card's only gold. */
function ShareTile({ id }: { id: string }) {
  const points = useMemo<TilePoint[]>(() => {
    const random = seededRandom(shareSeed(id));
    const count = 7 + Math.floor(random() * 5);
    const placed: TilePoint[] = [];

    for (let index = 0; index < count; index += 1) {
      placed.push({ x: 6 + random() * 88, y: 10 + random() * 80 });
    }

    return placed;
  }, [id]);

  const edges = useMemo(() => points.map((point, at) => {
    let nearest = -1;
    let best = Number.POSITIVE_INFINITY;

    for (const [otherIndex, other] of points.entries()) {
      if (otherIndex === at) continue;
      const distance = Math.hypot(point.x - other.x, (point.y - other.y) * 0.625);

      if (distance < best) { best = distance; nearest = otherIndex; }
    }

    return nearest < 0 ? null : { from: point, to: points[nearest]! };
  }), [points]);

  const accent = Math.floor(seededRandom(shareSeed(id))() * points.length);

  return (
    <svg aria-hidden="true" className="absolute inset-0 h-full w-full p-text-4">
      {edges.map((edge, index) => edge !== null && (
        <line key={index} x1={`${edge.from.x}%`} y1={`${edge.from.y}%`} x2={`${edge.to.x}%`} y2={`${edge.to.y}%`}
          stroke="currentColor" strokeOpacity={0.3} strokeWidth={1} />
      ))}
      {points.map((point, index) => index === accent
        ? <circle key={index} cx={`${point.x}%`} cy={`${point.y}%`} r={1.5} className="p-accent" fill="currentColor" />
        : <circle key={index} cx={`${point.x}%`} cy={`${point.y}%`} r={1} fill="currentColor" />)}
    </svg>
  );
}

/** The preview's title mark: the leading letters of the first words, in the
 *  display face — a monogram, not an abbreviation. */
function monogram(title: string): string {
  const letters = title.split(/\s+/).filter((word) => word !== "").slice(0, 2).map((word) => word.charAt(0)).join("").toUpperCase();

  return letters === "" ? title.trim().slice(0, 2).toUpperCase() : letters;
}

function ShareCard({ row, onFork }: { row: SharedRow; onFork: (row: SharedRow) => void }) {
  const locked = row.visibility === "users" || (row.users !== undefined && row.users.length > 0);

  return (
    <li className="p-card p-card-lift overflow-hidden">
      <div className="relative aspect-[16/10] border-b p-border p-surface">
        <ShareTile id={row.id} />
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center p-display text-[28px] p-text-2">
          {monogram(row.title)}
        </span>
        {locked && (
          <span className="absolute bottom-2 left-2 rounded-full border p-border p-surface p-1 p-text-3" title="Named people">
            <LockIcon size={11} />
          </span>
        )}
        {row.visibility === "public" && (
          <span className="absolute bottom-2 left-2 rounded-full border p-border p-surface p-1 p-text-3" title="Public">
            <GlobeIcon size={11} />
          </span>
        )}
        <span className="absolute top-2 right-2"><KindBadge row={row} /></span>
      </div>
      <div className="px-4 py-3">
        {row.kind === "blueprint"
          ? <Link to={blueprintPagePath(row.id)} className="block truncate p-row-text font-medium p-text hover:p-accent">{row.title}</Link>
          : <p className="truncate p-row-text font-medium p-text">{row.title}</p>}
        {row.description !== "" && <p className="mt-0.5 line-clamp-1 p-meta p-text-3">{row.description}</p>}
        <div className="mt-2 flex items-center gap-1.5 p-meta p-text-3">
          {row.owner !== undefined && (
            <>
              <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full p-fill text-[9px] font-medium p-text-2">
                {row.owner.charAt(0).toUpperCase()}
              </span>
              <span className="truncate">{row.owner}</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span className="shrink-0 tabular-nums">{when(row.createdAt)}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1 tabular-nums">
            <LinkIcon size={11} />{row.bindings}
          </span>
        </div>
        <div className="mt-2 flex justify-end">
          {row.kind === "live" ? <OpenLive row={row} /> : (
            <button type="button" onClick={() => onFork(row)}
              className="p-btn-quiet inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs">
              <GitBranchIcon size={13} /> Fork
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export default function SharedPage({ fixture, workspaces }: {
  /** Signed-out sample content for the gallery. */
  fixture?: SharedLibrary;
  workspaces?: readonly WorkspaceEntry[];
} = {}) {
  const [library, setLibrary] = useState<SharedLibrary | null>(fixture ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [forking, setForking] = useState<SharedRow | null>(null);
  const [segment, setSegment] = useState<SegmentId>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("recent");

  const refresh = useCallback(() => {
    if (fixture !== undefined) return;
    setErr(null);
    startTransition(async () => {
      try { setLibrary(await getSharedLibrary()); }
      catch (cause) { setErr(renderThrownChain({ cause })); }
    });
  }, [fixture]);

  useEffect(() => { refresh(); }, [refresh]);

  const counts = useMemo<Record<SegmentId, number>>(() => {
    const byId = { all: 0, mine: 0, received: 0, public: 0, known: 0 };

    for (const { id } of SEGMENTS) byId[id] = library === null ? 0 : rowsFor(library, id).length;

    return byId;
  }, [library]);

  const needle = query.trim().toLowerCase();

  const shown = useMemo(() => {
    if (library === null) return [];

    const rows = rowsFor(library, segment).filter((row) => needle === ""
      || row.title.toLowerCase().includes(needle)
      || row.description.toLowerCase().includes(needle)
      || (row.owner ?? "").toLowerCase().includes(needle));

    return sort === "used" ? [...rows].sort((a, b) => b.bindings - a.bindings) : rows;
  }, [library, segment, needle, sort]);

  const empty = SEGMENTS.find(({ id }) => id === segment)!;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <header className="flex items-center gap-3">
          <ShareNetworkIcon size={22} className="shrink-0 p-text-3" />
          <h1 className="p-display text-2xl">Shared</h1>
        </header>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Segmented label="Shared lists" value={segment} onChange={setSegment}
            segments={SEGMENTS.map((option) => ({ ...option, count: counts[option.id] }))} />
          <div className="flex w-full items-center gap-3 sm:w-auto sm:flex-1">
            <input value={query} onChange={(event) => setQuery(event.target.value)}
              placeholder="Search" aria-label="Search shared"
              className={`${inputCls} sm:max-w-xs`} />
            <div className="ml-auto flex items-center gap-2" role="group" aria-label="Sort">
              {SORTS.map((option) => (
                <button key={option.id} type="button" aria-pressed={sort === option.id} onClick={() => setSort(option.id)}
                  className={`whitespace-nowrap p-t-control ${sort === option.id ? "p-text font-medium" : "p-text-3 hover:p-text-2"}`}>
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        {err && (
          <div className="p-notice-danger flex items-center justify-between gap-3 rounded-md px-3 py-2 text-xs">
            <span className="min-w-0 truncate">{err}</span>
            <button type="button" onClick={refresh} className="shrink-0 underline">retry</button>
          </div>
        )}
        {library === null && err === null ? (
          <div className="flex items-center justify-center py-12"><Loader size="base" /></div>
        ) : library !== null && (
          shown.length === 0 ? (
            <p className="py-12 text-center p-text-3">
              {needle === "" ? empty.empty : `Nothing matches “${query.trim()}”`}
            </p>
          ) : (
            <ul data-share-grid className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((row) => <ShareCard key={`${row.kind}:${row.id}`} row={row} onFork={setForking} />)}
            </ul>
          )
        )}
      </div>
      {forking !== null && <ForkDialog blueprint={forking.id} title={forking.title} onClose={() => setForking(null)} workspaces={workspaces} />}
    </div>
  );
}
