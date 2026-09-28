import { useEffect, useState } from "react";
import { StopIcon } from "@phosphor-icons/react";

/** Stop stays: control is not input. */
export function ViewOnlyBar({ running, onStop }: { running: boolean; onStop: () => void }) {
  const [stopping, setStopping] = useState(false);

  useEffect(() => { if (!running) setStopping(false); }, [running]);

  return (
    <div className="border-t p-border p-sidebar flex min-h-12 items-center gap-2 px-4 py-2" data-view-only>
      <span className="flex-1 p-meta p-text-3">This agent takes no messages.</span>
      {running && (
        <button type="button" onClick={() => { setStopping(true); onStop(); }}
          className="p-btn-quiet inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 px-2"
          aria-label="Stop this agent" title="Stop this agent's work">
          <StopIcon size={14} weight="fill" />
          <span className="p-meta">{stopping ? "Stopping…" : "Stop"}</span>
        </button>
      )}
    </div>
  );
}
