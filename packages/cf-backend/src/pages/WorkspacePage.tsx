import { Effect, Cause } from 'effect';
import { Fragment, startTransition, useState, useRef, useEffect, useCallback, useMemo, type RefObject } from "react";
import { useParams, useLocation, Link, useMatch, useNavigate, useSearchParams } from "react-router-dom";
import { Button, Loader } from "@cloudflare/kumo";
import { FilledButton } from "@/components/ui/FilledButton";
import {
  ArrowsClockwiseIcon, GitBranchIcon, CheckCircleIcon, GearIcon, ListIcon, UsersThreeIcon,
  ClockIcon, WarningCircleIcon, DesktopTowerIcon, PaperclipIcon,
  ClockCounterClockwiseIcon, UserPlusIcon, type Icon,
} from "@phosphor-icons/react";
import {
  CLOUD_MAX_INLINE_ATTACHMENT_BYTES,
  isPlaceholderMission, summarizeRestorePlan,
} from "@kinu.run/core";
import type { AlternateTakeSet, DiffAnchor, FileRestoreChange, Rpc, TakePickOutcome } from "@kinu.run/core";
import type { SubordinateRosterEntry } from "@kinu.run/core/protocol";
import { useActorChat, useKinu, type WorkspaceNotice } from "@/hooks/use-kinu";
import { useAutogrow } from "@/hooks/use-autogrow";
import { useChatThread } from "@/hooks/use-chat-thread";
import { useConversationUiState, usePlanApprovedMode } from "@/hooks/use-conversation-ui-state";
import { useSteerActions } from "@/hooks/use-steer-actions";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { useAgentsNav } from "@/hooks/use-agents-nav";
import { usePendingAttachments } from "@/hooks/use-pending-attachments";
import { useFileDrop } from "@/hooks/use-file-drop";
import { touchWorkspace } from "@/lib/user-api";
import { describeError, useAsyncResource } from "@/hooks/use-async-resource";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { ConnectedModelPicker } from "@/components/ModelPicker";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Modal } from "@/components/ui/Modal";
import { RevertTurnDialog, type DeviceRestorePlan } from "@/components/RevertTurnDialog";
import { ChatLiveTail, DeviceOfflineRow, HelperChatBase, MessageView, ModelFallbackRows, SteerBubble } from "@/components/MessageView";
import { ProgrammaticTurnCard } from "@/components/ProgrammaticTurnCard";
import { TakesChip, BranchRunChip } from "@/components/AlternateTakes";
import { cloudPlanes, filesFocusOf, hasComparableTakes, referencePrefixes, WORKSPACE_ROOT, type FilesFocus } from "@kinu.run/core";
import { classifyProgrammaticTurn, messageSignalId, messagesUpTo, threadLiveTail, turnRows } from "@kinu.run/core";
import { WorkSurface } from "@/components/surfaces/WorkSurface";
import type { ChangesFocus } from "@/components/surfaces/ChangesSurface";
import { SlateInlineContext } from "@/components/slates/context";
import { ChatSlates } from "@/components/slates/InlineSlate";
import { SLATE_PREFIX, agentTitle, nestedAgent, type AgentLinkIds, type ForkNode, type PanelAgent, type SurfaceKind } from "@kinu.run/core";
import { ViewOnlyBar } from "@/components/ViewOnlyBar";
import { NodeTranscript } from "@/components/NodeTranscript";
import { FileLinkContext } from "@/components/surfaces/shared";
import { TranscriptViewport } from "@/components/TranscriptViewport";
import { KinuMark } from "@/components/ui/KinuLogo";
import { KeptChatColumn } from "@/components/KeptChatColumn";
import { WorkspaceHeader, type ChatTab } from "@/components/WorkspaceHeader";
import { RemoveWorkspaceDialog } from "@/components/RemoveWorkspaceDialog";
import { DeleteChatDialog } from "@/components/DeleteChatDialog";
import { NewChatView } from "@/components/workspaces/NewChatView";
import { WorkspaceOverview } from "@/components/workspaces/WorkspaceOverview";
import { WorkspaceSettings } from "@/pages/SettingsPage";
import { useLayoutDrawer } from "@/components/layout";
import { Composer, useProviderWaitNotice, workspaceLoadNotice, type ComposerNotice } from "@/components/Composer";
import { revealMisrepresenting, workspaceDisplayTitle, workspaceTitleDraft, type PendingConsent, type SubordinateActivityEvent } from "@kinu.run/core";
import { settleLogged, showing, detach, settle } from "@kinu.run/core/obs";
import { InspectorToggle, WorkbenchPanels, type InspectorControl, type WorkbenchHandle } from "@/components/WorkbenchPanels";
import { useCarriedAttachments, useOpeningMessage } from "@/components/workspaces/NewChatView";

/** The mission is shown as the standing brief, not sent as an opening message
 *  the agent would then try to carry out. */
export function EmptyConversation({ mission }: { mission: string }) {
  const brief = isPlaceholderMission(mission) ? null : mission.trim();

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <KinuMark size={34} className="mb-4 text-[var(--c-accent)] opacity-70" />
      {brief && (
        <>
          <p className="p-eyebrow">Mission</p>
          <p className="mt-2 max-w-md whitespace-pre-wrap p-heading p-title p-text-2">{brief}</p>
        </>
      )}
      <p className="mt-4 text-sm p-text-3">Send the first message to start.</p>
    </div>
  );
}

/** Fixed widths: a skeleton that reflows on every render is a second animation. */
const SKELETON_ROWS: readonly { mine: boolean; width: string }[] = [
  { mine: true, width: "38%" },
  { mine: false, width: "82%" },
  { mine: false, width: "64%" },
  { mine: true, width: "46%" },
  { mine: false, width: "74%" },
];

/** Shown between connect and transcript arrival, where EmptyConversation would falsely
 *  claim an empty chat. Transcript-shaped so messages land where the bars already are. */
