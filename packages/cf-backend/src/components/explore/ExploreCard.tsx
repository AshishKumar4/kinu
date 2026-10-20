/**
 * A thing on Explore, as a card that says at a glance what it is: an app you open (a listed slate) or a workspace you
 * install (a workspace blueprint); what it does, who made it, what it needs of yours, and how many use it.
 */
import { Link } from "react-router-dom";
import { AppWindowIcon, DownloadSimpleIcon, EyeIcon, KeyIcon, SealCheckIcon, SquaresFourIcon, StarIcon } from "@phosphor-icons/react";
import { galleryPicturePath } from "@kinu.run/core";
import { Avatar } from "@/components/ui/Avatar";
import { BrandMark } from "@/components/ui/BrandMark";
import { presetBrand } from "@/components/plugins/McpPresetCards";
import { KinuMark } from "@/components/ui/KinuLogo";
import { Cover } from "@/components/drive/DriveTiles";
import { SlatePicture } from "@/components/slates/SlatePicture";
import type { ExploreItem, ExploreKind, ExploreNeed } from "@/lib/explore-api";

/** A workspace blueprint's page. */
export const exploreWorkspaceHref = (id: string) => `/explore/workspaces/${encodeURIComponent(id)}`;

/** A listed slate's own page: the Gallery's, unchanged. */
const appHref = (workspace: string, slate: string) => `/gallery/${encodeURIComponent(workspace)}/${encodeURIComponent(slate)}`;

/** Where a workspace blueprint's picture is read. */
/** A picture of one of Kinu's own blueprints at work, which the app serves with its assets, under its base. */
export const kinuBlueprintPicture = (picture: string) => `${import.meta.env.BASE_URL}assets/explore/${encodeURIComponent(picture)}.webp`;

/** A picture of a whole page, cropped to its top left at a size its words can be read at in a card. */
const ZOOMED = "absolute left-0 top-0 h-auto w-[165%] max-w-none";

const count = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString("en-US"));

const KIND_WORDS: Record<ExploreKind, { label: string; verb: string }> = {
  app: { label: "App", verb: "Open" },
  workspace: { label: "Workspace", verb: "Install" },
};

