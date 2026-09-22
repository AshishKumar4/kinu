/**
 * Send and Stop for every chat column. The queued line is derived from `steerRuns`, never stored:
 * a stored status is never cleared once the server lands the message.
 */
import { startTransition, useCallback, useMemo, useState } from "react";
import type { FileUIPart } from "ai";
import { describeError } from "@/hooks/use-async-resource";
import type { ComposerNotice } from "@/components/Composer";
import type { InlineSteer } from "@kinu.run/core";
import { KinuError } from "@kinu.run/core/obs";
import type { SendAdmission } from "@/hooks/use-kinu";

/** One notice id for every line, so a new status replaces the old instead of stacking. */
const NOTICE_ID = "steer";

export interface SteerActionsDeps {
  /** The actor decides atomically in its turn queue whether a mid-turn message splices or runs next, so this hook never re-sends. */
  sendChat: (text: string, files: readonly FileUIPart[]) => SendAdmission;
  abortChat: () => Promise<void>;
  draft: string;
  setDraft: (update: (current: string) => string) => void;
  attachments?: { readonly parts: readonly FileUIPart[]; readonly clear: () => void };
  steerRuns: readonly InlineSteer[];
}

export interface SteerActions {
  notice: ComposerNotice | null;
  send: () => void;
  stop: () => void;
}

function queuedSteerNotice(steerRuns: readonly InlineSteer[]): ComposerNotice | null {
  if (!steerRuns.some((steer) => steer.state === "queued")) return null;

  return { id: NOTICE_ID, tone: "progress", text: "Queued. The agent reads it at its next step." };
}

export function useSteerActions(deps: SteerActionsDeps): SteerActions {
  const [settled, setSettled] = useState<ComposerNotice | null>(null);
  const { sendChat, abortChat, draft, setDraft, attachments, steerRuns } = deps;

  const notice = useMemo(() => settled ?? queuedSteerNotice(steerRuns), [settled, steerRuns]);

  const send = useCallback(() => {
    const text = draft.trim();
    const files = attachments?.parts ?? [];

    if (!text && files.length === 0) return;
    // `sendChat` owns admission; the draft clears only for a press that was taken.
    const admission = sendChat(text, files);

    if (admission === null) return;
    setDraft(() => "");
    attachments?.clear();
    setSettled(null);

    if (admission.landed === "turn") return;
    startTransition(async () => {
      try {
        if (await admission.settled === "turn") {
          // The turn had ended, so the actor ran this as the next turn, atomically in its own queue.
          setSettled({
            id: NOTICE_ID, tone: "info",
            text: "That turn had already finished, so this went as a new message.",
          });
        }
        // The queued line is read from the server's `queued` broadcast, the same for every open tab.
      } catch (cause) {
        // Unread words return to the draft, appended to anything typed since; a stop is not a failure.
        setDraft((current) => current === "" ? text : `${current}\n\n${text}`);
        setSettled(cause instanceof KinuError && cause.code === "cancelled"
          ? { id: NOTICE_ID, tone: "info", text: "Stopped before the agent read this, so it is back here." }
          : { id: NOTICE_ID, tone: "danger", text: `Could not send to the turn: ${describeError({ cause })}` });
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
          text: `Could not stop the turn: ${describeError({ cause })}`,
        });
      }
    });
  }, [abortChat]);

  return { notice, send, stop };
}