export function ConversationSkeleton() {
  return (
    <div className="space-y-5" role="status" aria-busy="true" data-testid="conversation-skeleton">
      <span className="sr-only">Loading this conversation…</span>
      {SKELETON_ROWS.map((row, index) => (
        <div key={index} className={`flex ${row.mine ? "justify-end" : "justify-start"}`} aria-hidden>
          <div className="max-w-[82%] space-y-2" style={{ width: row.width }}>
            <div className="p-skeleton-bar h-3.5 rounded-md" />
            <div className="p-skeleton-bar h-3.5 w-[70%] rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Accepting creates a per-workspace binding, revocable on the Devices page. No tier:
 *  what a command may reach is the device's own Sandbox setting. */
export function DeviceConsentCard({ consent, onResolve }: {
  consent: PendingConsent;
  onResolve: (consentId: string, decision: "once" | "always" | "deny") => void;
}) {
  const forWhom = consent.workspaceName ? `“${consent.workspaceName}”` : "this workspace";

  return (
    <div className="p-tint-warning rounded-xl border p-3 animate-fade-in" data-device-bind={consent.consentId}>
      <div className="flex items-start gap-2">
        <DesktopTowerIcon size={16} className="p-warning shrink-0 mt-0.5" weight="fill" />
        <div className="min-w-0 flex-1">
          <div className="text-xs p-text">
            Use <span className="font-medium">{consent.deviceLabel}</span> for {forWhom}?
          </div>
          <code className="block mt-1 p-t-code p-text-2 break-all p-fill rounded-sm px-2 py-1">{revealMisrepresenting(consent.command || "(command)")}</code>
          <div className="mt-1 p-meta p-text-3">
            Commands use {consent.deviceLabel}'s Sandbox setting. Revoke access on the Devices page.
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2.5 justify-end">
        <button onClick={() => onResolve(consent.consentId, "deny")}
            className="px-2.5 py-1 p-t-control rounded-md p-text-3 hover:p-text">Not now</button>
        <button onClick={() => onResolve(consent.consentId, "always")}
            className="px-2.5 py-1 p-t-control rounded-md p-accent-bg p-accent hover:opacity-90">
          Use {consent.deviceLabel}
        </button>
      </div>
    </div>
  );
}

/** Retry re-runs the failed turn instead of appending a duplicate user message.
 *  `replayed`: the server re-serves its last terminal record until a later turn supersedes it. */
export function ChatErrorCard({ message, replayed, streaming, onRetry, onDismiss }: {
  message: string;
  replayed?: boolean;
  streaming: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="rounded-xl border p-3 animate-fade-in p-elevated" data-chat-error={replayed ? "replayed" : "live"}
      style={{ borderColor: replayed ? "var(--c-border)" : "var(--c-danger)" }}>
      <div className="flex items-start gap-2">
        <WarningCircleIcon size={16} className={`shrink-0 mt-0.5 ${replayed ? "p-text-3" : "p-danger"}`} weight="fill" />
        <div className="min-w-0 flex-1">
          <div className="text-xs p-text font-medium">
            {replayed
              ? "This workspace was last left on a failed turn"
              : "The last turn failed and produced no answer"}
          </div>
          <code className="block mt-1 p-t-code p-text-2 break-all p-card rounded-sm px-2 py-1 max-h-28 overflow-y-auto">{message}</code>
          <div className="p-meta p-text-3 mt-1.5">
            {replayed
              ? "This is the last turn's result. Retry runs that turn again."
              : "Retry reuses this message in the same conversation."}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2.5 justify-end">
        <button onClick={onDismiss}
          className="px-2.5 py-1 p-t-control rounded-md p-text-3 hover:p-text cursor-pointer">Dismiss</button>
        <button onClick={onRetry} disabled={streaming}
          className="px-2.5 py-1 p-t-control rounded-md p-accent-bg p-accent hover:opacity-90 disabled:opacity-40 cursor-pointer flex items-center gap-1">
          <ArrowsClockwiseIcon size={11} />Retry this turn
        </button>
      </div>
    </div>
  );
}

interface TerminalCloseState {
  readonly code: number;
  readonly reason: string;
  readonly message: string;
}

/** A terminal close means the SDK stopped redialling; it is not a reconnecting state. */
function TerminalCloseBoundary({ close, onRetry }: {
  close: TerminalCloseState;
  onRetry: () => void;
}) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
      <WarningCircleIcon size={28} className="p-danger" />
      <p className="text-sm p-text">
        {close.code === 1008 ? "Access to this workspace was denied" : "This workspace is unavailable"}
      </p>
      <p className="p-meta p-text-3 max-w-sm break-words">{close.reason || close.message}</p>
      <div className="flex items-center gap-3">
        <button type="button" onClick={onRetry} className="text-xs p-accent hover:underline">Try again</button>
        <Link to="/" className="text-xs p-accent hover:underline">Back to your workspaces</Link>
      </div>
    </div>
  );
}

type EventOutcome = "done" | "failed" | "progress";

function eventOutcome(status: string | undefined): EventOutcome {
  if (status === "completed") return "done";

  if (status === "failed" || status === "error") return "failed";

  return "progress";
}

const OUTCOME_MARK: Record<EventOutcome, { Icon: Icon; verb: string; tone: string }> = {
  done: { Icon: CheckCircleIcon, verb: "reported done", tone: "p-success" },
  failed: { Icon: WarningCircleIcon, verb: "hit an error", tone: "p-danger" },
  progress: { Icon: ClockIcon, verb: "reported progress", tone: "p-text-3" },
};

function SubordinateEventCard({ event, workspace }: { event: SubordinateActivityEvent; workspace: string }) {
  const { Icon: outcomeIcon, verb: outcomeVerb, tone } = OUTCOME_MARK[eventOutcome(event.status)];
  const assigned = event.kind === "task";
  const Icon = assigned ? UserPlusIcon : outcomeIcon;
  const verb = assigned ? "assigned" : outcomeVerb;
  const detail = event.task === undefined || event.task === "" ? event.content : event.task;

  return (
    <div className="flex justify-center animate-fade-in py-1">
      <Link
        to={`/workspace/${workspace}/agents/${event.subordinate}`}
        title={detail}
        className="inline-flex max-w-[80%] items-center gap-2 rounded-full border p-border p-elevated px-3 py-1.5 p-row-text p-text-2 p-card-hover transition-colors"
      >
        <Icon size={13} className={`${tone} shrink-0`} weight="fill" />
        <span className="truncate"><span className="font-medium p-text">{event.subordinate}</span> {verb}: {detail}</span>
      </Link>
    </div>
  );
}

function ForkModal({
  sourceName, messagesUpToHere, onCancel, onSubmit,
}: {
  sourceName: string;
  messagesUpToHere: number;
  onCancel: () => void;
  /** Throws on RPC error so the modal can display it. */
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(() => detach(Effect.gen(function* () {
    if (busy) return;
    setBusy(true);
    setErr(null);

    return yield* Effect.catchCause(Effect.gen(function* () {
      yield* Effect.promise(async () => onSubmit(name.trim()));
    }), showing((chain) => {
      setErr(chain);
      setBusy(false);
    }));
  })), [name, busy, onSubmit]);

  return (
    <Modal
      title="Fork the workspace from here"
      icon={<GitBranchIcon size={18} className="p-accent" />}
      onClose={onCancel}
      busy={busy}
      footer={<>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <FilledButton onClick={submit} disabled={busy}>
          {busy ? <><Loader size="sm" /><span className="ml-1">Forking…</span></> : "Fork"}
        </FilledButton>
      </>}
    >
      <div className="text-xs p-text-2 leading-relaxed space-y-1.5">
        <p>Create a new workspace from <span className="font-mono p-text">{sourceName}</span>, with its own conversation and its own copy of the files.</p>
        <ul className="list-disc list-inside space-y-0.5 p-text-3">
          <li>Conversation: the {messagesUpToHere} message{messagesUpToHere === 1 ? "" : "s"} up to this one</li>
          <li>Files: the project, SOUL.md and memory as they are now, not as they were at this message</li>
          <li>Also copied: learned tools and settings</li>
          <li>Starts fresh: swarm trees, evolution events, scaffold, installed runtimes</li>
          <li>Source workspace is unaffected</li>
        </ul>
      </div>

      <div className="space-y-1">
        <label className="p-meta p-text-3 block">Fork name (optional)</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="a generated address, e.g. quiet-harbor-3f9a2c1d"
          disabled={busy}
          className="w-full px-3 py-1.5 border p-border p-card text-sm font-mono focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]"
        />
        <p className="p-meta p-text-3">Lowercase letters, digits and hyphens, at most 31 characters</p>
      </div>

      {err && (
        <div className="p-notice-danger text-xs rounded-md px-3 py-2">
          {err}
        </div>
      )}
    </Modal>
  );
}

function NestedAgentColumn({ workspace, path, rpc, ids, input }: { workspace: string; path: string; rpc: Rpc; ids: AgentLinkIds; input: boolean }) {
  const { resource, reload } = useAsyncResource(() => nestedAgent(rpc, path, ids), undefined, `${path}|${ids.actor ?? ""}|${ids.parent ?? ""}`);

  if (resource.status === "loading") return <div className="flex flex-1 items-center justify-center"><Loader size="sm" /></div>;

  if (resource.status === "error") return <LoadFailure className="p-4" what={`${path}'s place in its roster`} message={resource.message} onRetry={reload} />;
  const agent = resource.value;

  if (agent === null) return <p className="p-4 text-sm p-text-3">No agent is at {path} in this workspace.</p>;

  return (
    <HelperChatBase.Provider value={{ base: helperBase(workspace, path), parent: agent.actorId }}>
      {agent.live
        ? <SubordinateChatColumn workspace={workspace} subName={path} title={agent.title} input={input} />
        : <KeptChatColumn workspace={workspace} subName={path} title={agent.title} rpc={rpc} actorId={agent.actorId} />}
    </HelperChatBase.Provider>
  );
}

function SwarmNodeColumn({ main, ownerPath, runId, nodeId, agent }: {
  main: ReturnType<typeof useKinu>;
  ownerPath: string | null;
  runId: string;
  nodeId: string;
  agent: PanelAgent;
}) {
  const working = agent.activity === "working";

  // Main's socket reads every journal and carries every head's stream.
  const rpc = useCallback<Rpc>(<T,>(method: string, args?: unknown[]) => main.rpc<T>(
    method, method === "getNodeTranscript" && ownerPath !== null ? [...(args ?? []).slice(0, 2), (args ?? [])[2] ?? {}, ownerPath] : args,
  ), [main, ownerPath]);

  const trees = useMemo(() => new Map<string, ForkNode>([[runId, {
    id: nodeId, parentId: null, depth: 0, value: null, visits: null, status: working ? "running" : "terminal",
    action: agent.label, children: [],
  }]]), [runId, nodeId, working, agent.label]);

  return (
    <div className="@container relative flex flex-col flex-1 min-h-0" data-agent-pane={`node/${runId}/${nodeId}`}>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-4">
        {agent.parent !== null && <p className="p-meta p-text-3">Swarm worker from {agent.parent}</p>}
        <NodeTranscript selection={{ runId, nodeId }} trees={trees} rpc={rpc} headActivity={main.headActivity}
          headDeltas={main.headDeltas} onSelect={() => undefined} />
      </div>
      {/* The workspace holds every running worker, whoever started the swarm; its siblings run on. */}
      <ViewOnlyBar running={working} onStop={() => detach(Effect.promise(async () => settleLogged("agents.stop_failed", { doing: "stop a swarm worker", otherwise: "io" },
        () => main.rpc("stopSwarmWorker", [nodeId]))))} />
    </div>
  );
}

const MAIN_AGENT: PanelAgent = {
  key: "main", label: "Main", category: "main", activity: "idle", parent: null,
  open: { kind: "chat", path: null }, tab: true, input: true, figures: { activeMs: 0, cacheEma: null },
};

function useAgentsPanel({ listed, live, workspace = "", node, subName, workbench }: {
  listed: readonly PanelAgent[] | null;
  live: boolean;
  workspace: string | undefined;
  node: string | null;
  subName: string | undefined;
  workbench: RefObject<WorkbenchHandle | null>;
}) {
  const navigate = useNavigate();

  const agents = useMemo((): readonly PanelAgent[] => {
    const main = listed?.find((agent) => agent.category === "main") ?? MAIN_AGENT;

    return [{ ...main, activity: mainActivity(main.activity, live) }, ...(listed ?? []).filter((agent) => agent.category !== "main")];
  }, [listed, live]);

  const shownAgent = useMemo(() => shownPanelAgent(agents, node, subName), [agents, node, subName]);

  const open = useCallback((agent: PanelAgent) => settleLogged("agents.open_failed", { doing: "open an agent's chat", otherwise: "io" }, async () => {
    await navigate(agentPagePath(workspace, agent));
    workbench.current?.showChat();
  }), [navigate, workspace, workbench]);

  const shown = shownAgent?.key ?? null;
  const panel = useMemo(() => ({ list: agents, shown, open }), [agents, shown, open]);

  return {
    shownAgent,
    rosterLoaded: listed !== null,
    panel,
  };
}

/** Main's mark follows this page's own socket for working, so the bar and the composer's Stop never disagree; a
 *  question for the person outranks either. */
function mainActivity(listed: PanelAgent["activity"], live: boolean): PanelAgent["activity"] {
  if (listed === "waiting") return listed;

  if (live) return "working";

  return listed === "working" ? "idle" : listed;
}

function shownPanelAgent(agents: readonly PanelAgent[], node: string | null, subName: string | undefined): PanelAgent | undefined {
  if (node !== null) return agents.find((agent) => agent.key === node);

  return agents.find((agent) => agent.open.kind === "chat" && agent.open.path === (subName ?? null));
}

function agentPagePath(workspace: string, { open }: PanelAgent): string {
  if (open.kind === "chat") return open.path === null ? `/workspace/${workspace}` : helperBase(workspace, open.path).slice(0, -1);
  const owner = open.owner === null ? "" : `&owner=${encodeURIComponent(open.owner)}`;

  return `/workspace/${workspace}?node=${encodeURIComponent(`${open.runId}/${open.nodeId}`)}${owner}`;
}

/** `node` is `<run>/<node>`. */
function SwarmNodePane({ main, node, ownerPath, agent, rosterLoaded }: {
  main: ReturnType<typeof useKinu>;
  node: string;
  ownerPath: string | null;
  agent: PanelAgent | undefined;
  rosterLoaded: boolean;
}) {
  const [runId = "", ...rest] = node.split("/");
  const nodeId = rest.join("/");

  if (agent === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center p-meta p-text-3" data-agent-pane={`node/${node}`}>
        {rosterLoaded ? "This swarm worker is no longer listed. Open the Agents panel to pick another." : "Loading this swarm worker…"}
      </div>
    );
  }

  return <SwarmNodeColumn main={main} ownerPath={ownerPath} runId={runId} nodeId={nodeId} agent={agent} />;
}

function MainClearDialog({ open, agents, onClear, onClose }: {
  open: boolean;
  agents: readonly PanelAgent[];
  onClear: () => Promise<void>;
  onClose: () => void;
}) {
  if (!open) return null;

  return <DeleteChatDialog title={agents.find((agent) => agent.key === MAIN_AGENT.key)?.label ?? MAIN_AGENT.label} clears onConfirm={onClear} onClose={onClose} />;
}

/** The workspace's own pages share the chat route's key, so the socket and the bar stay mounted across them. */
const WORKSPACE_VIEW = "/workspace/:agentId/:view";

/** Main is the workspace's own chat: its × clears the conversation and Main stays. A chat the person opened is deleted. */
function chatTab(workspace: string, agent: PanelAgent, actions: {
  renameMain: (title: string) => Promise<void>;
  renameChat: (path: string, title: string) => Promise<void>;
  clearMain: () => void;
  remove: (path: string) => void;
}): ChatTab {
  const path = agent.open.kind === "chat" ? agent.open.path : null;

  if (path === null) return { agent, to: `/workspace/${workspace}`, rename: actions.renameMain, remove: actions.clearMain, clears: true };

  return {
    agent, to: helperBase(workspace, path).slice(0, -1),
    rename: (title: string) => actions.renameChat(path, title),
    remove: () => actions.remove(path),
  };
}

/** The bar's open item: the overview, or the chat shown when it has a tab. */
function openBarItem(view: string | undefined, shown: PanelAgent | undefined): string | null {
  if (view === "overview") return "overview";

  return view === undefined && shown?.tab === true ? shown.key : null;
}

function helperBase(workspace: string, subName: string): string {
  return `/workspace/${workspace}/agents/${subName.split("/").map(encodeURIComponent).join("/")}/`;
}

/** A subordinate below a direct child is addressed by its `/`-joined path of names, as its socket and RPCs take it. */
function routedAgentPath({ subName, "*": below }: Readonly<Record<string, string | undefined>>): string | undefined {
  if (subName === undefined) return undefined;

  return [subName, ...(below ?? "").split("/").filter(Boolean)].join("/");
}

/** The work read names an owner by its own name, the last of its path. */
function planOwnerName(subName: string | undefined, agentId: string | undefined): string {
  if (subName !== undefined) return subName.slice(subName.lastIndexOf("/") + 1);

  return agentId ?? "main";
}

function AgentChatColumn({ workspace, subName, subordinates, rpc, ids, input }: {
  workspace: string;
  subName: string;
  subordinates: readonly SubordinateRosterEntry[];
  rpc: Rpc;
  ids: AgentLinkIds;
  input: boolean;
}) {
  if (subName.includes("/")) return <NestedAgentColumn workspace={workspace} path={subName} rpc={rpc} ids={ids} input={input} />;
  const rosterEntry = subordinates.find((entry) => entry.name === subName);
  let column = <SubordinateChatColumn workspace={workspace} subName={subName} title={rosterEntry ? agentTitle(rosterEntry) : subName} input={input} />;

  if (rosterEntry?.status === "dismissed") {
    // A dismissed agent has no socket; its kept chat is paged over this workspace's.
    column = <KeptChatColumn workspace={workspace} subName={subName} title={agentTitle(rosterEntry)} rpc={rpc} actorId={rosterEntry.actorId} />;
  }

  // A helper this agent asked opens below it.
  return <HelperChatBase.Provider value={{ base: helperBase(workspace, subName), parent: rosterEntry?.actorId ?? null }}>{column}</HelperChatBase.Provider>;
}

/** One subordinate's chat over its own facet socket; Work Surface and Timeline stay on
 *  the parent socket. The facet exposes no fork/feedback/takes/restore. */
function SubordinateChatColumn({
  workspace, subName, title, input: takesInput,
}: {
  workspace: string;
  subName: string;
  title: string;
  input: boolean;
}) {
  const state = useActorChat({ workspace, subordinate: subName });
  const live = state.liveness.kind === "live";
  const pickEffort = useCallback((effort: Parameters<typeof state.setReasoningEffort>[0]) => detach(Effect.promise(async () => state.setReasoningEffort(effort))), [state]);

  // No model write from an agent pane: only the workspace pin is honoured, and the
  // snapshot carries the actor's effective model, rendered read-only.

  const ui = useConversationUiState(`${workspace}/agents/${subName}`);
  const input = ui.draft;
  const setInput = ui.setDraft;
  usePlanApprovedMode(state.activePlan, ui.setMode);

  const chat = useChatThread({
    rpc: state.rpc, live: state.messages, seeded: state.transcriptSeeded,
    steerRuns: state.steerRuns, actor: state.paneActorId,
  });

  const { thread } = chat;

  const inputRef = useRef<HTMLTextAreaElement>(null);

  useAutogrow(inputRef, input);

  const { notice: steerNotice, send, stop } = useSteerActions({
    sendChat: (text, files) => state.sendChat(text, [...files], ui.mode),
    abortChat: state.abortChat,
    draft: input,
    setDraft: ui.updateDraft,
    steerRuns: state.steerRuns,
  });

  useOpeningMessage(state.connectionStatus === "connected", (text, files) => { state.sendChat(text, [...files], ui.mode); });

  if (state.terminalClose && !state.agentStatus) {
    return <TerminalCloseBoundary close={state.terminalClose} onRetry={state.retryLoad} />;
  }

  if (state.connectionStatus === "connecting" && !state.agentStatus) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex items-center gap-2 text-sm p-text-2"><Loader size="sm" /><span>Connecting…</span></div>
      </div>
    );
  }

  const as = state.agentStatus;

  // An admitted turn with the operator's message last has no assistant row to ask, so the
  // live indicator is decided here. See `threadLiveTail`.
  const tail = threadLiveTail({ last: thread.entries.at(-1)?.message, liveness: state.liveness });

  return (
    <div className="@container relative flex flex-col flex-1 min-h-0" data-agent-pane={`${workspace}/agents/${subName}`}>
      <ErrorBoundary label="Agent chat">
        <TranscriptViewport chat={chat} live={live} padClass="pt-5 pb-12"
          scroll={{ initialScroll: ui.savedScroll, onScrollPosition: ui.rememberScroll, settled: state.transcriptSeeded }}
          pending={<ConversationSkeleton />}
          empty={
            <div className="flex h-full flex-col items-center justify-center text-center">
              <KinuMark size={30} className="mb-3 text-[var(--c-accent)] opacity-60" />
              <p className="text-sm p-text-3">This agent's conversation starts here.</p>
            </div>
          }
          rows={(before) => thread.entries.map(({ message: msg, steers }, i) => (
            <Fragment key={msg.id}>
              {before(msg.id)}
              <MessageView message={msg} steers={steers} liveTail={i === thread.entries.length - 1 ? tail : null} />
            </Fragment>
          ))}>
          <ChatLiveTail tail={tail} />
          {thread.trailing.map((steer) => <SteerBubble key={steer.id} steer={steer} />)}
          {state.chatError && (
            <ChatErrorCard
              message={state.chatError.body}
              replayed={state.chatError.replayed}
              streaming={live}
              onRetry={state.retryLastMessage}
              onDismiss={state.clearChatError}
            />
          )}
        </TranscriptViewport>
      </ErrorBoundary>

      {!takesInput && <ViewOnlyBar running={live} onStop={stop} />}
      {takesInput && <div className="p-composer-dock">
        <Composer
          textareaRef={inputRef}
          value={input}
          onValueChange={setInput}
          onSend={send}
          placeholder={live
            ? `Steer ${title}…`
            : `Message ${title}…`}
          disabled={state.connectionStatus !== "connected"}
          liveness={state.liveness}
          onRecover={state.recoverTurn}
          onStop={stop}
          mode={{ value: ui.mode, onChange: ui.setMode }}
          modelPicker={<ConnectedModelPicker value={as?.model ?? ""} onChange={(...args: Parameters<typeof state.setModel>) => detach(Effect.promise(async () => state.setModel(...args)))} size="xs"
            effort={{ value: as?.reasoningEffort ?? null, onChange: pickEffort }} />}
          notices={[
            ...(loadNotices(state.error, state.retryLoad)),
            ...(state.newerDeployedBuild ? [{
              id: "version", tone: "info" as const,
              text: "A new version is ready. Reload this tab to use it.",
              action: { label: "Reload", icon: <ArrowsClockwiseIcon size={11} />, onClick: () => window.location.reload() },
            }] : []),
            ...(steerNotice ? [steerNotice] : []),
          ]}
        />
      </div>}
    </div>
  );
}

/** Each source keeps its own error so one recovery never hides another failure, and a
 *  failed hydrate never renders as "there is nothing". */
const SIDE_SOURCES = [
  { source: "visit", label: "record this visit" },
  { source: "feedback", label: "load your turn feedback" },
  { source: "takes", label: "load alternate takes" },
] as const;

type SideSource = (typeof SIDE_SOURCES)[number]["source"];

function loadNotices(error: WorkspaceNotice | null, onRetry: () => void): ComposerNotice[] {
  if (error === null) return [];
  const notice = workspaceLoadNotice(error, onRetry);

  if (error.retry !== null) {
    notice.action = {
      label: error.retry, icon: <ArrowsClockwiseIcon size={11} />, onClick: onRetry,
    };
  }

  return [notice];
}


type WorkspaceState = ReturnType<typeof useKinu>;

/** The workspace's bar, with the dialogs its delete controls open. */
function WorkspaceBar({ workspace, title, editValue, state, agents, shown, view, subName, inspector, clearMain }: {
  workspace: string;
  title: string;
  editValue: string;
  state: WorkspaceState;
  agents: readonly PanelAgent[];
  shown: PanelAgent | undefined;
  view: string | undefined;
  subName: string | undefined;
  inspector: InspectorControl | null;
  clearMain: () => void;
}) {
  const navigate = useNavigate();
  const drawer = useLayoutDrawer();
  const agentsNav = useAgentsNav();
  const logo = useWorkspaceRoster().entries.find((entry) => entry.name === workspace)?.logo;
  const [removing, setRemoving] = useState(false);
  const [deleting, setDeleting] = useState<{ title: string; path: string } | null>(null);

  const chats = agents.filter((agent) => agent.tab).map((agent) => chatTab(workspace, agent, {
    renameMain: async (name) => { await state.rpc("renameMainChat", [name]); },
    renameChat: async (path, name) => { await state.renameSubordinate(path, name); },
    clearMain,
    remove: (path) => setDeleting({ title: agent.label, path }),
  }));

  return (
    <>
      <WorkspaceHeader
        workspace={{
          name: workspace,
          title, logo, to: `/workspace/${workspace}/overview`, editValue,
          rename: async (name) => { await state.setDisplayName(name); }, remove: () => setRemoving(true),
        }}
        chats={chats}
        active={openBarItem(view, shown)}
        newChat={`/workspace/${workspace}/new`}
        leading={drawer && <button type="button" onClick={drawer} className="p-bar-icon" aria-label="Open menu"><ListIcon size={18} /></button>}
        trailing={<>
          <button type="button" onClick={() => agentsNav.enter(workspace)} className="p-bar-icon" aria-label="All agents" title="All agents">
            <UsersThreeIcon size={16} />
          </button>
          <Link to={`/workspace/${workspace}/settings`} className="p-bar-icon" aria-current={view === "settings" ? "page" : undefined}
            aria-label="Workspace settings" title="Workspace settings"><GearIcon size={16} /></Link>
          {view === undefined && inspector && <InspectorToggle control={inspector} />}
        </>}
      />
      {removing && <RemoveWorkspaceDialog workspace={{ name: workspace, displayName: editValue }} onClose={() => setRemoving(false)} />}
      {deleting && (
        <DeleteChatDialog title={deleting.title} onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await state.dismissSubordinate(deleting.path, false);

            if (subName === deleting.path) await navigate(`/workspace/${workspace}`);
          }} />
      )}
    </>
  );
}

