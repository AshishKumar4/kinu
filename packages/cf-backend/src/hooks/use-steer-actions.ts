/**
 * The composer's two actions while a turn runs, for every chat surface: Send
 * and Stop.
 *
 * Both chat columns (the workspace conversation and a subordinate's) mount the
 * same `Composer`, and both need the same answers a user is owed after typing
 * to a working agent — "taken, it lands at the next step" and "that turn had
 * ended so this went as a new message". Stop aborts the turn while queued
 * messages stay queued and run as the next turn. This hook owns those, so
 * neither column can drift into a different account of what happened.
 *
 * A message carries its attachments with it, whatever the agent is doing: the
 * inbox splices them as file parts on the merged user message.
 *
 * ── Why "queued" is not stored ───────────────────────────────────────────────
 * It was, and it never went away: the line was written into state by the press
 * and cleared by nothing, so a composer said "it lands at the agent's next
 * step" for the rest of the session, over a message the model had already read
 * and answered. A status about a live server state has to be READ from that
 * state. `steerRuns` is the server's own account of where each message is, so
 * the line exists exactly while one is queued in it and disappears on the
 * `landed` broadcast, with nothing to forget to clear.
 *
 * What IS stored is the other two: each is a one-shot statement about an
 * action the user just took, true at the moment it was made and about nothing
 * the server will later contradict.
 */
import { startTransition, useCallback, useMemo, useState } from "react";
import type { FileUIPart } from "ai";
import { describeError } from "@/hooks/use-async-resource";
import type { ComposerNotice } from "@/components/Composer";
import type { InlineSteer } from "@kinu.run/core";
import type { SendAdmission } from "@/hooks/use-kinu";

/** The notice id every line here writes, so one replaces the other rather than
 *  stacking two contradictory statuses over the same draft. */
const NOTICE_ID = "steer";

export interface SteerActionsDeps {
  /** `useKinu().sendChat` — the one submit. Answers where the message went:
   *  a turn this pane started, or the running turn, whose `settled` promise
   *  says whether it was spliced there or — the turn had already ended — run
   *  by the actor as the next ordinary turn. The actor decides atomically in
   *  its own turn queue, so nothing is ever left with this hook to re-send. */
  sendChat: (text: string, files: readonly FileUIPart[]) => SendAdmission;
  /** `useKinu().abortChat` — aborts the running turn. Queued messages stay
   *  queued and run as the next turn. */
  abortChat: () => Promise<void>;
  draft: string;
  setDraft: (update: (current: string) => string) => void;
  /** The draft's attachments, sent with it and cleared once it is taken. */
  attachments?: { readonly parts: readonly FileUIPart[]; readonly clear: () => void };
  /** `useKinu().steerRuns` — the messages the server has taken mid-turn. */
  steerRuns: readonly InlineSteer[];
}

export interface SteerActions {
  /** The composer's status row while a message is waiting — null when there is
   *  nothing to say, which is most of the time. */
  notice: ComposerNotice | null;
  /** Send the draft, with its attachments, wherever the agent is. */
  send: () => void;
  /** Abort the running turn. Queued messages stay queued and run next. */
  stop: () => void;
}

/**
 * The line the composer shows about messages the server is still holding.
 *
 * Derived, never stored. Null the moment the last queued message lands, which
 * is the entire fix: the model has the words, so a row still promising to
 * deliver them is describing a state that has passed.
 */
function queuedSteerNotice(steerRuns: readonly InlineSteer[]): ComposerNotice | null {
  if (!steerRuns.some((steer) => steer.state === "queued")) return null;

  return { id: NOTICE_ID, tone: "progress", text: "Queued — it lands at the agent's next step." };
}

export function useSteerActions(deps: SteerActionsDeps): SteerActions {
  // Only the one-shot lines. The queued line is read from `steerRuns` below.
  const [settled, setSettled] = useState<ComposerNotice | null>(null);
  const { sendChat, abortChat, draft, setDraft, attachments, steerRuns } = deps;

  const notice = useMemo(() => settled ?? queuedSteerNotice(steerRuns), [settled, steerRuns]);

  const send = useCallback(() => {
    const text = draft.trim();
    const files = attachments?.parts ?? [];

    if (!text && files.length === 0) return;
    // `sendChat` owns admission — one synchronous latch inside `useKinu`. The
    // draft and its attachments are cleared only for a press that was taken;
    // the thread renders a mid-turn message from the server's own broadcast
    // the moment it is accepted, so the text is visibly somewhere.
    const admission = sendChat(text, files);

    if (admission === null) return;
    setDraft(() => "");
    attachments?.clear();
    setSettled(null);

    if (admission.landed === "turn") return;
    startTransition(async () => {
      try {
        if (await admission.settled === "turn") {
          // The turn ended before this arrived, so the ACTOR ran it as the
          // next ordinary turn — atomically, in its own turn queue, so another
          // turn starting first cannot push these words to a later slot.
          setSettled({
            id: NOTICE_ID, tone: "info",
            text: "That turn had already finished, so this went as a new message.",
          });
        }
        // Otherwise say nothing here: the server's `queued` broadcast is what
        // the line is read from, and it is the same fact for every open tab.
      } catch (cause) {
        // Nothing was accepted, so the draft is still the user's — give it back
        // rather than reporting a failure over an empty composer.
        setDraft((current) => current === "" ? text : current);
        setSettled({
          id: NOTICE_ID, tone: "danger",
          text: `Couldn't send to the turn: ${describeError(cause)}`,
        });
      }
    });
  }, [draft, setDraft, attachments, sendChat]);

  const stop = useCallback(() => {
    setSettled(null);
    startTransition(async () => {
      try {
        await abortChat();
      } catch (cause) {
        setSettled({
          id: NOTICE_ID, tone: "danger",
          text: `Couldn't stop the turn: ${describeError(cause)}`,
        });
      }
    });
  }, [abortChat]);

  return { notice, send, stop };
}
