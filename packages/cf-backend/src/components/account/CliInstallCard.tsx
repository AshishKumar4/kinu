import { useEffect, useState } from "react";
import { TerminalIcon } from "@phosphor-icons/react";
import { getCliSetup, type CliSetup } from "@/lib/user-api";
import { Card } from "@/components/ui/form";
import { CopyButton } from "@/components/ui/CopyButton";

export function CliInstallCard() {
  const [cliSetup, setCliSetup] = useState<CliSetup | null>(null);

  // Derivable from the origin, so a failed read costs nothing.
  useEffect(() => { getCliSetup().then(setCliSetup, () => setCliSetup(null)); }, []);

  return (
    <Card title="Install" icon={TerminalIcon}>
      <CommandCopy command={cliSetup?.installCommand ?? `curl -fsSL '${window.location.origin}/install.sh' | bash`} />
    </Card>
  );
}

function CommandCopy({ command }: { command: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md p-fill border p-border p-3">
      <code className="p-t-code p-text flex-1 break-all select-all">{command}</code>
      <CopyButton value={command} what="the install command" size={13} className="p-text-3 hover:p-text shrink-0" />
    </div>
  );
}