/** The workspace's own pages, under the bar the chats share. */
function WorkspaceView({ view, workspace, title, state, agents, open }: {
  view: string;
  workspace: string;
  title: string;
  state: WorkspaceState;
  agents: readonly PanelAgent[];
  open: (agent: PanelAgent) => void;
}) {
  const logo = useWorkspaceRoster().entries.find((entry) => entry.name === workspace)?.logo;

  if (view === "settings") return <WorkspaceSettings workspace={workspace} title={title} logo={logo} state={state} />;

  if (view === "new") return <NewChatView workspace={workspace} title={title} createChat={state.createSubordinate} />;

  return <WorkspaceOverview workspace={workspace} title={title} logo={logo} rpc={state.rpc} readMoves={state.readMoves}
    lineage={state.agentStatus?.forkLineage ?? null} agents={agents} open={open} />;
}

function GoneWorkspace() {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center" data-workspace-gone>
      <p className="text-sm p-text">This workspace no longer exists</p>
      <p className="p-meta p-text-3">It was deleted, here or somewhere else.</p>
      <Link to="/" className="mt-1 text-xs p-accent hover:underline">Back to your workspaces</Link>
    </div>
  );
}

export default function WorkspacePage() {
  const { agentId } = useParams();
  const [gone, setGone] = useState<string | null>(null);

  if (agentId !== undefined && gone === agentId) return <GoneWorkspace />;

  // Unmounting closes its socket and every read it polls.
  return <OpenWorkspace key={agentId} onGone={setGone} />;
}

