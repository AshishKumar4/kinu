/**
 * A live share's place in the Gallery, on its own row (docs/SLATE-SHARING-NIMBUS.md §4): listed by a line and a category,
 * both asked for before it lists. Only a share anyone with the link can open is listed, and only on each person's own
 * access; one on the owner's access says so, and why.
 */
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { GALLERY_CATEGORIES, type GalleryCategory, type LiveShareRecord } from "@kinu.run/core";
import { CATEGORY_WORDS } from "@/components/sharing/words";
import { Switch } from "@/components/ui/Switch";
import { TextInput } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";

/** Lists the share with its card's words, or, with null, takes it off the Gallery. */
export type ListShare = (listing: { line: string; category: GalleryCategory } | null) => void;

export function ShareListing({ share, onList, disabled }: { share: LiveShareRecord; onList: ListShare; disabled: boolean }) {
  const [drafting, setDrafting] = useState(false);
  const [line, setLine] = useState("");
  const [category, setCategory] = useState<GalleryCategory>("work");

  if (share.mode === "owner") {
    return <p data-share-gallery-owner className="t-meta p-text-3">Not in the Gallery: it runs on your access. Switch it to their own access to list it.</p>;
  }

  const listed = share.gallery;

  // On asks for its line first; off takes a listed share off the Gallery, or drops the draft.
  const turn = (next: boolean) => {
    setDrafting(next);

    if (!next && listed !== null) onList(null);
  };

  return (
    <div className="space-y-2" data-share-gallery-for={share.id}>
      <div className="flex min-h-8 items-center gap-3">
        <span className="t-meta min-w-0 flex-1 p-text-2">{listed === null ? "List in the Gallery" : <>In the Gallery: {listed.line} · {CATEGORY_WORDS[listed.category]}</>}</span>
        <Switch on={listed !== null || drafting} label="List in the Gallery" data-share-gallery onChange={turn} disabled={disabled} />
      </div>
      {listed === null && drafting && (
        <form className="space-y-2" onSubmit={(event) => {
          event.preventDefault();

          if (line.trim() === "") return;
          onList({ line: line.trim(), category });
          setDrafting(false);
        }}>
          <TextInput size="sm" value={line} onChange={(event) => setLine(event.target.value)} placeholder="One line about it" aria-label="One line about it"
            data-share-gallery-line maxLength={140} />
          <Segmented size="sm" label="Category" value={category} onChange={setCategory} disabled={disabled}
            segments={GALLERY_CATEGORIES.map((each) => ({ id: each, label: CATEGORY_WORDS[each] }))} />
          <div className="flex justify-end"><Button size="sm" variant="secondary" type="submit" data-share-gallery-list disabled={disabled}>List it</Button></div>
        </form>
      )}
    </div>
  );
}
