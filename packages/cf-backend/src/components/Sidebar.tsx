import { useEffect, useState, useCallback, useRef, type FormEvent, type ReactNode } from "react";
import { Link, NavLink, useMatch, useNavigate } from "react-router-dom";
import { GearIcon, TrashIcon, SignOutIcon, PencilSimpleIcon, CheckIcon, XIcon, PlusIcon, ShieldCheckIcon, SidebarSimpleIcon,
} from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import { FilledButton } from "./ui/FilledButton";
import { KinuLogo } from "./ui/KinuLogo";
import { removeWorkspace, type WorkspaceEntry } from "../lib/user-api";
import { useAccount } from "@/hooks/use-account";
import { useCloseOnOutsideClick } from "@/hooks/use-close-on-outside-click";
import { useWorkspaceRpc, type ConnectionStatus } from "../hooks/use-kinu";
import { useWorkspaceRoster } from "../hooks/use-workspace-roster";
import { lastValue } from "../hooks/use-async-resource";
import { ModeToggle } from "./theme-toggle";
import { FeedbackButton } from "./FeedbackButton";
import { agentTitle } from "./SubordinateTabs";
import { isPlaceholderWorkspaceTitle, shortAge, workspaceDisplayTitle } from "@kinu.run/core";
import { Modal } from "./ui/Modal";
import * as v from "valibot";
import { renderCauseChain, renderThrownChain } from "@kinu.run/core/obs";
import { PRIMARY_NAV } from "./nav";

function PrimaryNavRow({ to, label, Icon, end }: {
  to: string; label: string; Icon: React.ComponentType<{ size?: number; className?: string }>; end: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-2.5 rounded-lg py-[7px] pl-3 pr-3 p-t-control transition-colors ${
          isActive ? 'bg-[var(--c-elevated)] p-text' : 'p-text-2 hover:bg-[var(--c-elevated)]'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <Icon size={15} className={isActive ? 'p-accent' : 'p-text-3'} />
          <span>{label}</span>
        </>
      )}
    </NavLink>
  );
}


// Deleting an agent must first leave all of these: a mounted socket auto-reconnects and resurrects the DO.
const WORKSPACE_SCOPED_SECTIONS = ["workspace", "mcts", "settings", "triggers"];

interface SidebarAgent {
  name: string;
  displayName: string;
  status: string;
}

const SidebarAgentSchema = v.object({
  name: v.string(),
  displayName: v.string(),
  status: v.string(),
});

function subordinateDot(status: string): string {
  if (status === "working") return "p-dot-success p-dot-pulse";

  if (status === "awaiting_input") return "p-dot-warning";

  return "bg-[var(--c-fill)] border p-border";
}

function connectionWait(status: ConnectionStatus): string {
  if (status === "connecting") return "Connecting…";

  if (status === "disconnected") return "Reconnecting…";

  return "Could not connect";
}

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


function SidebarRenameEditor({ workspace, onSaved, onCancel }: {
  workspace: WorkspaceEntry;
  onSaved: (displayName: string) => void;
  onCancel: () => void;
}) {
  const { rpc, connectionStatus } = useWorkspaceRpc(workspace.name);
  const [value, setValue] = useState(workspace.displayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reported = error !== null && error !== "";

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
          aria-label={`Rename ${workspaceDisplayTitle(workspace)}`}
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
      {(reported || connectionStatus !== "connected") && (
        <div role={error || connectionStatus === "error" ? "alert" : "status"} className={`px-1 pt-1 p-meta truncate ${error || connectionStatus === "error" ? "p-danger" : "p-text-3"}`} title={error ?? undefined}>
          {error ?? connectionWait(connectionStatus)}
        </div>
      )}
    </form>
  );
}

