/**
 * The share affordance an open slate's tab carries: a strip button that opens
 * the one ShareSlateDialog the workspace owns. Absent when no slate is open or
 * the fixture has no workspace to publish from.
 */
import { useState } from "react";
import { ShareNetworkIcon } from "@phosphor-icons/react";
import type { Rpc, SlateSummary } from "@kinu.run/core";
import { tabCls } from "@/components/ui/form";
import { ShareSlateDialog } from "./ShareSlateDialog";

export function ShareSlateControl({ workspace, slate, rpc }: { workspace: string | undefined; slate: SlateSummary | undefined; rpc: Rpc }) {
  const [sharing, setSharing] = useState(false);

  if (slate === undefined || workspace === undefined) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setSharing(true)}
        data-slate-share
        title={`Share ${slate.title}`}
        aria-label={`Share ${slate.title}`}
        className={`${tabCls} px-2.5`}
      >
        <ShareNetworkIcon size={14} />
      </button>
      {sharing && (
        <ShareSlateDialog workspace={workspace} slate={slate.id} title={slate.title} rpc={rpc} onClose={() => setSharing(false)} />
      )}
    </>
  );
}
