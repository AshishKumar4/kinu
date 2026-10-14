/** A name edited in place: one save at a time, a refusal kept for the field to show, and `done` once it lands. */
import { useCallback, useRef, useState } from "react";
import { Effect } from "effect";
import { detach, showing } from "@kinu.run/core/obs";

export function useRename(value: string, save: (name: string) => Promise<void>, done: () => void) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref, not the state: a blur in the same tick as Enter must see the save already started.
  const inFlight = useRef(false);

  /** Saves the draft, trimmed; an empty or unchanged one is no rename, and leaves the editor as a cancel does. */
  const commit = useCallback((draftName: string): void => {
    const name = draftName.trim();

    if (inFlight.current) return;

    if (name === "" || name === value) {
      done();

      return;
    }

    inFlight.current = true;
    setSaving(true);
    setError(null);
    detach(Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      yield* Effect.promise(async () => save(name));
      done();
    }), showing(setError)), Effect.sync(() => {
      inFlight.current = false;
      setSaving(false);
    })));
  }, [value, save, done]);

  return { draft, setDraft, saving, error, commit };
}
