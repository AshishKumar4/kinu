/**
 * A listed slate's own page (sharing v7 `gallery-slate`): Open by its link, Fork with its key, Star, and Report.
 */
import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Effect } from "effect";
import { Loader } from "@cloudflare/kumo";
import { Button, buttonClass } from "@/components/ui/Button";
import { FlagIcon, FolderIcon, GitForkIcon, GithubLogoIcon, PlayIcon, PlugIcon, SparkleIcon, StarIcon } from "@phosphor-icons/react";
import { APP_ROUTES, galleryPicturePath, type GalleryListing, type GallerySlate, type RoomService } from "@kinu.run/core";
import { detach, showing } from "@kinu.run/core/obs";
import { useGallerySignedIn } from "@/hooks/use-gallery-signed-in";
import { FRAME_PAGE, Page } from "@/components/ui/PageHeader";
import { TILE_GRID, TypesetCover } from "@/components/ui/Tiles";
import { ExploreCard } from "@/components/explore/ExploreCard";
import { SlatePicture } from "@/components/slates/SlatePicture";
import { ForkDialog } from "@/components/shared/ForkDialog";
import { CATEGORY_WORDS } from "@/components/sharing/words";
import { Avatar } from "@/components/ui/Avatar";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { Modal } from "@/components/ui/Modal";
import { hereAsking, signInAndReturn } from "@/lib/sign-in";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { readExplore, type ExploreItem } from "@/lib/explore-api";
import { readGallerySlate, reportListing, starListing } from "@/lib/gallery-api";

