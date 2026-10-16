/**
 * The one place Kinu makes a sound or shows a browser notification (owner, 2026-10-15): when a workspace's turn finishes,
 * or something new waits on the owner, while they are away from Kinu (`ownerAlertOf`, `ownerIsAway`). Read off the
 * roster's socket, so every workspace counts, the open one among them. The sound is this device's to turn off; a
 * notification shows once the browser allows them, which the owner grants from Settings → Appearance.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { Effect } from "effect";
import { detach } from "@kinu.run/core/obs";
import { ownerAlertOf, ownerIsAway, workspaceDisplayTitle, type OwnerAlert, type RosterEntry } from "@kinu.run/core";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";

const SOUND_KEY = "alert-sound";

const soundListeners = new Set<() => void>();

/** Whether this device plays the alert's sound: on unless the owner turned it off here. */
export function useAlertSound(): boolean {
  return useSyncExternalStore(
    (listener) => {
      soundListeners.add(listener);

      return () => { soundListeners.delete(listener); };
    },
    () => localStorage.getItem(SOUND_KEY) !== "off",
    () => true,
  );
}

export function setAlertSound(on: boolean): void {
  if (on) localStorage.removeItem(SOUND_KEY);
  else localStorage.setItem(SOUND_KEY, "off");

  for (const listener of soundListeners) listener();
}

let audio: AudioContext | null = null;

/** Two soft notes, a fifth apart, under half a second. The browser lets a page that was once clicked play it. */
function chime(): Effect.Effect<void> {
  audio ??= new AudioContext();
  const context = audio;

  for (const [at, frequency] of [[0, 660], [0.12, 990]] as const) {
    const tone = context.createOscillator();
    const level = context.createGain();
    const start = context.currentTime + at;

    tone.type = "sine";
    tone.frequency.value = frequency;
    level.gain.setValueAtTime(0, start);
    level.gain.linearRampToValueAtTime(0.06, start + 0.02);
    level.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
    tone.connect(level).connect(context.destination);
    tone.start(start);
    tone.stop(start + 0.34);
  }

  return context.state === "suspended" ? Effect.promise(() => context.resume()) : Effect.void;
}

const SAYS: Record<OwnerAlert, string> = { finished: "Finished", "needs-you": "Waiting on you" };

/** Mounted once, in the app's shell. */
function useOwnerAlerts(): void {
  const { subscribe, entries, accountProposals } = useWorkspaceRoster();
  const navigate = useNavigate();
  const sound = useAlertSound();
  const soundOn = useRef(sound);
  const listed = useRef(entries);
  // Each workspace's tile as the last frame left it; a workspace not here yet is read from the loaded roster.
  const seen = useRef(new Map<string, RosterEntry>());
  const proposals = useRef<ReadonlySet<string> | null>(null);

  soundOn.current = sound;
  listed.current = entries;

  const notify = useCallback((title: string, body: string, opens: string) => {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const shown = new Notification(title, { body, tag: `kinu:${opens}`, icon: "/assets/kinu-icon.svg" });

    shown.addEventListener("click", () => {
      window.focus();
      shown.close();
      detach(Effect.promise(async () => navigate(opens)));
    });
  }, [navigate]);

  const alert = useCallback((title: string, body: string, opens: string) => {
    if (!ownerIsAway({ visibility: document.visibilityState, focused: document.hasFocus() })) return;
    notify(title, body, opens);

    if (!soundOn.current) return;
    detach(chime());
  }, [notify]);

  useEffect(() => subscribe((frame) => {
    const before = seen.current.get(frame.name) ?? listed.current.find((entry) => entry.name === frame.name) ?? null;
    const said = ownerAlertOf(before, frame.entry);

    if (frame.entry === null) seen.current.delete(frame.name);
    else seen.current.set(frame.name, frame.entry);

    if (said !== null && frame.entry !== null) alert(workspaceDisplayTitle(frame.entry), SAYS[said], `/workspace/${encodeURIComponent(frame.name)}`);
  }), [subscribe, alert]);

  // An account memory a workspace proposes waits on the owner too: each one new since the first read.
  useEffect(() => {
    if (accountProposals === null) return;
    const ids = new Set(accountProposals.map((proposal) => proposal.id));
    const before = proposals.current;

    proposals.current = ids;

    if (before !== null && [...ids].some((id) => !before.has(id))) alert("Kinu", "A memory waits for your OK", "/user/settings#memory");
  }, [accountProposals, alert]);
}

/** Renders nothing: the shell's place for {@link useOwnerAlerts}. */
export function OwnerAlerts(): null {
  useOwnerAlerts();

  return null;
}