function OpenWorkspace({ onGone }: { onGone: (workspace: string) => void }) {
  const params = useParams();
  const { agentId } = params;
  const subName = routedAgentPath(params);
  const [search] = useSearchParams();
  const linkIds = useMemo<AgentLinkIds>(() => ({ actor: search.get("actor"), parent: search.get("parent") }), [search]);
  // `&owner=` names the agent whose swarm it is.
  const shownNode = search.get("node");
  const nodeOwner = search.get("owner");
  const location = useLocation();
  const navigate = useNavigate();
  const state = useKinu(agentId);
  const live = state.liveness.kind === "live";
  const { entries: workspaceEntries } = useWorkspaceRoster();

  const view = useMatch(WORKSPACE_VIEW)?.params.view;
  const [inspectorControl, setInspectorControl] = useState<InspectorControl | null>(null);

  // `setModel` records failure on `state.error` and rolls the picker back itself.
  const setModel = state.setModel;

  const onPickModel = useCallback(async (spec: string): Promise<void> => {
    await setModel(spec);
  }, [setModel]);

  const [sideErrors, setSideErrors] = useState<Partial<Record<SideSource, string>>>({});

  const pickEffort = useCallback((effort: Parameters<typeof state.setReasoningEffort>[0]) => detach(Effect.promise(async () => state.setReasoningEffort(effort))), [state]);

  const reportSide = useCallback((source: SideSource, message: string | null) => {
    setSideErrors((prev) => {
      if ((prev[source] ?? null) === message) return prev;
      const next = { ...prev };

      if (message === null) delete next[source];
      else next[source] = message;

      return next;
    });
  }, []);

  const sideFailed = useCallback((source: SideSource) => (failed: Cause.Cause<unknown>) => Effect.sync(() => {
    reportSide(source, describeError({ cause: Cause.squash(failed) }));
  }), [reportSide]);

  const visiblePlan = state.activePlan;
  const [surface, setSurface] = useState<SurfaceKind>("Work");
  const [changesFocus, setChangesFocus] = useState<ChangesFocus | null>(null);
  const workbench = useRef<WorkbenchHandle | null>(null);

  const { shownAgent, rosterLoaded, panel: agentsPanel } = useAgentsPanel({ listed: state.workspaceAgents, live, workspace: agentId, node: shownNode, subName, workbench });
  const agentsNav = useAgentsNav();
  const { publish } = agentsNav;

  useEffect(() => {
    if (agentId !== undefined) publish({ workspace: agentId, ...agentsPanel });
  }, [agentId, agentsPanel, publish]);

  // A surface opened from the chat, a note or a landing is brought into view; a collapsed inspector or a phone
  // showing the chat would hide it.
  const show = useCallback((next: SurfaceKind): void => {
    setSurface(next);
    workbench.current?.reveal();
  }, []);

  // A chat file link, or a `?file=<reference>` landing, opens Files on the file it names.
  const [filesFocus, setFilesFocus] = useState<FilesFocus | null>(null);

  const openFile = useCallback((reference: string): void => {
    const focus = filesFocusOf(reference);

    if (focus === null) return;
    setFilesFocus((prior) => ({ ...focus, nonce: (prior?.nonce ?? 0) + 1 }));
    show("Files");
  }, [show]);

  // Every prefix, and each live machine's own name: `<name>://x` opens that machine's file in Files.
  const machines = useMemo(() => state.executors.flatMap((executor) => executor.mounts ?? []), [state.executors]);
  const fileLinks = useMemo(() => ({ roots: referencePrefixes(cloudPlanes(WORKSPACE_ROOT), machines), open: openFile }), [machines, openFile]);
  const [landingFile, setLandingFile] = useState<string | null>(() => new URLSearchParams(location.search).get("file"));

  useEffect(() => {
    if (landingFile === null) return;
    openFile(landingFile);
    setLandingFile(null);
  }, [landingFile, openFile]);

  const openChangeNote = useCallback((source: string, anchor: DiffAnchor | undefined): void => {
    show("Changes");
    setChangesFocus((prior) => ({ source, path: anchor?.path ?? null, nonce: (prior?.nonce ?? 0) + 1 }));
  }, [show]);

  // `?slate=<id>&unmapped=1` is a blueprint fork's landing; the jump waits until the listing names the slate.
  const [landingSlate, setLandingSlate] = useState<string | null>(() => new URLSearchParams(location.search).get("slate"));
  const [unmappedSlate, setUnmappedSlate] = useState<string | null>(() => new URLSearchParams(location.search).get("unmapped") === "1" ? new URLSearchParams(location.search).get("slate") : null);
  useEffect(() => {
    if (landingSlate === null || !state.slates.some((slate) => slate.id === landingSlate)) return;
    show(`${SLATE_PREFIX}${landingSlate}`);
    setLandingSlate(null);
  }, [landingSlate, state.slates, show]);
  const ui = useConversationUiState(`${agentId ?? ""}/main`);
  const setChatMode = ui.setMode;
  usePlanApprovedMode(subName === undefined ? state.activePlan : null, setChatMode);
  const chatInput = ui.draft;
  const setChatInput = ui.setDraft;
  const [forkFor, setForkFor] = useState<string | null>(null);

  // `state.messages` is the SDK's newest window with streamed messages; older history pages from storage.
  const chat = useChatThread({
    rpc: state.rpc, live: state.messages, seeded: state.transcriptSeeded, steerRuns: state.steerRuns,
    total: state.agentStatus?.messageCount,
  });

  const { history, thread, positions, transcript } = chat;

  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  // The hook spends the per-message aggregate cap (one DO row, see core/cloud-wire) inside its
  // reducer, so concurrent additions cannot reserve the same remaining capacity.
  const attachments = usePendingAttachments(CLOUD_MAX_INLINE_ATTACHMENT_BYTES);
  useCarriedAttachments(attachments.offer);
  const { dragOver, handlers: chatDrop } = useFileDrop(attachments.add);

  useAutogrow(chatInputRef, chatInput);

  // A visit the roster does not take is a gone workspace; asked again when the socket drops.
  const dropped = state.connectionStatus === "disconnected";

  useEffect(() => {
    if (!agentId) return;
    startTransition(() => settle(Effect.catchCause(Effect.gen(function* () {
      const taken = yield* Effect.promise(async () => touchWorkspace(agentId));

      if (!taken) onGone(agentId);
      reportSide("visit", null);
    }), sideFailed("visit"))));
  }, [agentId, dropped, onGone, reportSide, sideFailed]);

  // Steer-as-Branch: runs the draft as a parallel head while the live turn continues.
  const [branchNotice, setBranchNotice] = useState<string | null>(null);

  const handleBranch = useCallback(() => {
    const t = chatInput.trim();

    if (!t || !live || ui.mode === "plan") return;
    setBranchNotice(null);
    // Clear the draft only once the branch is accepted, and only if it was not edited meanwhile.
    startTransition(() => settle(Effect.catchCause(Effect.gen(function* () {
      const result = yield* Effect.promise(async () => state.rpc<{ accepted: boolean; reason?: string }>("branchTurn", [t]));

      if (result.accepted) ui.updateDraft((current) => current.trim() === t ? "" : current);
      else setBranchNotice(result.reason ?? "Branching is unavailable right now.");
    }), showing(setBranchNotice))));
  }, [chatInput, ui.mode, live, state]);

  const { notice: steerNotice, send: handleSend, stop: handleStop } = useSteerActions({
    sendChat: (text, files) => state.sendChat(text, [...files], ui.mode),
    abortChat: state.abortChat,
    draft: chatInput,
    setDraft: ui.updateDraft,
    attachments: { parts: attachments.parts, clear: attachments.clear },
    steerRuns: state.steerRuns,
  });

  // Identity-stable handlers so memo(MessageView) holds across stream ticks.
  const onForkMessage = useCallback((mid: string) => setForkFor(mid), []);

  // Committed locally only after the RPC succeeds, so the toggle never misreports scoring input.
  const [feedbackByMessage, setFeedbackByMessage] = useState<Record<string, 'positive' | 'negative'>>({});
  useEffect(() => {
    if (state.connectionStatus !== "connected") return;
    startTransition(() => settle(Effect.catchCause(Effect.gen(function* () {
      const loaded = yield* Effect.promise(async () => state.rpc<Record<string, 'positive' | 'negative'>>('listTurnFeedback'));
      setFeedbackByMessage(loaded);
      reportSide("feedback", null);
    }), sideFailed("feedback"))));
  }, [state.connectionStatus, state.rpc, reportSide, sideFailed]);

  // Refreshed when a turn settles: a settled /branch redirect may have produced a fresh set.
  const [takesByTurn, setTakesByTurn] = useState<Record<string, AlternateTakeSet>>({});

  // A signal that started a turn renders on its message; one spliced into a running turn
  // never gets a message. Each card renders once.
  const cardStates = useMemo(
    () => new Map(state.signalCards.map((card) => [card.id, card.state])),
    [state.signalCards]);

  const messageCardIds = useMemo(() => new Set(transcript.flatMap((msg) => {
    const id = messageSignalId({ metadata: msg.metadata });

    return id ? [id] : [];
  })), [transcript]);

  const looseCards = useMemo(() => state.signalCards.flatMap((card) => {
    if (messageCardIds.has(card.id)) return [];
    const turn = classifyProgrammaticTurn({ metadata: card.metadata });

    return turn ? [{ card, turn }] : [];
  }), [state.signalCards, messageCardIds]);

  const mainTail = threadLiveTail({ last: thread.entries.at(-1)?.message, liveness: state.liveness });
  const providerWait = useProviderWaitNotice(state.providerWait);

  const settledBranchCount = state.branchRuns.filter((b) => b.status === "settled").length;
  useEffect(() => {
    if (state.connectionStatus !== "connected" || live) return;
    startTransition(() => settle(Effect.catchCause(Effect.gen(function* () {
      const loaded = yield* Effect.promise(async () => state.rpc<Record<string, AlternateTakeSet>>('listAlternateTakes'));
      setTakesByTurn(loaded);
      reportSide("takes", null);
    }), sideFailed("takes"))));
    // settledBranchCount: a branch settling after the turn ended persists a fresh set.
  }, [state.connectionStatus, live, state.rpc, settledBranchCount, reportSide, sideFailed]);

  const onPickTake = useCallback(async (takeId: string, nodeId: string): Promise<TakePickOutcome> => {
    const result = await state.rpc<TakePickOutcome>('pickAlternateTake', [takeId, nodeId]);
    const turnId = result.set.turnId;

    if (turnId) setTakesByTurn((prev) => ({ ...prev, [turnId]: result.set }));

    return result;
  }, [state.rpc]);

  // Device file restore exists only while a device is connected; overwriting real files gets
  // its own confirm, preceded by a safety snapshot.
  const [revertFor, setRevertFor] = useState<string | null>(null);
  const [clearingMain, setClearingMain] = useState(false);
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  const [restorePlan, setRestorePlan] = useState<DeviceRestorePlan | null>(null);
  const [restoring, setRestoring] = useState(false);

  const applyRestore = useCallback(() => detach(Effect.gen(function* () {
    if (!restorePlan) return;
    setRestoring(true);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      for (const entry of restorePlan.entries) {
        yield* Effect.promise(async () => state.rpc('restoreFileCheckpoint', [entry.dir, entry.id]));
      }

      setRestoreNotice(`Restored ${restorePlan.files.length} ${restorePlan.files.length === 1 ? "file" : "files"}. Run restore again to undo it.`);
      setRestorePlan(null);
    }), showing((chain) => {
      setRestoreNotice(`Restore failed: ${chain}`);
      setRestorePlan(null);
    })), Effect.sync(() => {
      setRestoring(false);
    }));
  })), [restorePlan, state.rpc]);

  const onMessageFeedback = useCallback(async (mid: string, fb: 'positive' | 'negative' | null) => {
    await state.rpc('setTurnFeedback', [mid, fb]);
    setFeedbackByMessage((prev) => {
      const next = { ...prev };

      if (fb) next[mid] = fb; else delete next[mid];

      return next;
    });
  }, [state.rpc]);

  const slateInline = useMemo(() => ({
    rpc: state.rpc,
    openSlate: (id: string): void => show(`${SLATE_PREFIX}${id}`),
  }), [state.rpc, show]);

  // The slate the inspector shows beside the chat folds its chat previews; a phone never shows both.
  const panelSlate = (control: InspectorControl): string | null =>
    control.beside && !control.collapsed && surface.startsWith(SLATE_PREFIX) ? surface.slice(SLATE_PREFIX.length) : null;

  if (!agentId) return null;

  const as = state.agentStatus;
  const rosterTitle = workspaceEntries.find((entry) => entry.name === agentId)?.displayName;
  // No fallback to `agentId`: it is the URL slug, not a title.
  const statusTitle = as?.displayName;
  const storedTitle = statusTitle === undefined || statusTitle === "" ? rosterTitle : statusTitle;
  const shownTitle = workspaceDisplayTitle({ name: agentId, displayName: storedTitle });

  const bar = (
    <WorkspaceBar workspace={agentId} title={shownTitle} editValue={workspaceTitleDraft({ name: agentId, displayName: storedTitle })}
      state={state} agents={agentsPanel.list} shown={shownAgent} view={view} subName={subName} inspector={inspectorControl}
      clearMain={() => setClearingMain(true)} />
  );

  // Never unmount on transient WS errors.
  if (state.connectionStatus === "connecting" && !state.agentStatus) return (
    <div className="h-full flex flex-col">
      {bar}
      <div className="flex flex-1 items-center justify-center"><div className="flex items-center gap-2 text-sm p-text-2"><Loader size="sm" /><span>Connecting...</span></div></div>
    </div>
  );

  if (state.terminalClose && !state.agentStatus) {
    return <div className="h-full flex flex-col">{bar}<div className="min-h-0 flex-1"><TerminalCloseBoundary close={state.terminalClose} onRetry={state.retryLoad} /></div></div>;
  }


  return (
    <SlateInlineContext.Provider value={slateInline}><FileLinkContext.Provider value={fileLinks}>
    <div className="h-full flex flex-col" data-workbench>
      {/* The chat stays mounted through reconnect so the in-flight turn survives. */}
      {state.connectionStatus === "disconnected" && !state.terminalClose && (
        <div className="flex items-center justify-center gap-2 px-3 py-1.5 text-xs p-warning border-b p-border" style={{ background: "var(--c-warning-tint)" }}>
          <ArrowsClockwiseIcon size={12} className="animate-spin" />Reconnecting...
        </div>
      )}
      {state.terminalClose && (
        <div className="flex flex-wrap items-center justify-center gap-2 px-3 py-1.5 text-xs p-danger border-b p-border" style={{ background: "var(--c-danger-tint)" }}>
          <WarningCircleIcon size={12} className="shrink-0" />
          <span className="break-words">
            {state.terminalClose.code === 1008
              ? "Access to this workspace was denied."
              : "This workspace is unavailable."}
            {" "}{state.terminalClose.reason || state.terminalClose.message}
          </span>
          <button type="button" onClick={state.retryLoad} className="p-accent hover:underline">Try again</button>
          <Link to="/" className="p-accent hover:underline">Back to your workspaces</Link>
        </div>
      )}

      {bar}

      {view !== undefined && <WorkspaceView view={view} workspace={agentId} title={shownTitle} state={state} agents={agentsPanel.list}
        open={(agent) => { detach(Effect.promise(async () => agentsPanel.open(agent))); }} />}
      {view === undefined && (
      <WorkbenchPanels
        ref={workbench}
        workspace={agentId}
        contents={state}
        onInspector={setInspectorControl}
        chat={(control) => <HelperChatBase.Provider value={{ base: `/workspace/${agentId}/agents/`, parent: null }}><ChatSlates shownInPanel={panelSlate(control)}>
            {shownNode !== null && (
              <SwarmNodePane key={shownNode} main={state} node={shownNode} ownerPath={nodeOwner} agent={shownAgent} rosterLoaded={rosterLoaded} />
            )}
            {shownNode === null && (subName ? (
              <AgentChatColumn key={subName} workspace={agentId} subName={subName} subordinates={state.subordinates} rpc={state.rpc} ids={linkIds}
                input={shownAgent?.input ?? true} />
            ) : (
            <div className="@container relative flex flex-col flex-1 min-h-0" data-agent-pane={`${agentId}/main`}
              {...chatDrop}>
            {dragOver && (
              <div className="absolute inset-0 z-10 pointer-events-none flex items-center justify-center rounded-lg border-2 border-dashed"
                style={{ borderColor: "var(--c-accent)", background: "var(--c-accent-subtle)" }}>
                <div className="flex items-center gap-2 text-sm p-text px-3 py-1.5 rounded-lg p-elevated border p-border">
                  <PaperclipIcon size={16} className="p-accent" />Drop files to attach
                </div>
              </div>
            )}
            <ErrorBoundary label="Chat">
            <TranscriptViewport chat={chat} live={live} startFirst padClass="pt-7 pb-12"
              scroll={{ initialScroll: ui.savedScroll, onScrollPosition: ui.rememberScroll, settled: state.transcriptSeeded }}
              pending={<ConversationSkeleton />}
              empty={<EmptyConversation mission={as?.purpose ?? ""} />}
              rows={(before) => thread.entries.map(({ message: msg, steers }, i) => {
                const takes = takesByTurn[msg.id];
                const signalId = messageSignalId({ metadata: msg.metadata });

                return (
                  <Fragment key={msg.id}>
                    {before(msg.id)}
                    <MessageView
                      message={msg}
                      steers={steers}
                      liveTail={i === thread.entries.length - 1 ? mainTail : null}
                      onFork={onForkMessage}
                      onFeedback={onMessageFeedback}
                      feedback={feedbackByMessage[msg.id] ?? null}
                      onRevert={setRevertFor}
                      takesChip={hasComparableTakes(takes)
                        ? <TakesChip set={takes} onPick={onPickTake} />
                        : undefined}
                      signalState={signalId === null ? undefined : cardStates.get(signalId)}
                      onOpenChangeNote={openChangeNote}
                    />
                  </Fragment>
                );
              })}>
              <ChatLiveTail tail={mainTail} />
              {looseCards.map(({ card, turn }) => (
                <ProgrammaticTurnCard key={card.id} turn={turn} text={card.text} state={card.state} />
              ))}
              {thread.trailing.map((steer) => <SteerBubble key={steer.id} steer={steer} />)}
              {state.branchRuns.map((run) => (
                <BranchRunChip
                  key={run.branchId}
                  run={run}
                  takes={run.turnId ? takesByTurn[run.turnId] : undefined}
                  rpc={state.rpc}
                  headActivity={state.headActivity}
                  headDeltas={state.headDeltas}
                  onPick={onPickTake}
                  onDismiss={() => state.dismissBranchRun(run.branchId)}
                />
              ))}
              {state.subordinateEvents.map((event) => (
                <SubordinateEventCard key={event.id} event={event} workspace={agentId} />
              ))}
              <ModelFallbackRows notices={state.modelFallbacks} />
              <DeviceOfflineRow devices={state.unavailableDevices} />
              {state.chatError && (
                <ChatErrorCard
                  message={state.chatError.body}
                  replayed={state.chatError.replayed}
                  streaming={live}
                  onRetry={state.retryLastMessage}
                  onDismiss={state.clearChatError}
                />
              )}
            </TranscriptViewport>
            </ErrorBoundary>

            {state.pendingConsents.length > 0 && (
              <div className="p-thread-column space-y-2 pb-1">
                {state.pendingConsents.map((c) => (
                  <DeviceConsentCard key={c.consentId} consent={c} onResolve={(...args: Parameters<typeof state.resolveConsent>) => detach(Effect.promise(async () => state.resolveConsent(...args)))} />
                ))}
              </div>
            )}

            <div className="p-composer-dock">
              <Composer
                textareaRef={chatInputRef}
                value={chatInput}
                onValueChange={setChatInput}
                onSend={handleSend}
                placeholder={live ? "Steer the running turn…" : "Send a message..."}
                disabled={state.connectionStatus !== "connected"}
                liveness={state.liveness}
                onRecover={state.recoverTurn}
                onStop={handleStop}
                onBranch={handleBranch}
                mode={{ value: ui.mode, onChange: setChatMode }}
                attachments={{
                  parts: [...attachments.parts],
                  onAdd: attachments.add,
                  onRemove: attachments.remove,
                }}
                modelPicker={<ConnectedModelPicker value={as?.model ?? ""} onChange={(...args: Parameters<typeof onPickModel>) => detach(Effect.promise(async () => onPickModel(...args)))} size="xs"
                  effort={{ value: as?.reasoningEffort ?? null, onChange: pickEffort }} />}
                notices={[
                  ...(loadNotices(state.error, state.retryLoad)),
                  ...(state.newerDeployedBuild ? [{
                    id: "version", tone: "info" as const,
                    text: "A new version is ready. Reload this tab to use it.",
                    action: { label: "Reload", icon: <ArrowsClockwiseIcon size={11} />, onClick: () => window.location.reload() },
                  }] : []),
                  ...(attachments.refusal ? [{ id: "attach", tone: "warning" as const, text: attachments.refusal }] : []),
                  ...SIDE_SOURCES.flatMap(({ source, label }) => {
                    const message = sideErrors[source];

                    return message
                      ? [{ id: `side-${source}`, tone: "warning" as const,
                          text: `Could not ${label}: ${message}`,
                          onDismiss: () => reportSide(source, null) }]
                      : [];
                  }),
                  ...(branchNotice ? [{ id: "branch", tone: "warning" as const,
                    text: `Branch unavailable: ${branchNotice}`, onDismiss: () => setBranchNotice(null) }] : []),
                  ...(restoreNotice ? [{ id: "restore", tone: "neutral" as const, text: restoreNotice,
                    onDismiss: () => setRestoreNotice(null) }] : []),
                  ...providerWait,
                  ...(steerNotice ? [steerNotice] : []),
                ]}
              />
            </div>
            </div>
            ))}
        </ChatSlates></HelperChatBase.Provider>}
        inspector={(
          // `planOwner` is the actor's registered name, as the work read reports it; the root's is the workspace's.
          <WorkSurface
            surface={surface}
            previewFocus={state.previewFocus}
            planFocus={state.planFocus}
            changesFocus={changesFocus}
            filesFocus={filesFocus}
            planOwner={planOwnerName(subName, agentId)}
            workspacePlanArrival={state.workspacePlanArrival}
            onReviewActor={async (name, actorId) => {
              await navigate(`${helperBase(agentId, name).slice(0, -1)}${actorId === undefined ? "" : `?actor=${encodeURIComponent(actorId)}`}`);
              workbench.current?.showChat();
            }}
            onSurface={setSurface}
            agents={agentsPanel}
            pinnedPorts={state.pinnedPorts}
            previewError={state.previewError}
            previewStarting={state.previewStarting}
            onRefreshPorts={(...args: Parameters<typeof state.refreshExposedPorts>) => detach(Effect.promise(async () => state.refreshExposedPorts(...args)))}
            plan={visiblePlan}
            snapshot={state.snapshot}
            onRetryLoad={state.retryLoad}
            memory={state.memory}
            memoryContent={state.memoryContent}
            onSearchMemory={state.searchMemory}
            mctsTrees={state.mctsTrees}
            headActivity={state.headActivity}
            headDeltas={state.headDeltas}
            isStreaming={live}
            executors={state.executors}
            executorOutputs={state.executorOutputs}
            lastActiveExecutor={state.lastActiveExecutor}
            onExecute={state.executeInExecutor}
            backgroundJobs={state.backgroundJobs}
            onRefreshJobs={(...args: Parameters<typeof state.refreshBackgroundJobs>) => detach(Effect.promise(async () => state.refreshBackgroundJobs(...args)))}
            pendingActions={state.pendingActions}
            onRefreshQueue={(...args: Parameters<typeof state.refreshPendingActions>) => detach(Effect.promise(async () => state.refreshPendingActions(...args)))}
            onChangelogSeen={state.clearChangelogUnseen}
            slates={state.slates}
            slateReloads={state.slateReloads}
            changesMoved={state.changesMoved}
            readMoves={state.readMoves}
            tabPresence={state.tabPresence}
            presencePending={state.tabPresence === undefined}
            rpc={state.rpc}
            workspace={agentId}
            unmappedSlate={unmappedSlate}
            onUnmappedOpened={() => setUnmappedSlate(null)}
          />
        )}
      />
      )}

      {forkFor && (
        <ForkModal
          sourceName={shownTitle}
          messagesUpToHere={messagesUpTo(transcript, forkFor, state.agentStatus?.messageCount, { positions, inFlight: turnRows(transcript, live) })}
          onCancel={() => setForkFor(null)}
          onSubmit={(name) => settle(Effect.catchCause(Effect.gen(function* () {
            const result = yield* Effect.promise(async () => state.forkAgent(forkFor, name ? { name } : undefined));
            setForkFor(null);
            yield* Effect.promise(async () => navigate(result.url));
          }), (failed) => Effect.gen(function* () {
            const err = Cause.squash(failed);

            return yield* Effect.die(err instanceof Error ? err : new Error(String(err)));
          })))}
        />
      )}

      <MainClearDialog open={clearingMain} agents={agentsPanel.list} onClose={() => setClearingMain(false)}
        // Reset in the same press: an in-flight first page would otherwise restore the cleared messages.
        onClear={async () => { state.clearHistory(); history.reset(); }} />

      {revertFor !== null && <RevertTurnDialog
        messageId={revertFor}
        rpc={state.rpc}
        onClose={() => setRevertFor(null)}
        // Reset with the revert: an in-flight first page would otherwise restore the removed messages.
        onReverted={history.reset}
        onRestorePlan={setRestorePlan}
      />}

      {restorePlan && (
        <RestoreFilesModal plan={restorePlan} busy={restoring}
          onCancel={() => setRestorePlan(null)} onConfirm={applyRestore} />
      )}

    </div>
    </FileLinkContext.Provider></SlateInlineContext.Provider>
  );
}

