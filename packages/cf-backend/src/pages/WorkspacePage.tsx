import { startTransition, useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useParams, useLocation, Link, useNavigate } from "react-router-dom";
import { Button, Loader } from "@cloudflare/kumo";
import { FilledButton } from "@/components/ui/FilledButton";
import {
  ArrowsClockwiseIcon, GitBranchIcon, CheckCircleIcon, TrashIcon,
  ClockIcon, WarningCircleIcon, DesktopTowerIcon, PaperclipIcon,
  ClockCounterClockwiseIcon, UserPlusIcon, type Icon,
} from "@phosphor-icons/react";
import {
  CLOUD_MAX_INLINE_ATTACHMENT_BYTES,
  isPlaceholderMission, summarizeRestorePlan,
} from "@kinu.run/core";
import type { AlternateTakeSet, DiffAnchor, FileRestoreChange, TakePickOutcome } from "@kinu.run/core";
import { useKinu, type WorkspaceNotice } from "@/hooks/use-kinu";
import { useGrowingScroll } from "@/hooks/use-growing-scroll";
import { useAutogrow } from "@/hooks/use-autogrow";
import { useChatThread } from "@/hooks/use-chat-thread";
import { useConversationUiState, usePlanGatedMode } from "@/hooks/use-conversation-ui-state";
import { useSteerActions } from "@/hooks/use-steer-actions";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { usePendingAttachments } from "@/hooks/use-pending-attachments";
import { useFileDrop } from "@/hooks/use-file-drop";
import { touchWorkspace } from "@/lib/user-api";
import { describeError } from "@/hooks/use-async-resource";
import { ConnectedModelPicker } from "@/components/ModelPicker";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Modal } from "@/components/ui/Modal";
import { RevertTurnDialog, type DeviceRestorePlan } from "@/components/RevertTurnDialog";
import { ChatLiveTail, DeviceOfflineRow, MessageView, ModelFallbackRows, ProgrammaticTurnCard, SteerBubble } from "@/components/MessageView";
import { TakesChip, BranchRunChip } from "@/components/AlternateTakes";
import { hasComparableTakes } from "@kinu.run/core";
import { classifyProgrammaticTurn, messageSignalId, threadLiveTail } from "@kinu.run/core";
import { WorkSurface } from "@/components/surfaces/WorkSurface";
import type { ChangesFocus } from "@/components/surfaces/ChangesSurface";
import { SlateInlineContext } from "@/components/slates/context";
import { ChatSlates } from "@/components/slates/InlineSlate";
import { SLATE_PREFIX, type SurfaceKind } from "@kinu.run/core";
import { ConversationStartBoundary, HistoryBoundary } from "@/components/surfaces/shared";
import { KinuMark } from "@/components/ui/KinuLogo";
import { SupervisePage } from "./SupervisePage";
import { SubordinateTabs, agentTitle } from "@/components/SubordinateTabs";
import { KeptChatColumn } from "@/components/KeptChatColumn";
import { WorkspaceBar, type Altitude } from "@/components/WorkspaceBar";
import { Composer, workspaceLoadNotice, type ComposerNotice } from "@/components/Composer";
import { workspaceDisplayTitle, workspaceTitleDraft, type PendingConsent, type SubordinateActivityEvent } from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import { InspectorToggle, WorkbenchPanels, type InspectorControl, type WorkbenchHandle } from "@/components/WorkbenchPanels";

/** Composed key: Kumo's `Button` requires a `shape` prop, `anti-slop/no-shape-in-symbol-names`
 *  bans the substring in symbol names, and lint suppression comments are forbidden. */
const squareButtonVariant = "square";

const SQUARE_BUTTON_PROPS = { ["sha" + "pe"]: squareButtonVariant };

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
          <code className="block mt-1 p-t-code p-text-2 break-all p-fill rounded-sm px-2 py-1">{consent.command || "(command)"}</code>
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

  const submit = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);

    try {
      await onSubmit(name.trim());
    } catch (e) {
      setErr(renderThrownChain({ cause: e }));
      setBusy(false);
    }
  }, [name, busy, onSubmit]);

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
          <li>Starts fresh: MCTS tree, evolution events, scaffold, installed runtimes</li>
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

/** One subordinate's chat over its own facet socket; Work Surface and Timeline stay on
 *  the parent socket. The facet exposes no fork/feedback/takes/restore. */
