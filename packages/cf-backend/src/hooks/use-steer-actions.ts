/**
 * Send and Stop for every chat column. The queued line is derived from `steerRuns`, never stored:
 * a stored status is never cleared once the server lands the message.
 */
import { startTransition, useCallback, useMemo, useState } from "react";
import type { FileUIPart } from "ai";
import { readFailureText } from "@kinu.run/core";
import type { ComposerNotice } from "@/components/Composer";
import type { InlineSteer, WorkMode } from "@kinu.run/core";
import { Cause, Effect } from "effect";
import { KinuError, settle } from "@kinu.run/core/obs";
import type { SendAdmission } from "@/hooks/use-chat-owner";

/** One notice id for every line, so a new status replaces the old instead of stacking. */
const NOTICE_ID = "steer";

export interface SteerActionsDeps {
  /** The actor decides atomically in its turn queue whether a mid-turn message splices or runs next, so this hook never
   *  re-sends. `mode` is the chat's own unless a send names another. */
  sendChat: (text: string, files: readonly FileUIPart[], mode?: WorkMode) => SendAdmission;
  abortChat: () => Promise<void>;
  draft: string;
  setDraft: (update: (current: string) => string) => void;
  attachments?: { readonly parts: readonly FileUIPart[]; readonly clear: () => void };
  steerRuns: readonly InlineSteer[];
}

interface SteerActions {
  notice: ComposerNotice | null;
  send: () => void;
  /** Words sent as the draft's are, such as a new chat's opening; in `mode` where one is named (`/plan <text>`). */
  sendWords: (text: string, files: readonly FileUIPart[], mode?: WorkMode) => boolean;
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

  /** Sends `text`, and puts it back in the draft if no turn read it; false when the press was not taken. */
  const sendWords = useCallback((text: string, files: readonly FileUIPart[], mode?: WorkMode): boolean => {
    // `sendChat` owns admission.
    const landing = sendChat(text, files, mode);

    if (landing === null) return false;
    setSettled(null);
    startTransition(() => settle(Effect.catchCause(Effect.asVoid(Effect.promise(() => landing)), (failed) => Effect.sync(() => {
      const cause = Cause.squash(failed);
      // Unread words return to the draft, appended to anything typed since; a stop is not a failure.
      setDraft((current) => current === "" ? text : `${current}\n\n${text}`);
      setSettled(cause instanceof KinuError && cause.code === "cancelled"
        ? { id: NOTICE_ID, tone: "info", text: "Stopped before the agent read this, so it is back here." }
        : { id: NOTICE_ID, tone: "danger", text: `Could not send to the turn: ${readFailureText({ cause })}` });
    }))));

    return true;
  }, [setDraft, sendChat]);

  const send = useCallback(() => {
    const text = draft.trim();
    const files = attachments?.parts ?? [];

    if (!text && files.length === 0) return;

    // The draft clears only for a press that was taken.
    if (!sendWords(text, files)) return;
    setDraft(() => "");
    attachments?.clear();
  }, [draft, setDraft, attachments, sendWords]);

  const stop = useCallback(() => {
    setSettled(null);
    startTransition(() => settle(Effect.catchCause(Effect.promise(() => abortChat()), (failed) => Effect.sync(() => {
      setSettled({
        id: NOTICE_ID, tone: "danger",
        text: `Could not stop the turn: ${readFailureText({ cause: Cause.squash(failed) })}`,
      });
    }))));
  }, [abortChat]);

  return { notice, send, sendWords, stop };
}
