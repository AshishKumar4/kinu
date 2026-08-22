/**
 * The workspace bar — the mock's 56px top bar.
 *
 * It is the ONLY place the workspace's name is rendered inside a workspace.
 * Identity lives here because this is the only row present at BOTH altitudes:
 * in Supervise there is no chat header to carry it.
 *
 * Workspace-scoped chrome rides with it: the live pill (connection + the
 * shared mid-turn pulse), the model chip (what the next turn will run), the
 * theme circle, the Run/Supervise altitude pair, and the one gear into
 * workspace settings. Anything about one conversation (which tab, clearing
 * its history) stays on the chat column's tab strip.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { CheckIcon, GearSixIcon, GitBranchIcon, PencilSimpleIcon, SunIcon, MoonIcon } from "@phosphor-icons/react";
import type { ConnectionStatus } from "@/hooks/use-kinu";
import { useTheme, toggleMode } from "@/hooks/use-theme";
import { renderThrownChain } from '@kinu.run/core/obs';

export const ALTITUDES = ["run", "supervise"] as const;
export type Altitude = (typeof ALTITUDES)[number];

export interface WorkspaceBarProps {
  title: string;
  onRename: (displayName: string) => Promise<string>;
  connectionStatus: ConnectionStatus;
  /** The agent is mid-turn — the pulse the whole workspace shares. */
  working: boolean;
  /** The resolved model spec for the next turn, when the workspace has one. */
  model?: string;
  /** Present on a forked workspace: a link back to the one it was cut from. */
  forkParent?: { workspace: string; forkedAt: number };
  settingsHref: string;
  altitude: Altitude;
  onAltitude: (altitude: Altitude) => void;
}

/** `<provider>/<modelId>` → the wire id the mock's chip shows (`deepseek-v4-pro-0813`). */
function modelChipLabel(spec: string): string {
  const withoutCompatPrefix = spec.replace(/^openai-compat:[^/]+\//, "");
  const idPart = withoutCompatPrefix.includes("/")
    ? withoutCompatPrefix.slice(withoutCompatPrefix.indexOf("/") + 1)
    : withoutCompatPrefix;
  return idPart.startsWith("@cf/") ? idPart.slice(4) : idPart;
}

/** The live pill: one honest word about the socket, tinted by what it means. */
function LivePill({ status, working }: { status: ConnectionStatus; working: boolean }) {
  const tone =
    status === "connected"
      ? { cls: "text-[var(--c-accent)] border-[rgba(224,164,88,.28)] bg-[rgba(224,164,88,.1)]", dot: working ? "p-dot-accent p-dot-pulse" : "p-dot-success", word: working ? "Working" : "Live" }
      : status === "connecting"
        ? { cls: "p-text-3 p-border p-fill", dot: "p-dot-neutral p-dot-pulse", word: "Connecting" }
        : { cls: "p-danger border p-border p-fill", dot: "p-dot-danger", word: "Offline" };
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[11.5px] font-medium ${tone.cls}`}>
      <span className={`size-1.5 rounded-full ${tone.dot}`} />
      {tone.word}
    </span>
  );
}

export function WorkspaceBar({
  title, onRename, connectionStatus, working, model, forkParent,
  settingsHref, altitude, onAltitude,
}: WorkspaceBarProps) {
  const { mode } = useTheme();
  return (
    // Fixed 56px like the mock; below ~30rem it wraps rather than clipping —
    // a phone cannot hold a name, a pill and a switch on one line.
    <div className="@container flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b p-border p-sidebar px-5 py-2">
      <div className="flex min-w-0 basis-full items-center gap-3 @[30rem]:basis-0 @[30rem]:flex-1">
        <InlineWorkspaceTitle title={title} onRename={onRename} />
        <LivePill status={connectionStatus} working={working} />
        {model && (
          <span
            className="hidden max-w-48 truncate rounded-full border p-border p-fill px-3 py-1 font-mono text-[11px] p-text-4 sm:inline"
            title={`Next turn runs ${model}`}
          >
            {modelChipLabel(model)}
          </span>
        )}
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
        <Link to={settingsHref} className="p-text-3 transition-colors hover:p-gold" title="Workspace settings" aria-label="Workspace settings">
          <GearSixIcon size={15} />
        </Link>
        <button
          type="button"
          onClick={toggleMode}
          className="flex size-[30px] items-center justify-center rounded-full border p-border p-text-3 transition-colors hover:p-accent hover:border-[var(--c-accent)]"
          title={mode === "light" ? "Switch to dark mode" : "Switch to light mode"}
          aria-label={mode === "light" ? "Switch to dark mode" : "Switch to light mode"}
        >
          {mode === "light" ? <MoonIcon size={14} /> : <SunIcon size={14} />}
        </button>
        <div className="flex items-center gap-0.5 rounded-full border p-border p-fill p-[3px]">
          {ALTITUDES.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onAltitude(value)}
              aria-pressed={altitude === value}
              className={`rounded-full px-[18px] py-1.5 text-[12.5px] font-semibold capitalize transition-colors ${
                altitude === value ? "bg-[var(--c-accent)] text-[var(--c-accent-on)]" : "p-text-4 hover:p-gold"
              }`}
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
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape") setEditing(false); }}
          onBlur={() => { if (!saving) setEditing(false); }}
          className="w-48 rounded-md border border-[var(--c-accent)] p-elevated px-2 py-1 text-[15px] font-semibold p-text outline-none"
          aria-label="Workspace name"
        />
        <button
          type="submit"
          disabled={saving || !value.trim()}
          className="rounded-sm p-1 p-text-3 hover:p-text disabled:opacity-40"
          aria-label="Save workspace name"
        ><CheckIcon size={13} /></button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="rounded-sm p-1 p-text-3 hover:p-text"
          aria-label="Cancel rename"
        ><PencilSimpleIcon size={13} style={{ transform: "scaleX(-1)" }} /></button>
        {error && <span className="text-[10px] p-danger">{error}</span>}
      </form>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="group/title flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 -mx-1 transition-colors hover:bg-[var(--c-elevated)]"
      title="Rename workspace"
    >
      {/* 15px/600 is the mock's top-bar name weight. */}
      <span className="truncate text-[15px] font-semibold p-text">{title}</span>
      <PencilSimpleIcon size={11} className="shrink-0 p-text-4 opacity-0 transition-opacity group-hover/title:opacity-100" />
    </button>
  );
}
