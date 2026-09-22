/** Live: viewers reach granted binding members. Blueprint: bindings exported unmapped; nothing of the owner's stays reachable. */
import { useState } from "react";
import { ShareNetworkIcon } from "@phosphor-icons/react";
import type { Rpc } from "@kinu.run/core";
import { Modal } from "@/components/ui/Modal";
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

const MODES: readonly { id: ShareMode; label: string; hint: string }[] = [
  { id: "live", label: "Live share", hint: "Runs here, under the members you grant" },
  { id: "blueprint", label: "Blueprint", hint: "A copy others fork, bindings unmapped" },
];

export function ShareSlateDialog({ workspace, slate, title, rpc, onClose, fixture }: ShareSlateDialogProps) {
  const [mode, setMode] = useState<ShareMode>(fixture?.mode ?? "live");
  const [busy, setBusy] = useState(false);

  return (
    <Modal title={`Share ${title}`} icon={<ShareNetworkIcon size={18} className="p-accent" />} onClose={onClose} busy={busy} maxWidthClass="max-w-lg">
      <div role="tablist" aria-label="How to share" className="grid grid-cols-2 gap-2">
        {MODES.map((option) => (
          <button key={option.id} type="button" role="tab" aria-selected={mode === option.id} disabled={busy} onClick={() => setMode(option.id)}
            data-share-mode={option.id}
            className={`rounded-md border px-3 py-2 text-left ${mode === option.id ? "border-[var(--c-accent)] p-accent-bg" : "p-border p-card-hover"}`}>
            <span className="block text-xs font-medium p-text">{option.label}</span>
            <span className="block p-meta p-text-3">{option.hint}</span>
          </button>
        ))}
      </div>
      {mode === "live"
        ? <LiveShareForm workspace={workspace} slate={slate} rpc={rpc} onClose={onClose} onBusy={setBusy} fixture={fixture?.live} />
        : <BlueprintShareForm workspace={workspace} slate={slate} rpc={rpc} onClose={onClose} onBusy={setBusy} fixture={fixture?.blueprint} />}
    </Modal>
  );
}
