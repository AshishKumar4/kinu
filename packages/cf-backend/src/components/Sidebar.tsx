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
import { useEffect, useState, useCallback, useRef } from "react";
import { Link, NavLink, useMatch, useNavigate } from "react-router-dom";
import { BrainIcon, PlusIcon, GearIcon, TrashIcon, SignOutIcon, CaretRightIcon } from "@phosphor-icons/react";
import { listWorkspaces, removeWorkspace, getProfile, type WorkspaceEntry, type UserProfile } from "../lib/user-api";
import { CreateWorkspaceModal } from "./CreateWorkspaceModal";
import { ModeToggle } from "./mode-toggle";

// Route families in App.tsx that mount a live useProteus/useAgent socket for
// :agentId. Deleting that agent must first navigate away from ALL of them —
// a still-mounted socket auto-reconnects and resurrects the destroyed DO.
const WORKSPACE_SCOPED_SECTIONS = ["workspace", "mcts", "settings", "triggers"];

export default function Sidebar() {
  // useParams can't see :agentId from here (the Sidebar renders outside the
  // route's Outlet) — match the location directly instead.
  const sectionMatch = useMatch("/:section/:agentId");
  const agentId = sectionMatch && WORKSPACE_SCOPED_SECTIONS.includes(sectionMatch.params.section ?? "")
    ? sectionMatch.params.agentId
    : undefined;
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const refreshWorkspaces = useCallback(async () => {
    try { setWorkspaces(await listWorkspaces()); }
    catch (err) { console.warn('[sidebar] listWorkspaces:', (err as Error).message); }
  }, []);

  useEffect(() => {
    refreshWorkspaces();
    getProfile().then(setProfile).catch(() => {});
  }, [refreshWorkspaces]);

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

  const handleDelete = useCallback(async (name: string) => {
    if (!confirm(`Delete workspace "${name}" and clear its server-side state?`)) return;
    // Leave the agent's workspace BEFORE destroying it: the still-mounted
    // useAgent socket would auto-reconnect to the destroyed DO name and
    // resurrect an empty ghost agent (idFromName instantiates on connect).
    if (name === agentId) navigate("/");
    try { await removeWorkspace(name); await refreshWorkspaces(); }
    catch (err) { alert(`Could not remove: ${(err as Error).message}`); }
  }, [agentId, navigate, refreshWorkspaces]);

  // The responsive wrappers (desktop rail / mobile drawer) live in layout.tsx;
  // this renders just the column content so both reuse one roster + user menu.
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Logo + new workspace */}
      <div className="px-3 pt-4 pb-2 flex flex-col gap-2">
        <Link to="/" className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:p-card transition-colors">
          <BrainIcon size={22} weight="duotone" className="p-accent" />
          <span className="font-medium tracking-tight">Proteus</span>
        </Link>
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
        {workspaces.length === 0 && (
          <div className="px-2 py-3 text-xs p-text-3">No workspaces yet. Click "New workspace" to start.</div>
        )}
        <ul className="space-y-0.5">
          {workspaces.map((a) => (
            // Link and delete button are siblings (a button inside an anchor is
            // invalid HTML and breaks keyboard/AT semantics); the button overlays
            // the row's right edge and is reachable by keyboard via focus-visible.
            <li key={a.name} className="group relative">
              <NavLink
                to={`/workspace/${a.name}`}
                className={({ isActive }) =>
                  `flex items-center gap-2 pl-2 pr-7 py-1.5 rounded-md text-sm ${
                    isActive ? 'p-card font-medium' : 'hover:p-card-hover p-text'
                  }`
                }
              >
                <span className="truncate">{a.displayName || a.name}</span>
              </NavLink>
              <button
                onClick={() => handleDelete(a.name)}
                className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-60 focus-visible:opacity-100 hover:!opacity-100 p-text-3 hover:p-danger transition-all p-1"
                title="Remove"
                aria-label={`Remove workspace ${a.displayName || a.name}`}
              ><TrashIcon size={12} /></button>
            </li>
          ))}
        </ul>
      </div>

      {/* User dropdown — pinned to bottom */}
      <div className="px-2 py-2 border-t p-border relative" ref={userMenuRef}>
        <button
          onClick={() => setShowUserMenu((v) => !v)}
          className="w-full flex items-center justify-between gap-2 px-2 py-2 rounded-lg hover:p-card transition-colors text-left"
        >
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-full p-accent-bg flex items-center justify-center text-xs font-medium p-accent shrink-0">
              {profile?.email?.[0]?.toUpperCase() ?? '?'}
            </div>
            <span className="text-xs p-text truncate">{profile?.email ?? 'loading...'}</span>
          </div>
          <CaretRightIcon size={12} className={`transition-transform p-text-3 ${showUserMenu ? 'rotate-90' : ''}`} />
        </button>
        {showUserMenu && (
          <div className="absolute bottom-full left-2 right-2 mb-1 p-card rounded-lg p-1.5 shadow-lg border p-border">
            <Link to="/user/settings" onClick={() => setShowUserMenu(false)}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:p-card-hover">
              <GearIcon size={14} />
              <span>Settings</span>
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
    </div>
  );
}
