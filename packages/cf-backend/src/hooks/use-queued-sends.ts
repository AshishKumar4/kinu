/**
 * `/queue`: words held in this tab while the chat's turn runs and sent once it ends, as the CLI's queue holds them (core
 * `reduceInput`, one machine for both). A Stop hands what was held back to the draft; nothing held is sent behind it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { initialInputState, reduceInput, type InputMachineEvent } from "@kinu.run/core";
import type { ComposerNotice } from "@/components/Composer";

export interface QueuedSends {
  /** Holds `words` while a turn runs; with none, sends them now. True when they were taken either way. */
  readonly queue: (words: string) => boolean;
  /** The Stop: what was held returns to the draft after what is typed there. */
  readonly stopped: () => void;
  /** What is held, said above the composer: none or one. */
  readonly notices: readonly ComposerNotice[];
}

export function useQueuedSends({ live, send, draft, setDraft }: {
  readonly live: boolean;
  /** Sends words as the draft's are; false when the chat did not take them. */
  readonly send: (words: string) => boolean;
  readonly draft: string;
  readonly setDraft: (draft: string) => void;
}): QueuedSends {
  const machine = useRef(initialInputState);
  const [held, setHeld] = useState<readonly string[]>([]);
  const latest = useRef({ send, draft, setDraft });

  latest.current = { send, draft, setDraft };

  /** Runs `event`. Held words the chat refuses once released return to the draft, after what is typed there. */
  const dispatch = useCallback((event: InputMachineEvent): void => {
    const { state, effects } = reduceInput(machine.current, event);

    machine.current = state;
    setHeld(state.queue);

    for (const effect of effects) {
      if (effect.kind === "send-queued" && !latest.current.send(effect.text)) {
        const typed = latest.current.draft;

        latest.current.setDraft(typed === "" ? effect.text : `${typed}\n\n${effect.text}`);
      }

      if (effect.kind === "set-input") latest.current.setDraft(effect.text);
    }
  }, []);

  // The turn's start and end, as the machine counts them: the end releases what was held.
  const running = useRef(false);

  useEffect(() => {
    if (live === running.current) return;
    running.current = live;
    dispatch({ type: live ? "turn-start" : "turn-settled" });
  }, [live, dispatch]);

  const queue = useCallback((words: string): boolean => {
    if (!running.current) return latest.current.send(words);
    dispatch({ type: "queue", text: words });

    return true;
  }, [dispatch]);

  const stopped = useCallback(() => { dispatch({ type: "interrupt", draft: latest.current.draft }); }, [dispatch]);

  const notices: readonly ComposerNotice[] = held.length === 0 ? [] : [{
    id: "queued", tone: "progress", text: "Queued. It sends when this turn ends.", ...held.length > 1 && { dim: `${String(held.length)} waiting` },
    action: { label: "Edit", onClick: stopped }, hooks: { "data-queued-sends": String(held.length) },
  }];

  return { queue, stopped, notices };
}
