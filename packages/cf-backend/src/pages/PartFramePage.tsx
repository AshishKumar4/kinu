/**
 * `/s/:workspace/:slate/parts/:part`: one part of a shared slate, in the app's own frame inside the slate's page. It
 * reads and calls the room only through the live page at the top of its window (lib/room-bridge.ts); opened any other
 * way it shows nothing of the room.
 */
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Effect } from "effect";
import { Loader } from "@cloudflare/kumo";
import { detach } from "@kinu.run/core/obs";
import type { RoomCall, RoomView } from "@kinu.run/core";
import { PartFrameView, PartOutsideItsSlate } from "@/components/sharing/Parts";
import { connectRoomBridge, type RoomBridge } from "@/lib/room-bridge";

export function PartFrame({ part }: { part: string }) {
  const [view, setView] = useState<RoomView | null>(null);
  const [bridge, setBridge] = useState<RoomBridge | null>(null);
  const [outside, setOutside] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const stop = connectRoomBridge(setView, setBridge);

    if (stop === null) setOutside(true);

    return () => { stop?.(); };
  }, []);

  // This session opens the part once its live page answers; the room's next view carries it.
  useEffect(() => {
    if (bridge === null) return;

    detach(Effect.map(Effect.promise(() => bridge.call({ op: "open", part })), (refused) => { if (refused !== null) setFailure(refused); }));
  }, [bridge, part]);

  if (outside) return <PartOutsideItsSlate />;

  const shown = view?.parts[part];

  if (bridge === null || view === null || shown === undefined) return <div className="flex justify-center py-6"><Loader size="sm" /></div>;

  const send = (sent: RoomCall) => {
    setFailure(null);
    detach(Effect.map(Effect.promise(() => bridge.call(sent)), (refused) => { if (refused !== null) setFailure(refused); }));
  };

  const act = {
    ask: () => send({ op: "ask", part }),
    check: () => send({ op: "check", part }),
    unshow: () => send({ op: "unshow", part }),
    decideShow: () => bridge.decide({ kind: "show", part }),
    decideAllow: () => bridge.decide({ kind: "allow", part }),
    signIn: bridge.signIn,
    connect: bridge.connect,
  };

  return (
    <div data-part-frame={shown.state} className="flex h-dvh flex-col p-text">
      <PartFrameView part={shown} signedIn={view.session.me !== null} act={act} />
      {failure !== null && <p role="alert" className="mt-1.5 p-meta p-danger">{failure}</p>}
    </div>
  );
}

/**
 * A part's frame sits inside the slate's own page: it shows that page through it, not the app's background, and takes
 * `?scheme=light|dark` when the slate's page says which suits it.
 */
export function useSlateScheme(scheme: string | null): void {
  useEffect(() => {
    const root = document.documentElement;

    root.style.background = "transparent";
    document.body.style.background = "transparent";

    if (scheme !== "light" && scheme !== "dark") return;

    root.setAttribute("data-mode", scheme);
    root.style.colorScheme = scheme;
  }, [scheme]);
}

export default function PartFramePage() {
  const { part = "" } = useParams();
  const [search] = useSearchParams();

  useSlateScheme(search.get("scheme"));

  return <PartFrame part={part} />;
}
