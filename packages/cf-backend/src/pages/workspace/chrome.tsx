import { useState, type ReactNode } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { GitBranchIcon, ListIcon } from "@phosphor-icons/react";
import { countOf, workspaceRoute, WORKSPACE_ADDRESS_MAX } from "@kinu.run/core";
import { liveStep, threadLiveTail } from "@kinu.run/core";
import { useKinu } from "@/hooks/use-kinu";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { useAgentsNav } from "@/hooks/use-agents-nav";
import { ActivityView } from "@/components/workspaces/ActivityView";
import { DESKTOP_LANDING } from "@/hooks/use-workbench-surfaces";
import NotFoundPage from "@/pages/NotFoundPage";
import { Modal } from "@/components/ui/Modal";
import { type PanelAgent } from "@kinu.run/core";
import { FocusBar, WorkspaceBarActions, WorkspaceHeader, type ChatTab } from "@/components/WorkspaceHeader";
import { useMascotOf } from "@/hooks/use-chat-mascot";
import { RemoveWorkspaceDialog } from "@/components/RemoveWorkspaceDialog";
import { DeleteChatDialog } from "@/components/DeleteChatDialog";
import { NewChatView } from "@/components/workspaces/NewChatView";
import { WorkspaceOverview } from "@/components/workspaces/WorkspaceOverview";
import { WorkspaceSettings } from "@/pages/SettingsPage";
import { useLayoutDrawer } from "@/components/layout";
import { workspaceTitleDraft } from "@kinu.run/core";
import { TextInput } from "@/components/ui/Field";
import { type InspectorControl } from "@/components/WorkbenchPanels";
import { Notice } from "@/components/ui/Notice";
import { IconControl } from "@/components/ui/IconControl";
import { useLabelledStep } from "@/hooks/use-labelled-step";
import { MAIN_UNREAD, openBarItem } from "./agents-panel";

export function ForkModal({
  sourceName, messagesUpToHere, onCancel, onSubmit,
}: {
  sourceName: string;
  messagesUpToHere: number;
  onCancel: () => void;
  /** Throws on RPC error so the modal can display it. */
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const { busy, error, run } = useLabelledStep();
  const submit = (): void => run("fork", async () => onSubmit(name.trim()));

  return (
    <Modal
      title="Fork the workspace from here"
      icon={<GitBranchIcon size={18} className="p-accent-fg" />}
      onClose={onCancel}
      busy={busy !== null}
      footer={<>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy !== null}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={submit} busy={busy !== null}>
          {busy !== null ? "Forking…" : "Fork"}
        </Button>
      </>}
    >
      <div className="t-meta p-text-2 space-y-2">
        <p>Create a new workspace from <span className="font-mono p-text">{sourceName}</span>, with its own conversation and its own copy of the files.</p>
        <ul className="list-disc list-inside space-y-px p-text-3">
          <li>Conversation: the {countOf(messagesUpToHere, "message")} up to this one</li>
          <li>Files: the project, SOUL.md and memory as they are now, not as they were at this message</li>
          <li>Also copied: learned tools and settings</li>
          <li>Starts fresh: swarm trees, evolution events, scaffold, installed runtimes</li>
          <li>Source workspace is unaffected</li>
        </ul>
      </div>

      <div className="space-y-1">
        <label className="t-meta p-text-3 block">Fork name (optional)</label>
        <TextInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="a generated address, e.g. quiet-harbor-3f9a2c1d"
          disabled={busy !== null}
          className="t-mono"
        />
        <p className="t-meta p-text-3">Lowercase letters, digits and hyphens, at most {WORKSPACE_ADDRESS_MAX} characters</p>
      </div>

      {error !== null && <Notice tone="danger">{error}</Notice>}
    </Modal>
  );
}

/** A chat's delete, asked from its tab or its sidebar row: deleting the chat on screen returns to Main. */
export function DeleteChat({ chat, workspace, shown, dismiss, onClose }: {
  chat: { readonly title: string; readonly path: string } | null;
  workspace: string;
  shown: string | undefined;
  dismiss: WorkspaceState["dismissSubagent"];
  onClose: () => void;
}) {
  const navigate = useNavigate();

  if (chat === null) return null;

  return (
    <DeleteChatDialog title={chat.title} onClose={onClose} onConfirm={async () => {
      await dismiss(chat.path, false);

      if (shown === chat.path) await navigate(workspaceRoute(workspace));
    }} />
  );
}

export function MainClearDialog({ open, agents, onClear, onClose }: {
  open: boolean;
  agents: readonly PanelAgent[];
  onClear: () => Promise<void>;
  onClose: () => void;
}) {
  if (!open) return null;

  return <DeleteChatDialog title={agents.find((agent) => agent.key === MAIN_UNREAD.key)?.label ?? MAIN_UNREAD.label} clears onConfirm={onClear} onClose={onClose} />;
}

export type WorkspaceState = ReturnType<typeof useKinu>;

/** The workspace's bar, with the dialogs its delete controls open. In the `focus` layout the chat tabs give way to
 *  who is talking and what they are doing, until the person asks for the tabs. Until its layout is known it is bare. */
