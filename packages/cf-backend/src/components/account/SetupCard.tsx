/**
 * The home page's setup card: the three account-setup doors, opened in place
 * as a modal rather than navigated to — the page behind is the mission form,
 * and leaving it would lose a half-typed mission.
 */
import { useState } from "react";
import { AccountPanelModal, type AccountPanel } from "@/components/account/AccountPanelModal";

export function SetupCard({ returnTo }: { returnTo: string }) {
  const [open, setOpen] = useState<AccountPanel | null>(null);

  return (
    <>
      <div className="rounded-[14px] border p-border p-surface px-[18px] py-4">
        <div className="mb-2.5 text-xs font-semibold p-text-4">Setup</div>
        <button type="button" onClick={() => setOpen('providers')}
          className="block w-full py-[5px] text-left p-t-control p-accent">
          Connect providers →
        </button>
        <button type="button" onClick={() => setOpen('mcp')}
          className="block w-full py-[5px] text-left p-t-control p-accent">
          Add MCP servers →
        </button>
        <button type="button" onClick={() => setOpen('cli')}
          className="block w-full py-[5px] text-left p-t-control p-accent">
          Install the CLI →
        </button>
      </div>
      {open !== null && (
        <AccountPanelModal panel={open} returnTo={returnTo} onClose={() => setOpen(null)} />
      )}
    </>
  );
}
