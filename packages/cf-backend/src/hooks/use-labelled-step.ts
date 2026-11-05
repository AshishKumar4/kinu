/**
 * The app's one way to run a step behind a control: one at a time, `busy` naming the step running so only its control
 * says so; a failure is kept, in words, until the next step; `done` runs after a step that succeeded. A step is a promise
 * or an effect, whose value is not read; it fails by rejecting or by failing its effect, and `Effect.fail("words")` is a
 * refusal said as it stands.
 */
import { useCallback, useRef, useState } from "react";
import { Effect } from "effect";
import { detach, showing } from "@kinu.run/core/obs";

export interface LabelledStep<Label extends string = string> {
  readonly busy: Label | null;
  readonly error: string | null;
  /** Runs `step` unless one is running; `label` is what `busy` says meanwhile. */
  readonly run: <A, E>(label: Label, step: () => PromiseLike<A> | Effect.Effect<A, E>) => void;
  /** Drops a kept failure: the reader changed what it was about. */
  readonly clear: () => void;
}

const NOTHING_AFTER = (): void => undefined;

export function useLabelledStep<Label extends string = string>(done: () => void = NOTHING_AFTER): LabelledStep<Label> {
  const [busy, setBusy] = useState<Label | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A ref, not the state: a second press in the same tick must see the first already started.
  const running = useRef(false);

  const run = useCallback(<A, E>(label: Label, step: () => PromiseLike<A> | Effect.Effect<A, E>) => {
    if (running.current) return;
    running.current = true;
    setBusy(label);
    setError(null);

    detach(Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      const work = step();
      const effect: Effect.Effect<A, E> = Effect.isEffect(work) ? work : Effect.promise(async () => work);

      yield* effect;
      done();
    }), showing(setError)), Effect.sync(() => {
      running.current = false;
      setBusy(null);
    })));
  }, [done]);

  const clear = useCallback(() => setError(null), []);

  return { busy, error, run, clear };
}