export function WorkspaceBar({ workspace, title, editValue, state, agents, shown, view, inspector, actions, focus, pending }: {
  workspace: string;
  title: string;
  editValue: string;
  state: WorkspaceState;
  agents: readonly PanelAgent[];
  shown: PanelAgent | undefined;
  view: string | undefined;
  inspector: InspectorControl | null;
  actions: (agent: PanelAgent) => ChatTab;
  /** The `focus` layout's identity: the name it goes by and its line. */
  focus: FocusIdentity | null;
  /** Neither the workspace's status nor the roster has said which layout it is. */
  pending: boolean;
}) {
  const drawer = useLayoutDrawer();
  const agentsNav = useAgentsNav();
  const { entries, rename } = useWorkspaceRoster();
  const logo = entries.find((entry) => entry.name === workspace)?.logo;
  const [removing, setRemoving] = useState(false);
  const [tabsShown, setTabsShown] = useState(false);
  const working = agents.filter((agent) => !agent.tab && agent.activity === "working").length;
  const chats = agents.filter((agent) => agent.tab).map(actions);
  const menu = drawer && <IconControl place="bar" onClick={drawer} aria-label="Open menu"><ListIcon size={18} /></IconControl>;
  const barActions = <WorkspaceBarActions workspace={workspace} working={working} view={view} inspector={inspector} onAgents={() => agentsNav.enter(workspace)} />;
  const speaking = shown ?? agents.find((agent) => agent.category === "main");
  const mascotOf = useMascotOf(workspace);

  if (pending) return <header className="p-bar" data-workspace-bar data-layout="pending">{menu && <div className="p-bar-menu">{menu}</div>}</header>;

  if (focus !== null && !tabsShown && view === undefined) {
    return (
      <FocusBar
        workspace={{ name: workspace, title, logo, to: workspaceRoute(workspace, "activity") }}
        agent={{
          label: focus.label ?? "", ...mascotOf(speaking?.key ?? "main", speaking?.colour ?? 0), activity: speaking?.activity,
        }}
        line={focus.line}
        leading={menu}
        trailing={barActions}
        {...(chats.length > 1 && { tabs: { count: chats.length, show: () => setTabsShown(true) } })}
      />
    );
  }

  return (
    <>
      <WorkspaceHeader
        workspace={{
          name: workspace,
          title, logo, to: workspaceRoute(workspace, "overview"), editValue,
          rename: async (name) => { rename(workspace, (await state.rpc("setDisplayName", [name])).displayName); }, remove: () => setRemoving(true),
        }}
        chats={chats}
        active={openBarItem(view, shown)}
        newChat={workspaceRoute(workspace, "new")}
        leading={menu}
        trailing={barActions}
      />
      {removing && <RemoveWorkspaceDialog workspace={{ name: workspace, displayName: editValue }} onClose={() => setRemoving(false)} />}
    </>
  );
}

/** The workspace's own pages, under the bar the chats share. */
export function WorkspaceView({ view, workspace, title, state, agents, open, clearMain }: {
  view: string;
  workspace: string;
  title: string;
  state: WorkspaceState;
  agents: readonly PanelAgent[];
  open: (agent: PanelAgent) => void;
  clearMain: () => void;
}) {
  const entry = useWorkspaceRoster().entries.find((each) => each.name === workspace);
  const logo = entry?.logo;

  if (view === "settings") {
    return <WorkspaceSettings workspace={workspace} title={title} titleDraft={entry === undefined ? null : workspaceTitleDraft(entry)}
      logo={logo} state={state} clearMain={clearMain} />;
  }

  if (view === "new") return <NewChatView workspace={workspace} title={title} createChat={state.createSubagent} />;

  // The desktop's own page went with D99: its address lands on the desktop where it lives now, the Environment surface.
  if (view === "desktop") return <Navigate to={`${workspaceRoute(workspace)}?${DESKTOP_LANDING}`} replace />;

  // What the agent did and is doing, from its chat and its watches (1018-xao, Muse's activity log).
  if (view === "activity") return <ActivityView workspace={workspace} title={title} rpc={state.rpc} now={liveStep(threadLiveTail({ last: state.messages.at(-1), liveness: state.liveness }))} />;

  if (view !== "overview") return <NotFoundPage />;

  return <WorkspaceOverview workspace={workspace} title={title} logo={logo} rpc={state.rpc} readMoves={state.readMoves}
    plan={state.activePlan} arrival={state.workspacePlanArrival}
    lineage={state.status?.forkLineage ?? null} agents={agents} open={open} />;
}

export function GoneWorkspace() {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center" data-workspace-gone>
      <p className="t-body p-text">This workspace no longer exists</p>
      <p className="t-meta p-text-3">It was deleted, here or somewhere else.</p>
      <Link to="/" className="t-meta mt-1 p-accent-fg hover:underline">Back to your workspaces</Link>
    </div>
  );
}

/** What the `focus` layout's bar says: the name it goes by (its agent's, else the workspace's title) and its line. */
export interface FocusIdentity {
  readonly label?: string;
  readonly line: ReactNode;
}
