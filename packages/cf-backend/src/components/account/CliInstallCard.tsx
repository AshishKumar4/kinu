import { useEffect, useState } from "react";
import { Effect } from "effect";
import { detach } from "@kinu.run/core/obs";
import { getCliSetup, type CliSetup } from "@/lib/user-api";
import { Card } from "@/components/ui/Card";
import { CopyField } from "@/components/ui/CopyField";

export function CliInstallCard() {
  const [cliSetup, setCliSetup] = useState<CliSetup | null>(null);

  // Derivable from the origin, so a failed read costs nothing.
  useEffect(() => {
    detach(Effect.match(Effect.tryPromise({ try: getCliSetup, catch: () => "unread" }), { onSuccess: setCliSetup, onFailure: () => setCliSetup(null) }));
  }, []);

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
