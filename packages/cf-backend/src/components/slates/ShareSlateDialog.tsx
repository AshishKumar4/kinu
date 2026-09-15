/**
 * The share control on a slate's tab, two ways to share one slate:
 *
 *   Live — the slate keeps running here, in the owner's workspace, and viewers
 *   reach exactly the binding members the owner granted (`LiveShareForm`: the
 *   capability graph, read members by construction, mutating ones by explicit
 *   approval with the risk named).
 *
 *   Blueprint — a committed version exported with every binding unmapped; a
 *   forker connects their own (`BlueprintShareForm`). Nothing of the owner's
 *   is reachable afterwards.
 */
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
  /** Fixture inputs for the gallery, one per mode; `mode` picks the tab shown. */
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
