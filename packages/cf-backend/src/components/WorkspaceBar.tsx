/**
 * The workspace bar — the one row that says which workspace you are in.
 *
 * It is the ONLY place the workspace's name is rendered inside a workspace.
 * The title used to appear on this bar, again on the chat header below it and
 * a tab strip between them, so three rows of chrome stood between the window
 * edge and the first message. Identity belongs here because this is the only
 * row present at BOTH altitudes: in Supervise there is no chat header to carry
 * it, and there never was a second thing this bar did.
 *
 * So it also carries what is workspace-scoped rather than conversation-scoped:
 * connection, settings, and the altitude switch. Anything about one
 * conversation (which tab, clearing its history) lives on the chat column's tab
 * strip instead — and so does the MODEL, which used to sit here: it describes
 * the turn you are about to send, so it belongs in the composer beside the mode
 * control, which is where the subordinate chat already had it.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { CheckIcon, GearSixIcon, GitBranchIcon, PencilSimpleIcon, XIcon } from "@phosphor-icons/react";
import { ConnectionIndicator } from "@/components/connection-indicator";
import type { ConnectionStatus } from "@/hooks/use-kinu";
import { renderCauseChain } from '@kinu/core/obs';

export const ALTITUDES = ["run", "supervise"] as const;
export type Altitude = (typeof ALTITUDES)[number];

export interface WorkspaceBarProps {
  title: string;
  onRename: (displayName: string) => Promise<string>;
  connectionStatus: ConnectionStatus;
  /** The agent is mid-turn — the pulse the whole workspace shares. */
  working: boolean;
  /** Present on a forked workspace: a link back to the one it was cut from. */
  forkParent?: { workspace: string; forkedAt: number };
  settingsHref: string;
  altitude: Altitude;
  onAltitude: (altitude: Altitude) => void;
}

export function WorkspaceBar({
  title, onRename, connectionStatus, working, forkParent, settingsHref,
  altitude, onAltitude,
}: WorkspaceBarProps) {
  return (
    // Wraps below ~30rem: a phone cannot hold a name and a switch on one line,
    // and the name is what would lose. It takes the first line alone and the
    // controls drop beneath it.
    <div className="@container flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b p-border px-4 py-2">
      <div className="flex min-w-0 basis-full items-center gap-2.5 @[30rem]:basis-0 @[30rem]:flex-1">
        <ConnectionIndicator status={connectionStatus} />
        <InlineWorkspaceTitle title={title} onRename={onRename} />
        {working && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 p-accent-subtle @[34rem]:px-2" title="The agent is working">
            <span className="size-1.5 rounded-full p-dot-accent animate-pulse" />
            <span className="hidden p-meta p-accent font-medium @[34rem]:inline">working</span>
          </span>
        )}
        {forkParent && (
          <Link
            to={`/workspace/${forkParent.workspace}`}
            className="flex shrink-0 items-center gap-1 rounded-sm border p-border px-1.5 py-0.5 text-[10px] p-text-3 transition-colors hover:p-text"
            title={`Open parent workspace from ${new Date(forkParent.forkedAt).toLocaleString()}`}
          >
            <GitBranchIcon size={10} />
            <span>Parent workspace</span>
          </Link>
        )}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Link to={settingsHref} className="p-text-2 transition-colors hover:p-text" title="Settings" aria-label="Workspace settings">
          <GearSixIcon size={14} />
        </Link>
        <div className="flex items-center gap-0.5 rounded-md p-recessed p-0.5">
          {ALTITUDES.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onAltitude(value)}
              aria-pressed={altitude === value}
              className={`rounded-sm px-2.5 py-1 text-[11px] capitalize transition-colors ${altitude === value ? "p-fill p-text font-medium" : "p-text-3 hover:p-text-2"}`}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function InlineWorkspaceTitle({ title, onRename }: {
  title: string;
  onRename: (displayName: string) => Promise<string>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (!editing) setValue(title); }, [editing, title]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const displayName = value.trim();
    if (!displayName || saving) return;
    setSaving(true);
    setError(null);
    try {
      setValue(await onRename(displayName));
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? renderCauseChain(err) : "Rename failed");
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <form onSubmit={save} className="flex min-w-0 items-center gap-1">
        <input
          autoFocus
          value={value}
          maxLength={60}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape" && !saving) { setEditing(false); setError(null); } }}
          className="w-44 rounded-md border p-border p-elevated px-2 py-1 text-sm p-text focus:outline-none focus:border-[var(--c-accent)] focus:ring-1 focus:ring-[var(--c-accent-subtle)]"
          aria-label="Workspace display name"
        />
        <button
          type="submit"
          disabled={!value.trim() || saving}
          className="rounded-sm p-1 p-text-3 hover:p-text p-card-hover disabled:opacity-40"
          aria-label="Save workspace name"
        ><CheckIcon size={13} /></button>
        <button
          type="button"
          onClick={() => { setEditing(false); setError(null); }}
          disabled={saving}
          className="rounded-sm p-1 p-text-3 hover:p-text p-card-hover"
          aria-label="Cancel rename"
        ><XIcon size={13} /></button>
        {error && <span role="alert" className="text-[10px] p-danger" title={error}>Rename failed</span>}
      </form>
    );
  }

  return (
    <div className="group/title flex min-w-0 items-center gap-1">
      <span className="truncate text-sm font-medium p-text" title={title}>{title}</span>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="shrink-0 rounded-sm p-1 opacity-0 transition-all p-text-3 group-hover/title:opacity-60 hover:!opacity-100 hover:p-text focus-visible:opacity-100"
        title="Rename"
        aria-label={`Rename workspace ${title}`}
      ><PencilSimpleIcon size={12} /></button>
    </div>
  );
}
