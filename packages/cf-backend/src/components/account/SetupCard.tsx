/** Opens setup as a modal so a half-typed mission on the page behind is not lost. */
import { useState } from "react";
import { AccountPanelModal, type AccountPanel } from "@/components/account/AccountPanelModal";

export function SetupCard({ returnTo }: { returnTo: string }) {
  const [open, setOpen] = useState<AccountPanel | null>(null);

  return (
    <>
      <div className="rounded-[14px] border p-border p-surface px-[18px] py-4">
        <div className="t-status mb-3 p-text-3">Setup</div>
        <button type="button" onClick={() => setOpen('providers')}
          className="t-control block w-full py-[5px] text-left p-accent-fg">
          Connect providers →
        </button>
        <button type="button" onClick={() => setOpen('mcp')}
          className="t-control block w-full py-[5px] text-left p-accent-fg">
          Add MCP servers →
        </button>
        <button type="button" onClick={() => setOpen('cli')}
          className="t-control block w-full py-[5px] text-left p-accent-fg">
          Install the CLI →
        </button>
      </div>
      {open !== null && (
        <AccountPanelModal panel={open} returnTo={returnTo} onClose={() => setOpen(null)} />
      )}
    </>
  );
}
