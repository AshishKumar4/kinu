/** What finishing setup could not do, on whatever page the person is on (`lib/setup-finish.ts`), with Try again. */
import { WarningIcon, XIcon } from "@phosphor-icons/react";
import { detach } from "@kinu.run/core/obs";
import { Surface } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { dismissSetupFinish, retrySetupFinish, useSetupFinish } from "@/lib/setup-finish";

export function SetupFinishBar() {
  const finish = useSetupFinish();

  if (finish === null || finish.dismissed) return null;
  const said: string[] = [];

  if (finish.stamp.state === "failed") said.push(`Setup didn't save, so it opens again next time: ${finish.stamp.error}`);

  if (finish.assistant?.state === "failed") said.push(`Your assistant, ${finish.assistant.name}, wasn't set up: ${finish.assistant.error}`);

  if (said.length === 0) return null;

  return (
    <Surface look="wash" className="t-meta flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 p-text" data-setup-finish-failed role="alert">
      <WarningIcon size={14} className="shrink-0 p-danger" />
      <span className="min-w-0 flex-1">{said.join(" ")}</span>
      <Button variant="secondary" size="sm" onClick={() => detach(retrySetupFinish())}>Try again</Button>
      <Button variant="ghost" size="sm" icon={<XIcon size={14} />} aria-label="Dismiss" onClick={dismissSetupFinish} />
    </Surface>
  );
}
