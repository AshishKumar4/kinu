import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@cloudflare/kumo";
import { HouseIcon, PlusIcon, TrashIcon, UserPlusIcon } from "@phosphor-icons/react";
import type { SubordinateRosterEntry } from "@proteus/core";
import { Modal } from "./ui/Modal";

interface SpawnResult {
  name: string;
  displayName: string;
}

interface SubordinateTabsProps {
  workspace: string;
  subordinates: readonly SubordinateRosterEntry[];
  activeName?: string;
  onSpawn(role: string, mission: string): Promise<SpawnResult>;
  onDismiss(name: string): Promise<void>;
}

function StatusMark({ subordinate }: { subordinate: SubordinateRosterEntry }) {
  if (subordinate.status === "awaiting_input") {
    return <span className="rounded px-1.5 py-0.5 text-[9px] font-medium p-badge-warning">input</span>;
  }
  return (
    <span
      className={`size-1.5 shrink-0 rounded-full ${subordinate.status === "working" ? "p-dot-success animate-pulse" : "p-dot-neutral"}`}
      aria-label={subordinate.status === "working" ? "Working" : "Idle"}
    />
  );
}

function SpawnSubordinateDialog({ onClose, onSpawn }: {
  onClose(): void;
  onSpawn(role: string, mission: string): Promise<SpawnResult>;
}) {
  const [role, setRole] = useState("");
  const [mission, setMission] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!role.trim() || !mission.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSpawn(role.trim(), mission.trim());
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Add a subordinate"
      icon={<UserPlusIcon size={18} className="p-accent" />}
      onClose={onClose}
      busy={saving}
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button size="sm" variant="primary" type="submit" form="spawn-subordinate" disabled={!role.trim() || !mission.trim() || saving}>
          {saving ? "Starting…" : "Start mission"}
        </Button>
      </>}
    >
      <form id="spawn-subordinate" onSubmit={submit} className="space-y-3">
        <label className="block space-y-1.5">
          <span className="text-xs font-medium p-text-2">Role</span>
          <input
            autoFocus
            value={role}
            onChange={(event) => setRole(event.target.value)}
            placeholder="e.g. Research lead"
            maxLength={120}
            className="w-full rounded-lg border p-border p-card px-3 py-2 text-sm p-text placeholder:p-text-3 focus:outline-none focus:border-[var(--c-accent)]"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium p-text-2">Mission</span>
          <textarea
            value={mission}
            onChange={(event) => setMission(event.target.value)}
            placeholder="Describe the outcome this subordinate should deliver."
            rows={5}
            maxLength={4_000}
            className="w-full resize-y rounded-lg border p-border p-card px-3 py-2 text-sm leading-relaxed p-text placeholder:p-text-3 focus:outline-none focus:border-[var(--c-accent)]"
          />
        </label>
        <p className="text-[11px] leading-relaxed p-text-3">
          Proteus names the subordinate automatically and sends the mission as its first turn.
        </p>
        {error && <div role="alert" className="rounded-md px-2.5 py-2 text-xs p-notice-danger">{error}</div>}
      </form>
    </Modal>
  );
}

export function SubordinateTabs({ workspace, subordinates, activeName, onSpawn, onDismiss }: SubordinateTabsProps) {
  const [showSpawn, setShowSpawn] = useState(false);
  const [dismissTarget, setDismissTarget] = useState<SubordinateRosterEntry | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);

  const mainPath = `/workspace/${workspace}`;

  return (
    <>
      <nav aria-label="Workspace agents" className="flex shrink-0 items-stretch gap-1 overflow-x-auto border-b p-border px-2 pt-1.5">
        <Link
          to={mainPath}
          aria-current={!activeName ? "page" : undefined}
          className={`flex shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-2 text-xs transition-colors ${!activeName ? "p-card p-text font-medium" : "border-transparent p-text-3 hover:p-text hover:p-card-hover"}`}
        >
          <HouseIcon size={13} weight={!activeName ? "fill" : "regular"} />
          Main
        </Link>
        {subordinates.map((subordinate) => {
          const active = activeName === subordinate.name;
          return (
            <div key={subordinate.name} className="group/tab relative shrink-0">
              <Link
                to={`${mainPath}/agents/${subordinate.name}`}
                aria-current={active ? "page" : undefined}
                title={`${subordinate.role}${subordinate.currentTask ? ` — ${subordinate.currentTask}` : ""}`}
                className={`flex h-full max-w-52 items-center gap-2 rounded-t-md border border-b-0 py-2 pl-3 pr-8 text-xs transition-colors ${active ? "p-card p-text font-medium" : "border-transparent p-text-2 hover:p-text hover:p-card-hover"}`}
              >
                <span className="truncate">{subordinate.displayName}</span>
                <StatusMark subordinate={subordinate} />
              </Link>
              <button
                type="button"
                onClick={() => { setDismissError(null); setDismissTarget(subordinate); }}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 opacity-0 p-text-3 transition-all hover:p-danger focus-visible:opacity-100 group-hover/tab:opacity-70"
                title={`Dismiss ${subordinate.displayName}`}
                aria-label={`Dismiss ${subordinate.displayName}`}
              >
                <TrashIcon size={11} />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={() => setShowSpawn(true)}
          className="mb-1.5 flex size-7 shrink-0 self-center items-center justify-center rounded-md p-text-3 transition-colors hover:p-text hover:p-card-hover"
          title="Add a subordinate"
          aria-label="Add a subordinate"
        >
          <PlusIcon size={14} />
        </button>
      </nav>

      {showSpawn && <SpawnSubordinateDialog onClose={() => setShowSpawn(false)} onSpawn={onSpawn} />}

      {dismissTarget && (
        <Modal
          title={`Dismiss ${dismissTarget.displayName}?`}
          icon={<TrashIcon size={18} className="p-danger" />}
          onClose={() => setDismissTarget(null)}
          busy={dismissing}
          footer={<>
            <Button size="sm" variant="ghost" disabled={dismissing} onClick={() => setDismissTarget(null)}>Cancel</Button>
            <Button
              size="sm"
              variant="primary"
              disabled={dismissing}
              onClick={async () => {
                setDismissing(true);
                setDismissError(null);
                try {
                  await onDismiss(dismissTarget.name);
                  setDismissTarget(null);
                } catch (cause) {
                  setDismissError(cause instanceof Error ? cause.message : String(cause));
                } finally {
                  setDismissing(false);
                }
              }}
            >
              {dismissing ? "Dismissing…" : "Dismiss"}
            </Button>
          </>}
        >
          <p className="text-xs leading-relaxed p-text-2">
            This removes the tab and permanently deletes its conversation and private agent state. Shared workspace files are kept.
          </p>
          {dismissError && <div role="alert" className="rounded-md px-2.5 py-2 text-xs p-notice-danger">{dismissError}</div>}
        </Modal>
      )}
    </>
  );
}
