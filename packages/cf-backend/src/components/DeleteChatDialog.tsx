import { TrashIcon } from "@phosphor-icons/react";
import { ConfirmDialog } from "./ui/ConfirmDialog";

export function DeleteChatDialog({ title, onDelete, onClose }: { title: string; onDelete: () => Promise<void>; onClose: () => void }) {
  return (
    <ConfirmDialog title={`Delete ${title}?`} icon={<TrashIcon size={18} className="p-danger" />} action="Delete"
      failed="Could not delete" onConfirm={onDelete} onClose={onClose}>
      <p className="text-xs p-text-2 leading-relaxed">Its conversation is deleted. This cannot be undone.</p>
    </ConfirmDialog>
  );
}
