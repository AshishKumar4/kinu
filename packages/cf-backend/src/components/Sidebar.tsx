import { useState, type FormEvent, type RefObject } from "react";
import { Link, NavLink, useLocation, useMatch } from "react-router-dom";
import { TrashIcon, PencilSimpleIcon, CheckIcon, XIcon, PlusIcon,
  UsersThreeIcon, CaretRightIcon, EraserIcon,
} from "@phosphor-icons/react";
import { SidebarHeader } from "./SidebarHeader";
import { useWorkspaceRpc, type ConnectionStatus } from "../hooks/use-chat-owner";
import { useWorkspaceRoster } from "../hooks/use-workspace-roster";
import { isPlaceholderWorkspaceTitle, rosterHeadline, shortAge, workspaceDisplayTitle, WORKSPACE_TITLE_MAX, type PanelAgent, type RosterEntry, type WorkspaceEntry } from "@kinu.run/core";
import { useRename } from "@/hooks/use-rename";
import { SidebarAgents } from "./SidebarAgents";
import { ChatMascot, WorkspaceLogo, mascotColour, mascotSeed } from "./Marks";
import { AgentStatusMark } from "./AgentStatus";
import { RemoveWorkspaceDialog } from "./RemoveWorkspaceDialog";
import { useAgentsNav, useOpenAgentsPanel, type WorkspaceAgentsPanel } from "@/hooks/use-agents-nav";
import { navActive, navRowCls, PRIMARY_NAV } from "./nav";
import { composing } from "@/components/ui/form";
import { StatusDot } from "@/components/ui/Status";
import { workspaceStatusTone } from "@/components/workspaces/workspace-status-tone";

