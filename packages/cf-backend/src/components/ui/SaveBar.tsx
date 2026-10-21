/**
 * Unsaved changes, on every form that saves as a whole (design review 2026-10-20, D2): a bar floating at its column's
 * foot while there is something to save, with Discard and Save; "Saved" alone for a moment after, then gone. In and
 * out over 220 ms.
 */
import { useEffect, useRef, useState } from "react";
import { CheckIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/Button";

/** How long "Saved" stays before the bar leaves, and how long it takes to leave. */
const SAVED_MS = 1500;

const LEAVE_MS = 220;

export function SaveBar({ dirty, saving, error = null, onSave, onDiscard }: {
  dirty: boolean;
  saving: boolean;
  /** A save or a read that failed, in its own words, in place of the label. */
  error?: string | null;
  onSave: () => void;
  /** Absent where the form cannot put its edits back. */
  onDiscard?: () => void;
}) {
  // Each save that lands counts once, so "Saved" stays its full time after every one, not only the first.
  const [saves, setSaves] = useState(0);
  const [saved, setSaved] = useState(false);
  const wasSaving = useRef(saving);

  useEffect(() => {
    if (wasSaving.current && !saving && !dirty && error === null) setSaves((count) => count + 1);
    wasSaving.current = saving;
  }, [saving, dirty, error]);

  useEffect(() => {
    if (saves === 0) return;
    setSaved(true);

    const timer = setTimeout(() => setSaved(false), SAVED_MS);

    return () => clearTimeout(timer);
  }, [saves]);

  const shown = dirty || saving || saved || error !== null;
  // Kept through its way out, so it leaves rather than vanishes.
  const [present, setPresent] = useState(shown);

  useEffect(() => {
    if (shown) {
      setPresent(true);

      return;
    }

    const timer = setTimeout(() => setPresent(false), LEAVE_MS);

    return () => clearTimeout(timer);
  }, [shown]);

  if (!shown && !present) return null;

  let said = <span className="t-item p-text-2">Unsaved changes</span>;

  if (error !== null) said = <p role="alert" className="t-body min-w-0 truncate p-danger" title={error}>{error}</p>;
  else if (saved && !dirty) said = <span className="t-item flex items-center gap-1.5 p-text-2"><CheckIcon size={14} className="p-success" />Saved</span>;

  // Its buttons only while there is something to save: saved, there is nothing to discard or save, so it says so alone.
  const acting = dirty || saving || error !== null;

  return (
    <div className="p-save-bar" data-state={shown ? "open" : "closed"} data-save-bar>
      {said}
      {acting && (
        <div className="ml-auto flex shrink-0 gap-2">
          {onDiscard !== undefined && <Button variant="ghost" size="sm" disabled={saving} onClick={onDiscard}>Discard</Button>}
          <Button variant="primary" size="sm" busy={saving} onClick={onSave}>Save</Button>
        </div>
      )}
    </div>
  );
}
