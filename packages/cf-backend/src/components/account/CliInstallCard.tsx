/**
 * The one command that installs the CLI. Account settings shows it as the
 * `cli` section; the setup card and the onboarding wizard mount it in a modal.
 * Its read lives here with the card rather than on whichever page hosts it.
 */
import { useEffect, useState } from "react";
import { TerminalIcon } from "@phosphor-icons/react";
import { getCliSetup, type CliSetup } from "@/lib/user-api";
import { Card } from "@/components/ui/form";
import { CopyButton } from "@/components/ui/CopyButton";

export function CliInstallCard() {
  const [cliSetup, setCliSetup] = useState<CliSetup | null>(null);

  // The install command is derivable from the origin, so its read failing
  // costs nothing and claims nothing.
  useEffect(() => { getCliSetup().then(setCliSetup, () => setCliSetup(null)); }, []);

  return (
    <Card title="Install" icon={TerminalIcon}>
      <CommandCopy command={cliSetup?.installCommand ?? `curl -fsSL '${window.location.origin}/install.sh' | bash`} />
    </Card>
  );
}

/** A command to run elsewhere, in the block the connect panel hands its
 *  command over in: the well, the selectable text, and the copy action. */
function CommandCopy({ command }: { command: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md p-fill border p-border p-3">
      <code className="p-t-code p-text flex-1 break-all select-all">{command}</code>
      <CopyButton value={command} what="the install command" size={13} className="p-text-3 hover:p-text shrink-0" />
    </div>
  );
}
