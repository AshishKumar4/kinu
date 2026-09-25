/** The only place a workspace's name renders inside a workspace: the one row present in both Work and Supervise. */
import { useEffect, useState, type FormEvent } from "react";
import { Tabs, type TabsItem } from "@cloudflare/kumo";
import { Link } from "react-router-dom";
import { CheckIcon, GitBranchIcon, PencilSimpleIcon, SunIcon, MoonIcon } from "@phosphor-icons/react";
import type { ConnectionStatus } from "@/hooks/use-kinu";
import { useTheme, toggleMode } from "@/hooks/use-theme";
import { renderThrownChain } from '@kinu.run/core/obs';

export type Altitude = "run" | "supervise";

const ALTITUDE_TAB_CLASS = "!my-0.5 !rounded-full !px-[18px] !text-[12.5px] !leading-[18px] !font-semibold !text-[var(--c-text-4)] hover:!text-[var(--c-accent)] aria-selected:!text-[var(--c-accent-on)]";

const ALTITUDE_TABS = [
  {
    value: "run",
    label: "Work",
    className: ALTITUDE_TAB_CLASS,
    // TabsItem has no title prop; Base UI merges the render element's props onto the trigger.
    render: (props) => <button {...props} title="Work: the current task and its record" aria-description="Work: the current task and its record" />,
  },
  {
    value: "supervise",
    label: "Supervise",
    className: ALTITUDE_TAB_CLASS,
    render: (props) => <button {...props} title="Supervise: what the agent learned and what needs you" aria-description="Supervise: what the agent learned and what needs you" />,
  },
] satisfies TabsItem[];

export interface WorkspaceBarProps {
  title: string;
  editValue?: string;
  onRename: (displayName: string) => Promise<string>;
  connectionStatus: ConnectionStatus;
  working: boolean;
  providerWait?: { provider: string; waitMs: number } | null;
  waitingOnYou?: boolean;
  forkParent?: { workspace: string; forkedAt: number };
  altitude: Altitude;
  onAltitude: (altitude: Altitude) => void;
}

const CONNECTION_TONE: Record<ConnectionStatus, { dot: string; word: string }> = {
  connected: { dot: "p-dot-success", word: "Connected" },
  connecting: { dot: "p-dot-neutral p-dot-pulse", word: "Connecting" },
  disconnected: { dot: "p-dot-danger", word: "Offline" },
  error: { dot: "p-dot-danger", word: "Offline" },
};

/** Dot plus word at every state: a dot alone is hue alone. */
function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const tone = CONNECTION_TONE[status];

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 p-text-3">
      <span className={`size-1.5 rounded-full ${tone.dot}`} />
      <span className="text-[11.5px] font-medium">{tone.word}</span>
    </span>
  );
}

