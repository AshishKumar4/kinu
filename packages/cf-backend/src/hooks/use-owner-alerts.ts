/**
 * The one place Kinu makes a sound or shows a browser notification (owner, 2026-10-15): when a workspace's turn finishes,
 * or something new waits on the owner, while they are away from Kinu (`ownerAlertOf`, `ownerIsAway`). Read off the
 * roster's socket, so every workspace counts, the open one among them. The sound is this device's to turn off; a
 * notification shows once the browser allows them, which the owner grants from Settings → Appearance.
 *
 * Away is away from Kinu, not from one tab. A browser's tabs tell each other whether they are looked at over a
 * BroadcastChannel, and one of them, the holder of a Web Lock the next tab takes when it closes, alerts for the browser.
 * Each page also tells the account's roster socket, which counts the pages looked at on every device: while the owner
 * reads Kinu on their phone, the laptop stays quiet. Away from all of them, each device alerts once.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as v from "valibot";
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

/** Whether the owner is looking at this page: shown, and its window focused. */
function useLooking(): boolean {
  const read = () => document.visibilityState === "visible" && document.hasFocus();
  const [looking, setLooking] = useState(read);

  useEffect(() => {
    const stop = new AbortController();
    const follow = () => setLooking(read());

    document.addEventListener("visibilitychange", follow, { signal: stop.signal });
    window.addEventListener("focus", follow, { signal: stop.signal });
    window.addEventListener("blur", follow, { signal: stop.signal });

    return () => stop.abort();
  }, []);

  return looking;
}

const TABS = "kinu-owner-alerts";

/** What a tab tells the browser's other tabs: whether it is looked at, as it changes and when a new tab asks. */
const TabSaysSchema = v.variant("kind", [
  v.object({ kind: v.literal("looking"), tab: v.string(), looking: v.boolean() }),
  v.object({ kind: v.literal("asking"), tab: v.string() }),
]);

/**
 * This browser's other tabs of Kinu and whether each is looked at; and whether this tab alerts for them all. Each tab
 * holds a lock named for it while it lives, so another tab hears it close when it is granted that lock; the leader's lock
 * passes to a waiting tab the same way.
 */
function useBrowserTabs(looking: boolean) {
  const [leader, setLeader] = useState(false);
  const others = useRef(new Map<string, boolean>());
  const tell = useRef<((looking: boolean) => void) | null>(null);
  const said = useRef(looking);

  said.current = looking;

  useEffect(() => {
    const tab = crypto.randomUUID();
    const stop = new AbortController();
    // Held until the tab's page leaves.
    const held = () => new Promise<void>((release) => stop.signal.addEventListener("abort", () => release(), { once: true }));

    // A lock asked for and never granted is given up as the page leaves: that refusal is the leaving; any other is a defect.
    const left = (asked: Promise<void>) => Effect.orDie(Effect.catchIf(Effect.tryPromise({ try: () => asked, catch: (cause) => cause }),
      (cause) => cause instanceof DOMException && cause.name === "AbortError", () => Effect.void));

    // Granted only once that tab has closed: then it no longer counts.
    const gone = (other: string) => left(navigator.locks.request(`${TABS}:${other}`, { signal: stop.signal }, () => { others.current.delete(other); }));
    let channel: BroadcastChannel | null = null;

    // Told once the lock is the tab's own, so no other tab can take it for this tab's close before it is held.
    const owned = navigator.locks.request(`${TABS}:${tab}`, { signal: stop.signal }, () => {
      const opened = new BroadcastChannel(TABS);
      const say = (now: boolean) => opened.postMessage({ kind: "looking", tab, looking: now });

      channel = opened;
      tell.current = say;
      opened.addEventListener("message", (event: MessageEvent) => {
        const heard = v.safeParse(TabSaysSchema, event.data);

        if (!heard.success || heard.output.tab === tab) return;

        if (heard.output.kind === "asking") {
          say(said.current);

          return;
        }

        const other = heard.output.tab;
        const first = !others.current.has(other);

        others.current.set(other, heard.output.looking);
        detach(first ? gone(other) : Effect.void);
      });
      opened.postMessage({ kind: "asking", tab });
      say(said.current);

      return held();
    });

    const led = navigator.locks.request(TABS, { signal: stop.signal }, () => {
      setLeader(true);

      return held();
    });

    detach(Effect.all([left(owned), left(led)], { discard: true }));

    return () => {
      stop.abort();
      channel?.close();
      tell.current = null;
    };
  }, []);

  useEffect(() => { tell.current?.(looking); }, [looking]);

  const othersLooking = useCallback(() => [...others.current.values()].filter(Boolean).length, []);

  return { leader, others: othersLooking };
}

const SAYS: Record<OwnerAlert, string> = { finished: "Finished", "needs-you": "Waiting on you" };

/** A turn that ended with work still owed, as a failed one does: it stopped, and says so. */
const saysOf = (alert: OwnerAlert, tile: RosterEntry) => (alert === "finished" && tile.overview?.activity === "unfinished" ? "Stopped before it finished" : SAYS[alert]);

/** Mounted once, in the app's shell. */
function useOwnerAlerts(): void {
  const { subscribe, entries, accountProposals, accountLooking, reportForeground } = useWorkspaceRoster();
  const navigate = useNavigate();
  const sound = useAlertSound();
  const soundOn = useRef(sound);
  const listed = useRef(entries);
  const looking = useLooking();
  const tabs = useBrowserTabs(looking);
  // Read when a frame lands: what the browser's tabs and the account's pages last said.
  const away = useRef<() => boolean>(() => false);
  // Each workspace's tile as the last frame left it; a workspace not here yet is read from the loaded roster.
  const seen = useRef(new Map<string, RosterEntry>());
  const proposals = useRef<ReadonlySet<string> | null>(null);

  soundOn.current = sound;
  listed.current = entries;
  away.current = () => tabs.leader && ownerIsAway({ here: looking, otherTabs: tabs.others(), account: accountLooking });

  useEffect(() => { reportForeground(looking); }, [looking, reportForeground]);

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
    if (!away.current()) return;
    notify(title, body, opens);

    if (!soundOn.current) return;
    detach(chime());
  }, [notify]);

  useEffect(() => subscribe((frame) => {
    const before = seen.current.get(frame.name) ?? listed.current.find((entry) => entry.name === frame.name) ?? null;
    const said = ownerAlertOf(before, frame.entry);

    if (frame.entry === null) seen.current.delete(frame.name);
    else seen.current.set(frame.name, frame.entry);

    if (said !== null && frame.entry !== null) alert(workspaceDisplayTitle(frame.entry), saysOf(said, frame.entry), `/workspace/${encodeURIComponent(frame.name)}`);
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
