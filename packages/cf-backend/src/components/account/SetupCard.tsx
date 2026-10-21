/** Opens setup as a modal so a half-typed mission on the page behind is not lost. */
import { useState } from "react";
import { AccountPanelModal, type AccountPanel } from "@/components/account/AccountPanelModal";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

export function SetupCard({ returnTo }: { returnTo: string }) {
  const [open, setOpen] = useState<AccountPanel | null>(null);

  return (
    <>
      <Card title="Setup">
        <div className="-my-2 flex flex-col items-start">
          <Button variant="ghost" size="sm" onClick={() => setOpen('providers')}>Connect providers →</Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen('mcp')}>Add MCP servers →</Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen('cli')}>Install the CLI →</Button>
        </div>
      </Card>
      {open !== null && (
        <AccountPanelModal panel={open} returnTo={returnTo} onClose={() => setOpen(null)} />
      )}
    </>
  );
}
