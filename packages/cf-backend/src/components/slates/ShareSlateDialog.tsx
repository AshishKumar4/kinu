/** Live: people use the running slate, as its owner. Blueprint: a copy to fork, which calls its forker's own surface. */
import { useState } from "react";
import { ShareNetworkIcon } from "@phosphor-icons/react";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { BlueprintShareForm, type BlueprintFixture } from "./BlueprintShareForm";
import { LiveShareForm, type LiveShareFixture } from "./LiveShareForm";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";

type ShareMode = "live" | "blueprint";

interface ShareSlateDialogProps {
  workspace: string;
  slate: string;
  title: string;
  rpc: WorkspaceRpc;
  onClose: () => void;
  onListingPending?: () => void;
  fixture?: { mode?: ShareMode; live?: LiveShareFixture; blueprint?: BlueprintFixture };
}

const MODES = [{ id: "live", label: "Live" }, { id: "blueprint", label: "Blueprint" }] as const;

export function ShareSlateDialog({ workspace, slate, title, rpc, onClose, onListingPending, fixture }: ShareSlateDialogProps) {
  const [mode, setMode] = useState<ShareMode>(fixture?.mode ?? "live");
  const [busy, setBusy] = useState(false);

  return (
    <Modal title={`Share ${title}`} icon={<ShareNetworkIcon size={18} className="p-accent" />} onClose={onClose} busy={busy} maxWidthClass="max-w-[520px]">
      <div className="w-fit">
        <Segmented label="How to share" value={mode} segments={MODES} onChange={(next) => { if (!busy) setMode(next); }} />
      </div>
      {mode === "live"
        ? <LiveShareForm workspace={workspace} slate={slate} rpc={rpc} onClose={onClose} onBusy={setBusy} onListingPending={onListingPending} fixture={fixture?.live} />
        : <BlueprintShareForm workspace={workspace} slate={slate} rpc={rpc} onClose={onClose} onBusy={setBusy} onListingPending={onListingPending} fixture={fixture?.blueprint} />}
    </Modal>
  );
}
