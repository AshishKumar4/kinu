import { Link } from "react-router-dom";
import { PlusIcon } from "@phosphor-icons/react";
import { APP_ROUTES } from "@kinu.run/core";

/** The way to a new workspace is the home page, whose mission card holds the brass action; so this one stays quiet. */
export function NewWorkspaceButton({ className }: { className: string }) {
  return (
    <Link to={APP_ROUTES.home} className={`p-btn-quiet flex items-center justify-center gap-2 font-semibold ${className}`}>
      <PlusIcon size={14} weight="bold" className="p-accent-mark" />
      New workspace
    </Link>
  );
}
