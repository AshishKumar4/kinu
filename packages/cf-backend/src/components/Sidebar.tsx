import { useState, type FormEvent, type RefObject } from "react";
import { useLocation, useMatch } from "react-router-dom";
import { TrashIcon, PencilSimpleIcon, CheckIcon, XIcon, PlusIcon,
  UsersThreeIcon, CaretRightIcon, EraserIcon,
} from "@phosphor-icons/react";
import { SidebarHeader } from "./SidebarHeader";
import { SidebarFooter } from "./SidebarFooter";
import { useWorkspaceRpc, type ConnectionStatus } from "../hooks/use-chat-owner";
import { useWorkspaceRoster } from "../hooks/use-workspace-roster";
import { isPlaceholderWorkspaceTitle, rosterHeadline, shortAge, workspaceDisplayTitle, WORKSPACE_TITLE_MAX, type PanelAgent, type RosterEntry, type WorkspaceEntry } from "@kinu.run/core";
import { useRename } from "@/hooks/use-rename";
import { SidebarAgents } from "./SidebarAgents";
import { ChatMascot, WorkspaceLogo } from "@/components/ui/Marks";
import { useMascotOf } from "@/hooks/use-chat-mascot";
import { AgentStatusMark } from "./AgentStatus";
import { RemoveWorkspaceDialog } from "./RemoveWorkspaceDialog";
import { useAgentsNav, useOpenAgentsPanel, type WorkspaceAgentsPanel } from "@/hooks/use-agents-nav";
import { navActive, PRIMARY_NAV } from "./nav";
import { composing } from "@/components/ui/form";
import { StatusDot } from "@/components/ui/Status";
import { workspaceStatusTone } from "@/components/workspaces/workspace-status-tone";
import { Button } from "@/components/ui/Button";
import { Pressable } from "@/components/ui/Pressable";
import { TextInput } from "@/components/ui/Field";
import { NavRow, NavRowButton } from "@/components/ui/NavRow";
import { Surface } from "@/components/ui/Surface";

function PrimaryNavRow(item: (typeof PRIMARY_NAV)[number]) {
  const { to, label, Icon } = item;
  const active = navActive(item, useLocation().pathname);

  return (
    <NavRow to={to} current={active} className="gap-3">
      <Icon size={16} className={active ? 'p-accent-mark' : 'p-text-3'} />
      <span>{label}</span>
    </NavRow>
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
    <Surface look="panel" as="form" onSubmit={submit} className="px-1 py-1">
      <div className="flex items-center gap-1">
        <TextInput size="sm" className="min-w-0 flex-1" autoFocus value={draft} maxLength={WORKSPACE_TITLE_MAX} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
            if (event.key !== "Escape" || composing(event.nativeEvent) || saving) return;
            event.preventDefault();
            onDone();
          }} aria-label={label} />
        <Button variant="ghost" size="sm" icon={<CheckIcon size={14} />} type="submit" disabled={!draft.trim() || saving || waiting !== null} aria-label={saveLabel} />
        <Button variant="ghost" size="sm" icon={<XIcon size={14} />} onClick={onDone} disabled={saving} aria-label="Cancel rename" />
      </div>
      {said !== null && (
        <div role={error !== null || waiting?.failed === true ? "alert" : "status"} title={error ?? undefined}
          className={`t-meta px-1 pt-1 truncate ${error !== null || waiting?.failed === true ? "p-danger" : "p-text-3"}`}>
          {said}
        </div>
      )}
    </Surface>
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

