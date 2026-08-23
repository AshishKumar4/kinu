/**
 * Left sidebar — the mock's 240px rail.
 *
 *   ┌─────────────────┐
 *   │ ❯ Kinu          │   Newsreader brand lockup
 *   │ + New workspace │
 *   │ WORKSPACES      │
 *   │ ● Jarvis    4h  │
 *   │   ├ Scout       │   nested subordinates of the OPEN workspace
 *   │   └ + New agent │
 *   │ ─────────────── │
 *   │ A user@…     ⚙  │
 *   └─────────────────┘
 *
 * The nested agent rows are real data for exactly one workspace: the one open
 * this session (only a mounted WorkspacePage has a live socket, and it bridges
 * its subordinate roster here over `kinu:workspace-activity`). "+ New agent"
 * asks that page to open its spawn dialog (`kinu:hire-subordinate`); with no
 * workspace mounted there is nothing to hire INTO, so the row only renders
 * under an open workspace.
 */
import { useEffect, useState, useCallback, useRef, type FormEvent } from "react";
import { Link, NavLink, useMatch, useNavigate } from "react-router-dom";
import { GearIcon, TrashIcon, SignOutIcon, PencilSimpleIcon, CheckIcon, XIcon, PlusIcon } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import { FilledButton } from "./ui/FilledButton";
import { KinuLogo } from "./ui/KinuLogo";
import { removeWorkspace, getProfile, type WorkspaceEntry, type UserProfile } from "../lib/user-api";
import { useWorkspaceRpc } from "../hooks/use-kinu";
import { useWorkspaceRoster } from "../hooks/use-workspace-roster";
import { ModeToggle } from "./theme-toggle";
import { Modal } from "./ui/Modal";
import * as v from "valibot";
import { renderCauseChain, renderThrownChain } from "@kinu.run/core/obs";

// Route families in App.tsx that mount a live useKinu/useAgent socket for
// :agentId. Deleting that agent must first navigate away from ALL of them —
// a still-mounted socket auto-reconnects and resurrects the destroyed DO.
const WORKSPACE_SCOPED_SECTIONS = ["workspace", "mcts", "settings", "triggers"];

/** The nested-agent payload the open workspace broadcasts beside its running
 *  flag — identity fields only, straight off the SubordinateRosterEntry. */
interface SidebarAgent {
  name: string;
  displayName: string;
  role: string;
  status: string;
}

const SidebarAgentSchema = v.object({
  name: v.string(),
  displayName: v.string(),
  role: v.string(),
  status: v.string(),
});

/** Live per-workspace activity, bridged from the mounted WorkspacePage socket
 *  via a window event (only the open workspace has a live socket, so the roster
 *  reflects status for workspaces visited this session). */
interface WorkspaceActivity {
  running: boolean;
  unseenChangelog: number;
  agents: SidebarAgent[];
}
const WorkspaceActivityEventSchema = v.object({
  name: v.string(),
  running: v.boolean(),
  unseenChangelog: v.number(),
  agents: v.array(SidebarAgentSchema),
});

/** The mock's short ages: "4h", not "Active 4h ago" — the dot already says
 *  it is activity, and the column is 30px wide. */