export default function Sidebar({ onCollapse }: { onCollapse?: () => void } = {}) {
  // Sidebar renders outside the route's Outlet, so useParams cannot see :agentId.
  const sectionMatch = useMatch({ path: "/:section/:agentId/*", end: false });

  const agentId = sectionMatch && WORKSPACE_SCOPED_SECTIONS.includes(sectionMatch.params.section ?? "")
    ? sectionMatch.params.agentId
    : undefined;

  const onHome = useMatch({ path: "/", end: true }) !== null;

  const navigate = useNavigate();

  const {
    entries: workspaces,
    total: workspaceTotal,
    error: listError,
    refresh: refreshWorkspaces,
    rename: renameWorkspace,
    remove: removeFromRoster,
  } = useWorkspaceRoster();

  const account = useAccount();
  const profile = lastValue(account.profile);
  const profileFailed = account.profile.status === "error";
  const [activity, setActivity] = useState<Record<string, WorkspaceActivity>>({});
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [editingWorkspace, setEditingWorkspace] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const userMenuRef = useRef<HTMLDivElement>(null);

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


  const closeUserMenu = useCallback(() => setShowUserMenu(false), []);
  useCloseOnOutsideClick(showUserMenu, userMenuRef, closeUserMenu);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const name = deleteTarget.name;
    setDeleteBusy(true);
    setDeleteError(null);

    // Navigate away first: a mounted useAgent socket reconnects and idFromName resurrects an empty agent.
    try {
      if (name === agentId) await navigate("/");
      await removeWorkspace(name);
      removeFromRoster(name);
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(renderThrownChain({ cause: err }));
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteTarget, agentId, navigate, removeFromRoster]);

  const activeAgents = agentId ? activity[agentId]?.agents : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2.5 pl-5 pr-3 pt-[18px] pb-2">
        <Link to="/" className="flex items-center" aria-label="Kinu home">
          <KinuLogo />
        </Link>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Hide sidebar"
            title="Hide sidebar"
            data-rail-collapse
            className="rounded-md p-1.5 p-text-3 transition-colors hover:bg-[var(--c-elevated)] hover:p-text"
          >
            <SidebarSimpleIcon size={17} />
          </button>
        )}
      </div>

      {!onHome && (
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
      )}
      <nav aria-label="Primary" className="px-2 pt-1 space-y-0.5">
        {PRIMARY_NAV.map((item) => <PrimaryNavRow key={item.to} {...item} />)}
      </nav>
      <div className="flex-1 overflow-y-auto pt-2 pb-3">
        <div className="px-5 pb-2 pt-4 p-eyebrow">
          Workspaces{workspaceTotal > workspaces.length ? ` · ${workspaces.length}/${workspaceTotal}` : ""}
        </div>
        {workspaces.length === 0 && !listError && (
          <div className="px-5 py-3 text-xs p-text-3">No workspaces yet.</div>
        )}
        {listError && (
          <button
            onClick={refreshWorkspaces}
            className="w-full text-left px-5 py-2 text-xs p-warning rounded-md p-card-hover transition-colors"
          >Could not load workspaces. Retry</button>
        )}
        <ul className="space-y-0.5">
          {workspaces.map((a) => {
            const age = shortAge(a.lastVisited);
            const live = activity[a.name];
            const editing = editingWorkspace === a.name;
            const isActive = a.name === agentId;
            const shown = workspaceDisplayTitle(a);

            let dot: ReactNode = null;

            if (live?.running) {
              dot = <span className="block size-1.5 rounded-full p-dot-success p-dot-pulse" title="Working now" />;
            } else if (live !== undefined && live.unseenChangelog > 0) {
              dot = <span className="block size-1.5 rounded-full p-dot-accent" title={`${live.unseenChangelog} new self-change${live.unseenChangelog === 1 ? "" : "s"}`} />;
            } else if (isActive) {
              dot = <span className="block size-1.5 rounded-full p-dot-accent" />;
            }

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
                          `flex items-center gap-2 rounded-lg py-[7px] pl-3 pr-16 lg:pr-3 lg:group-hover:pr-16 lg:group-focus-within:pr-16 transition-colors ${
                            linkActive ? 'bg-[var(--c-elevated)]' : 'hover:bg-[var(--c-elevated)]'
                          }`
                        }
                      >
                        <span className="size-1.5 shrink-0 rounded-full">{dot}</span>
                        <span className={`min-w-0 flex-1 truncate p-row-text ${isActive ? 'font-semibold p-text' : 'font-semibold p-text-2'} ${isPlaceholderWorkspaceTitle(a.displayName, a.name) ? 'italic p-text-3' : ''}`}>{shown}</span>
                        {age && <span className="w-[30px] shrink-0 text-right p-meta tabular-nums p-text-4 opacity-0 transition-opacity lg:opacity-100 lg:group-hover:opacity-0 lg:group-focus-within:opacity-0">{age}</span>}
                      </NavLink>
                      <Link
                        to={`/settings/${a.name}`}
                        className="absolute right-11 top-1/2 -translate-y-1/2 p-1 opacity-60 transition-all p-text-3 hover:p-accent focus-visible:opacity-100 lg:opacity-0 lg:group-hover:opacity-60"
                        title="Workspace settings"
                        aria-label={`Workspace settings for ${shown}`}
                      ><GearIcon size={11} /></Link>
                      <button
                        onClick={() => setEditingWorkspace(a.name)}
                        className="absolute right-6 top-1/2 -translate-y-1/2 p-1 opacity-60 transition-all p-text-3 hover:p-text focus-visible:opacity-100 lg:opacity-0 lg:group-hover:opacity-60"
                        title="Rename"
                        aria-label={`Rename workspace ${shown}`}
                      ><PencilSimpleIcon size={11} /></button>
                      <button
                        onClick={() => { setDeleteError(null); setDeleteTarget(a); }}
                        className="absolute right-1 top-1/2 -translate-y-1/2 p-1 opacity-60 transition-all p-text-3 hover:p-danger focus-visible:opacity-100 lg:opacity-0 lg:group-hover:opacity-60"
                        title="Remove"
                        aria-label={`Remove workspace ${shown}`}
                      ><TrashIcon size={11} /></button>
                    </>
                  )}
                </div>

                {isActive && activeAgents && activeAgents.length > 0 && (
                  <div className="ml-[21px] mt-0.5 border-l p-border pl-2.5">
                    {activeAgents.map((sub) => (
                      <NavLink
                        key={sub.name}
                        to={`/workspace/${a.name}/agents/${sub.name}`}
                        className="flex items-center gap-2 rounded-lg px-2.5 py-[5px] transition-colors hover:bg-[var(--c-elevated)]"
                        title={agentTitle(sub)}
                      >
                        <span className={`size-1.5 shrink-0 rounded-full ${subordinateDot(sub.status)}`} />
                        <span className="min-w-0 flex-1 truncate p-row-text p-text-2">{agentTitle(sub)}</span>
                      </NavLink>
                    ))}
                    <button
                      onClick={() => window.dispatchEvent(new CustomEvent("kinu:new-agent"))}
                      className="w-full rounded-lg px-2.5 py-[5px] text-left p-t-control p-text-4 transition-colors hover:p-accent"
                    >
                      + New agent
                    </button>
                  </div>
                )}
                {isActive && activeAgents && activeAgents.length === 0 && (
                  <div className="ml-[21px] mt-0.5 border-l p-border pl-2.5">
                    <button
                      onClick={() => window.dispatchEvent(new CustomEvent("kinu:new-agent"))}
                      className="w-full rounded-lg px-2.5 py-[5px] text-left p-t-control p-text-4 transition-colors hover:p-accent"
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

      <div className="border-t p-border px-4 py-3.5 relative" ref={userMenuRef}>
        <button
          onClick={() => setShowUserMenu((shown) => !shown)}
          className="flex w-full min-w-0 items-center gap-2.5 text-left"
        >
          <div className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-[#2A2018] text-[12px] font-semibold text-[var(--c-accent)]">
            {profile?.email?.[0]?.toUpperCase() ?? '?'}
          </div>
          <span className="min-w-0 flex-1 truncate p-t-control p-text-4">
            {profile?.email ?? (profileFailed ? 'Could not load your profile' : 'Loading…')}
          </span>
          <GearIcon size={14} className="shrink-0 p-text-4 transition-colors hover:p-accent" />
        </button>
        {showUserMenu && (
          <div className="absolute bottom-full left-2 right-2 mb-1 p-card p-1.5 p-shadow-menu border p-border z-10">
            <Link to="/user/settings" onClick={() => setShowUserMenu(false)}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm p-card-hover">
              <GearIcon size={14} />
              <span>Account settings</span>
            </Link>
            {profile?.controlPlane === true && (
              <Link to="/control" onClick={() => setShowUserMenu(false)}
                className="flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm p-card-hover">
                <ShieldCheckIcon size={14} />
                <span>Control plane</span>
              </Link>
            )}
            <ModeToggle />
            <FeedbackButton />
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
            Remove <span className="font-medium p-text">{workspaceDisplayTitle(deleteTarget)}</span> and delete
            everything in it? This cannot be undone.
          </p>
          {deleteError && (
            <div className="p-notice-danger text-xs rounded-md px-3 py-2">Could not remove: {deleteError}</div>
          )}
        </Modal>
      )}
    </div>
  );
}
