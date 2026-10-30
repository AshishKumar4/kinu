import { useEffect, useRef } from "react";
import { useMatch } from "react-router-dom";
import { Effect } from "effect";
import { detach, diagnostics, toKinuError } from "@kinu.run/core/obs";
import { APP_ROUTES } from "@kinu.run/core";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { wakeWorkspace } from "@/lib/user-api";

/** When each workspace was last woken from this page. */
const woken = new Map<string, number>();

/** Opens up to 5 min apart found main's isolate still loaded (production, 2026-10-28), so a wake a minute old still
 *  holds when the click comes. */
const WAKE_HOLDS_MS = 60_000;

/** How long a pointer or the focus rests on a row before its workspace wakes: one crossing the list wakes none. */
const REST_MS = 100;

/** Readies `name`'s object and main's isolate, once a minute at most. A failure only loses the head start: the open
 *  reaches the workspace itself and answers for it. */
function wake(name: string): Effect.Effect<void> {
  return Effect.suspend(() => {
    const now = Date.now();

    if (now - (woken.get(name) ?? 0) < WAKE_HOLDS_MS) return Effect.void;
    woken.set(name, now);

    return Effect.catchCause(wakeWorkspace(name), (cause) => Effect.sync(() => {
      woken.delete(name);
      diagnostics.failure("workspace.wake_ahead_failed", toKinuError({ doing: "waking a workspace ahead of its open", cause, otherwise: "unavailable" }), { workspace: name });
    }));
  });
}

/** The row the pointer or the focus rests on now: one at a time. */
let resting: number | undefined;

/** A workspace link's handlers: a pointer or the focus resting on it wakes the workspace before the click. */
export function wakeAheadOf(name: string) {
  const rest = () => { window.clearTimeout(resting); resting = window.setTimeout(() => detach(wake(name)), REST_MS); };

  const leave = () => { window.clearTimeout(resting); };

  return { onPointerEnter: rest, onPointerLeave: leave, onFocus: rest, onBlur: leave };
}

/** As the app shell loads: wakes the workspace opened last (the roster's first), unless the page is opening it. */
export function WakeLastOpened() {
  const { entries } = useWorkspaceRoster();
  const opening = useMatch({ path: APP_ROUTES.workspace, end: false })?.params.agentId;
  const last = entries.find((entry) => entry.home !== true)?.name;
  const done = useRef(false);

  useEffect(() => {
    if (done.current || last === undefined) return;

    done.current = true;

    if (last === opening) return;

    detach(wake(last));
  }, [last, opening]);

  return null;
}
