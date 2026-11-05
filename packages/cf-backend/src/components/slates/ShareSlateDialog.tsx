/**
 * Live, the way to share: people use the running slate. A copy to fork (a blueprint), which calls its forker's own
 * surface, is the secondary way, one link away at the foot.
 */
import { useState } from "react";
import { ShareNetworkIcon } from "@phosphor-icons/react";
import { Modal } from "@/components/ui/Modal";
import { BlueprintShareForm } from "./BlueprintShareForm";
import { LiveShareForm } from "./LiveShareForm";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";
import { Button } from "@/components/ui/Button";

type ShareMode = "live" | "blueprint";

interface ShareSlateDialogProps {
  workspace: string;
  slate: string;
  title: string;
  rpc: WorkspaceRpc;
  onClose: () => void;
  onListingPending?: () => void;
  /** Where it opens: live unless asked for the copy. */
  opensOn?: ShareMode;
}

export function ShareSlateDialog({ workspace, slate, title, rpc, onClose, onListingPending, opensOn = "live" }: ShareSlateDialogProps) {
  const [mode, setMode] = useState<ShareMode>(opensOn);
  const [busy, setBusy] = useState(false);

  return (
    <Modal title={`Share ${title}`} icon={<ShareNetworkIcon size={18} className="p-accent-fg" />} onClose={onClose} busy={busy} width="md">
      {mode === "live"
        ? <LiveShareForm workspace={workspace} slate={slate} rpc={rpc} onClose={onClose} onBusy={setBusy} onListingPending={onListingPending} />
        : <BlueprintShareForm workspace={workspace} slate={slate} rpc={rpc} onClose={onClose} onBusy={setBusy} onListingPending={onListingPending} />}
      <Button variant="ghost" size="sm" className="self-start" data-share-switch={mode === "live" ? "blueprint" : "live"} disabled={busy} onClick={() => setMode(mode === "live" ? "blueprint" : "live")}>
        {mode === "live" ? "Share a copy instead" : "Share it live instead"}
      </Button>
    </Modal>
  );
}