const RESTORE_PREVIEW_LIMIT = 12;

const RESTORE_MARK = {
  modify: { mark: "~", tone: "p-warning" },
  create: { mark: "+", tone: "p-success" },
  delete: { mark: "-", tone: "p-danger" },
} satisfies Record<FileRestoreChange["kind"], { mark: string; tone: string }>;

function RestoreFilesModal({ plan, busy, onCancel, onConfirm }: {
  plan: DeviceRestorePlan; busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const { modified, created, deleted } = summarizeRestorePlan(plan.files);

  const counts = [
    modified ? `${modified} modified` : null,
    created ? `${created} recreated` : null,
    deleted ? `${deleted} removed` : null,
  ].filter(Boolean).join(", ");

  const shown = plan.files.slice(0, RESTORE_PREVIEW_LIMIT);

  return (
    <Modal
      title="Restore device files to before this turn"
      icon={<ClockCounterClockwiseIcon size={18} className="p-warning" />}
      onClose={onCancel}
      busy={busy}
      footer={<>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <FilledButton onClick={onConfirm} disabled={busy}>
          {busy ? <><Loader size="sm" /><span className="ml-1">Restoring…</span></> : `Restore ${plan.files.length} file${plan.files.length === 1 ? "" : "s"}`}
        </FilledButton>
      </>}
    >
      <div className="space-y-2">
        <p className="text-xs p-text-2 leading-relaxed">
          This changes files under <span className="font-mono p-text">{plan.dirs.join(", ")}</span> on your
          device: {counts}. Kinu creates a safety snapshot first. Restore again to undo this change.
        </p>
        <ul className="rounded-md border p-border p-elevated max-h-52 overflow-y-auto p-annotation">
          {shown.map((f) => {
            const { mark, tone } = RESTORE_MARK[f.kind];

            return (
              <li key={`${f.kind}:${f.path}`} className="flex gap-2 px-2.5 py-1 border-b p-border last:border-0">
                <span className={`shrink-0 ${tone}`}>{mark}</span>
                <span className="p-text-2 truncate" title={f.path}>{f.path}</span>
              </li>
            );
          })}
          {plan.files.length > shown.length && (
            <li className="px-2.5 py-1 p-text-3">… {plan.files.length - shown.length} more</li>
          )}
        </ul>
      </div>
    </Modal>
  );
}
