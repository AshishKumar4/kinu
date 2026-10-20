/** "Send to a workspace…" (docs/MAIL.md §8): a thread handed to one of the owner's workspaces, whose chat it opens. */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@cloudflare/kumo";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { Modal } from "@/components/ui/Modal";
import { FilledButton } from "@/components/ui/FilledButton";
import { useLabelledStep } from "@/components/ui/ConfirmDialog";
import { WorkspacePicker, type ChosenWorkspace } from "@/components/secrets/SecretRows";
import { handMailThread } from "@/lib/mail-api";

export function SendToWorkspace({ thread, onClose }: { thread: string; onClose: () => void }) {
  const [chosen, setChosen] = useState<ChosenWorkspace | null>(null);
  const navigate = useNavigate();
  const { busy, error, run } = useLabelledStep(onClose);

  const send = (workspace: ChosenWorkspace): void => run("Sending", async () => {
    const { status } = await handMailThread(workspace.workspace, thread);

    if (status === "skipped") throw new Error(`${workspace.title} did not take it.`);
    await navigate(`/workspace/${encodeURIComponent(workspace.workspace)}`);
  });

  return (
    <Modal title="Send to a workspace" icon={<ArrowSquareOutIcon size={16} />} onClose={onClose} busy={busy !== null}
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy !== null}>Cancel</Button>
        <FilledButton data-mail-hand-commit onClick={() => { if (chosen !== null) send(chosen); }} disabled={chosen === null || busy !== null}>
          {busy ?? "Send"}
        </FilledButton>
      </>}>
      <div data-mail-hand className="space-y-2">
        <WorkspacePicker chosen={chosen} onChange={setChosen} placeholder="Workspace" />
        {error !== null && <div role="alert" className="p-notice-danger rounded-md px-3 py-2 text-xs">{error}</div>}
      </div>
    </Modal>
  );
}
