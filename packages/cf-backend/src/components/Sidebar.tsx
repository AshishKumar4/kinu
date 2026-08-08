/**
 * Left sidebar — ChatGPT/Codex-style.
 *
 *   ┌─────────────────┐
 *   │ ◉  Proteus      │
 *   │ + New workspace │
 *   │ ─── Agents ───  │
 *   │ ● refactor-X    │
 *   │ ○ exploration   │
 *   │ ...             │
 *   │ ─────────────── │
 *   │ 👤 user.email   │
 *   │   ⚙ Settings    │
 *   │   ⎋ Sign out    │
 *   └─────────────────┘
 */
import { useEffect, useState, useCallback, useRef, type FormEvent } from "react";
import { Link, NavLink, useMatch, useNavigate } from "react-router-dom";
import { BrainIcon, PlusIcon, GearIcon, GithubLogoIcon, TrashIcon, SignOutIcon, CaretRightIcon, PencilSimpleIcon, CheckIcon, XIcon, SunIcon, MoonIcon } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import { listWorkspaces, removeWorkspace, getProfile, type WorkspaceEntry, type UserProfile } from "../lib/user-api";
import { useWorkspaceRpc } from "../hooks/use-proteus";
import { useTheme, toggleTheme } from "../hooks/use-theme";
import { CreateWorkspaceModal } from "./CreateWorkspaceModal";
import { ModeToggle } from "./mode-toggle";
import { Modal } from "./ui/Modal";

/** Live per-workspace activity, bridged from the mounted WorkspacePage socket
 *  via a window event (only the open workspace has a live socket, so the roster
 *  reflects status for workspaces visited this session). */
interface WorkspaceActivity { running: boolean; unseenChangelog: number; }

// Route families in App.tsx that mount a live useProteus/useAgent socket for
// :agentId. Deleting that agent must first navigate away from ALL of them —
// a still-mounted socket auto-reconnects and resurrects the destroyed DO.
const WORKSPACE_SCOPED_SECTIONS = ["workspace", "mcts", "settings", "triggers"];

