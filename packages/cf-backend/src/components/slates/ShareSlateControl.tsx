import { useState } from "react";
import { ShareNetworkIcon } from "@phosphor-icons/react";
import type { SlateSummary } from "@kinu.run/core";
import { ShareSlateDialog } from "./ShareSlateDialog";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";
import { IconControl } from "@/components/ui/IconControl";

export function ShareSlateControl({ workspace, slate, rpc }: { workspace: string; slate: SlateSummary; rpc: WorkspaceRpc }) {
  const [sharing, setSharing] = useState(false);

  return (
    <>
      <IconControl place="tab" onClick={() => setSharing(true)} data-slate-share title={`Share ${slate.title}`} aria-label={`Share ${slate.title}`}>
        <ShareNetworkIcon size={12} />
      </IconControl>
      {sharing && (
        <ShareSlateDialog workspace={workspace} slate={slate.id} title={slate.title} rpc={rpc} onClose={() => setSharing(false)} />
      )}
    </>
  );
}
