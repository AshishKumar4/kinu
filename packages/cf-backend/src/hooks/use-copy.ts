/** writeText rejects on denied permission, insecure origin, or an unfocused document; feedback waits for the outcome. */
import { useCallback, useEffect, useRef, useState } from "react";
import { detach } from "@kinu.run/core/obs";
import { Effect } from "effect";

export type CopyStatus = "idle" | "copied" | "failed";

interface CopyControl {
  status: CopyStatus;
  copy: (text: string) => void;
}

const RESET_MS = 1500;

export function useCopy(): CopyControl {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback((text: string) => {
    clearTimeout(timer.current);
    // A refused write (no permission, no focus) says so on the control, as a landed one does.
    detach(Effect.ensuring(Effect.match(Effect.tryPromise({ try: () => navigator.clipboard.writeText(text), catch: () => "refused" }), {
      onSuccess: () => setStatus("copied"),
      onFailure: () => setStatus("failed"),
    }), Effect.sync(() => {
      timer.current = setTimeout(() => setStatus("idle"), RESET_MS);
    })));
  }, []);

  return { status, copy };
}

export function copyLabel(status: CopyStatus): string {
  if (status === "copied") return "Copied";

  if (status === "failed") return "Could not copy";

  return "Copy";
}