/** What it is, in a word. `onPicture`: solid, so it reads over any picture. */
export function KindBadge({ kind, onPicture = false, className = "" }: { kind: ExploreKind; onPicture?: boolean; className?: string }) {
  const Icon = kind === "app" ? AppWindowIcon : SquaresFourIcon;
  let ground = kind === "workspace" ? "bg-[var(--c-accent-subtle)] p-accent" : "bg-[var(--c-neutral-tint)] p-text-2";

  if (onPicture) ground = `border p-border bg-[var(--c-surface)] shadow-sm ${kind === "workspace" ? "p-accent" : "p-text"}`;

  return (
    <span data-explore-kind={kind} className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tracking-[0.01em] ${ground} ${className}`}>
      <Icon size={12} weight="bold" />{KIND_WORDS[kind].label}
    </span>
  );
}

/** Who made it: a person by their initial, or Kinu, which keeps its own. */
export function Maker({ maker, size = 18 }: { maker: { readonly name: string; readonly kinu: boolean }; size?: number }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {maker.kinu ? <KinuMark size={size - 2} /> : <Avatar name={maker.name} size={size} />}
      <span className="truncate">{maker.name}</span>
      {maker.kinu && <SealCheckIcon size={13} weight="fill" className="shrink-0 p-accent" aria-label="Made by Kinu" />}
    </span>
  );
}


/** What it reaches of yours: each connection's mark, and a key for each secret. Nothing at all says so. */
export function Needs({ needs }: { needs: readonly ExploreNeed[] }) {
  if (needs.length === 0) return <span className="p-meta p-text-3">Needs nothing of yours</span>;

  const words = needs.map((need) => `${need.connection ?? need.secret ?? "?"} (${need.access})`).join(", ");

  return (
    <span className="inline-flex items-center gap-1" title={`Uses your ${words}`} aria-label={`Uses your ${words}`}>
      {needs.map((need) => {
        const brand = presetBrand(need.connection);

        return (
          <span key={`${need.connection ?? ""}${need.secret ?? ""}`} className="flex size-5 items-center justify-center rounded-md bg-[var(--c-neutral-tint)]">
            {brand !== undefined ? <BrandMark brand={brand} size={12} bare /> : <KeyIcon size={11} className="p-text-2" />}
          </span>
        );
      })}
    </span>
  );
}

export function ExploreCard({ item }: { item: ExploreItem }) {
  if (item.kind === "app") {
    const { app } = item;

    return (
      <Card href={appHref(app.workspace, app.slate)} kind="app" title={app.title} line={app.line} id={app.slate}
        picture={(
          <SlatePicture workspace={app.workspace} slate={{ id: app.slate, title: app.title, picture: app.picture }} at={galleryPicturePath}
            className={ZOOMED} fallback={<Cover title={app.title} />} />
        )}
        maker={<Maker maker={{ name: app.owner.name, kinu: false }} />}
        needs={item.needs}
        numbers={<><EyeIcon size={13} className="p-text-3" />{count(app.viewers)}<StarIcon size={13} className="ml-1.5 p-text-3" />{count(app.stars)}</>} />
    );
  }

  const { workspace } = item;

  return (
    <Card href={exploreWorkspaceHref(workspace.id)} kind="workspace" title={workspace.title} line={workspace.line} id={workspace.id}
      picture={workspace.picture === null
        ? <Cover title={workspace.title} />
        : <img src={kinuBlueprintPicture(workspace.picture)} alt="" loading="lazy" className={ZOOMED} />}
      maker={<Maker maker={workspace.maker} />}
      needs={workspace.needs}
      numbers={<><DownloadSimpleIcon size={13} className="p-text-3" />{count(workspace.installs)}<StarIcon size={13} className="ml-1.5 p-text-3" />{count(workspace.stars)}</>} />
  );
}

function Card({ href, kind, id, title, line, picture, maker, needs, numbers }: {
  href: string; kind: ExploreKind; id: string; title: string; line: string;
  picture: React.ReactNode; maker: React.ReactNode; needs: readonly ExploreNeed[]; numbers: React.ReactNode;
}) {
  return (
    <li className="min-w-0" data-explore-item={id}>
      <Link to={href} aria-label={`${title}: ${KIND_WORDS[kind].label.toLowerCase()} to ${KIND_WORDS[kind].verb.toLowerCase()}`}
        className="group flex h-full flex-col overflow-hidden rounded-[14px] border p-border p-surface p-card-lift focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-accent)]">
        <span className="relative block aspect-[16/10] shrink-0 overflow-hidden border-b p-border">
          {picture}
          <KindBadge kind={kind} onPicture className="absolute left-2.5 top-2.5" />
        </span>
        <span className="flex flex-1 flex-col gap-1.5 px-3.5 pb-3 pt-3">
          <span className="truncate p-row-text font-semibold p-text">{title}</span>
          <span className="line-clamp-2 min-h-[2lh] p-meta p-text-2">{line}</span>
          <span className="mt-1 flex min-w-0 items-center gap-2 p-meta p-text-3">
            {maker}
            <span className="ml-auto inline-flex shrink-0 items-center gap-1">{numbers}</span>
          </span>
          <span className="mt-1 flex items-center justify-between gap-2 border-t p-border pt-2.5">
            <Needs needs={needs} />
            <span className="shrink-0 rounded-full px-2.5 py-0.5 text-[12px] font-medium transition-colors bg-[var(--c-neutral-tint)] p-text group-hover:bg-[var(--c-accent)] group-hover:text-[var(--c-accent-on)]">
              {KIND_WORDS[kind].verb}
            </span>
          </span>
        </span>
      </Link>
    </li>
  );
}
