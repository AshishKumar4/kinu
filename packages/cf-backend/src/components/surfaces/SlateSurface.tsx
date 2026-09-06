import { SparkleIcon } from "@phosphor-icons/react";
import type { SlateSummary } from "@kinu.run/core";
import type { Rpc } from "@/lib/protocol";
import { SlateFrame } from "@/components/slates/SlateFrame";

/** One agent-authored Slate inside the work surface's chrome. */
export function SlateSurface({ slate, rpc, reloadKey }: {
  slate: SlateSummary;
  rpc: Rpc;
  /** Bumped when the Slate changes, so its preview URL is re-read. */
  reloadKey?: number;
}) {
  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex items-center gap-2 flex-wrap">
        <SparkleIcon size={14} className="p-text-3" />
        <span className="p-eyebrow p-text-3">Written by Kinu</span>
        <span className="p-text-3 text-xs">·</span>
        <span className="text-sm font-medium p-text">{slate.title}</span>
        {slate.bindings.length > 0 && (
          <span className="text-[10px] p-text-3 p-num">{slate.bindings.join(" · ")}</span>
        )}
      </div>
      <SlateFrame id={slate.id} rpc={rpc} reloadKey={reloadKey} />
    </div>
  );
}