export default function Sidebar({ onCollapse, accountOpen = false }: { onCollapse?: () => void; accountOpen?: boolean } = {}) {
  // Sidebar renders outside the route's Outlet, so useParams cannot see :agentId.
  const sectionMatch = useMatch({ path: "/:section/:agentId/*", end: false });
  const { pathname } = useLocation();

  const agentId = sectionMatch && WORKSPACE_SCOPED_SECTIONS.includes(sectionMatch.params.section ?? "")
    ? sectionMatch.params.agentId
    : undefined;


  const agentsNav = useAgentsNav();
  const { panel, drilled } = useOpenAgentsPanel(agentId);

  const {
    entries: roster,
    total: rosterTotal,
    error: listError,
    loading: listLoading,
    refresh: refreshWorkspaces,
    rename: renameWorkspace,
  } = useWorkspaceRoster();

  // The owner's assistant is Home, so it is not listed again here.
  const workspaces = roster.filter((entry) => entry.home !== true);
  const workspaceTotal = rosterTotal - (roster.length - workspaces.length);

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
        <div className="t-label px-5 pb-2 pt-4 p-text-3">
          Workspaces{workspaceTotal > workspaces.length ? ` · ${workspaces.length}/${workspaceTotal}` : ""}
        </div>
        {!listLoading && workspaces.length === 0 && !listError && (
          <div className="t-meta px-5 py-3 p-text-3">No workspaces yet.</div>
        )}
        {listError && (
          <Pressable className="t-meta px-5 py-2 p-warning" onClick={refreshWorkspaces}>Could not load workspaces. Retry</Pressable>
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
                      <NavRow to={`/workspace/${a.name}`} current={pathname === `/workspace/${a.name}` && panel === null}
                        className="pr-12 lg:pr-3 lg:group-hover:pr-12 lg:group-focus-within:pr-12">
                        <span className="relative flex shrink-0">
                          <WorkspaceLogo title={shown} logo={a.logo} />
                          <span className="p-logo-badge"><WorkspaceDot entry={a} /></span>
                        </span>
                        <span className={`t-label min-w-0 flex-1 truncate ${isPlaceholderWorkspaceTitle(a.displayName, a.name) ? `italic ${isActive ? '' : 'p-text-3'}` : ''}`}>{shown}</span>
                        {age && <span className="t-meta w-8 shrink-0 text-right tabular-nums p-text-3 opacity-0 transition-opacity lg:opacity-100 lg:group-hover:opacity-0 lg:group-focus-within:opacity-0">{age}</span>}
                      </NavRow>
                      <Button variant="ghost" size="sm" icon={<PencilSimpleIcon size={14} />} className="absolute right-6 top-1/2 -translate-y-1/2 opacity-60 transition-opacity focus-visible:opacity-100 lg:opacity-0 lg:group-hover:opacity-70" onClick={() => setEditingWorkspace(a.name)} title="Rename" aria-label={`Rename workspace ${shown}`} />
                      <Button variant="danger" size="sm" icon={<TrashIcon size={14} />} className="absolute right-1 top-1/2 -translate-y-1/2 opacity-60 transition-opacity focus-visible:opacity-100 lg:opacity-0 lg:group-hover:opacity-70" onClick={() => setDeleteTarget(a)} title="Remove" aria-label={`Remove workspace ${shown}`} />
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

      <SidebarFooter initiallyOpen={accountOpen} />
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
    <ul className="p-nest mb-1 ml-6 mr-2 mt-px space-y-px" aria-label="Chats">
      {chats.map((chat: PanelAgent) => (
        <li key={chat.key}>
          {renaming === chat.key
            ? <RowRenameEditor value={chat.label} label={`Rename ${chat.label}`} saveLabel="Save chat name" save={panel.actions(chat).rename}
                waiting={null} onDone={() => setRenaming(null)} />
            : <ChatRow chat={chat} panel={panel} onRename={() => setRenaming(chat.key)} />}
        </li>
      ))}
      <li>
        <NavRow to={`/workspace/${panel.workspace}/new`} size="sm" quiet>
          <PlusIcon size={14} className="shrink-0" aria-hidden /> <span className="t-body">New agent</span>
        </NavRow>
      </li>
      <li>
        <NavRowButton ref={trigger} size="sm" quiet onClick={onAgents} data-agents-counter>
          <UsersThreeIcon size={14} className="shrink-0" aria-hidden />
          <span className="t-body flex-1">All agents</span>
          {working && <AgentStatusMark activity="working" />}
          {others > 0 && <span className="t-meta tabular-nums p-text-3">{others}</span>}
          <CaretRightIcon size={14} aria-hidden />
        </NavRowButton>
      </li>
    </ul>
  );
}

/** A chat's row, with the tab's own rename and delete beside its name: on hover with a pointer, always at a touch. */
function ChatRow({ chat, panel, onRename }: { chat: PanelAgent; panel: WorkspaceAgentsPanel; onRename: () => void }) {
  const { remove, clears = false } = panel.actions(chat);
  const look = useMascotOf(panel.workspace)(chat.key, chat.colour);
  const reveal = "opacity-60 transition-opacity focus-visible:opacity-100 lg:opacity-0 lg:group-hover/chat:opacity-70 lg:group-focus-within/chat:opacity-70";

  return (
    <div className="group/chat relative">
      <NavRowButton size="sm" current={panel.shown === chat.key} onClick={() => panel.open(chat)} data-workspace-chat={chat.key} data-status={chat.activity}
        aria-current={panel.shown === chat.key ? "page" : undefined}
        className={`p-halo relative ${remove ? "pr-12 lg:pr-3 lg:group-hover/chat:pr-12 lg:group-focus-within/chat:pr-12" : "pr-8 lg:pr-3 lg:group-hover/chat:pr-8 lg:group-focus-within/chat:pr-8"}`}>
        <ChatMascot seed={look.seed} colour={look.colour} activity={chat.activity} />
        <span className="t-body p-status-label min-w-0 flex-1 truncate">{chat.label}</span>
      </NavRowButton>
      <Button variant="ghost" size="sm" icon={<PencilSimpleIcon size={14} />} onClick={onRename} title="Rename" aria-label={`Rename chat ${chat.label}`}
        className={`absolute top-1/2 -translate-y-1/2 ${remove ? "right-6" : "right-1"} ${reveal}`} />
      {remove && (
        <Button variant="danger" size="sm" icon={clears ? <EraserIcon size={14} /> : <TrashIcon size={14} />} onClick={remove} title={clears ? "Clear" : "Delete"}
          aria-label={`${clears ? "Clear" : "Delete"} chat ${chat.label}`} className={`absolute right-1 top-1/2 -translate-y-1/2 ${reveal}`} />
      )}
    </div>
  );
}
