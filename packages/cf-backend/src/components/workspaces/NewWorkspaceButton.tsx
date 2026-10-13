import { Effect } from "effect";
import { useNavigate } from "react-router-dom";
import { PlusIcon } from "@phosphor-icons/react";
import { APP_ROUTES } from "@kinu.run/core";
import { detach } from "@kinu.run/core/obs";

/** The way to a new workspace is the home page, whose mission card holds the brass action; so this one stays quiet. */
export function NewWorkspaceButton({ className }: { className: string }) {
  const navigate = useNavigate();

  return (
    <button
      type="button"
      onClick={() => detach(Effect.promise(async () => navigate(APP_ROUTES.home)))}
      className={`p-btn-quiet flex items-center justify-center gap-2 font-semibold ${className}`}
    >
      <PlusIcon size={14} weight="bold" className="p-accent-mark" />
      New workspace
    </button>
  );
}
