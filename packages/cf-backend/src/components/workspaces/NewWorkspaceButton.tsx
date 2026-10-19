import type { MouseEvent } from "react";
import { Link, useMatch } from "react-router-dom";
import { NotePencilIcon, PlusIcon } from "@phosphor-icons/react";
import { APP_ROUTES } from "@kinu.run/core";

/** The home page's mission prompt, where a new workspace is described. */
export const WORKSPACE_MISSION_ID = "workspace-mission";

/** The way to a new workspace is the home page, whose mission card holds the brass action; so this one stays quiet. */
export function NewWorkspaceButton({ className }: { className: string }) {
  return (
    <Link to={APP_ROUTES.home} className={`p-btn-quiet flex items-center justify-center gap-2 whitespace-nowrap font-semibold ${className}`}>
      <PlusIcon size={14} weight="bold" className="p-accent-mark" />
      New workspace
    </Link>
  );
}

/** New workspace as a round, quiet compose icon: the home page, or on it, its mission prompt to write in. */
export function NewWorkspaceIconButton({ className = "size-8 rounded-full pointer-coarse:size-10" }: { className?: string }) {
  const onHome = useMatch({ path: APP_ROUTES.home, end: true }) !== null;

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!onHome) return;
    event.preventDefault();
    document.getElementById(WORKSPACE_MISSION_ID)?.focus();
  };

  return (
    <Link
      to={APP_ROUTES.home}
      onClick={onClick}
      aria-label="New workspace"
      title="New workspace"
      className={`flex shrink-0 items-center justify-center p-text-2 transition-colors hover:bg-[var(--c-neutral-tint)] hover:p-text ${className}`}
    >
      <NotePencilIcon size={17} />
    </Link>
  );
}
