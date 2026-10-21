import type { MouseEvent } from "react";
import { NotePencilIcon } from "@phosphor-icons/react";
import { APP_ROUTES } from "@kinu.run/core";
import { buttonClass } from "@/components/ui/Button";
import { Link } from "react-router-dom";

/** The mission prompt, where a new workspace is described: on its own page, and on Home until Home is the assistant. */
export const WORKSPACE_MISSION_ID = "workspace-mission";

/** New workspace as a round, quiet compose icon: the mission's page, or where a mission prompt shows, that prompt. */
/** `className` sets its size and roundness where it stands: the sidebar's 32 circle by default. */
export function NewWorkspaceIconButton({ className = "size-8 rounded-full pointer-coarse:size-10" }: { className?: string }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const prompt = document.getElementById(WORKSPACE_MISSION_ID);

    if (prompt === null) return;
    event.preventDefault();
    prompt.focus();
  };

  return (
    <Link to={APP_ROUTES.newWorkspace} onClick={onClick} aria-label="New workspace" title="New workspace"
      className={`${buttonClass({ variant: "ghost", iconOnly: true })} shrink-0 ${className}`}>
      <NotePencilIcon size={17} />
    </Link>
  );
}