function shortAge(lastVisited: number): string | null {
  if (!lastVisited) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - lastVisited) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 86400)}d`;
  if (seconds < 31_536_000) return `${Math.floor(seconds / 2_592_000)}mo`;
  return `${Math.floor(seconds / 31_536_000)}y`;
}

function SidebarRenameEditor({ workspace, onSaved, onCancel }: {
  workspace: WorkspaceEntry;
  onSaved: (displayName: string) => void;
  onCancel: () => void;
}) {
  const { rpc, connectionStatus } = useWorkspaceRpc(workspace.name);
  const [value, setValue] = useState(workspace.displayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const displayName = value.trim();
    if (!displayName || saving || connectionStatus !== "connected") return;
    setSaving(true);
    setError(null);
    try {
      const result = await rpc<{ displayName: string }>("setDisplayName", [displayName]);
      onSaved(result.displayName);
    } catch (err) {
      setError(err instanceof Error ? renderCauseChain(err) : "Rename failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="p-card px-1.5 py-1">
      <div className="flex items-center gap-1">
        <input
          autoFocus
          value={value}
          maxLength={60}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape" && !saving) onCancel(); }}
          className="min-w-0 flex-1 rounded-sm px-1.5 py-1 text-xs p-elevated p-text border p-border focus:outline-none focus:border-[var(--c-accent)] focus:ring-1 focus:ring-[var(--c-accent-subtle)]"
          aria-label={`Rename ${workspace.displayName}`}
        />
        <button
          type="submit"
          disabled={!value.trim() || saving || connectionStatus !== "connected"}
          className="rounded-sm p-1 p-text-3 hover:p-text p-card-hover disabled:opacity-40"
          aria-label="Save workspace name"
        ><CheckIcon size={12} /></button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-sm p-1 p-text-3 hover:p-text p-card-hover"
          aria-label="Cancel rename"
        ><XIcon size={12} /></button>
      </div>
      {(error || connectionStatus !== "connected") && (
        <div role={error || connectionStatus === "error" ? "alert" : "status"} className={`px-1 pt-1 text-[10px] truncate ${error || connectionStatus === "error" ? "p-danger" : "p-text-3"}`} title={error ?? undefined}>
          {error ?? (connectionStatus === "connecting" ? "Connecting…" : connectionStatus === "disconnected" ? "Reconnecting…" : "Could not connect")}
        </div>
      )}
    </form>
  );
}

export default function Sidebar() {
  // useParams can't see :agentId from here (the Sidebar renders outside the
  // route's Outlet) — match the location directly instead.
  const sectionMatch = useMatch({ path: "/:section/:agentId/*", end: false });
  const agentId = sectionMatch && WORKSPACE_SCOPED_SECTIONS.includes(sectionMatch.params.section ?? "")
    ? sectionMatch.params.agentId
    : undefined;
  const navigate = useNavigate();
  const {
    entries: workspaces,
    total: workspaceTotal,
    error: listError,
    refresh: refreshWorkspaces,
    rename: renameWorkspace,
    remove: removeFromRoster,
  } = useWorkspaceRoster();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileFailed, setProfileFailed] = useState(false);
  const [activity, setActivity] = useState<Record<string, WorkspaceActivity>>({});
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [editingWorkspace, setEditingWorkspace] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);


  useEffect(() => {
    getProfile().then(
      (profile) => { setProfile(profile); setProfileFailed(false); },
      () => setProfileFailed(true),
    );
  }, []);

  // Reflect the open workspace's live status on its roster row, and carry its
  // nested agent roster for the mock's indented block.
  useEffect(() => {
    const h = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const parsed = v.safeParse(WorkspaceActivityEventSchema, e.detail);
      if (!parsed.success) return;
      const { name, running, unseenChangelog, agents } = parsed.output;
      setActivity((prev) => ({ ...prev, [name]: { running, unseenChangelog, agents } }));
    };
    window.addEventListener("kinu:workspace-activity", h);
    return () => window.removeEventListener("kinu:workspace-activity", h);
  }, []);


  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (userMenuRef.current && e.target instanceof Node && !userMenuRef.current.contains(e.target)) {
        setShowUserMenu(false);
      }
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const name = deleteTarget.name;
    setDeleteBusy(true);
    setDeleteError(null);
    // Leave the agent's workspace BEFORE destroying it: the still-mounted
    // useAgent socket would auto-reconnect to the destroyed DO name and
    // resurrect an empty ghost agent (idFromName instantiates on connect).
    if (name === agentId) navigate("/");
    try {
      await removeWorkspace(name);
      removeFromRoster(name);
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(renderThrownChain({ cause: err }));
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteTarget, agentId, navigate, removeFromRoster]);

  // The responsive wrappers (desktop rail / mobile drawer) live in layout.tsx;
  // this renders just the column content so both reuse one roster + user menu.
  const activeAgents = agentId ? activity[agentId]?.agents : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2.5 px-5 pt-[18px] pb-2">
        <Link to="/" className="flex items-center" aria-label="Kinu home">
          <KinuLogo />
        </Link>
      </div>

      {/* New workspace — the outlined control the mock draws, into the
          mission-first screen (the home route). */}
      <div className="px-3.5 pb-1.5">
        <Button
          type="button"
          variant="secondary"
          size="base"
          onClick={() => navigate("/")}
          className="!h-10 w-full justify-center"
          icon={<PlusIcon size={15} weight="bold" />}
        >
          New workspace
        </Button>
      </div>

      {/* Workspace list */}
      <div className="flex-1 overflow-y-auto pt-2 pb-3">
        <div className="px-5 pb-2 pt-4 font-mono text-[9px] tracking-[.18em] uppercase p-text-4">
          Workspaces{workspaceTotal > workspaces.length ? ` · ${workspaces.length}/${workspaceTotal}` : ""}
        </div>
        {workspaces.length === 0 && !listError && (
          <div className="px-5 py-3 text-xs p-text-3">No workspaces yet.</div>
        )}
        {listError && (
          <button
            onClick={refreshWorkspaces}
            className="w-full text-left px-5 py-2 text-xs p-warning rounded-md p-card-hover transition-colors"
          >Couldn't load workspaces. Tap to retry.</button>
        )}
        <ul>
          {workspaces.map((a) => {
            const age = shortAge(a.lastVisited);
            const live = activity[a.name];
            const editing = editingWorkspace === a.name;
            const isActive = a.name === agentId;
            return (
              <li key={a.name}>
                <div className="group relative mx-2">
                  {editing ? (
                    <SidebarRenameEditor
                      workspace={a}
                      onCancel={() => setEditingWorkspace(null)}
                      onSaved={(displayName) => {
                        renameWorkspace(a.name, displayName);
                        setEditingWorkspace(null);
                      }}
                    />
                  ) : (
                    <>
                      <NavLink
                        to={`/workspace/${a.name}`}
                        className={({ isActive: linkActive }) =>
                          `flex items-center gap-2 rounded-lg py-[7px] pl-3 pr-16 transition-colors ${
                            linkActive ? 'bg-[var(--c-elevated)]' : 'hover:bg-[var(--c-elevated)]'
                          }`
                        }
                      >
                        {/* One dot, four honest states: working (green pulse),
                            unread self-changes (accent), the open workspace
                            (the mock's gold selection dot), plain row (none). */}
                        <span className="size-1.5 shrink-0 rounded-full">
                          {live?.running
                            ? <span className="block size-1.5 rounded-full p-dot-success p-dot-pulse" title="Working now" />
                            : (live?.unseenChangelog ?? 0) > 0
                              ? <span className="block size-1.5 rounded-full p-dot-accent" title={`${live!.unseenChangelog} new self-change${live!.unseenChangelog === 1 ? "" : "s"}`} />
                              : isActive
                                ? <span className="block size-1.5 rounded-full p-dot-accent" />
                                : null}
                        </span>
                        <span className={`min-w-0 flex-1 truncate text-[13px] ${isActive ? 'font-semibold p-text' : 'font-semibold p-text-2'}`}>{a.displayName}</span>
                        {age && <span className="shrink-0 text-[10.5px] tabular-nums p-text-4 opacity-0 transition-opacity lg:opacity-100 lg:group-hover:opacity-0">{age}</span>}
                      </NavLink>
                      <Link
                        to={`/settings/${a.name}`}
                        className="absolute right-11 top-1/2 -translate-y-1/2 p-1 opacity-60 transition-all p-text-3 hover:p-gold focus-visible:opacity-100 lg:opacity-0 lg:group-hover:opacity-60"
                        title="Workspace settings"
                        aria-label={`Workspace settings for ${a.displayName}`}
                      ><GearIcon size={11} /></Link>
                      <button
                        onClick={() => setEditingWorkspace(a.name)}
                        className="absolute right-6 top-1/2 -translate-y-1/2 p-1 opacity-60 transition-all p-text-3 hover:p-text focus-visible:opacity-100 lg:opacity-0 lg:group-hover:opacity-60"
                        title="Rename"
                        aria-label={`Rename workspace ${a.displayName}`}
                      ><PencilSimpleIcon size={11} /></button>
                      <button
                        onClick={() => { setDeleteError(null); setDeleteTarget(a); }}
                        className="absolute right-1 top-1/2 -translate-y-1/2 p-1 opacity-60 transition-all p-text-3 hover:p-danger focus-visible:opacity-100 lg:opacity-0 lg:group-hover:opacity-60"
                        title="Remove"
                        aria-label={`Remove workspace ${a.displayName}`}
                      ><TrashIcon size={11} /></button>
                    </>
                  )}
                </div>

                {/* Nested subordinates — the open workspace's real roster, in
                    the mock's indented block with its left rule. */}
                {isActive && activeAgents && activeAgents.length > 0 && (
                  <div className="ml-[21px] mt-0.5 border-l p-border pl-2.5">
                    {activeAgents.map((sub) => (
                      <NavLink
                        key={sub.name}
                        to={`/workspace/${a.name}/agents/${sub.name}`}
                        className="flex items-center gap-2 rounded-lg px-2.5 py-[5px] transition-colors hover:bg-[var(--c-elevated)]"
                        title={sub.role}
                      >
                        <span className={`size-1.5 shrink-0 rounded-full ${sub.status === "working" ? "p-dot-success p-dot-pulse" : sub.status === "awaiting_input" ? "p-dot-warning" : "bg-[var(--c-fill)] border p-border"}`} />
                        <span className="min-w-0 flex-1 truncate text-[12.5px] p-text-2">{sub.displayName}</span>
                        <span className="shrink-0 max-w-20 truncate text-[10px] p-text-4">{sub.role}</span>
                      </NavLink>
                    ))}
                    <button
                      onClick={() => window.dispatchEvent(new CustomEvent("kinu:hire-subordinate"))}
                      className="w-full rounded-lg px-2.5 py-[5px] text-left text-[11.5px] p-text-4 transition-colors hover:p-gold"
                    >
                      + New agent
                    </button>
                  </div>
                )}
                {isActive && activeAgents && activeAgents.length === 0 && (
                  <div className="ml-[21px] mt-0.5 border-l p-border pl-2.5">
                    <button
                      onClick={() => window.dispatchEvent(new CustomEvent("kinu:hire-subordinate"))}
                      className="w-full rounded-lg px-2.5 py-[5px] text-left text-[11.5px] p-text-4 transition-colors hover:p-gold"
                    >
                      + New agent
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* Account row — pinned to bottom; the gear opens the same menu as
          clicking the row. */}
      <div className="border-t p-border px-4 py-3.5 relative" ref={userMenuRef}>
        <button
          onClick={() => setShowUserMenu((v) => !v)}
          className="flex w-full min-w-0 items-center gap-2.5 text-left"
        >
          <div className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-[#2A2018] text-[12px] font-semibold text-[var(--c-accent)]">
            {profile?.email?.[0]?.toUpperCase() ?? '?'}
          </div>
          <span className="min-w-0 flex-1 truncate text-[13px] p-text-4">
            {profile?.email ?? (profileFailed ? 'Profile unavailable' : 'loading…')}
          </span>
          <GearIcon size={14} className="shrink-0 p-text-4 transition-colors hover:p-gold" />
        </button>
        {showUserMenu && (
          <div className="absolute bottom-full left-2 right-2 mb-1 p-card p-1.5 p-shadow-menu border p-border z-10">
            <Link to="/user/settings" onClick={() => setShowUserMenu(false)}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm p-card-hover">
              <GearIcon size={14} />
              <span>Account settings</span>
            </Link>
            <ModeToggle />
            <a
              href="/logout"
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm p-card-hover"
            >
              <SignOutIcon size={14} />
              <span>Sign out</span>
            </a>
          </div>
        )}
      </div>

      {deleteTarget && (
        <Modal
          title="Remove workspace"
          icon={<TrashIcon size={18} className="p-danger" />}
          onClose={() => setDeleteTarget(null)}
          busy={deleteBusy}
          footer={<>
            <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>Cancel</Button>
            <FilledButton danger onClick={confirmDelete} disabled={deleteBusy}>
              {deleteBusy ? "Removing…" : "Remove"}
            </FilledButton>
          </>}
        >
          <p className="text-xs p-text-2 leading-relaxed">
            Remove <span className="font-medium p-text">{deleteTarget.displayName}</span> and clear its
            server-side state? This cannot be undone.
          </p>
          {deleteError && (
            <div className="p-notice-danger text-xs rounded-md px-3 py-2">Could not remove: {deleteError}</div>
          )}
        </Modal>
      )}
    </div>
  );
}