function ReportDialog({ listing, onClose, onSent }: { listing: GalleryListing; onClose: () => void; onSent: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const send = useCallback(() => {
    setBusy(true);
    detach(Effect.ensuring(Effect.catchCause(
      Effect.map(Effect.promise(() => reportListing({ workspace: listing.workspace, slate: listing.slate, reason: reason.trim() })), onSent),
      showing(setFailure),
    ), Effect.sync(() => setBusy(false))));
  }, [listing, reason, onSent]);

  return (
    <Modal title={`Report ${listing.title}`} icon={<FlagIcon size={18} className="p-accent" />} onClose={onClose} busy={busy}
      footer={(
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" disabled={reason.trim() === "" || busy} data-gallery-report-send onClick={send}>Report</Button>
        </div>
      )}>
      <p className="p-row-text p-text-2">Say what is wrong with it. The people who run Kinu read every report.</p>
      <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={500} aria-label="What is wrong" data-gallery-report-reason
        className="w-full rounded-md border p-border bg-[var(--c-field)] px-2.5 py-1.5 p-row-text p-text outline-none placeholder:text-[var(--c-text-3)]" />
      {failure !== null && <p role="alert" className="p-meta p-danger">{failure}</p>}
    </Modal>
  );
}

/** Fork, signed in: the roster it lands in is the shell's, so the sidebar lists a new workspace at once. */
function ForkListing({ listing, onClose }: { listing: GalleryListing; onClose: () => void }) {
  const { create } = useWorkspaceRoster();

  return (
    <ForkDialog live={{ share: listing.share, workspace: listing.workspace }} title={listing.title} onClose={onClose} create={create} />
  );
}

const SERVICE_ICON: Record<RoomService["kind"], typeof PlugIcon> = { github: GithubLogoIcon, mcp: PlugIcon, ai: SparkleIcon, workspace: FolderIcon };

/**
 * What a visitor's own connections it uses (docs/SLATE-SHARING-NIMBUS.md §4): a listed slate runs on each person's own
 * access, so each of these asks them before it reads anything; nothing of its author's is used.
 */
function UsesYours({ needs }: { needs: readonly RoomService[] }) {
  return (
    <div data-gallery-needs className="pt-2">
      <h2 className="mb-2 p-meta font-medium p-text-2">Uses your own</h2>
      {needs.length === 0 ? (
        <p className="p-row-text p-text-2">Nothing of yours.</p>
      ) : (
        <ul className="p-group">
          {needs.map((need) => {
            const Icon = SERVICE_ICON[need.kind];

            return <li key={`${need.kind}:${need.title}`} data-gallery-need={need.kind} className="flex items-center gap-3 px-3.5 py-2.5 p-row-text p-text"><Icon size={16} className="shrink-0 p-text-3" />{need.title}</li>;
          })}
        </ul>
      )}
    </div>
  );
}

export default function GallerySlatePage() {
  const { workspace = "", slate = "" } = useParams();
  const [search] = useSearchParams();
  const signedIn = useGallerySignedIn();
  const [read, setRead] = useState<GallerySlate | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const [like, setLike] = useState<readonly ExploreItem[]>([]);
  const [star, setStar] = useState<{ on: boolean; count: number } | null>(null);
  const [starFailure, setStarFailure] = useState<string | null>(null);
  // Back from signing in to fork: the picker is open.
  const [dialog, setDialog] = useState<"fork" | "report" | null>(signedIn && search.has("fork") ? "fork" : null);
  const [reported, setReported] = useState(false);

  // The slate's page, then more apps of its category from Explore: never itself.
  useEffect(() => {
    let current = true;

    detach(Effect.catchCause(Effect.flatMap(Effect.promise(() => readGallerySlate(workspace, slate)), (page) => {
      if (!current) return Effect.void;
      setRead(page);
      setStar({ on: page.listing.starred, count: page.listing.stars });

      return Effect.map(Effect.promise(() => readExplore({ q: "", kind: "app", sort: "trending", category: page.listing.category, page: 0 })), (same) => {
        if (current) setLike(same.items.filter((each) => each.kind === "app" && (each.app.workspace !== workspace || each.app.slate !== slate)).slice(0, 2));
      });
    }), showing((chain) => { if (current) setFailure(chain); })));

    return () => { current = false; };
  }, [workspace, slate, tries]);

  // Drawn at once, and put back if the Gallery refuses it.
  const toggleStar = useCallback(() => {
    if (star === null) return;
    const before = star;
    const on = !before.on;

    setStar({ on, count: before.count + (on ? 1 : -1) });
    setStarFailure(null);
    detach(Effect.catchCause(Effect.promise(() => starListing({ workspace, slate, on })), showing((chain) => {
      setStar(before);
      setStarFailure(chain);
    })));
  }, [star, workspace, slate]);

  if (failure !== null) {
    return <div className={FRAME_PAGE}><LoadFailure what="this slate" message={failure} onRetry={() => { setFailure(null); setTries((count) => count + 1); }} /></div>;
  }

  if (read === null || star === null) return <div className="flex h-full items-center justify-center"><Loader size="base" /></div>;

  const { listing } = read;

  return (
    <Page back={{ to: `${APP_ROUTES.explore}?kind=app`, label: "Back to Explore" }} icon={null} title={listing.title} data-gallery-slate={listing.slate}
      actions={(
        <>
          <Button variant="secondary" aria-pressed={star.on} data-gallery-star data-gallery-stars={star.count} onClick={signedIn ? toggleStar : () => signInAndReturn()}>
            <StarIcon size={15} weight={star.on ? "fill" : "regular"} className={star.on ? "p-accent" : ""} />{star.on ? "Starred" : "Star"} · {star.count.toLocaleString("en-US")}
          </Button>
          <Button variant="secondary" data-gallery-fork onClick={() => (signedIn ? setDialog("fork") : signInAndReturn(hereAsking("fork")))}>
            <GitForkIcon size={15} />Fork
          </Button>
          <a href={listing.url} data-gallery-open className={buttonClass({ variant: "primary" })}><PlayIcon size={14} weight="fill" />Open</a>
        </>
      )}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div data-gallery-hero className="relative aspect-[2/1] overflow-hidden rounded-[var(--r-card)] border p-border">
          <SlatePicture workspace={listing.workspace} slate={{ id: listing.slate, title: listing.title, picture: listing.picture }} at={galleryPicturePath}
            className="absolute inset-0 size-full object-cover object-left-top" fallback={<TypesetCover title={listing.title} line={listing.line} />} />
        </div>
        <div className="min-w-0 space-y-4">
          <p className="flex items-center gap-2 p-row-text p-text-3"><Avatar name={listing.owner.name} size={20} />{listing.owner.name} · {CATEGORY_WORDS[listing.category]}</p>
          <p className="p-row-text p-text-2">{listing.line}</p>
          {starFailure !== null && <p role="alert" className="p-meta p-danger">{starFailure}</p>}
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 p-meta p-text-3">
            <span data-gallery-viewers={listing.viewers}>{listing.viewers === 1 ? "Opened by 1 person" : `Opened by ${listing.viewers.toLocaleString("en-US")} people`}</span>
            {read.people !== undefined && <span data-gallery-people>Used by about {read.people.toLocaleString("en-US")} people this week</span>}
            {read.forks !== undefined && <span data-gallery-forks>{read.forks === 1 ? "1 fork" : `${read.forks.toLocaleString("en-US")} forks`}</span>}
            {reported
              ? <span data-gallery-reported className="ml-auto inline-flex items-center gap-1"><FlagIcon size={12} />Reported</span>
              : <button type="button" data-gallery-report onClick={() => (signedIn ? setDialog("report") : signInAndReturn())} className="ml-auto inline-flex items-center gap-1 hover:underline"><FlagIcon size={12} />Report</button>}
          </p>
          {read.needs !== undefined && <UsesYours needs={read.needs} />}
        </div>
      </div>
      {like.length > 0 && (
        <section data-gallery-like>
          <h2 className="mb-3 p-label">More like it</h2>
          <ul className={TILE_GRID}>{like.map((each) => <ExploreCard key={each.kind === "app" ? `${each.app.workspace}/${each.app.slate}` : each.workspace.id} item={each} />)}</ul>
        </section>
      )}
      {dialog === "fork" && <ForkListing listing={listing} onClose={() => setDialog(null)} />}
      {dialog === "report" && <ReportDialog listing={listing} onClose={() => setDialog(null)} onSent={() => { setReported(true); setDialog(null); }} />}
    </Page>
  );
}
