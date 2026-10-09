import { useState } from "react";
import { ShareNetworkIcon } from "@phosphor-icons/react";
import type { Rpc, SlateSummary } from "@kinu.run/core";
import { ShareSlateDialog } from "./ShareSlateDialog";

export function ShareSlateControl({ workspace, slate, rpc }: { workspace: string; slate: SlateSummary; rpc: Rpc }) {
  const [sharing, setSharing] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setSharing(true)}
        data-slate-share
        title={`Share ${slate.title}`}
        aria-label={`Share ${slate.title}`}
        className="p-bar-action"
      >
        <ShareNetworkIcon size={12} />
      </button>
      {sharing && (
        <ShareSlateDialog workspace={workspace} slate={slate.id} title={slate.title} rpc={rpc} onClose={() => setSharing(false)} />
      )}
    </>
  );
}