// No stopped state: a turn nobody executes offers Recover in the composer, and nothing here says it runs.
function TaskIndicator({ working, providerWait, waitingOnYou }: { working: boolean; providerWait: { provider: string; waitMs: number } | null; waitingOnYou: boolean }) {
  let tone = { cls: "p-text-3 p-border p-fill", dot: "p-dot-neutral", word: "idle" };

  if (waitingOnYou) {
    tone = { cls: "p-warning border p-border p-fill", dot: "p-dot-warning", word: "waiting on you" };
  } else if (providerWait) {
    tone = { cls: "text-[var(--c-accent)] border-[rgba(224,164,88,.28)] bg-[rgba(224,164,88,.1)]", dot: "p-dot-accent p-dot-pulse", word: `waiting on ${providerWait.provider} · ${Math.ceil(providerWait.waitMs / 1000)}s` };
  } else if (working) {
    tone = { cls: "text-[var(--c-accent)] border-[rgba(224,164,88,.28)] bg-[rgba(224,164,88,.1)]", dot: "p-dot-accent p-dot-pulse", word: "working" };
  }

  return (
    <span
      role="status"
      aria-label="Task state"
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[11.5px] font-medium ${tone.cls}`}
      title={providerWait ? `Retry in ${Math.ceil(providerWait.waitMs / 1000)}s` : undefined}
    >
      <span className={`size-1.5 rounded-full ${tone.dot}`} />
      {tone.word}
    </span>
  );
}

export function WorkspaceBar({
  title, editValue, onRename, connectionStatus, working, providerWait = null, waitingOnYou = false, forkParent,
  altitude, onAltitude,
}: WorkspaceBarProps) {
  const { mode } = useTheme();

  return (
    // Below ~30rem it wraps rather than clipping.
    <div className="@container flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b p-border p-sidebar px-5 py-2">
      <div className="flex min-w-0 basis-full items-center gap-3 @[30rem]:basis-0 @[30rem]:flex-1">
        <InlineRenameTitle title={title} editValue={editValue} onRename={onRename} subject="workspace" />
        <ConnectionIndicator status={connectionStatus} />
        <TaskIndicator working={working} providerWait={providerWait} waitingOnYou={waitingOnYou} />
        {forkParent && (
          <Link
            to={`/workspace/${forkParent.workspace}`}
            className="flex shrink-0 items-center gap-1 rounded-full border p-border px-2 py-[3px] text-[10px] p-text-3 transition-colors hover:p-text"
            title={`Open parent workspace from ${new Date(forkParent.forkedAt).toLocaleString()}`}
          >
            <GitBranchIcon size={10} />
            <span>Parent</span>
          </Link>
        )}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2.5">
        <button
          type="button"
          onClick={toggleMode}
          className="flex size-[30px] items-center justify-center rounded-full border p-border p-text-3 transition-colors hover:p-accent hover:border-[var(--c-accent)]"
          title={mode === "light" ? "Switch to dark mode" : "Switch to light mode"}
          aria-label={mode === "light" ? "Switch to dark mode" : "Switch to light mode"}
        >
          {mode === "light" ? <MoonIcon size={14} /> : <SunIcon size={14} />}
        </button>
        <Tabs
          tabs={ALTITUDE_TABS}
          value={altitude}
          onValueChange={(value) => {
            if (value === "run" || value === "supervise") onAltitude(value);
          }}
          activateOnFocus
          className="p-altitude-tabs shrink-0 [&>div:first-child]:!h-9 [&>div:first-child]:!rounded-full [&>div:first-child]:!bg-[var(--c-fill)] [&_[role=tab]]:!my-0 [&_[role=tab]]:!h-[30px] [&_[role=tab]]:!rounded-full"
          listClassName="!h-9 !rounded-full !border !border-[var(--c-border)] !bg-[var(--c-fill)] !px-[3px] !py-[2px] !ring-0"
          indicatorClassName="!rounded-full !bg-[var(--c-accent)] !shadow-none !ring-0"
        />
      </div>
    </div>
  );
}

/** `textClass` carries the row's type scale and colour; none is set here because a utility-layer role would outrank the row. */
export function InlineRenameTitle({ title, editValue, onRename, subject, textClass = "text-[15px] font-semibold p-text", pencil = true }: {
  title: string;
  /** Stored title to edit from; pre-filling the shown label would persist "Untitled workspace". Defaults to `title`. */
  editValue?: string;
  onRename: (displayName: string) => Promise<string>;
  subject: string;
  textClass?: string;
  pencil?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(editValue ?? title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (!editing) setValue(editValue ?? title); }, [editing, title, editValue]);


  const save = async (event: FormEvent) => {
    event.preventDefault();
    const displayName = value.trim();

    if (!displayName || saving) return;
    setSaving(true);
    setError(null);

    try {
      await onRename(displayName);
      setEditing(false);
    } catch (err) {
      setError(renderThrownChain({ cause: err }));
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
          placeholder={title}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape") setEditing(false); }}
          onBlur={() => { if (!saving) setEditing(false); }}
          className={`w-48 rounded-md border border-[var(--c-accent)] p-elevated px-2 py-1 ${textClass} p-text outline-none`}
          aria-label={`${subject[0].toUpperCase()}${subject.slice(1)} name`}
        />
        <button
          type="submit"
          disabled={saving || !value.trim()}
          className="rounded-sm p-1 p-text-3 hover:p-text disabled:opacity-40"
          aria-label={`Save ${subject} name`}
        ><CheckIcon size={13} /></button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="rounded-sm p-1 p-text-3 hover:p-text"
          aria-label="Cancel rename"
        ><PencilSimpleIcon size={13} style={{ transform: "scaleX(-1)" }} /></button>
        {error && <span data-failure className="text-[10px] p-danger">{error}</span>}
      </form>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="group/title flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 -mx-1 transition-colors hover:bg-[var(--c-elevated)]"
      title={`Rename ${subject}`}
    >
      <span className={`truncate ${textClass}`}>{title}</span>
      {pencil && <PencilSimpleIcon size={11} className="shrink-0 p-text-4 opacity-0 transition-opacity group-hover/title:opacity-100" />}
    </button>
  );
}
