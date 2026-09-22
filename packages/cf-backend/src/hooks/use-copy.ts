/** writeText rejects on denied permission, insecure origin, or an unfocused document; feedback waits for the outcome. */
import { useCallback, useEffect, useRef, useState } from "react";

export type CopyStatus = "idle" | "copied" | "failed";

export interface CopyControl {
  status: CopyStatus;
  copy: (text: string) => void;
}

export function useCopy(resetMs = 1500): CopyControl {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback((text: string) => {
    clearTimeout(timer.current);
    navigator.clipboard.writeText(text).then(
      () => setStatus("copied"),
      () => setStatus("failed"),
    ).finally(() => {
      timer.current = setTimeout(() => setStatus("idle"), resetMs);
    });
  }, [resetMs]);

  return { status, copy };
}

export function copyLabel(status: CopyStatus, idle = "Copy"): string {
  if (status === "copied") return "Copied";

  if (status === "failed") return "Could not copy";

  return idle;
}
