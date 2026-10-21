/**
 * One read of the deploy door, as the page shows it while it is asked, once it is answered, or once it is refused; read
 * again when what it asks changes, after `rest` of no change, on coming back to the page, and every `every` while set.
 */
import { useEffect, useRef, useState } from "react";
import { Effect } from "effect";
import { detach } from "@kinu.run/core/obs";
import type { DeployHeard, DeployRefused } from "@/lib/deploy-page-api";

export type Reading<A> =
  | { readonly state: "reading" }
  | { readonly state: "read"; readonly answer: A }
  | { readonly state: "refused"; readonly refusal: DeployRefused };

export interface ReadAgain {
  /** How long what is asked must rest before it is read: typing, not each key. */
  readonly rest?: number;
  /** Read again when the person comes back to the page (from a hand-off to Cloudflare). */
  readonly onFocus?: boolean;
  /** Read again this often, while set. */
  readonly every?: number | null;
}

/**
 * `key` names what is read (its account, its query): a new name is a new read, shown as reading until it answers; the
 * same name read again (a focus, an interval) keeps what it showed until the new answer. Null reads nothing.
 */
export function useDeployRead<A>(key: string | null, read: () => Promise<DeployHeard<A>>, { rest = 0, onFocus = false, every = null }: ReadAgain = {}): Reading<A> | null {
  const [held, setHeld] = useState<{ readonly key: string; readonly reading: Reading<A> } | null>(null);
  // The read as this render made it: the one the timers run, never one an earlier render captured.
  const latest = useRef(read);

  latest.current = read;

  useEffect(() => {
    if (key === null) return undefined;

    let current = true;
    // Reads overlap (a focus while an interval's read is out): only the last one asked may answer.
    let asked = 0;

    const ask = () => detach(Effect.promise(async () => {
      asked += 1;

      const mine = asked;
      const heard = await latest.current();

      if (current && mine === asked) setHeld({ key, reading: "answer" in heard ? { state: "read", answer: heard.answer } : { state: "refused", refusal: heard.refusal } });
    }));

    const first = setTimeout(ask, rest);
    const again = every === null ? undefined : setInterval(ask, every);

    if (onFocus) window.addEventListener("focus", ask);

    return () => {
      current = false;
      clearTimeout(first);
      clearInterval(again);
      window.removeEventListener("focus", ask);
    };
  }, [key, rest, onFocus, every]);

  if (key === null) return null;

  return held?.key === key ? held.reading : { state: "reading" };
}
