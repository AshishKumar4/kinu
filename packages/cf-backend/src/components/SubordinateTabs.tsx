import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@cloudflare/kumo";
import { FilledButton } from "./ui/FilledButton";
import { HouseIcon, PlusIcon, TrashIcon, UserPlusIcon } from "@phosphor-icons/react";
import type { SubordinateRosterEntry } from "@kinu.run/core";
import { Modal } from "./ui/Modal";
import { renderThrownChain } from "@kinu.run/core/obs";

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
  /** Controls for the conversation this strip has open, pinned to its right
   *  edge — the chat column has no other chrome row to hang them on. */
  trailing?: ReactNode;
}

function StatusMark({ subordinate }: { subordinate: SubordinateRosterEntry }) {
  if (subordinate.status === "awaiting_input") {
    return <span className="rounded-sm px-1.5 py-0.5 text-[9px] font-medium p-badge-warning">input</span>;
  }
  return (
    <span
      className={`size-1.5 shrink-0 rounded-full ${subordinate.status === "working" ? "p-dot-success p-dot-pulse" : "p-dot-neutral"}`}
      aria-label={subordinate.status === "working" ? "Working" : "Idle"}
    />
  );
}

export function SpawnSubordinateDialog({ onClose, onSpawn }: {
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
      setError(renderThrownChain({ cause: cause }));
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
        <FilledButton type="submit" form="spawn-subordinate" disabled={!role.trim() || !mission.trim() || saving}>
          {saving ? "Creating…" : "Create agent"}
        </FilledButton>
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
            className="w-full border p-border p-card px-3 py-2 text-sm p-text placeholder:p-text-3 focus:outline-none focus:border-[var(--c-accent)]"
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
            className="w-full resize-y border p-border p-card px-3 py-2 text-sm leading-relaxed p-text placeholder:p-text-3 focus:outline-none focus:border-[var(--c-accent)]"
          />
        </label>
        <p className="text-[11px] leading-relaxed p-text-3">
          The mission defines this agent’s standing role. It stays idle until you open its tab and send the first message.
        </p>
        {error && <div role="alert" className="rounded-md px-2.5 py-2 text-xs p-notice-danger">{error}</div>}
      </form>
    </Modal>
  );
}

export function SubordinateTabs({ workspace, subordinates, activeName, onSpawn, onDismiss, trailing }: SubordinateTabsProps) {
  const navigate = useNavigate();
  const [showSpawn, setShowSpawn] = useState(false);
  const [dismissTarget, setDismissTarget] = useState<SubordinateRosterEntry | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);

  const mainPath = `/workspace/${workspace}`;
  const createAndOpen = async (role: string, mission: string): Promise<SpawnResult> => {
    const created = await onSpawn(role, mission);
    navigate(`${mainPath}/agents/${created.name}`);
    return created;
  };

  return (
    <>
      {/* One tab grammar with the work surfaces: a bottom edge, not a box.
          `-mb-px` puts the active bar on the strip's own rule so the two
          read as one line rather than two.

          The trailing controls are a SIBLING of the strip, not content inside
          it: the strip scrolls horizontally once the roster outgrows the
          column, and anything within it scrolls away with the tabs. They carry
          the same bottom rule so the two still read as one line. */}
      <div className="flex shrink-0 items-stretch">
        <nav aria-label="Workspace agents" className="p-tabstrip flex min-w-0 flex-1 items-stretch border-b p-border px-2">
          <Link
            to={mainPath}
            aria-current={!activeName ? "page" : undefined}
            className={`p-tab -mb-px flex shrink-0 items-center gap-1.5 px-3 py-2 text-xs transition-colors ${!activeName ? "p-tab-active font-medium" : ""}`}
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
                  className={`p-tab -mb-px flex h-full max-w-52 items-center gap-2 py-2 pl-3 pr-8 text-xs transition-colors ${active ? "p-tab-active font-medium" : ""}`}
                >
                  <span className="truncate">{subordinate.displayName}</span>
                  <StatusMark subordinate={subordinate} />
                </Link>
                <button
                  type="button"
                  onClick={() => { setDismissError(null); setDismissTarget(subordinate); }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-1 opacity-0 p-text-3 transition-all hover:p-danger focus-visible:opacity-100 group-hover/tab:opacity-70"
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
            className="p-btn-ghost my-1 ml-1 flex size-7 shrink-0 self-center items-center justify-center"
            title="Add a subordinate"
            aria-label="Add a subordinate"
          >
            <PlusIcon size={14} />
          </button>
        </nav>
        {trailing && (
          <div className="flex shrink-0 items-center gap-2 border-b p-border pl-2 pr-3">{trailing}</div>
        )}
      </div>

      {showSpawn && <SpawnSubordinateDialog onClose={() => setShowSpawn(false)} onSpawn={createAndOpen} />}

      {dismissTarget && (
        <Modal
          title={`Dismiss ${dismissTarget.displayName}?`}
          icon={<TrashIcon size={18} className="p-danger" />}
          onClose={() => setDismissTarget(null)}
          busy={dismissing}
          footer={<>
            <Button size="sm" variant="ghost" disabled={dismissing} onClick={() => setDismissTarget(null)}>Cancel</Button>
            <FilledButton danger disabled={dismissing}
              onClick={async () => {
                setDismissing(true);
                setDismissError(null);
                try {
                  await onDismiss(dismissTarget.name);
                  if (dismissTarget.name === activeName) navigate(mainPath);
                  setDismissTarget(null);
                } catch (cause) {
                  setDismissError(renderThrownChain({ cause: cause }));
                } finally {
                  setDismissing(false);
                }
              }}
            >
              {dismissing ? "Dismissing…" : "Dismiss"}
            </FilledButton>
          </>}
        >
          <p className="text-xs leading-relaxed p-text-2">
            This archives the agent and removes its tab. Its conversation and private state are preserved.
          </p>
          {dismissError && <div role="alert" className="rounded-md px-2.5 py-2 text-xs p-notice-danger">{dismissError}</div>}
        </Modal>
      )}
    </>
  );
}