function relativeActivity(lastVisited: number): string | null {
  if (!lastVisited) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - lastVisited) / 1000));
  if (seconds < 60) return "Active just now";
  if (seconds < 3600) return `Active ${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `Active ${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2_592_000) return `Active ${Math.floor(seconds / 86400)}d ago`;
  if (seconds < 31_536_000) return `Active ${Math.floor(seconds / 2_592_000)}mo ago`;
  return `Active ${Math.floor(seconds / 31_536_000)}y ago`;
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
      setError(err instanceof Error ? err.message : "Rename failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="p-card rounded-md px-1.5 py-1">
      <div className="flex items-center gap-1">
        <input
          autoFocus
          value={value}
          maxLength={60}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape" && !saving) onCancel(); }}
          className="min-w-0 flex-1 rounded px-1.5 py-1 text-xs p-elevated p-text border p-border focus:outline-none focus:border-[var(--c-accent)] focus:ring-1 focus:ring-[var(--c-accent-subtle)]"
          aria-label={`Rename ${workspace.displayName}`}
        />
        <button
          type="submit"
          disabled={!value.trim() || saving || connectionStatus !== "connected"}
          className="rounded p-1 p-text-3 hover:p-text hover:p-card-hover disabled:opacity-40"
          aria-label="Save workspace name"
        ><CheckIcon size={12} /></button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded p-1 p-text-3 hover:p-text hover:p-card-hover"
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
  const sectionMatch = useMatch("/:section/:agentId");
  const agentId = sectionMatch && WORKSPACE_SCOPED_SECTIONS.includes(sectionMatch.params.section ?? "")
    ? sectionMatch.params.agentId
    : undefined;
  const navigate = useNavigate();
  const mode = useTheme();
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [listError, setListError] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileFailed, setProfileFailed] = useState(false);
  const [activity, setActivity] = useState<Record<string, WorkspaceActivity>>({});
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [editingWorkspace, setEditingWorkspace] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const refreshWorkspaces = useCallback(async () => {
    try { setWorkspaces(await listWorkspaces()); setListError(false); }
    catch (err) { console.warn('[sidebar] listWorkspaces:', (err as Error).message); setListError(true); }
  }, []);

  useEffect(() => {
    refreshWorkspaces();
    getProfile().then((p) => { setProfile(p); setProfileFailed(false); }).catch(() => setProfileFailed(true));
  }, [refreshWorkspaces]);

  // Reflect the open workspace's live status on its roster row.
  useEffect(() => {
    const h = (e: Event) => {
      const { name, running, unseenChangelog } = (e as CustomEvent<{ name: string } & WorkspaceActivity>).detail;
      setActivity((prev) => ({ ...prev, [name]: { running, unseenChangelog } }));
    };
    window.addEventListener("proteus:workspace-activity", h);
    return () => window.removeEventListener("proteus:workspace-activity", h);
  }, []);

  // Re-sync when route changes (so a freshly-created workspace appears).
  useEffect(() => { refreshWorkspaces(); }, [agentId, refreshWorkspaces]);

  // Re-sync when the active workspace AI-renames itself after its first turn.
  useEffect(() => {
    const h = () => refreshWorkspaces();
    window.addEventListener("proteus:workspace-renamed", h);
    return () => window.removeEventListener("proteus:workspace-renamed", h);
  }, [refreshWorkspaces]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setShowUserMenu(false);
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
      await refreshWorkspaces();
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError((err as Error).message);
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteTarget, agentId, navigate, refreshWorkspaces]);

  // The responsive wrappers (desktop rail / mobile drawer) live in layout.tsx;
  // this renders just the column content so both reuse one roster + user menu.
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Logo + new workspace */}
      <div className="px-3 pt-4 pb-2 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:p-card transition-colors">
            <BrainIcon size={22} weight="duotone" className="p-accent" />
            <span className="font-medium tracking-tight">Proteus</span>
          </Link>
          <a
            href="https://github.com/AshishKumar4/Proteus"
            target="_blank" rel="noopener noreferrer" aria-label="GitHub repository"
            className="flex size-8 items-center justify-center rounded-md p-text-2 hover:p-card-hover hover:p-text transition-colors"
          >
            <GithubLogoIcon size={17} />
          </a>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-3 py-2 rounded-lg p-card hover:p-card-hover transition-colors text-sm cursor-pointer"
        >
          <PlusIcon size={14} />
          <span>New workspace</span>
        </button>
      </div>

      {/* Workspace list */}
      <div className="flex-1 overflow-y-auto px-2 pt-2 pb-3">
        <div className="text-[10px] font-medium p-text-3 uppercase tracking-wider px-2 pb-1">Workspaces</div>
        {workspaces.length === 0 && !listError && (
          <div className="px-2 py-3 text-xs p-text-3">No workspaces yet. Click "New workspace" to start.</div>
        )}
        {listError && (
          <button
            onClick={() => refreshWorkspaces()}
            className="w-full text-left px-2 py-2 text-xs p-warning rounded-md hover:p-card-hover transition-colors"
          >Couldn't load workspaces — tap to retry</button>
        )}
        <ul className="space-y-0.5">
          {workspaces.map((a) => {
            const lastActive = relativeActivity(a.lastVisited);
            const live = activity[a.name];
            const editing = editingWorkspace === a.name;
            return (
              <li key={a.name} className="group relative">
                {editing ? (
                  <SidebarRenameEditor
                    workspace={a}
                    onCancel={() => setEditingWorkspace(null)}
                    onSaved={(displayName) => {
                      setWorkspaces((current) => current.map((entry) => entry.name === a.name ? { ...entry, displayName } : entry));
                      setEditingWorkspace(null);
                    }}
                  />
                ) : (
                  <>
                    <NavLink
                      to={`/workspace/${a.name}`}
                      className={({ isActive }) =>
                        `flex min-w-0 flex-col pl-2 pr-12 py-1.5 rounded-md ${
                          isActive ? 'p-card' : 'hover:p-card-hover p-text'
                        }`
                      }
                    >
                      <span className="truncate text-sm font-medium">{a.displayName}</span>
                      {lastActive && <span className="truncate text-[10px] p-text-3 font-normal">{lastActive}</span>}
                    </NavLink>
                    {live && (live.running || live.unseenChangelog > 0) && (
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1 transition-opacity group-hover:opacity-0">
                        {live.running && <span className="size-1.5 rounded-full p-dot-success animate-pulse" title="Working now" />}
                        {live.unseenChangelog > 0 && <span className="size-1.5 rounded-full p-dot-accent" title={`${live.unseenChangelog} new self-change${live.unseenChangelog === 1 ? "" : "s"}`} />}
                      </span>
                    )}
                    <button
                      onClick={() => setEditingWorkspace(a.name)}
                      className="absolute right-6 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-60 focus-visible:opacity-100 hover:!opacity-100 p-text-3 hover:p-text transition-all p-1"
                      title="Rename"
                      aria-label={`Rename workspace ${a.displayName}`}
                    ><PencilSimpleIcon size={12} /></button>
                    <button
                      onClick={() => { setDeleteError(null); setDeleteTarget(a); }}
                      className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-60 focus-visible:opacity-100 hover:!opacity-100 p-text-3 hover:p-danger transition-all p-1"
                      title="Remove"
                      aria-label={`Remove workspace ${a.displayName}`}
                    ><TrashIcon size={12} /></button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* User dropdown — pinned to bottom, with a visible theme toggle */}
      <div className="px-2 py-2 border-t p-border relative" ref={userMenuRef}>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowUserMenu((v) => !v)}
            className="min-w-0 flex-1 flex items-center justify-between gap-2 px-2 py-2 rounded-lg hover:p-card transition-colors text-left"
          >
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 rounded-full p-accent-bg flex items-center justify-center text-xs font-medium p-accent shrink-0">
                {profile?.email?.[0]?.toUpperCase() ?? '?'}
              </div>
              <span className="text-xs p-text truncate">{profile?.email ?? (profileFailed ? 'Profile unavailable' : 'loading...')}</span>
            </div>
            <CaretRightIcon size={12} className={`transition-transform p-text-3 ${showUserMenu ? 'rotate-90' : ''}`} />
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            className="shrink-0 flex size-9 items-center justify-center rounded-lg p-text-3 hover:p-card hover:p-text transition-colors"
            title={mode === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            aria-label={mode === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          >
            {mode === 'light' ? <MoonIcon size={15} /> : <SunIcon size={15} />}
          </button>
        </div>
        {showUserMenu && (
          <div className="absolute bottom-full left-2 right-2 mb-1 p-card rounded-lg p-1.5 shadow-lg border p-border">
            <Link to="/user/settings" onClick={() => setShowUserMenu(false)}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:p-card-hover">
              <GearIcon size={14} />
              <span>Account settings</span>
            </Link>
            <ModeToggle />
            <a
              href="/logout"
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:p-card-hover"
            >
              <SignOutIcon size={14} />
              <span>Sign out</span>
            </a>
          </div>
        )}
      </div>

      {showCreate && <CreateWorkspaceModal onClose={() => setShowCreate(false)} />}

      {deleteTarget && (
        <Modal
          title="Remove workspace"
          icon={<TrashIcon size={18} className="p-danger" />}
          onClose={() => setDeleteTarget(null)}
          busy={deleteBusy}
          footer={<>
            <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={confirmDelete} disabled={deleteBusy}>
              {deleteBusy ? "Removing…" : "Remove"}
            </Button>
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
