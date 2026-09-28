/** writeText rejects on denied permission, insecure origin, or an unfocused document; feedback waits for the outcome. */
import { useCallback, useEffect, useRef, useState } from "react";

export type CopyStatus = "idle" | "copied" | "failed";

export interface CopyControl {
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
    navigator.clipboard.writeText(text).then(
      () => setStatus("copied"),
      () => setStatus("failed"),
    ).finally(() => {
      timer.current = setTimeout(() => setStatus("idle"), RESET_MS);
    });
  }, []);

  return { status, copy };
}

export function copyLabel(status: CopyStatus): string {
  if (status === "copied") return "Copied";

  if (status === "failed") return "Could not copy";

  return "Copy";
}
