/** Opens setup as a modal so a half-typed mission on the page behind is not lost. */
import { useState } from "react";
import { AccountPanelModal, type AccountPanel } from "@/components/account/AccountPanelModal";
import { Pressable } from "@/components/ui/Pressable";

export function SetupCard({ returnTo }: { returnTo: string }) {
  const [open, setOpen] = useState<AccountPanel | null>(null);

  return (
    <>
      <div className="rounded-[14px] border p-border p-surface px-[18px] py-4">
        <div className="t-status mb-3 p-text-3">Setup</div>
        <Pressable className="t-control py-[5px] p-accent-fg" onClick={() => setOpen('providers')}>
          Connect providers →
        </Pressable>
        <Pressable className="t-control py-[5px] p-accent-fg" onClick={() => setOpen('mcp')}>
          Add MCP servers →
        </Pressable>
        <Pressable className="t-control py-[5px] p-accent-fg" onClick={() => setOpen('cli')}>
          Install the CLI →
        </Pressable>
      </div>
      {open !== null && (
        <AccountPanelModal panel={open} returnTo={returnTo} onClose={() => setOpen(null)} />
      )}
    </>
  );
}
