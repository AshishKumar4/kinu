/**
 * Live, the way to share: people use the running slate. A copy to fork (a blueprint), which calls its forker's own
 * surface, is the secondary way, one link away at the foot.
 */
import { useState } from "react";
import { ShareNetworkIcon } from "@phosphor-icons/react";
import { Modal } from "@/components/ui/Modal";
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

export function ShareSlateDialog({ workspace, slate, title, rpc, onClose, onListingPending, fixture }: ShareSlateDialogProps) {
  const [mode, setMode] = useState<ShareMode>(fixture?.mode ?? "live");
  const [busy, setBusy] = useState(false);

  return (
    <Modal title={`Share ${title}`} icon={<ShareNetworkIcon size={18} className="p-accent" />} onClose={onClose} busy={busy} maxWidthClass="max-w-[520px]">
      {mode === "live"
        ? <LiveShareForm workspace={workspace} slate={slate} rpc={rpc} onClose={onClose} onBusy={setBusy} onListingPending={onListingPending} fixture={fixture?.live} />
        : <BlueprintShareForm workspace={workspace} slate={slate} rpc={rpc} onClose={onClose} onBusy={setBusy} onListingPending={onListingPending} fixture={fixture?.blueprint} />}
      <button type="button" data-share-switch={mode === "live" ? "blueprint" : "live"} disabled={busy} onClick={() => setMode(mode === "live" ? "blueprint" : "live")}
        className="self-start p-meta p-text-3 underline-offset-2 hover:underline">
        {mode === "live" ? "Share a copy instead" : "Share it live instead"}
      </button>
    </Modal>
  );
}
