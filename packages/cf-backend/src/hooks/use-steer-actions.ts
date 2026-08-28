/**
 * The composer's two mid-turn actions, for every chat surface: Steer and Stop.
 *
 * Both chat columns (the workspace conversation and a subordinate's) mount the
 * same `Composer`, and both need the same three answers a user is owed after
 * typing to a working agent — "queued for the next step", "that turn had ended
 * so this went as a new message", "stopped, and here is your text back". This
 * hook owns those, so neither column can drift into a different account of what
 * happened.
 *
 * A steer carries TEXT only. Attachments stay in the composer for the next real
 * send rather than being silently dropped into a splice that cannot hold them.
 *
 * ── Why "queued" is not stored ───────────────────────────────────────────────
 * It was, and it never went away: the line was written into state by the press
 * and cleared by nothing, so a composer said "it lands at the agent's next
 * step" for the rest of the session, over a steer the model had already read
 * and answered. A status about a live server state has to be READ from that
 * state. `steerRuns` is the server's own account of where each steer is, so the
 * line exists exactly while a steer is queued in it and disappears on the
 * `landed` broadcast, with nothing to forget to clear.
 *
 * What IS stored is the other three: each is a one-shot statement about an
 * action the user just took, true at the moment it was made and about nothing
 * the server will later contradict.
 */
import { useCallback, useMemo, useState } from "react";
import { describeError } from "@/hooks/use-async-resource";
import type { ComposerNotice } from "@/components/Composer";
import type { InlineSteer } from "@kinu.run/core";

/** The notice id every line here writes, so one replaces the other rather than
 *  stacking two contradictory statuses over the same draft. */
const NOTICE_ID = "steer";

export interface SteerActionsDeps {
  /** `useKinu().steerChat` — resolves with where the text landed: spliced into
   *  the running turn, or — the turn had already ended — queued by the actor as
   *  the next ordinary turn. The actor decides atomically in its own turn
   *  queue, so nothing is ever left with this hook to re-send. */
  steerChat: (text: string) => Promise<"mid-turn" | "queued">;
  /** `useKinu().abortChat` — resolves with the steers the abort dropped. */
  abortChat: () => Promise<string[]>;
  draft: string;
  setDraft: (update: (current: string) => string) => void;
  /** Whether the draft carries attachments a steer cannot take. */
  hasAttachments?: boolean;
  /** `useKinu().steerRuns` — the steers the server has taken. */
  steerRuns: readonly InlineSteer[];
}

export interface SteerActions {
  /** The composer's status row while steering — null when there is nothing to
   *  say, which is most of the time. */
  notice: ComposerNotice | null;
  /** Hand the draft to the running turn. */
  steer: () => void;
  /** Abandon the turn and take back whatever the agent never saw. */
  stop: () => void;
}

/**
 * The line the composer shows about steers the server is still holding.
 *
 * Derived, never stored. Null the moment the last queued steer lands, which is
 * the entire fix: the model has the words, so a row still promising to deliver
 * them is describing a state that has passed.
 */
function queuedSteerNotice(
  steerRuns: readonly InlineSteer[], hasAttachments: boolean,
): ComposerNotice | null {
  if (!steerRuns.some((steer) => steer.state === "queued")) return null;
  return {
    id: NOTICE_ID, tone: "progress",
    text: hasAttachments
      ? "Queued — it lands at the agent's next step. Attachments stay here: a steer carries text only."
      : "Queued — it lands at the agent's next step.",
  };
}

export function useSteerActions(deps: SteerActionsDeps): SteerActions {
  // Only the one-shot lines. The queued line is read from `steerRuns` below.
  const [settled, setSettled] = useState<ComposerNotice | null>(null);
  const { steerChat, abortChat, draft, setDraft, hasAttachments, steerRuns } = deps;

  const notice = useMemo(
    () => settled ?? queuedSteerNotice(steerRuns, hasAttachments === true),
    [settled, steerRuns, hasAttachments]);

  const steer = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    // Cleared optimistically: the thread renders the steer from the server's own
    // broadcast the moment it is taken, so the text is visibly somewhere.
    setDraft(() => "");
    setSettled(null);
    steerChat(text).then(
      (landed) => {
        if (landed === "queued") {
          // The turn ended before this arrived, so the ACTOR queued it as the
          // next ordinary turn — atomically, in its own turn queue, so another
          // turn starting first cannot push these words to a later slot.
          setSettled({
            id: NOTICE_ID, tone: "info",
            text: "That turn had already finished, so this went as a new message.",
          });
        }
        // Otherwise say nothing here: the server's `queued` broadcast is what
        // the line is read from, and it is the same fact for every open tab.
      },
      (err) => {
        // Nothing was accepted, so the draft is still the user's — give it back
        // rather than reporting a failure over an empty composer.
        setDraft((current) => current === "" ? text : current);
        setSettled({
          id: NOTICE_ID, tone: "danger",
          text: `Couldn't steer the turn: ${describeError(err)}`,
        });
      },
    );
  }, [draft, setDraft, steerChat]);

  const stop = useCallback(() => {
    setSettled(null);
    void abortChat().then((returned) => {
      if (returned.length === 0) return;
      setDraft((current) => current.trim() === "" ? returned.join("\n\n") : current);
      setSettled({
        id: NOTICE_ID, tone: "warning",
        text: "Stopped. What you had queued is back in the composer — the agent never saw it.",
      });
    });
  }, [abortChat, setDraft]);

  return { notice, steer, stop };
}
