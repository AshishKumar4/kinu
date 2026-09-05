/**
 * The gadget tab — one gadget Kinu published, in the work surface's chrome.
 *
 * The header names the gadget and the bindings its manifest declares, beside
 * the "Written by Kinu" mark every agent-authored tab carries, so a reader
 * sees the gadget's reach where its name is. The frame below is the client's
 * sandboxed document; a `reloadKey` bump remounts it after the gadget's
 * files changed.
 */

import { SparkleIcon } from "@phosphor-icons/react";
import type { GadgetSummary } from "@kinu.run/core";
import type { Rpc } from "@/lib/protocol";
import { GadgetFrame } from "@/components/gadgets/GadgetFrame";

export function GadgetSurface({ gadget, rpc, reloadKey }: {
  gadget: GadgetSummary;
  rpc: Rpc;
  /** Bumped when this gadget's files change — remounts the frame. */
  reloadKey?: number;
}) {
  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex items-center gap-2 flex-wrap">
        <SparkleIcon size={14} className="p-text-3" />
        <span className="p-eyebrow p-text-3">Written by Kinu</span>
        <span className="p-text-3 text-xs">·</span>
        <span className="text-sm font-medium p-text">{gadget.title}</span>
        {gadget.bindings.length > 0 && (
          <span className="text-[10px] p-text-3 p-num">{gadget.bindings.join(" · ")}</span>
        )}
      </div>
      {gadget.subtitle && <p className="text-xs p-text-3 -mt-2">{gadget.subtitle}</p>}
      <GadgetFrame slug={gadget.slug} rpc={rpc} reloadKey={reloadKey} />
    </div>
  );
}
