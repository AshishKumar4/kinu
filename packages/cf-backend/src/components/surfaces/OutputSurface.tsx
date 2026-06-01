/**
 * Output surface — what the agent PRODUCED, made first-class: the live app
 * preview (exposePort), promoted out of the buried Executors sub-card. The
 * cumulative workspace change-set (code/doc/data diff) and other artifact
 * viewers are layered in by the Output/Artifacts phase.
 */
import { useState } from "react";
import { MonitorIcon, ArrowSquareOutIcon } from "@phosphor-icons/react";
import { EmptyState, EMPTY_HINTS } from "./shared";

export interface PinnedPort { port: number; url: string; name?: string }

export function OutputSurface({ pinnedPorts }: { pinnedPorts: PinnedPort[] }) {
  const [active, setActive] = useState(0);
  if (pinnedPorts.length === 0) {
    return <EmptyState icon={<MonitorIcon size={28} />} title="No live output yet" hint={EMPTY_HINTS.preview} />;
  }
  const idx = Math.min(active, pinnedPorts.length - 1);
  const port = pinnedPorts[idx]!;
  return (
    <div className="flex flex-col h-full -m-5">
      {pinnedPorts.length > 1 && (
        <div className="flex items-center gap-1 px-2 pt-2 border-b p-border">
          {pinnedPorts.map((p, i) => (
            <button key={p.port} onClick={() => setActive(i)}
              className={`px-2.5 py-1 text-[11px] rounded-t-md border-b -mb-px transition-colors ${
                i === idx ? "p-tab-active border-b-[1.5px]" : "p-text-3 border-transparent hover:p-text-2"
              }`}>
              {p.name ?? `:${p.port}`}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b p-border text-xs shrink-0">
        <span className="text-emerald-400 text-[10px]">● live</span>
        <span className="font-mono p-text-2">{port.name ?? `port ${port.port}`}</span>
        <a href={port.url} target="_blank" rel="noopener noreferrer" className="ml-auto p-accent hover:opacity-80 flex items-center gap-1" title="Open in new tab">
          <span className="text-[10px]">open</span><ArrowSquareOutIcon size={11} />
        </a>
      </div>
      <iframe src={port.url} title={`preview-${port.port}`} className="flex-1 w-full bg-white" />
    </div>
  );
}
