/**
 * `/s/:workspace/:slate` (`?k=` the link's key): the live slate everyone it is shared with uses together. Its entry says
 * first whether this session may open it; then one socket to the slate's room, the slate's own page in a frame on its
 * own host, its parts in the app's own frames, which reach the room through this page, and every decision opened here,
 * where the slate's code cannot cover it.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Effect } from "effect";
import { Loader } from "@cloudflare/kumo";
import type { RoomCall, RoomEntry, RoomPerson, WorkspaceEntry } from "@kinu.run/core";
import { detach, renderThrownChain, showing } from "@kinu.run/core/obs";
import { ForkDialog, type RoomSlate } from "@/components/shared/ForkDialog";
import { HolderAsks, RoomDecisionDialogs } from "@/components/sharing/Decisions";
import { Ended, LiveBar } from "@/components/sharing/LiveChrome";
import { ShareSheet } from "@/components/sharing/ShareSheet";
import { FilledButton } from "@/components/ui/FilledButton";
import { KinuLogo } from "@/components/ui/KinuLogo";
import { useRoom, type RoomLive } from "@/hooks/use-room";
import { signInAndReturn, useRoomFrames } from "@/hooks/use-room-frames";
import type { RoomDecision } from "@/lib/room-bridge";
import { readRoomEntry, type RoomClosed } from "@/lib/room-client";
import { registerWorkspace } from "@/lib/user-api";

/** An email to the slate's owner: once a session ended, the room has no one to ask through. */
const emailTo = (owner: RoomPerson) => { window.location.href = `mailto:${owner.email}`; };

/** A page the live slate shows instead of itself: its word, and one way on. */
export function Closed({ said, detail, action }: { said: string; detail?: string; action: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col p-bg p-text">
      <header className="flex h-12 items-center border-b p-border px-4"><a href="/" aria-label="Kinu home"><KinuLogo /></a></header>
      <main className="mx-auto flex max-w-sm flex-1 flex-col items-center justify-center gap-3 px-6 pb-24 text-center">
        <p className="p-heading text-[17px] p-text">{said}</p>
        {detail !== undefined && <p className="p-row-text p-text-3">{detail}</p>}
        <div className="pt-1">{action}</div>
      </main>
    </div>
  );
}

export const CLOSED: Record<Exclude<RoomClosed, "sign-in">, { said: string; detail?: string }> = {
  "not-shared": { said: "This slate isn't shared with you", detail: "Ask whoever sent it to add you, or sign in with the account they added." },
  missing: { said: "There's no slate here", detail: "Its link may have changed." },
  stopped: { said: "This link was stopped" },
};

/** What a live page opens with: a gallery frame's sheet, picker or decision. */
export interface LiveOpened {
  readonly sheet?: boolean;
  readonly pick?: "fork" | "edit";
  readonly decide?: RoomDecision;
}

export function LiveSlate({ room, entry, linkKey, live, opened = {}, workspaces }: {
  room: RoomSlate;
  entry: RoomEntry;
  linkKey: string | null;
  live?: RoomLive;
  opened?: LiveOpened;
  /** A fixture roster for the fork and edit picker; absent, it reads the account's own. */
  workspaces?: readonly WorkspaceEntry[];
}) {
  const { view, call } = useRoom({ workspace: room.workspace, slate: room.slate, linkKey, live });
  const { deciding, done } = useRoomFrames({ view, call, opened: opened.decide ?? null });
  const [sharing, setSharing] = useState(opened.sheet ?? false);
  const [picking, setPicking] = useState<"fork" | "edit" | null>(opened.pick ?? null);
  const [failure, setFailure] = useState<string | null>(null);

  // A call this page makes itself: its refusal shows here.
  const send = useCallback((sent: RoomCall) => {
    setFailure(null);
    detach(call(sent).pipe(Effect.catch((refused) => Effect.sync(() => setFailure(renderThrownChain({ cause: refused }))))));
  }, [call]);

  if (view === null) return <div data-live-loading className="flex h-screen items-center justify-center p-bg"><Loader size="base" /></div>;

  const { session } = view;
  const owner = session.access === "owner";

  return (
    <div className="flex h-screen w-screen flex-col p-bg p-text">
      <LiveBar session={session} presence={view.presence} onShare={view.sheet === null ? null : () => setSharing(true)}
        onEdit={() => (owner ? window.location.assign(`/workspace/${encodeURIComponent(room.workspace)}?slate=${encodeURIComponent(room.slate)}`) : setPicking("edit"))}
        onFork={() => setPicking("fork")} />
      <main className="relative min-h-0 flex-1">
        <iframe src={session.frame} title={session.title} data-live-frame className="block size-full border-0" />
        {view.ended !== null && <Ended ended={view.ended} slate={session.title} onAsk={() => { if (view.ended !== null) emailTo(view.ended.by); }} />}
      </main>
      {view.ended === null && <HolderAsks asks={view.asks} slate={session.title} onAnswer={send} />}
      {failure !== null && (
        <div role="alert" className="fixed inset-x-3 top-14 z-40 mx-auto max-w-md p-notice-danger rounded-md px-3 py-2 text-xs sm:inset-x-auto sm:right-5">{failure}</div>
      )}
      {view.ended === null && <RoomDecisionDialogs view={view} deciding={deciding} send={send} onDone={done} />}
      {sharing && view.sheet !== null && (
        <ShareSheet title={session.title} owner={session.owner} sheet={view.sheet} call={call} onClose={() => setSharing(false)}
          onFixSecret={(secret) => window.location.assign(`/workspace/${encodeURIComponent(room.workspace)}?fix=${encodeURIComponent(`${secret.file}:${String(secret.line)}`)}`)} />
      )}
      {picking !== null && (
        <ForkDialog room={room} title={entry.title} mode={picking} onClose={() => setPicking(null)} workspaces={workspaces}
          create={async (mission) => registerWorkspace(undefined, mission.trim())} />
      )}
    </div>
  );
}

export default function LiveSlatePage() {
  const { workspace = "", slate = "" } = useParams();
  const [search] = useSearchParams();
  const linkKey = search.get("k");
  const [entry, setEntry] = useState<RoomEntry | RoomClosed | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;

    detach(Effect.catchCause(
      Effect.map(Effect.promise(() => readRoomEntry(workspace, slate, linkKey)), (answer) => { if (live) setEntry("open" in answer ? answer.open : answer.closed); }),
      showing((chain) => { if (live) setFailure(chain); }),
    ));

    return () => { live = false; };
  }, [workspace, slate, linkKey]);

  if (failure !== null) return <Closed said="This slate didn't open" detail={failure} action={<FilledButton onClick={() => window.location.reload()}>Try again</FilledButton>} />;

  if (entry === null) return <div data-live-loading className="flex h-screen items-center justify-center p-bg"><Loader size="base" /></div>;

  if (entry === "sign-in") {
    signInAndReturn();

    return null;
  }

  if (typeof entry === "string") {
    const closed = CLOSED[entry];

    return <Closed {...closed} action={<FilledButton onClick={() => window.location.assign("/")}>Go to Kinu</FilledButton>} />;
  }

  return <LiveSlate room={{ workspace, slate }} entry={entry} linkKey={linkKey} />;
}
