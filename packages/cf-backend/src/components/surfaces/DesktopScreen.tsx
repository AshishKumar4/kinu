/**
 * The computer's desktop: KasmVNC's own client (D70) in a frame this screen keeps open. Every restart of the computer
 * (a resize, D50; a rest and wake) ends the desktop's session, and the client, left to itself, shows its own splash
 * from then on: it reconnects once at most, and gives up when that try meets the computer still starting (staging
 * 2026-10-13, a 503). So the client posts its connection state here, and a session that ends is opened again with a
 * fresh client. Until a session is up, Kinu's own state covers the frame.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import * as v from "valibot";
import { KinuMark } from "@/components/ui/KinuLogo";
import { Surface } from "@/components/ui/Surface";

const ConnectionStateSchema = v.object({ action: v.literal("connection_state"), value: v.string() });

/** The client's notice that it is leaving an idle session: that end lets the computer rest, so nothing reopens it. */
const IdleTimeoutSchema = v.object({ action: v.literal("idle_session_timeout") });

/** A resize's restart took 2-8 s on staging (2026-10-13). A computer whose start was refused (D52) answers every
 *  attach with the refusal its size control shows, so each unanswered try waits twice as long, up to 32 s. */
const REOPEN_MS = 2_000;

const REOPEN_DOUBLINGS = 4;

type Phase = "opening" | "connected" | "reconnecting" | "idle";

const SAYS: Record<Exclude<Phase, "connected">, { readonly title: string; readonly detail: string }> = {
  opening: { title: "Opening the desktop", detail: "Starting its session on the computer." },
  reconnecting: { title: "Reconnecting", detail: "The computer restarted. Its desktop comes back as soon as it answers." },
  idle: { title: "The desktop closed", detail: "It was idle, so the computer could rest." },
};

export function DesktopScreen({ src, title }: { src: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [opened, setOpened] = useState(0);
  // Sessions that ended without a new one answering since.
  const [unanswered, setUnanswered] = useState(0);
  const [phase, setPhase] = useState<Phase>("opening");

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow) return;

      if (v.is(IdleTimeoutSchema, event.data)) {
        setPhase("idle");

        return;
      }

      const state = v.safeParse(ConnectionStateSchema, event.data);

      if (!state.success) return;

      if (state.output.value === "connected") {
        setPhase("connected");
        setUnanswered(0);
      }

      if (state.output.value !== "disconnected") return;
      setPhase((was) => (was === "connected" ? "reconnecting" : was));
      setUnanswered((count) => count + 1);
    };

    window.addEventListener("message", onMessage);

    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (unanswered === 0 || phase === "idle") return;
    const timer = setTimeout(() => setOpened((count) => count + 1), REOPEN_MS * 2 ** Math.min(unanswered - 1, REOPEN_DOUBLINGS));

    return () => clearTimeout(timer);
  }, [unanswered, phase]);

  return (
    <Surface look="screen" data-desktop-frame className="relative h-full overflow-hidden">
      <iframe key={opened} ref={frame} data-desktop title={title} src={src} className="block h-full w-full border-0" />
      {phase !== "connected" && (
        <div role="status" className="p-desktop-veil absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <KinuMark size={34} className={phase === "idle" ? undefined : "p-dot-pulse"} />
          <div className="space-y-1">
            <p className="t-title p-text">{SAYS[phase].title}</p>
            <p className="t-meta p-text-3">{SAYS[phase].detail}</p>
          </div>
          {phase === "idle" && (
            <Button size="sm" className="mt-1" onClick={() => { setPhase("opening"); setUnanswered(0); setOpened((count) => count + 1); }}>
              Open it again
            </Button>
          )}
        </div>
      )}
    </Surface>
  );
}
