import { Button } from "@/components/ui/Button";
import { useState } from "react";
import { StopIcon } from "@phosphor-icons/react";
import { Surface } from "@/components/ui/Surface";

/** Stop stays: control is not input. */
export function ViewOnlyBar({ running, onStop }: { running: boolean; onStop: () => void }) {
  const [stopping, setStopping] = useState(false);
  const [wasRunning, setWasRunning] = useState(running);

  if (running !== wasRunning) {
    setWasRunning(running);

    if (!running) setStopping(false);
  }

  return (
    <Surface look="chrome" className="border-t p-border flex min-h-12 items-center gap-2 px-4 py-2" data-view-only>
      <span className="t-meta flex-1 p-text-3">This agent takes no messages.</span>
      {running && (
        <Button disabled={stopping} onClick={() => { setStopping(true); onStop(); }}
          aria-label="Stop this agent" title="Stop this agent's work">
          <StopIcon size={14} weight="fill" />
          <span className="t-meta">{stopping ? "Stopping…" : "Stop"}</span>
        </Button>
      )}
    </Surface>
  );
}
