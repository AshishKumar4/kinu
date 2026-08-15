/**
 * The one copy-to-clipboard affordance.
 *
 * navigator.clipboard.writeText rejects on a denied permission, an insecure
 * origin, or a document that isn't focused — and every hand-rolled copy button
 * here either flipped to "Copied!" before finding out or gave no feedback at
 * all. One of them copies a secret that is shown exactly once, where a
 * silently-empty clipboard is unrecoverable. This owns the three outcomes.
 */
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

/** The label a copy button shows for each outcome. */
export function copyLabel(status: CopyStatus, idle = "Copy"): string {
  return status === "copied" ? "Copied!" : status === "failed" ? "Copy failed" : idle;
}
