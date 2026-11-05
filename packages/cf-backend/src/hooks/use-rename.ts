/** A name edited in place: one save at a time, a refusal kept for the field to show, and `done` once it lands. */
import { useState } from "react";
import { useLabelledStep } from "@/hooks/use-labelled-step";

export function useRename(value: string, save: (name: string) => Promise<void>, done: () => void) {
  const [draft, setDraft] = useState(value);
  const { busy, error, run } = useLabelledStep(done);

  /** Saves the draft, trimmed; an empty or unchanged one is no rename, and leaves the editor as a cancel does. A blur in
   *  the same tick as Enter finds the save already started. */
  const commit = (draftName: string): void => {
    const name = draftName.trim();

    if (busy !== null) return;

    if (name === "" || name === value) {
      done();

      return;
    }

    run("rename", () => save(name));
  };

  return { draft, setDraft, saving: busy !== null, error, commit };
}
