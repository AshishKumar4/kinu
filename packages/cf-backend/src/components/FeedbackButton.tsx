/**
 * The Feedback affordance in the authenticated app's navigation.
 *
 * It owns the open state and nothing else, so the dialog — and through it the
 * rasteriser's own chunk — is only ever constructed after a click. `compact`
 * is the icon-only form the mobile header's action row uses; the rail gets the
 * labelled form, because a rail has room for a word and an unlabelled megaphone
 * does not say what it does.
 */
import { useState } from "react";
import { MegaphoneIcon } from "@phosphor-icons/react";
import { FeedbackModal } from "./FeedbackModal";

export function FeedbackButton({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Send feedback"
        data-feedback-open
        className={compact
          ? "flex size-9 items-center justify-center rounded-md p-text-2 p-card-hover hover:p-text"
          : "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] p-text-2 p-card-hover hover:p-text"}
      >
        <MegaphoneIcon size={compact ? 17 : 15} />
        {compact ? null : <span>Feedback</span>}
      </button>
      {open && <FeedbackModal onClose={() => setOpen(false)} />}
    </>
  );
}
