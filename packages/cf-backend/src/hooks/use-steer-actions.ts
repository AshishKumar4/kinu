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
 */
import { useCallback, useMemo, useState } from "react";
import { describeError } from "@/hooks/use-async-resource";
import type { ComposerNotice } from "@/components/Composer";
import type { SteerRun } from "@/hooks/use-proteus";

/** The notice id both actions write, so one replaces the other rather than
 *  stacking two contradictory statuses over the same draft. */
const NOTICE_ID = "steer";

export interface SteerActionsDeps {
  /** `useProteus().steerChat` — resolves with where the text landed. */
  steerChat: (text: string) => Promise<"mid-turn" | "idle">;
  /** `useProteus().abortChat` — resolves with the steers the abort dropped. */
  abortChat: () => Promise<string[]>;
  /** `useProteus().sendChat`, for the `idle` race where nothing was buffered. */
  sendChat: (text: string) => void;
  draft: string;
  setDraft: (update: (current: string) => string) => void;
  /** Whether the draft carries attachments a steer cannot take. */
  hasAttachments?: boolean;
  /** `useProteus().steerRuns` — the steers the server has taken. */
  steerRuns: readonly SteerRun[];
  /** Ids of the messages the chat is already rendering durably. */
  messageIds: readonly string[];
}

export interface SteerActions {
  /** The composer's status row while steering — null when there is nothing to
   *  say, which is most of the time. */
  notice: ComposerNotice | null;
  /** Hand the draft to the running turn. */
  steer: () => void;
  /** Abandon the turn and take back whatever the agent never saw. */
  stop: () => void;
  /**
   * Steers to render in the thread right now: the ones whose durable user row
   * has not arrived yet. The row carries the SAME id, so once it lands the live
   * bubble drops out and the thread shows the steer once, in the position the
   * model saw it — never both.
   */
  liveSteers: readonly SteerRun[];
}

export function useSteerActions(deps: SteerActionsDeps): SteerActions {
  const [notice, setNotice] = useState<ComposerNotice | null>(null);
  const { steerChat, abortChat, sendChat, draft, setDraft, hasAttachments, steerRuns, messageIds } = deps;

  const liveSteers = useMemo(() => {
    const durable = new Set(messageIds);
    return steerRuns.filter((steer) => !durable.has(steer.steerId));
  }, [steerRuns, messageIds]);

  const steer = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    // Cleared optimistically: the thread renders the steer from the server's own
    // broadcast the moment it is taken, so the text is visibly somewhere.
    setDraft(() => "");
    setNotice(null);
    steerChat(text).then(
      (landed) => {
        if (landed === "idle") {
          // The turn ended between the keystroke and the RPC and NOTHING was
          // buffered server-side, so this text is still ours to send. Exactly
          // one of the two paths ever runs it.
          sendChat(text);
          setNotice({
            id: NOTICE_ID, tone: "info",
            text: "That turn had already finished, so this went as a new message.",
          });
          return;
        }
        setNotice({
          id: NOTICE_ID, tone: "progress",
          text: hasAttachments
            ? "Queued — it lands at the agent's next step. Attachments stay here: a steer carries text only."
            : "Queued — it lands at the agent's next step.",
        });
      },
      (err) => {
        // Nothing was accepted, so the draft is still the user's — give it back
        // rather than reporting a failure over an empty composer.
        setDraft((current) => current === "" ? text : current);
        setNotice({
          id: NOTICE_ID, tone: "danger",
          text: `Couldn't steer the turn: ${describeError(err)}`,
        });
      },
    );
  }, [draft, hasAttachments, sendChat, setDraft, steerChat]);

  const stop = useCallback(() => {
    setNotice(null);
    void abortChat().then((returned) => {
      if (returned.length === 0) return;
      setDraft((current) => current.trim() === "" ? returned.join("\n\n") : current);
      setNotice({
        id: NOTICE_ID, tone: "warning",
        text: "Stopped. What you had queued is back in the composer — the agent never saw it.",
      });
    });
  }, [abortChat, setDraft]);

  return { notice, steer, stop, liveSteers };
}
