/** Owns only the open state, so the dialog and the rasteriser's chunk are built after a click. */
import { useState } from "react";
import { MegaphoneIcon } from "@phosphor-icons/react";
import { FeedbackModal } from "./FeedbackModal";
import { Button } from "@/components/ui/Button";
import { Pressable } from "@/components/ui/Pressable";

export function FeedbackButton({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {compact
        ? <Button variant="ghost" icon={<MegaphoneIcon size={17} />} onClick={() => setOpen(true)} aria-label="Send feedback" data-feedback-open className="size-9" />
        : (
          <Pressable onClick={() => setOpen(true)} aria-label="Send feedback" data-feedback-open className="t-body flex items-center gap-2 px-2 py-1">
            <MegaphoneIcon size={14} /><span>Feedback</span>
          </Pressable>
        )}
      {open && <FeedbackModal onClose={() => setOpen(false)} />}
    </>
  );
}
