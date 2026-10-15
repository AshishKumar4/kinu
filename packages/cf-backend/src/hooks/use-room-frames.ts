/**
 * Serves the part frames of a slate a page embeds (lib/room-bridge.ts): the page that shows the slate holds its room's
 * socket and answers its parts. Answers what a frame asks with the room; hands a decision a frame asks for to the page,
 * which opens it where the slate's code cannot cover it.
 */
import { useEffect, useRef, useState } from "react";
import { Effect } from "effect";
import type { RoomCall, RoomView } from "@kinu.run/core";
import { renderThrownChain, settle, type KinuError } from "@kinu.run/core/obs";
import { hostRoomFrames, type RoomDecision, type RoomFrames } from "@/lib/room-bridge";

/** Back to this page after signing in, or after connecting a service. */
const returnHere = () => window.location.pathname + window.location.search;

/** `back`: where to land once signed in, this page by default. */
export function signInAndReturn(back = returnHere()): void {
  const login = new URL("/login", window.location.origin);

  login.searchParams.set("return_to", back);
  window.location.assign(login.toString());
}

/** Where a person connects a service of their own, and comes back from. */
function connectAndReturn(): void {
  window.location.assign(`/user/settings/mcp?return_to=${encodeURIComponent(returnHere())}`);
}

/** The decision a part frame asked for, open until the page answers or dismisses it. */
export function useRoomFrames({ view, call, opened = null }: {
  view: RoomView | null;
  call: (call: RoomCall) => Effect.Effect<void, KinuError>;
  /** A decision open from the start: a gallery frame's. */
  opened?: RoomDecision | null;
}) {
  const [deciding, setDeciding] = useState<RoomDecision | null>(opened);
  const latest = useRef(view);
  const frames = useRef<RoomFrames | null>(null);

  latest.current = view;

  useEffect(() => {
    const hosted = hostRoomFrames({
      view: () => latest.current,
      call: (sent) => settle(Effect.match(call(sent), {
        onSuccess: () => null,
        onFailure: (refused) => renderThrownChain({ cause: refused }),
      })),
      decide: setDeciding,
      signIn: signInAndReturn,
      connect: connectAndReturn,
    });

    frames.current = hosted;

    return () => {
      hosted.stop();
      frames.current = null;
    };
  }, [call]);

  useEffect(() => { frames.current?.publish(view); }, [view]);

  return { deciding, done: () => setDeciding(null) };
}
