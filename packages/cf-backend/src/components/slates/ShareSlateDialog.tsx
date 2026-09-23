/** Live: people use the running slate, as its owner. Blueprint: a copy to fork, every binding unmapped. */
import { useState } from "react";
import { ShareNetworkIcon } from "@phosphor-icons/react";
import type { Rpc } from "@kinu.run/core";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { BlueprintShareForm, type BlueprintFixture } from "./BlueprintShareForm";
import { LiveShareForm, type LiveShareFixture } from "./LiveShareForm";

type ShareMode = "live" | "blueprint";

export interface ShareSlateDialogProps {
  workspace: string;
  slate: string;
  title: string;
  rpc: Rpc;
  onClose: () => void;
  fixture?: { mode?: ShareMode; live?: LiveShareFixture; blueprint?: BlueprintFixture };
}

const MODES = [{ id: "live", label: "Live" }, { id: "blueprint", label: "Blueprint" }] as const;

export function ShareSlateDialog({ workspace, slate, title, rpc, onClose, fixture }: ShareSlateDialogProps) {
  const [mode, setMode] = useState<ShareMode>(fixture?.mode ?? "live");
  const [busy, setBusy] = useState(false);

  return (
    <Modal title={`Share ${title}`} icon={<ShareNetworkIcon size={18} className="p-accent" />} onClose={onClose} busy={busy} maxWidthClass="max-w-[520px]">
      <div className="w-fit">
        <Segmented label="How to share" value={mode} segments={MODES} onChange={(next) => { if (!busy) setMode(next); }} />
      </div>
      {mode === "live"
        ? <LiveShareForm workspace={workspace} slate={slate} rpc={rpc} onClose={onClose} onBusy={setBusy} fixture={fixture?.live} />
        : <BlueprintShareForm workspace={workspace} slate={slate} rpc={rpc} onClose={onClose} onBusy={setBusy} fixture={fixture?.blueprint} />}
    </Modal>
  );
}
