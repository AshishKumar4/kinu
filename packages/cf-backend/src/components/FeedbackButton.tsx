/** Owns only the open state, so the dialog and the rasteriser's chunk are built after a click. */
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
          : "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left p-t-control p-text-2 p-card-hover hover:p-text"}
      >
        <MegaphoneIcon size={compact ? 17 : 15} />
        {compact ? null : <span>Feedback</span>}
      </button>
      {open && <FeedbackModal onClose={() => setOpen(false)} />}
    </>
  );
}
