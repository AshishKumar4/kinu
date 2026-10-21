import { useEffect, useState } from "react";
import { getCliSetup, type CliSetup } from "@/lib/user-api";
import { Card } from "@/components/ui/form";
import { CopyField } from "@/components/ui/CopyField";

export function CliInstallCard() {
  const [cliSetup, setCliSetup] = useState<CliSetup | null>(null);

  // Derivable from the origin, so a failed read costs nothing.
  useEffect(() => { getCliSetup().then(setCliSetup, () => setCliSetup(null)); }, []);

  return (
    <Card title="Install">
      <CommandCopy command={cliSetup?.installCommand ?? `curl -fsSL '${window.location.origin}/install.sh' | bash`} />
    </Card>
  );
}

function CommandCopy({ command }: { command: string }) {
  return (
    <CopyField value={command} what="the install command" />
  );
}