function PrimaryNavRow(item: (typeof PRIMARY_NAV)[number]) {
  const { to, label, Icon } = item;
  const active = navActive(item, useLocation().pathname);

  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2.5 rounded-lg py-[7px] pl-3 pr-3 p-t-control transition-colors ${navRowCls(active)}`}
    >
      <Icon size={15} className={active ? 'p-accent-mark' : 'p-text-3'} />
      <span>{label}</span>
    </Link>
  );
}


const WORKSPACE_SCOPED_SECTIONS = ["workspace", "swarm"];

function connectionWait(status: ConnectionStatus): string {
  if (status === "connecting") return "Connecting…";

  if (status === "disconnected") return "Reconnecting…";

  return "Could not connect";
}

/** A row's name edited in place: Enter or ✓ saves, Escape or × leaves it as it was, and a refusal stays under it. */
function RowRenameEditor({ value, label, saveLabel, save, waiting, onDone }: {
  value: string;
  /** The field's name for a reader. */
  label: string;
  saveLabel: string;
  save: (name: string) => Promise<void>;
  /** Why it cannot save yet, said under the field; null when it can. */
  waiting: { readonly text: string; readonly failed: boolean } | null;
  onDone: () => void;
}) {
  const { draft, setDraft, saving, error, commit } = useRename(value, save, onDone);

  const submit = (event: FormEvent): void => {
    event.preventDefault();

    if (waiting === null) commit(draft);
  };

  const said = error ?? waiting?.text ?? null;

  return (
    <form onSubmit={submit} className="p-card px-1.5 py-1">
      <div className="flex items-center gap-1">
        <input
          autoFocus
          value={draft}
          maxLength={WORKSPACE_TITLE_MAX}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || composing(event.nativeEvent) || saving) return;
            event.preventDefault();
            onDone();
          }}
          className="min-w-0 flex-1 rounded-sm px-1.5 py-1 text-xs p-elevated p-text border p-border focus:outline-none focus:border-[var(--c-accent)] focus:ring-1 focus:ring-[var(--c-accent-subtle)]"
          aria-label={label}
        />
        <button
          type="submit"
          disabled={!draft.trim() || saving || waiting !== null}
          className="rounded-sm p-1 p-text-3 hover:p-text p-card-hover disabled:opacity-40"
          aria-label={saveLabel}
        ><CheckIcon size={12} /></button>
        <button
          type="button"
          onClick={onDone}
          disabled={saving}
          className="rounded-sm p-1 p-text-3 hover:p-text p-card-hover"
          aria-label="Cancel rename"
        ><XIcon size={12} /></button>
      </div>
      {said !== null && (
        <div role={error !== null || waiting?.failed === true ? "alert" : "status"} title={error ?? undefined}
          className={`px-1 pt-1 p-meta truncate ${error !== null || waiting?.failed === true ? "p-danger" : "p-text-3"}`}>
          {said}
        </div>
      )}
    </form>
  );
}

/** The workspace's name, saved through its own socket: it waits, and says so, until that socket connects. */
function WorkspaceRenameEditor({ workspace, onSaved, onDone }: {
  workspace: WorkspaceEntry;
  onSaved: (displayName: string) => void;
  onDone: () => void;
}) {
  const { rpc, connectionStatus } = useWorkspaceRpc(workspace.name);

  return (
    <RowRenameEditor value={workspace.displayName} label={`Rename ${workspaceDisplayTitle(workspace)}`} saveLabel="Save workspace name"
      waiting={connectionStatus === "connected" ? null : { text: connectionWait(connectionStatus), failed: connectionStatus === "error" }}
      save={async (name) => { onSaved((await rpc("setDisplayName", [name])).displayName); }}
      onDone={onDone} />
  );
}

/** A workspace at work pulses; one with news, or the open one, wears the accent. */
/** The workspace's headline as a dot on its logo, as the Workspaces card says it; an idle one has none. */
function WorkspaceDot({ entry }: { entry: RosterEntry }) {
  const { label, status } = rosterHeadline(entry.overview, entry.decisions);

  if (status === "idle" || status === "unreported") return null;

  return <StatusDot className="block" tone={workspaceStatusTone(status)} title={label} />;
}

export default function Sidebar({ onCollapse }: { onCollapse?: () => void } = {}) {
  // Sidebar renders outside the route's Outlet, so useParams cannot see :agentId.
  const sectionMatch = useMatch({ path: "/:section/:agentId/*", end: false });

  const agentId = sectionMatch && WORKSPACE_SCOPED_SECTIONS.includes(sectionMatch.params.section ?? "")
    ? sectionMatch.params.agentId
    : undefined;


  const agentsNav = useAgentsNav();
  const { panel, drilled } = useOpenAgentsPanel(agentId);

  const {
    entries: workspaces,
    total: workspaceTotal,
    error: listError,
    loading: listLoading,
    refresh: refreshWorkspaces,
    rename: renameWorkspace,
  } = useWorkspaceRoster();

  const [editingWorkspace, setEditingWorkspace] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceEntry | null>(null);





  return (
    <div className="group/side flex h-full min-h-0 flex-col">
      <SidebarHeader onCollapse={onCollapse} />
      <nav aria-label="Primary" className="px-2 pt-1 space-y-1">
        {PRIMARY_NAV.map((item) => <PrimaryNavRow key={item.to} {...item} />)}
      </nav>
      {/* Clipped, never scrollable: a scrollIntoView, a focus or a find-in-page that reaches the panel off to the side
          would scroll a hidden overflow, and the slide would then land both panels half out of view. */}
      <div className="relative min-h-0 flex-1 overflow-clip">
      <div className="p-slide" data-drilled={drilled || undefined}>
      <div className="h-full overflow-y-auto pt-2 pb-3" inert={drilled}>
        <div className="px-5 pb-2 pt-4 p-eyebrow">
          Workspaces{workspaceTotal > workspaces.length ? ` · ${workspaces.length}/${workspaceTotal}` : ""}
        </div>
        {!listLoading && workspaces.length === 0 && !listError && (
          <div className="px-5 py-3 text-xs p-text-3">No workspaces yet.</div>
        )}
        {listError && (
          <button
            onClick={refreshWorkspaces}
            className="w-full text-left px-5 py-2 text-xs p-warning rounded-md p-card-hover transition-colors"
          >Could not load workspaces. Retry</button>
        )}
        <ul className="space-y-1" aria-busy={listLoading && !listError}>
          {workspaces.map((a) => {
            const age = shortAge(a.lastVisited);
            const editing = editingWorkspace === a.name;
            const isActive = a.name === agentId;
            const shown = workspaceDisplayTitle(a);

            return (
              <li key={a.name}>
                <div className="group relative mx-2">
                  {editing ? (
                    <WorkspaceRenameEditor workspace={a} onSaved={(displayName) => { renameWorkspace(a.name, displayName); }}
                      onDone={() => setEditingWorkspace(null)} />
                  ) : (
                    <>
                      <NavLink
                        to={`/workspace/${a.name}`}
                        end
                        className={({ isActive: linkActive }) =>
                          `flex items-center gap-2 rounded-lg py-[7px] pl-3 pr-12 lg:pr-3 lg:group-hover:pr-12 lg:group-focus-within:pr-12 transition-colors ${navRowCls(linkActive && panel === null)}`
                        }
                      >
                        <span className="relative flex shrink-0">
                          <WorkspaceLogo title={shown} logo={a.logo} />
                          <span className="p-logo-badge"><WorkspaceDot entry={a} /></span>
                        </span>
                        <span className={`min-w-0 flex-1 truncate p-row-text font-semibold ${isPlaceholderWorkspaceTitle(a.displayName, a.name) ? `italic ${isActive ? '' : 'p-text-3'}` : ''}`}>{shown}</span>
                        {age && <span className="w-[30px] shrink-0 text-right p-meta tabular-nums p-text-4 opacity-0 transition-opacity lg:opacity-100 lg:group-hover:opacity-0 lg:group-focus-within:opacity-0">{age}</span>}
                      </NavLink>
                      <button
                        onClick={() => setEditingWorkspace(a.name)}
                        className="absolute right-6 top-1/2 -translate-y-1/2 p-1 opacity-60 transition-opacity p-text-3 hover:p-text focus-visible:opacity-100 lg:opacity-0 lg:group-hover:opacity-70"
                        title="Rename"
                        aria-label={`Rename workspace ${shown}`}
                      ><PencilSimpleIcon size={11} /></button>
                      <button
                        onClick={() => setDeleteTarget(a)}
                        className="absolute right-1 top-1/2 -translate-y-1/2 p-1 opacity-60 transition-opacity p-text-3 hover:p-danger focus-visible:opacity-100 lg:opacity-0 lg:group-hover:opacity-70"
                        title="Remove"
                        aria-label={`Remove workspace ${shown}`}
                      ><TrashIcon size={11} /></button>
                    </>
                  )}
                </div>
                {isActive && panel !== null && <WorkspaceChats panel={panel} trigger={agentsNav.trigger} onAgents={() => agentsNav.enter(a.name)} />}
              </li>
            );
          })}
        </ul>
      </div>
      <div className="h-full" inert={!drilled}>
        {panel !== null && <SidebarAgents panel={panel} onBack={agentsNav.back} />}
      </div>
      </div>
      </div>

      {deleteTarget && <RemoveWorkspaceDialog workspace={deleteTarget} onClose={() => setDeleteTarget(null)} />}
    </div>
  );
}

/** The open workspace's chats under its row, as production draws them, with a way into every agent it runs. */
function WorkspaceChats({ panel, trigger, onAgents }: { panel: WorkspaceAgentsPanel; trigger: RefObject<HTMLButtonElement | null>; onAgents: () => void }) {
  const chats = panel.list.filter((agent) => agent.tab);
  const others = panel.list.length - chats.length;
  // The agents with no tab of their own work out of sight: their row says so while any of them does.
  const working = panel.list.some((agent) => !agent.tab && agent.activity === "working");
  const [renaming, setRenaming] = useState<string | null>(null);

  return (
    <ul className="p-nest mb-1 ml-[26px] mr-2 mt-0.5 space-y-px" aria-label="Chats">
      {chats.map((chat: PanelAgent) => (
        <li key={chat.key}>
          {renaming === chat.key
            ? <RowRenameEditor value={chat.label} label={`Rename ${chat.label}`} saveLabel="Save chat name" save={panel.actions(chat).rename}
                waiting={null} onDone={() => setRenaming(null)} />
            : <ChatRow chat={chat} panel={panel} onRename={() => setRenaming(chat.key)} />}
        </li>
      ))}
      <li>
        <Link to={`/workspace/${panel.workspace}/new`} className={`flex items-center gap-2 rounded-lg py-[6px] pl-2 pr-3 p-row-text transition-colors ${navRowCls(false, "p-text-3")}`}>
          <PlusIcon size={12} className="w-[13px] shrink-0" aria-hidden /> New agent
        </Link>
      </li>
      <li>
        <button ref={trigger} type="button" onClick={onAgents} data-agents-counter
          className={`flex w-full items-center gap-2 rounded-lg py-[6px] pl-2 pr-3 text-left p-row-text transition-colors ${navRowCls(false, "p-text-3")}`}>
          <UsersThreeIcon size={13} className="w-[13px] shrink-0" aria-hidden />
          <span className="flex-1">All agents</span>
          {working && <AgentStatusMark activity="working" />}
          {others > 0 && <span className="p-meta tabular-nums p-text-4">{others}</span>}
          <CaretRightIcon size={11} aria-hidden />
        </button>
      </li>
    </ul>
  );
}

/** A chat's row, with the tab's own rename and delete beside its name: on hover with a pointer, always at a touch. */
function ChatRow({ chat, panel, onRename }: { chat: PanelAgent; panel: WorkspaceAgentsPanel; onRename: () => void }) {
  const { remove, clears = false } = panel.actions(chat);
  const reveal = "opacity-60 transition-opacity focus-visible:opacity-100 lg:opacity-0 lg:group-hover/chat:opacity-70 lg:group-focus-within/chat:opacity-70";

  return (
    <div className="group/chat relative">
      <button type="button" onClick={() => panel.open(chat)} data-workspace-chat={chat.key} data-status={chat.activity}
        aria-current={panel.shown === chat.key ? "page" : undefined}
        className={`p-halo relative flex w-full min-w-0 items-center gap-2 rounded-lg py-[6px] pl-2 text-left transition-colors ${remove ? "pr-12 lg:pr-3 lg:group-hover/chat:pr-12 lg:group-focus-within/chat:pr-12" : "pr-7 lg:pr-3 lg:group-hover/chat:pr-7 lg:group-focus-within/chat:pr-7"} ${navRowCls(panel.shown === chat.key)}`}>
        <ChatMascot seed={mascotSeed(panel.workspace, chat.key)} colour={mascotColour(panel.workspace, chat.colour)} activity={chat.activity} />
        <span className="p-status-label min-w-0 flex-1 truncate p-row-text">{chat.label}</span>
      </button>
      <button type="button" onClick={onRename} title="Rename" aria-label={`Rename chat ${chat.label}`}
        className={`absolute top-1/2 -translate-y-1/2 p-1 p-text-3 hover:p-text ${remove ? "right-6" : "right-1"} ${reveal}`}>
        <PencilSimpleIcon size={11} />
      </button>
      {remove && (
        <button type="button" onClick={remove} title={clears ? "Clear" : "Delete"} aria-label={`${clears ? "Clear" : "Delete"} chat ${chat.label}`}
          className={`absolute right-1 top-1/2 -translate-y-1/2 p-1 p-text-3 hover:p-danger ${reveal}`}>
          {clears ? <EraserIcon size={11} /> : <TrashIcon size={11} />}
        </button>
      )}
    </div>
  );
}