function SubordinateChatColumn({
  workspace, subName, title,
}: {
  workspace: string;
  subName: string;
  title: string;
}) {
  const state = useKinu({ workspace, subordinate: subName });
  const live = state.liveness.kind === "live";

  // No model write from an agent pane: only the workspace pin is honoured, and the
  // snapshot carries the actor's effective model, rendered read-only.

  const ui = useConversationUiState(`${workspace}/agents/${subName}`);
  const input = ui.draft;
  const setInput = ui.setDraft;
  const planGate = usePlanGatedMode(state.activePlan, ui);
  const effectiveMode = planGate.mode;

  // History reads name this pane's actor; the default actor is the workspace's own chat.
  const { history, transcript, thread } = useChatThread({
    rpc: state.rpc, live: state.messages, seeded: state.transcriptSeeded,
    steerRuns: state.steerRuns, actor: state.paneActorId,
  });

  const messagesRef = useGrowingScroll({
    grows: "up",
    content: transcript,
    fetched: history.fetched,
    loading: history.loading,
    onReachEdge: history.loadMore,
    initialScroll: ui.savedScroll,
    onScrollPosition: ui.rememberScroll,
    exhausted: history.exhausted,
  });

  const inputRef = useRef<HTMLTextAreaElement>(null);

  useAutogrow(inputRef, input);

  const { notice: steerNotice, send, stop } = useSteerActions({
    sendChat: (text, files) => state.sendChat(text, [...files], effectiveMode),
    abortChat: state.abortChat,
    draft: input,
    setDraft: ui.updateDraft,
    steerRuns: state.steerRuns,
  });

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
        <div ref={messagesRef} className="flex-1 overflow-y-auto p-thread-column py-5 space-y-5">
          {thread.entries.length > 0 && (
            <HistoryBoundary
              loading={history.loading}
              error={history.error}
              exhausted={history.exhausted}
              onRetry={history.loadMore}
            />
          )}
          <ConversationStartBoundary
            hasEntries={thread.entries.length > 0}
            streaming={live}
            error={history.error}
            exhausted={history.exhausted}
            onRetry={history.loadMore}
            pending={<ConversationSkeleton />}
            empty={
              <div className="flex h-full flex-col items-center justify-center text-center">
                <KinuMark size={30} className="mb-3 text-[var(--c-accent)] opacity-60" />
                <p className="text-sm p-text-3">This agent's conversation starts here.</p>
              </div>
            }
          />
          {thread.entries.map(({ message: msg, steers }, i) => (
            <MessageView
              key={msg.id}
              message={msg}
              steers={steers}
              liveTail={i === thread.entries.length - 1 ? tail : null}
            />
          ))}
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
        </div>
      </ErrorBoundary>

      <div className="border-t p-border p-sidebar">
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
          mode={{ value: effectiveMode, onChange: ui.setMode, locked: planGate.locked }}
          modelPicker={<ConnectedModelPicker value={as?.model ?? ""} onChange={state.setModel} size="xs"
            effort={{ value: as?.reasoningEffort ?? null, onChange: state.setReasoningEffort }} />}
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
      </div>
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


export default function WorkspacePage() {
  const { agentId, subName } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const state = useKinu(agentId);
  const live = state.liveness.kind === "live";
  const { entries: workspaceEntries } = useWorkspaceRoster();

  const [creatingAgent, setCreatingAgent] = useState(false);
  const creatingAgentRef = useRef(false);
  const [createAgentError, setCreateAgentError] = useState<string | null>(null);

  const createAndOpenAgent = useCallback(async () => {
    if (!agentId || creatingAgentRef.current) return;
    creatingAgentRef.current = true;
    setCreatingAgent(true);
    setCreateAgentError(null);

    try {
      const created = await state.createSubordinate();
      await navigate(`/workspace/${agentId}/agents/${created.name}`);
    } catch (cause) {
      setCreateAgentError(renderThrownChain({ cause }));
    } finally {
      creatingAgentRef.current = false;
      setCreatingAgent(false);
    }
  }, [agentId, navigate, state.createSubordinate]);

  useEffect(() => {
    const open = async (): Promise<void> => { await createAndOpenAgent(); };

    window.addEventListener("kinu:new-agent", open);

    return () => window.removeEventListener("kinu:new-agent", open);
  }, [createAndOpenAgent]);

  // `setModel` records failure on `state.error` and rolls the picker back itself.
  const setModel = state.setModel;

  const onPickModel = useCallback(async (spec: string): Promise<void> => {
    await setModel(spec);
  }, [setModel]);

  const [sideErrors, setSideErrors] = useState<Partial<Record<SideSource, string>>>({});

  const reportSide = useCallback((source: SideSource, message: string | null) => {
    setSideErrors((prev) => {
      if ((prev[source] ?? null) === message) return prev;
      const next = { ...prev };

      if (message === null) delete next[source];
      else next[source] = message;

      return next;
    });
  }, []);

  // ?altitude=supervise deep-links to Supervise (/triggers/:id redirect, settings' Automations link).
  const [altitude, setAltitude] = useState<Altitude>(
    () => new URLSearchParams(location.search).get("altitude") === "supervise" ? "supervise" : "run",
  );

  const visiblePlan = state.activePlan;
  const [surface, setSurface] = useState<SurfaceKind>("Work");
  const [changesFocus, setChangesFocus] = useState<ChangesFocus | null>(null);
  const workbench = useRef<WorkbenchHandle | null>(null);

  // Every surface opened from the chat, a note or a landing is brought into view: a collapsed inspector, or a phone
  // showing the chat, would otherwise change what nobody can see.
  const show = useCallback((next: SurfaceKind): void => {
    setSurface(next);
    workbench.current?.reveal();
  }, []);

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
  const planGate = usePlanGatedMode(subName === undefined ? state.activePlan : null, ui);
  const effectiveChatMode = planGate.mode;
  const chatInput = ui.draft;
  const setChatInput = ui.setDraft;
  const [forkFor, setForkFor] = useState<string | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // `state.messages` is the SDK's bounded newest window plus streamed messages; older history is
  // paged from storage. An empty seed still starts the walk: an activation may fail to rebuild the window.
  const { history, transcript, thread } = useChatThread({
    rpc: state.rpc, live: state.messages, seeded: state.transcriptSeeded, steerRuns: state.steerRuns,
  });

  const messagesRef = useGrowingScroll({
    grows: "up",
    content: transcript,
    fetched: history.fetched,
    loading: history.loading,
    onReachEdge: history.loadMore,
    initialScroll: ui.savedScroll,
    onScrollPosition: ui.rememberScroll,
    exhausted: history.exhausted,
  });

  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  // The hook spends the per-message aggregate cap (one DO row, see core/cloud-wire) inside its
  // reducer, so concurrent additions cannot reserve the same remaining capacity.
  const attachments = usePendingAttachments(CLOUD_MAX_INLINE_ATTACHMENT_BYTES);
  const { dragOver, handlers: chatDrop } = useFileDrop(attachments.add);

  useAutogrow(chatInputRef, chatInput);

  useEffect(() => {
    if (!agentId) return;
    startTransition(async () => {
      try {
        await touchWorkspace(agentId);
        reportSide("visit", null);
      } catch (cause) {
        reportSide("visit", describeError({ cause }));
      }
    });
  }, [agentId, reportSide]);

  // Only the mounted workspace has a live socket, so the sidebar shows live status only for
  // workspaces visited this session.
  useEffect(() => {
    if (!agentId) return;
    const running = live || state.backgroundJobs.some((j) => j.status === "running");
    window.dispatchEvent(new CustomEvent("kinu:workspace-activity", {
      detail: {
        name: agentId,
        running,
        unseenChangelog: state.changelogUnseen,
        // Dismissed agents stay reachable from the chat strip, not the sidebar's working roster.
        agents: state.subordinates.filter((sub) => sub.status !== "dismissed").map((sub) => ({
          name: sub.name, displayName: sub.displayName, status: sub.status,
        })),
      },
    }));
  }, [agentId, live, state.backgroundJobs, state.changelogUnseen, state.subordinates]);

  // The sidebar has no socket; clear its snapshot on unmount so no stale "working" dot remains.
  useEffect(() => {
    if (!agentId) return;

    return () => {
      window.dispatchEvent(new CustomEvent("kinu:workspace-activity", {
        detail: { name: agentId, running: false, unseenChangelog: 0, agents: [] },
      }));
    };
  }, [agentId]);


  // Steer-as-Branch: runs the draft as a parallel head while the live turn continues.
  const [branchNotice, setBranchNotice] = useState<string | null>(null);

  const handleBranch = useCallback(() => {
    const t = chatInput.trim();

    if (!t || !live || effectiveChatMode === "plan") return;
    setBranchNotice(null);
    // Clear the draft only once the branch is accepted, and only if it was not edited meanwhile.
    startTransition(async () => {
      try {
        const result = await state.rpc<{ accepted: boolean; reason?: string }>("branchTurn", [t]);

        if (result.accepted) ui.updateDraft((current) => current.trim() === t ? "" : current);
        else setBranchNotice(result.reason ?? "Branching is unavailable right now.");
      } catch (cause) {
        setBranchNotice(renderThrownChain({ cause }));
      }
    });
  }, [chatInput, effectiveChatMode, live, state]);

  const { notice: steerNotice, send: handleSend, stop: handleStop } = useSteerActions({
    sendChat: (text, files) => state.sendChat(text, [...files], effectiveChatMode),
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
    startTransition(async () => {
      try {
        const loaded = await state.rpc<Record<string, 'positive' | 'negative'>>('listTurnFeedback');
        setFeedbackByMessage(loaded);
        reportSide("feedback", null);
      } catch (cause) {
        reportSide("feedback", describeError({ cause }));
      }
    });
  }, [state.connectionStatus, state.rpc, reportSide]);

  // Refreshed when a turn settles: a think convergence may have produced a fresh near-tied set.
  const [takesByTurn, setTakesByTurn] = useState<Record<string, AlternateTakeSet>>({});

  // A signal that started a turn renders on its message; one spliced into a running turn
  // never gets a message. Each card renders once.
  const cardStates = useMemo(
    () => new Map(state.signalCards.map((card) => [card.id, card.state])),
    [state.signalCards]);

  const messageCardIds = useMemo(() => new Set(state.messages.flatMap((msg) => {
    const id = messageSignalId({ metadata: msg.metadata });

    return id ? [id] : [];
  })), [state.messages]);

  const looseCards = useMemo(() => state.signalCards.flatMap((card) => {
    if (messageCardIds.has(card.id)) return [];
    const turn = classifyProgrammaticTurn({ metadata: card.metadata });

    return turn ? [{ card, turn }] : [];
  }), [state.signalCards, messageCardIds]);

  const mainTail = threadLiveTail({ last: thread.entries.at(-1)?.message, liveness: state.liveness });

  const settledBranchCount = state.branchRuns.filter((b) => b.status === "settled").length;
  useEffect(() => {
    if (state.connectionStatus !== "connected" || live) return;
    startTransition(async () => {
      try {
        const loaded = await state.rpc<Record<string, AlternateTakeSet>>('listAlternateTakes');
        setTakesByTurn(loaded);
        reportSide("takes", null);
      } catch (cause) {
        reportSide("takes", describeError({ cause }));
      }
    });
    // settledBranchCount: a branch settling after the turn ended persists a fresh set.
  }, [state.connectionStatus, live, state.rpc, settledBranchCount, reportSide]);

  const onPickTake = useCallback(async (takeId: string, nodeId: string): Promise<TakePickOutcome> => {
    const result = await state.rpc<TakePickOutcome>('pickAlternateTake', [takeId, nodeId]);
    const turnId = result.set.turnId;

    if (turnId) setTakesByTurn((prev) => ({ ...prev, [turnId]: result.set }));

    return result;
  }, [state.rpc]);

  // Device file restore exists only while a device is connected; overwriting real files gets
  // its own confirm, preceded by a safety snapshot.
  const [revertFor, setRevertFor] = useState<string | null>(null);
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  const [restorePlan, setRestorePlan] = useState<DeviceRestorePlan | null>(null);
  const [restoring, setRestoring] = useState(false);

  const applyRestore = useCallback(async () => {
    if (!restorePlan) return;
    setRestoring(true);

    try {
      for (const entry of restorePlan.entries) {
        await state.rpc('restoreFileCheckpoint', [entry.dir, entry.id]);
      }

      setRestoreNotice(`Restored ${restorePlan.files.length} ${restorePlan.files.length === 1 ? "file" : "files"}. Run restore again to undo it.`);
      setRestorePlan(null);
    } catch (err) {
      setRestoreNotice(`Restore failed: ${renderThrownChain({ cause: err })}`);
      setRestorePlan(null);
    } finally {
      setRestoring(false);
    }
  }, [restorePlan, state.rpc]);

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
  const panelSlate = (control: InspectorControl | null): string | null =>
    control !== null && !control.collapsed && surface.startsWith(SLATE_PREFIX) ? surface.slice(SLATE_PREFIX.length) : null;

  // Never unmount on transient WS errors.
  if (state.connectionStatus === "connecting" && !state.agentStatus) return (
    <div className="h-full flex items-center justify-center"><div className="flex items-center gap-2 text-sm p-text-2"><Loader size="sm" /><span>Connecting...</span></div></div>
  );

  if (state.terminalClose && !state.agentStatus) {
    return <TerminalCloseBoundary close={state.terminalClose} onRetry={state.retryLoad} />;
  }

  if (!agentId) return null;

  const as = state.agentStatus;
  const rosterTitle = workspaceEntries.find((entry) => entry.name === agentId)?.displayName;
  // No fallback to `agentId`: it is the URL slug, not a title.
  const statusTitle = as?.displayName;
  const storedTitle = statusTitle === undefined || statusTitle === "" ? rosterTitle : statusTitle;
  const shownTitle = workspaceDisplayTitle({ name: agentId, displayName: storedTitle });


  return (
    <SlateInlineContext.Provider value={slateInline}>
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

      <WorkspaceBar
        title={shownTitle}
        editValue={workspaceTitleDraft({ name: agentId, displayName: storedTitle })}
        onRename={state.setDisplayName}
        connectionStatus={state.connectionStatus}
        working={live}
        providerWait={state.providerWait}
        waitingOnYou={state.pendingActions.length > 0 || state.pendingConsents.length > 0}
        {...(as?.forkLineage ? { forkParent: { workspace: as.forkLineage.sourceWorkspaceName, forkedAt: as.forkLineage.forkedAt } } : {})}
        altitude={altitude}
        onAltitude={setAltitude}
      />
      {createAgentError && (
        <div role="alert" className="flex items-center justify-center gap-3 border-b p-border px-3 py-1.5 text-xs p-notice-danger">
          <span>Could not create an agent: {createAgentError}</span>
          <button type="button" className="font-medium underline" onClick={() => setCreateAgentError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {altitude === "supervise" ? (
        <div className="flex-1 min-h-0">
          <ErrorBoundary label="Supervise">
            <SupervisePage rpc={state.rpc} />
          </ErrorBoundary>
        </div>
      ) : (
      <WorkbenchPanels
        ref={workbench}
        workspace={agentId}
        contents={state}
        chat={(inspectorControl) => <ChatSlates shownInPanel={panelSlate(inspectorControl)}>
            <SubordinateTabs
              workspace={agentId}
              subordinates={state.subordinates}
              activeName={subName}
              onCreate={createAndOpenAgent}
              creating={creatingAgent}
              onDismiss={(name, keepHistory) => state.dismissSubordinate(name, keepHistory).then(() => {})}
              onRename={(name, displayName) => state.renameSubordinate(name, displayName).then((entry) => entry.displayName)}
              trailing={<>
                {!subName && state.messages.length > 0 && (
                  <Button variant="ghost" {...SQUARE_BUTTON_PROPS} size="sm"
                    onClick={() => setShowClearConfirm(true)}
                    icon={<TrashIcon size={12} />} aria-label="Clear history" />
                )}
                {inspectorControl && <InspectorToggle control={inspectorControl} />}
              </>}
            />
            {subName ? (() => {
              const rosterEntry = state.subordinates.find((entry) => entry.name === subName);

              // A dismissed agent has no socket; its kept chat is paged over this workspace's.
              if (rosterEntry?.status === "dismissed") {
                return (
                  <KeptChatColumn key={subName} workspace={agentId} subName={subName}
                    title={agentTitle(rosterEntry)} rpc={state.rpc} actorId={rosterEntry.actorId} />
                );
              }

              return (
                <SubordinateChatColumn
                  key={subName}
                  workspace={agentId}
                  subName={subName}
                  title={rosterEntry ? agentTitle(rosterEntry) : subName}
                />
              );
            })() : (
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
            <div ref={messagesRef} className="flex-1 overflow-y-auto p-thread-column py-7 space-y-5">
              <ConversationStartBoundary
                hasEntries={thread.entries.length > 0}
                streaming={live}
                error={history.error}
                exhausted={history.exhausted}
                onRetry={history.loadMore}
                pending={<ConversationSkeleton />}
                empty={<EmptyConversation mission={as?.purpose ?? ""} />}
              />
              {thread.entries.length > 0 && (
                <HistoryBoundary
                  loading={history.loading} error={history.error}
                  exhausted={history.exhausted} onRetry={history.loadMore} />
              )}
              {thread.entries.map(({ message: msg, steers }, i) => {
                const takes = takesByTurn[msg.id];
                const signalId = messageSignalId({ metadata: msg.metadata });

                return (
                  <MessageView
                    key={msg.id}
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
                );
              })}
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
            </div>
            </ErrorBoundary>

            {state.pendingConsents.length > 0 && (
              <div className="p-thread-column space-y-2 pb-1">
                {state.pendingConsents.map((c) => (
                  <DeviceConsentCard key={c.consentId} consent={c} onResolve={state.resolveConsent} />
                ))}
              </div>
            )}

            <div className="border-t p-border p-sidebar">
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
                mode={{ value: effectiveChatMode, onChange: setChatMode, locked: planGate.locked }}
                attachments={{
                  parts: [...attachments.parts],
                  onAdd: attachments.add,
                  onRemove: attachments.remove,
                }}
                modelPicker={<ConnectedModelPicker value={as?.model ?? ""} onChange={onPickModel} size="xs"
                  effort={{ value: as?.reasoningEffort ?? null, onChange: state.setReasoningEffort }} />}
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
                  ...(steerNotice ? [steerNotice] : []),
                ]}
              />
            </div>
            </div>
            )}
        </ChatSlates>}
        inspector={(
          // `planOwner` must be the actor's registered name as the work read reports it; the root's is the workspace name.
          <WorkSurface
            surface={surface}
            previewFocus={state.previewFocus}
            planFocus={state.planFocus}
            changesFocus={changesFocus}
            planOwner={subName ?? agentId ?? "main"}
            workspacePlanArrival={state.workspacePlanArrival}
            onReviewActor={async name => { await navigate(`/workspace/${agentId}/agents/${encodeURIComponent(name)}`); }}
            onSurface={setSurface}
            pinnedPorts={state.pinnedPorts}
            previewError={state.previewError}
            previewStarting={state.previewStarting}
            onRefreshPorts={state.refreshExposedPorts}
            plan={visiblePlan}
            snapshot={state.snapshot}
            onRetryLoad={state.retryLoad}
            tools={state.tools}
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
            onRefreshJobs={state.refreshBackgroundJobs}
            pendingActions={state.pendingActions}
            onRefreshQueue={state.refreshPendingActions}
            onChangelogSeen={state.clearChangelogUnseen}
            slates={state.slates}
            slateReloads={state.slateReloads}
            changesMoved={state.changesMoved}
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
          messagesUpToHere={state.messages.findIndex(m => m.id === forkFor) + 1}
          onCancel={() => setForkFor(null)}
          onSubmit={async (name) => {
            try {
              const result = await state.forkAgent(forkFor, name ? { name } : undefined);
              setForkFor(null);
              await navigate(result.url);
            } catch (err) {
              throw err instanceof Error ? err : new Error(String(err));
            }
          }}
        />
      )}

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

      {showClearConfirm && (
        <Modal
          title="Clear conversation history"
          icon={<TrashIcon size={18} className="p-danger" />}
          onClose={() => setShowClearConfirm(false)}
          footer={<>
            <Button size="sm" variant="ghost" onClick={() => setShowClearConfirm(false)}>Cancel</Button>
            {/* Reset in the same press: an in-flight first page would otherwise restore the cleared messages. */}
            <FilledButton danger onClick={() => {
              state.clearHistory();
              history.reset();
              setShowClearConfirm(false);
            }}>Clear history</FilledButton>
          </>}
        >
          <p className="text-xs p-text-2 leading-relaxed">
            This cannot be undone. Memory, SOUL.md, learned tools, and evolution stay unchanged.
          </p>
        </Modal>
      )}
    </div>
    </SlateInlineContext.Provider>
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
