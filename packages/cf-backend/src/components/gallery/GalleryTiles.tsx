/** A Gallery listing as a card: its picture, whose it is, its viewers and stars, and what a fork asks of you. */
import { Link } from "react-router-dom";
import { EyeIcon, StarIcon } from "@phosphor-icons/react";
import { galleryPicturePath, type GalleryListing } from "@kinu.run/core";
import { Avatar } from "@/components/ui/Avatar";
import { Cover, Tile } from "@/components/drive/DriveTiles";
import { SlatePicture } from "@/components/slates/SlatePicture";

/** A listed slate's own page in the app. */
const gallerySlateHref = (workspace: string, slate: string) => `/gallery/${encodeURIComponent(workspace)}/${encodeURIComponent(slate)}`;

export function ListingPicture({ listing }: { listing: GalleryListing }) {
  return (
    <SlatePicture workspace={listing.workspace} slate={{ id: listing.slate, title: listing.title, picture: listing.picture }} at={galleryPicturePath}
      className="absolute inset-0 size-full object-cover object-left-top" fallback={<Cover title={listing.title} />} />
  );
}

function Stars({ count, on = false }: { count: number; on?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 tabular-nums">
      <StarIcon size={13} weight={on ? "fill" : "regular"} className={on ? "p-accent" : "p-text-3"} />{count.toLocaleString("en-US")}
    </span>
  );
}

/** How many people signed in have opened it, as its workspace last said. */
function Viewers({ count }: { count: number }) {
  const words = `${count.toLocaleString("en-US")} ${count === 1 ? "person has" : "people have"} opened it`;

  return (
    <span className="inline-flex items-center gap-1 tabular-nums" data-gallery-viewers={count} title={words} aria-label={words}>
      <EyeIcon size={13} className="p-text-3" aria-hidden />{count.toLocaleString("en-US")}
    </span>
  );
}

/** A card's counts, viewers beside stars. */
function Counts({ listing }: { listing: GalleryListing }) {
  return <span className="inline-flex shrink-0 items-center gap-2"><Viewers count={listing.viewers} /><Stars count={listing.stars} on={listing.starred} /></span>;
}

export function ListingTile({ listing }: { listing: GalleryListing }) {
  return (
    <Tile title={listing.title} icon={<Avatar name={listing.owner.name} size={18} />} picture={<ListingPicture listing={listing} />}
      href={gallerySlateHref(listing.workspace, listing.slate)} attributes={{ "data-gallery-listing": listing.slate }}
      meta={<span className="flex min-w-0 items-center gap-2"><span className="truncate">{listing.owner.name}</span><Counts listing={listing} /></span>}
      menu={[]} />
  );
}

/** One of this week's top two, wide: its line beside its picture. */
export function FeaturedListing({ listing }: { listing: GalleryListing }) {
  return (
    <Link to={gallerySlateHref(listing.workspace, listing.slate)} data-gallery-featured={listing.slate}
      className="flex min-w-0 flex-col overflow-hidden rounded-[14px] border p-border p-surface p-card-lift sm:flex-row">
      <span className="relative block aspect-[2/1] shrink-0 border-b p-border sm:aspect-auto sm:w-[46%] sm:border-b-0 sm:border-r"><ListingPicture listing={listing} /></span>
      <span className="flex min-w-0 flex-1 flex-col gap-2 p-4">
        <span className="p-eyebrow p-accent">Featured</span>
        <span className="p-heading text-[17px] p-text">{listing.title}</span>
        <span className="line-clamp-2 p-meta p-text-3">{listing.line}</span>
        <span className="mt-auto flex flex-wrap items-center gap-2 p-meta p-text-3">
          <Avatar name={listing.owner.name} size={18} />{listing.owner.name}<span className="ml-1"><Counts listing={listing} /></span>
        </span>
      </span>
    </Link>
  );
}
