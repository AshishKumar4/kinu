import { TrashIcon } from "@phosphor-icons/react";
import { ConfirmDialog } from "./ui/ConfirmDialog";

const ENDINGS = {
  delete: { action: "Delete", failed: "Could not delete", says: "Its conversation is deleted. This cannot be undone." },
  clear: { action: "Clear", failed: "Could not clear", says: "Its messages are deleted; the chat, its memory and its files stay. This cannot be undone." },
} as const;

/** A tab's ×: a chat the person opened is deleted; Main's conversation is cleared and Main stays. */
export function DeleteChatDialog({ title, clears = false, onConfirm, onClose }: {
  title: string;
  clears?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const ending = ENDINGS[clears ? "clear" : "delete"];

  return (
    <ConfirmDialog title={`${ending.action} ${title}?`} icon={<TrashIcon size={18} className="p-danger" />} action={ending.action}
      failed={ending.failed} onConfirm={onConfirm} onClose={onClose}>
      <p className="t-meta p-text-2">{ending.says}</p>
    </ConfirmDialog>
  );
}
