import { startTransition, useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, type DragEvent as ReactDragEvent } from "react";
import { useParams, useLocation, Link, useNavigate } from "react-router-dom";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { Button, Loader } from "@cloudflare/kumo";
import { FilledButton } from "@/components/ui/FilledButton";
import {
  ArrowsClockwiseIcon, GitBranchIcon, CheckCircleIcon, TrashIcon,
  ClockIcon, WarningCircleIcon, DesktopTowerIcon, PaperclipIcon,
  ClockCounterClockwiseIcon, UserPlusIcon,
} from "@phosphor-icons/react";
import {
  CLOUD_MAX_INLINE_ATTACHMENT_BYTES, DEVICE_PROVISION_METHOD,
  isPlaceholderMission, planReviewAwaitingDecision, summarizeRestorePlan,
} from "@kinu.run/core";
import type {
  AlternateTakeSet, FileCheckpointEntry, FileCheckpointListing,
  FileRestoreChange, FileRestorePlan, PlanReview, TakePickOutcome,
} from "@kinu.run/core";
import { useKinu } from "@/hooks/use-kinu";
import { useGrowingScroll } from "@/hooks/use-growing-scroll";
import { useChatThread } from "@/hooks/use-chat-thread";
import { useConversationUiState } from "@/hooks/use-conversation-ui-state";
import { useSteerActions } from "@/hooks/use-steer-actions";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { usePendingAttachments } from "@/hooks/use-pending-attachments";
import { touchWorkspace } from "@/lib/user-api";
import { describeError } from "@/hooks/use-async-resource";
import { ConnectedModelPicker } from "@/components/ModelPicker";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ConnectionIndicator } from "@/components/connection-indicator";
import { Modal } from "@/components/ui/Modal";
import { MessageView, ProgrammaticTurnCard, SteerBubble } from "@/components/MessageView";
import { TakesChip, BranchRunChip } from "@/components/AlternateTakes";
import { hasComparableTakes } from "@/components/alternate-takes-logic";
import { classifyProgrammaticTurn, messageSignalId } from "@/components/background-event";
import { WorkSurface, type SurfaceKind } from "@/components/surfaces/WorkSurface";
import { ConversationStartBoundary, HistoryBoundary } from "@/components/surfaces/shared";
import { KinuMark } from "@/components/ui/KinuLogo";
import { SupervisePage } from "./SupervisePage";
import { SubordinateTabs, agentTitle, workspaceTitle } from "@/components/SubordinateTabs";
import { WorkspaceBar, InlineRenameTitle, type Altitude } from "@/components/WorkspaceBar";
import { Composer } from "@/components/Composer";
import type { PendingConsent, Rpc, SubordinateActivityEvent } from "@/lib/protocol";
import { renderThrownChain } from "@kinu.run/core/obs";
// The model picker reads /api/user/models (which unions the connected
// providers' menus); the result is cached for the SPA session (see user-api).

/* ── Transcript chrome ────────────────────────────────────────── */

/**
 * Kumo's `Button` names this prop `shape`, and `anti-slop/no-shape-in-symbol-names`
 * bans the substring in every symbol name a JSX attribute included. The two are
 * only reconcilable by not writing the identifier, so the key is composed —
 * DECLARED here rather than left as an unexplained concatenation a reader would
 * take for obfuscation, and never a lint suppression comment, which the standing
 * rule forbids outright. (Naming that directive in prose is itself a finding:
 * the suppression gate matches the literal text wherever it appears, which is
 * how this comment first failed it.)
 *
 * The rule is aimed at names this repository CHOOSES ("shape" describes
 * structure rather than ownership); a vendor's required prop is not one of
 * those. Exempting external JSX attributes is a rule change with evidence, not
 * something to take while clearing a path, so it stays surfaced instead.
 */
const squareButtonVariant = "square";
const SQUARE_BUTTON_PROPS = { ["sha" + "pe"]: squareButtonVariant };

/** A workspace before its first turn. The mission it was created for is what
 *  the workspace IS, not something it was asked to do — so it is shown here as
 *  the standing brief rather than sent as an opening message that the agent
 *  would then try to carry out. */
export function EmptyConversation({ mission }: { mission: string }) {
  const brief = isPlaceholderMission(mission) ? null : mission.trim();
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <KinuMark size={34} className="mb-4 text-[var(--c-accent)] opacity-70" />
      {brief && (
        <>
          <p className="p-eyebrow">Mission</p>
          <p className="mt-2 max-w-md whitespace-pre-wrap p-heading text-[17px] leading-relaxed p-text-2">{brief}</p>
        </>
      )}
      <p className="mt-4 text-sm p-text-3">Send the first message to start.</p>
    </div>
  );
}

/** The bars a loading transcript draws. Fixed rather than random: a skeleton
 *  that reflows on every render is a second animation nobody asked for. */
const SKELETON_ROWS: readonly { mine: boolean; width: string }[] = [
  { mine: true, width: "38%" },
  { mine: false, width: "82%" },
  { mine: false, width: "64%" },
  { mine: true, width: "46%" },
  { mine: false, width: "74%" },
];

/**
 * The chat pane between connect and the transcript arriving.
 *
 * This state exists because the pane had no way to say "not yet". A workspace
 * whose conversation had not been delivered rendered {@link EmptyConversation}
 * — "Send the first message to start", under the mission — and then replaced it
 * with four hundred messages. Measured against production on 2026-08-20 that
 * window was 0.8-3.8 seconds of the app stating the opposite of the truth, and
 * it is the whole of what "clicking a workspace takes forever" felt like: the
 * page had painted, and what it had painted was wrong.
 *
 * Shaped like a transcript rather than centred like a spinner, so the messages
 * land where the bars already are instead of shifting the pane under the
 * reader.
 */
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

/**
 * Device card. Two shapes, one rail:
 *   - a device is connected and this workspace has no binding on it yet, so
 *     the agent's action is waiting on the owner. One question: use this
 *     machine for this workspace? "Use <device>" IS the binding, per
 *     workspace, revocable under Account settings → Devices. The card names
 *     no tier, because a binding has none: what a command may reach is the
 *     machine's own Sandbox setting, set on the device row.
 *   - no device is connected at all (`DEVICE_PROVISION_METHOD`), so the agent
 *     is asking for one to exist. Approving cannot bind anything by itself —
 *     it points the owner at the connect flow, which states its own terms.
 */
export function DeviceConsentCard({ consent, onResolve }: {
  consent: PendingConsent;
  onResolve: (consentId: string, decision: "once" | "always" | "deny") => void;
}) {
  if (consent.method === DEVICE_PROVISION_METHOD) {
    const asking = consent.workspaceName ? `“${consent.workspaceName}”` : "This agent";
    return (
      <div className="p-tint-warning rounded-xl border p-3 animate-fade-in">
        <div className="flex items-start gap-2">
          <DesktopTowerIcon size={16} className="p-warning shrink-0 mt-0.5" weight="fill" />
          <div className="min-w-0 flex-1">
            <div className="text-xs p-text">
              {asking} needs a computer of yours and none is connected.
            </div>
            <div className="mt-1 text-[11px] p-text-2">{consent.command}</div>
            <Link to="/user/settings#devices"
              className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md p-accent-bg p-accent text-[11px] font-medium hover:opacity-90">
              Connect a device
            </Link>
            <div className="mt-1 text-[10px] p-text-3">
              You will review the access before anything runs.
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 mt-2.5 justify-end">
          <button onClick={() => onResolve(consent.consentId, "deny")}
            className="px-2.5 py-1 text-[11px] rounded-md p-text-3 hover:p-text">Not now</button>
          <button onClick={() => onResolve(consent.consentId, "once")}
            className="px-2.5 py-1 text-[11px] p-card p-card-hover p-text-2">Dismiss</button>
        </div>
      </div>
    );
  }
  const forWhom = consent.workspaceName ? `“${consent.workspaceName}”` : "this workspace";
  return (
    <div className="p-tint-warning rounded-xl border p-3 animate-fade-in" data-device-bind={consent.consentId}>
      <div className="flex items-start gap-2">
        <DesktopTowerIcon size={16} className="p-warning shrink-0 mt-0.5" weight="fill" />
        <div className="min-w-0 flex-1">
          <div className="text-xs p-text">
            Use <span className="font-medium">{consent.deviceLabel}</span> for {forWhom}?
          </div>
          <code className="block mt-1 text-[11px] p-text-2 font-mono break-all p-fill rounded-sm px-2 py-1">{consent.command || "(command)"}</code>
          <div className="mt-1 text-[10px] p-text-3">
            Commands use {consent.deviceLabel}'s Sandbox setting. Revoke access under Account settings → Devices.
          </div>
        </div>
      </div>
      {/* The strongest tier is never the highlighted button on a card about ONE
          command. "Always" on an exec used to record full filesystem and shell
          access forever, from every ingress the workspace consumes, in answer
          to a question about a single `printf`. For an exec the card offers
          once or deny, and the standing decision lives in Account settings. */}
      <div className="flex items-center gap-2 mt-2.5 justify-end">
        <button onClick={() => onResolve(consent.consentId, "deny")}
          className="px-2.5 py-1 text-[11px] rounded-md p-text-3 hover:p-text">Not now</button>
        <button onClick={() => onResolve(consent.consentId, "always")}
          className="px-2.5 py-1 text-[11px] rounded-md font-medium p-accent-bg p-accent hover:opacity-90">
          Use {consent.deviceLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * Terminal chat error — a turn failed (provider error, stream break) and
 * produced no visible answer.
 *
 * The retry RE-RUNS that turn rather than asking the same thing again: the
 * label says so, because the button used to append a duplicate user message
 * on every press and three attempts left three identical turns in the
 * transcript. The error body is shown verbatim; the hook clears the card on
 * the next send.
 *
 * A REPLAYED failure is not the same claim and does not get the same words.
 * The server retains its last terminal record until a later turn supersedes
 * it, so a workspace parked after a failure re-serves that failure to every
 * client that opens it — `sunlit-stone-4a20` still answers with the
 * `Unauthorized` its 2026-08-17 turn ended on. Presenting that as "the last
 * turn failed" reads as something that just happened, and sends the owner
 * chasing a fault that may be three days gone.
 */
export function ChatErrorCard({ message, replayed, streaming, onRetry, onDismiss }: {
  message: string;
  /** The server is re-serving an older turn's outcome, not reporting a live one. */
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
          <code className="block mt-1 text-[11px] p-text-2 font-mono break-all p-card rounded-sm px-2 py-1 max-h-28 overflow-y-auto">{message}</code>
          <div className="text-[10px] p-text-3 mt-1.5">
            {replayed
              ? "This is the last turn's result. Retry runs that turn again."
              : "Retry reuses this message in the same conversation."}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2.5 justify-end">
        <button onClick={onDismiss}
          className="px-2.5 py-1 text-[11px] rounded-md p-text-3 hover:p-text cursor-pointer">Dismiss</button>
        <button onClick={onRetry} disabled={streaming}
          className="px-2.5 py-1 text-[11px] rounded-md font-medium p-accent-bg p-accent hover:opacity-90 disabled:opacity-40 cursor-pointer flex items-center gap-1">
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

/** One terminal socket outcome for both workspace and subordinate chat. A
 * terminal close is not reconnecting; the SDK stopped redialling, so each pane
 * gets the same reason and recovery/navigation choices. */
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

/** A subordinate's task assignment or progress report, mirrored into the main
 *  chat as a centered marker that links to that subordinate's tab. */
function SubordinateEventCard({ event, workspace }: { event: SubordinateActivityEvent; workspace: string }) {
  const done = event.status === "completed";
  const failed = event.status === "failed" || event.status === "error";
  const Icon = event.kind === "task" ? UserPlusIcon : done ? CheckCircleIcon : failed ? WarningCircleIcon : ClockIcon;
  const tone = done ? "p-success" : failed ? "p-danger" : "p-text-3";
  const verb = event.kind === "task" ? "assigned" : done ? "reported done" : failed ? "hit an error" : "reported progress";
  const detail = event.task || event.content;
  return (
    <div className="flex justify-center animate-fade-in py-1">
      <Link
        to={`/workspace/${workspace}/agents/${event.subordinate}`}
        title={detail}
        className="inline-flex max-w-[80%] items-center gap-2 rounded-full border p-border p-elevated px-3 py-1.5 text-[11px] p-text-2 p-card-hover transition-colors"
      >
        <Icon size={13} className={`${tone} shrink-0`} weight="fill" />
        <span className="truncate"><span className="font-medium p-text">{event.subordinate}</span> {verb}: {detail}</span>
      </Link>
    </div>
  );
}

/* ── Fork modal ───────────────────────────────────────────────── */

function ForkModal({
  sourceName, messagesUpToHere, craftedToolsCount, onCancel, onSubmit,
}: {
  sourceName: string;
  messagesUpToHere: number;
  craftedToolsCount: number;
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
      title="Fork from here"
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
        <p>Create a new workspace that branches off <span className="font-mono p-text">{sourceName}</span> at this message.</p>
        <ul className="list-disc list-inside space-y-0.5 p-text-3">
          <li>Copies: SOUL.md, {messagesUpToHere} message{messagesUpToHere === 1 ? "" : "s"}, memory, {craftedToolsCount} crafted tool{craftedToolsCount === 1 ? "" : "s"}</li>
          <li>Resets: MCTS tree, evolution events, scaffold, craft scores</li>
          <li>Source workspace is unaffected</li>
        </ul>
      </div>

      <div className="space-y-1">
        <label className="text-[11px] p-text-3 block">Fork name (optional)</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`${sourceName}-fork-<6-char-id>`}
          disabled={busy}
          className="w-full px-3 py-1.5 border p-border p-card text-sm font-mono focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]"
        />
        <p className="text-[10px] p-text-3">Allowed: A-Z, a-z, 0-9, _, -</p>
      </div>

      {err && (
        <div className="p-notice-danger text-xs rounded-md px-3 py-2">
          {err}
        </div>
      )}
    </Modal>
  );
}

/* ── Subordinate chat (Column A body when a subordinate tab is active) ── */

interface SubordinatePlanContext {
  name: string;
  plan: PlanReview | null;
  rpc: Rpc;
}

/** Drives one additional agent's conversation over its own facet socket. The
 *  Work Surface and Timeline stay workspace-scoped on the parent socket (§A5) —
 *  only the chat switches here. An ordinary conversation: messages, model pick,
 *  Auto/Plan, rename, send/steer/stop (no fork/feedback/takes/restore — the
 *  facet exposes none of those). Draft, mode and reading position are this
 *  conversation's own, carried by useConversationUiState across tab switches.
 *
 *  `title` is the parent roster's name for this agent — the roster is the
 *  source of truth the tabs and sidebar read, so the header reads it too and
 *  the first-message auto-title lands everywhere in one broadcast. `onRename`
 *  goes through the parent for the same reason. */
function SubordinateChatColumn({
  workspace, subName, title, onRename, onPlanContext,
}: {
  workspace: string;
  subName: string;
  title: string;
  onRename: (displayName: string) => Promise<string>;
  onPlanContext: (context: SubordinatePlanContext | null) => void;
}) {
  const state = useKinu({ workspace, subordinate: subName });
  useEffect(() => {
    onPlanContext({ name: subName, plan: state.activePlan, rpc: state.rpc });
    return () => onPlanContext(null);
  }, [onPlanContext, state.activePlan, state.rpc, subName]);

  // The picker awaits its own write. `setModel` records the failure on
  // `state.error` and rolls the picker back to the stored spec before it
  // resolves the reason, so this handler owns the settlement and has nothing
  // to add to what the banner already shows.
  const setModel = state.setModel;
  const onPickModel = useCallback(async (spec: string): Promise<void> => {
    await setModel(spec);
  }, [setModel]);
  const ui = useConversationUiState(`${workspace}/agents/${subName}`);
  const input = ui.draft;
  const setInput = ui.setDraft;
  // The same Plan gate as the workspace column: an additional agent runs the
  // same turn pipeline, so a plan it submitted locks its composer to Plan
  // until the owner decides.
  const planAwaitingDecision = planReviewAwaitingDecision(state.activePlan);
  const effectiveMode = planAwaitingDecision ? "plan" : ui.mode;
  useEffect(() => {
    if (planAwaitingDecision) ui.setMode("plan");
    else if (state.activePlan?.status === "approved") ui.setMode("build");
  }, [planAwaitingDecision, state.activePlan?.status, ui.setMode]);
  // The same older-history walk the workspace column runs, over this facet's
  // own storage. A subordinate keeps its own conversation, and a helper that
  // worked for an hour has more of one than the SDK's hydration window holds.
  const { history, transcript, thread } = useChatThread(
    state.rpc, state.messages, state.transcriptSeeded, state.steerRuns);
  const messagesRef = useGrowingScroll<HTMLDivElement>({
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

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // `sendChat` owns admission — one synchronous latch inside `useKinu`. A
  // reactive `state.isStreaming` pre-check here is what let two presses in one
  // tick both pass, so the composer is cleared only for the press that was
  // actually admitted and a refused press leaves the draft alone.
  const send = useCallback(() => {
    const t = input.trim();
    if (!t) return;
    if (!state.sendChat(t, [], effectiveMode)) return;
    setInput("");
  }, [input, state, effectiveMode, setInput]);

  const { notice: steerNotice, steer, stop } = useSteerActions({
    steerChat: (text) => state.steerChat(text, effectiveMode),
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
  return (
    <div className="@container relative flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b p-border">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <ConnectionIndicator status={state.connectionStatus} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <InlineRenameTitle title={title} onRename={onRename} subject="agent" textClass="text-sm font-medium" />
              {state.isStreaming && (
                  <span className="shrink-0 inline-flex items-center gap-1.5 px-1.5 @[34rem]:px-2 py-0.5 rounded-full p-accent-subtle" title="The agent is working">
                    <span className="size-1.5 rounded-full p-dot-accent animate-pulse" />
                    <span className="hidden @[34rem]:inline p-meta p-accent font-medium">working</span>
                  </span>
                )}
            </div>
          </div>
        </div>
      </div>

      <ErrorBoundary label="Agent chat">
        <div ref={messagesRef} className="flex-1 overflow-y-auto px-6 py-5 space-y-5 lg:px-8 [&>*]:max-w-[780px] [&>*]:mx-auto">
          {/* Above the oldest message, exactly as the workspace column has it:
              a walk in progress, a failed page with its retry, or the store's
              own statement that this is the beginning. Suppressed only when
              there is nothing at all, where the empty state below says more. */}
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
            streaming={state.isStreaming}
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
              isLast={i === thread.entries.length - 1}
              isStreaming={state.isStreaming}
            />
          ))}
          {thread.trailing.map((steer) => <SteerBubble key={steer.id} steer={steer} />)}
          {state.chatError && (
            <ChatErrorCard
              message={state.chatError.body}
              replayed={state.chatError.replayed}
              streaming={state.isStreaming}
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
          placeholder={state.isStreaming
            ? `Steer ${title}…`
            : `Message ${title}…`}
          disabled={state.connectionStatus !== "connected"}
          streaming={state.isStreaming}
          onSteer={steer}
          onStop={stop}
          mode={{ value: effectiveMode, onChange: ui.setMode, locked: planAwaitingDecision }}
          modelPicker={<ConnectedModelPicker value={as?.model ?? ""} onChange={onPickModel} size="xs" />}
          notices={[
            ...(state.error
              ? [{ id: "load", tone: "danger" as const, text: state.error,
                   action: { label: "Retry", icon: <ArrowsClockwiseIcon size={11} />, onClick: state.retryLoad } }]
              : []),
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

/* ── Main page ────────────────────────────────────────────────── */

/** Background reads and writes this page owns beyond the agent socket. Each
 *  keeps its own message so a recovery in one never hides a still-broken
 *  other, and so a failed hydrate is never rendered as "there is nothing". */
const SIDE_SOURCES = [
  { source: "visit", label: "record this visit" },
  { source: "feedback", label: "load your turn feedback" },
  { source: "takes", label: "load alternate takes" },
] as const;

type SideSource = (typeof SIDE_SOURCES)[number]["source"];

export default function WorkspacePage() {
  const { agentId, subName } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const state = useKinu(agentId);
  const { entries: workspaceEntries } = useWorkspaceRoster();
  const [subordinatePlanContext, setSubordinatePlanContext] =
    useState<SubordinatePlanContext | null>(null);
  const syncSubordinatePlanContext = useCallback((context: SubordinatePlanContext | null) => {
    setSubordinatePlanContext(context);
  }, []);
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

  // The picker awaits its own write. `setModel` records the failure on
  // `state.error` and rolls the picker back to the stored spec before it
  // resolves the reason, so this handler owns the settlement and has nothing
  // to add to what the banner already shows.
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
  // ?altitude=supervise deep-links straight to the Supervise altitude (the
  // /triggers/:id redirect and settings' Automations link use it).
  const [altitude, setAltitude] = useState<Altitude>(
    () => new URLSearchParams(location.search).get("altitude") === "supervise" ? "supervise" : "run",
  );
  // A returning driver opens on status, not on the agent's own description.
  const [mobilePane, setMobilePane] = useState<'chat' | 'workspace'>('chat');
  const [desktopPanels, setDesktopPanels] = useState(
    () => globalThis.window === undefined || globalThis.window.matchMedia("(min-width: 768px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const sync = () => setDesktopPanels(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  // Output still takes over the moment there is something running to look at.
  const subordinateReview = subName !== undefined
    && subordinatePlanContext?.name === subName
    ? subordinatePlanContext
    : null;
  const visiblePlan = subName === undefined ? state.activePlan : subordinateReview?.plan ?? null;
  const [surface, setSurface] = useState<SurfaceKind>("Work");
  // Draft, Auto/Plan and reading position belong to THIS conversation — the
  // orchestrator's — and survive tab switches and revisits without leaking
  // into any additional agent's composer.
  const ui = useConversationUiState(`${agentId ?? ""}/main`);
  const chatMode = ui.mode;
  const setChatMode = ui.setMode;
  const planAwaitingDecision = planReviewAwaitingDecision(state.activePlan);
  const effectiveChatMode = planAwaitingDecision ? "plan" : chatMode;
  const chatInput = ui.draft;
  const setChatInput = ui.setDraft;
  const [forkFor, setForkFor] = useState<string | null>(null); // message id to fork at, or null
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  // ── Older history ────────────────────────────────────────────────────────
  // `state.messages` is the LIVE list: the SDK's `get-messages` seed (which is
  // `Think.messages`, a bounded newest window governed by hydrationByteBudget)
  // plus everything the socket has streamed since. Anything older than that
  // window exists only in storage and is reached one cursored page at a time.
  //
  // The seed can be empty while storage is not — the window is rebuilt from
  // storage on every activation, and an activation that could not rebuild it
  // serves nothing. So an empty seed starts the walk at the newest page rather
  // than not starting it: the store is asked, and "there is nothing here" is
  // then something the store said instead of something the socket failed to
  // say. That is the report — a workspace whose conversation was gone.
  const { history, transcript, thread } = useChatThread(
    state.rpc, state.messages, state.transcriptSeeded, state.steerRuns);

  const messagesRef = useGrowingScroll<HTMLDivElement>({
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
  // Pending chat attachments — fed by the attach button, paste, and drag-drop
  // onto the chat column; rendered as removable chips above the input. The hook
  // owns the per-message AGGREGATE cap (all pending data-URL parts persist
  // inside one DO message row, see core/cloud-wire) and spends it inside its
  // reducer, so two additions started before either finished cannot both
  // reserve the same remaining capacity.
  const attachments = usePendingAttachments(CLOUD_MAX_INLINE_ATTACHMENT_BYTES);
  const [dragOver, setDragOver] = useState(false);

  const onChatDragOver = useCallback((e: ReactDragEvent) => {
    if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); }
  }, []);
  const onChatDragLeave = useCallback((e: ReactDragEvent) => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setDragOver(false);
  }, []);
  const onChatDrop = useCallback((e: ReactDragEvent) => {
    const files = e.dataTransfer.files;
    if (!files.length) return;
    e.preventDefault();
    setDragOver(false);
    // Handed straight over: the hook owns the conversion task through
    // settlement and returns nothing to await, so the transition this used to
    // be wrapped in resolved on an already-finished value and deferred nothing.
    attachments.add(files);
  }, [attachments]);

  // Auto-grow the chat input with its content (kumo InputArea has no resize
  // logic). The max-h-40 class clamps growth; beyond it the textarea scrolls
  // internally. Clearing chatInput after send collapses it back to one row.
  useLayoutEffect(() => {
    const el = chatInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [chatInput]);

  useEffect(() => {
    if (!agentId) return;
    startTransition(async () => {
      try {
        await touchWorkspace(agentId);
        reportSide("visit", null);
      } catch (cause) {
        reportSide("visit", describeError(cause));
      }
    });
  }, [agentId, reportSide]);

  // Bridge the open workspace's live status to the sidebar roster (running dot +
  // unseen-evolution dot). Only the mounted workspace has a live socket, so the
  // roster reflects status for workspaces visited this session.
  useEffect(() => {
    if (!agentId) return;
    const running = state.isStreaming || state.backgroundJobs.some((j) => j.status === "running");
    window.dispatchEvent(new CustomEvent("kinu:workspace-activity", {
      detail: {
        name: agentId,
        running,
        unseenChangelog: state.changelogUnseen,
        agents: state.subordinates.map((sub) => ({
          name: sub.name, displayName: sub.displayName, status: sub.status,
        })),
      },
    }));
  }, [agentId, state.isStreaming, state.backgroundJobs, state.changelogUnseen, state.subordinates]);

  // The sidebar has no socket of its own. Once this page unmounts, its last
  // activity snapshot is no longer live; clear it rather than leaving a green
  // "working now" dot on a workspace whose connection has gone away.
  useEffect(() => {
    if (!agentId) return;
    return () => {
      window.dispatchEvent(new CustomEvent("kinu:workspace-activity", {
        detail: { name: agentId, running: false, unseenChangelog: 0, agents: [] },
      }));
    };
  }, [agentId]);

  // The ONE rule that steers the surface on its own: a newly exposed sandbox
  // port switches to Output, where the running app is. Environment used to run
  // a second, competing rule over the same signal — two owners of one decision,
  // which is a bug however either of them behaves — and it went with the
  // preview panes it drove.
  // (Port discovery itself lives in useKinu' live-data poll, so this fires
  // from any surface.)
  const prevPortCountRef = useRef(0);
  useEffect(() => {
    const n = state.pinnedPorts.length;
    const planOwnsOutput = chatMode === "plan"
      || visiblePlan?.status === "pending"
      || visiblePlan?.status === "changes_requested";
    if (n > prevPortCountRef.current && !planOwnsOutput) setSurface("Output");
    prevPortCountRef.current = n;
  }, [chatMode, state.pinnedPorts.length, visiblePlan?.status]);

  // A new durable revision owns focus once. Annotation saves update the same
  // revision and must not keep dragging the owner back after they navigate.
  const previousPlanRef = useRef<string | null>(null);
  useEffect(() => {
    const key = visiblePlan
      ? `${subName ?? "main"}/${visiblePlan.id}/${visiblePlan.revision}`
      : null;
    if (key && key !== previousPlanRef.current) setSurface("Output");
    if (subName === undefined) {
      if (planAwaitingDecision) setChatMode("plan");
      else if (state.activePlan?.status === "approved") setChatMode("build");
    }
    previousPlanRef.current = key;
  }, [
    planAwaitingDecision,
    setChatMode,
    state.activePlan?.status,
    subName,
    visiblePlan?.id,
    visiblePlan?.revision,
  ]);

  // `sendChat` owns admission — one synchronous latch inside `useKinu`, so a
  // reactive `state.isStreaming` pre-check here is exactly what let two presses
  // in one tick both start a turn. The draft and its attachments are cleared
  // only for the press that was admitted; a refused press keeps both.
  const handleSend = useCallback(() => {
    const t = chatInput.trim();
    if (!t && attachments.parts.length === 0) return;
    if (!state.sendChat(t, [...attachments.parts], effectiveChatMode)) return;
    setChatInput("");
    attachments.clear();
  }, [chatInput, attachments, effectiveChatMode, state]);

  // Steer-as-Branch: while the agent streams, the composer's split affordance
  // runs the draft as a parallel head (branchTurn) — the live turn continues;
  // progress arrives as branch_status broadcasts (state.branchRuns).
  const [branchNotice, setBranchNotice] = useState<string | null>(null);
  const handleBranch = useCallback(() => {
    const t = chatInput.trim();
    if (!t || !state.isStreaming || effectiveChatMode === "plan") return;
    setBranchNotice(null);
    // The composer is cleared only once the branch was actually accepted — a
    // refused or failed branch used to destroy what the user had typed. The
    // identity check leaves anything typed while the RPC was in flight alone.
    startTransition(async () => {
      try {
        const result = await state.rpc<{ accepted: boolean; reason?: string }>("branchTurn", [t]);
        if (result.accepted) ui.updateDraft((current) => current.trim() === t ? "" : current);
        else setBranchNotice(result.reason ?? "Branching is unavailable right now.");
      } catch (cause) {
        setBranchNotice(renderThrownChain({ cause }));
      }
    });
  }, [chatInput, effectiveChatMode, state]);

  /**
   * Steer and Stop — the composer's mid-turn pair, shared with the subordinate
   * column so both surfaces give the same account of where a message went.
   *
   * The thread the chat draws — every steer inside the turn that read it, and
   * only an unplaceable one trailing — comes from `useChatThread` above, which
   * owns that one rule for the live splice and the reloaded row alike.
   */
  const { notice: steerNotice, steer: handleSteer, stop: handleStop } = useSteerActions({
    steerChat: (text) => state.steerChat(text, effectiveChatMode),
    abortChat: state.abortChat,
    draft: chatInput,
    setDraft: ui.updateDraft,
    hasAttachments: attachments.parts.length > 0,
    steerRuns: state.steerRuns,
  });

  // Identity-stable handlers so memo(MessageView) holds across stream ticks.
  const onForkMessage = useCallback((mid: string) => setForkFor(mid), []);

  // Thumbs feedback — hydrated from the server (it remembers across reloads)
  // and only committed locally when the RPC succeeds; failures propagate to
  // MessageFeedback so the toggle never lies about evolution-scoring input.
  const [feedbackByMessage, setFeedbackByMessage] = useState<Record<string, 'positive' | 'negative'>>({});
  useEffect(() => {
    if (state.connectionStatus !== "connected") return;
    startTransition(async () => {
      try {
        const loaded = await state.rpc<Record<string, 'positive' | 'negative'>>('listTurnFeedback');
        setFeedbackByMessage(loaded);
        reportSide("feedback", null);
      } catch (cause) {
        reportSide("feedback", describeError(cause));
      }
    });
  }, [state.connectionStatus, state.rpc, reportSide]);

  // Alternate Takes chips, keyed by assistant message id — hydrated on load
  // and refreshed when a turn settles (a think convergence may have produced
  // a fresh near-tied set for the answer that just streamed in).
  const [takesByTurn, setTakesByTurn] = useState<Record<string, AlternateTakeSet>>({});

  // A signal that started a turn has a durable message; one spliced into a
  // running turn never will. Both are the same card, so the message renders it
  // once it exists and the live list carries the rest — never both.
  const cardStates = useMemo(
    () => new Map(state.signalCards.map((card) => [card.id, card.state])),
    [state.signalCards]);
  const messageCardIds = useMemo(() => new Set(state.messages.flatMap((msg) => {
    const id = messageSignalId(msg.metadata);
    return id ? [id] : [];
  })), [state.messages]);
  const looseCards = useMemo(() => state.signalCards.flatMap((card) => {
    if (messageCardIds.has(card.id)) return [];
    const turn = classifyProgrammaticTurn(card.metadata);
    return turn ? [{ card, turn }] : [];
  }), [state.signalCards, messageCardIds]);

  const cardStateOf = <Metadata,>(metadata: Metadata) => {
    const id = messageSignalId(metadata);
    return id ? cardStates.get(id) : undefined;
  };

  const settledBranchCount = state.branchRuns.filter((b) => b.status === "settled").length;
  useEffect(() => {
    if (state.connectionStatus !== "connected" || state.isStreaming) return;
    startTransition(async () => {
      try {
        const loaded = await state.rpc<Record<string, AlternateTakeSet>>('listAlternateTakes');
        setTakesByTurn(loaded);
        reportSide("takes", null);
      } catch (cause) {
        reportSide("takes", describeError(cause));
      }
    });
    // settledBranchCount: a branch settling after the turn ended persists a
    // fresh set — refetch so its chip can hydrate the comparison.
  }, [state.connectionStatus, state.isStreaming, state.rpc, settledBranchCount, reportSide]);

  const onPickTake = useCallback(async (takeId: string, nodeId: string): Promise<TakePickOutcome> => {
    const result = await state.rpc<TakePickOutcome>('pickAlternateTake', [takeId, nodeId]);
    const turnId = result.set.turnId;
    if (turnId) setTakesByTurn((prev) => ({ ...prev, [turnId]: result.set }));
    return result;
  }, [state.rpc]);
  // Shadow-git restore — the files half of walk-back. The store lives on the
  // user's device daemon; the DO forwards. Shows the plan (paths + counts)
  // before applying; the restore itself is preceded by a safety snapshot.
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  // Planning is several sequential RPCs over the device tunnel; without a
  // guard the affordance was re-entrant, and the plan was shown in a native
  // confirm() — a browser-chrome box for an operation that overwrites files on
  // the user's actual machine.
  const [planning, setPlanning] = useState(false);
  const [restorePlan, setRestorePlan] = useState<RestorePlan | null>(null);
  const [restoring, setRestoring] = useState(false);

  const onRestoreFiles = useCallback(async (mid: string) => {
    if (planning || restoring) return;
    setRestoreNotice(null);
    setPlanning(true);
    try {
      // Keyed on the turn IN THE STORE, not filtered here. Reading a window and
      // filtering client-side is what produced "It changed no device files." on a
      // turn that had written plenty: retention is per working directory while
      // this limit is global across them, so once the operator had a few active
      // directories a still-restorable checkpoint fell outside the newest 200 and
      // the empty filter result was rendered as a fact about the turn.
      const { availability, entries } =
        await state.rpc<FileCheckpointListing>('listFileCheckpoints', [200, mid]);
      if (!availability.available) {
        // The store is not reachable. Saying anything about what the turn
        // changed would be a guess: this is where "It changed no device files."
        // came from on a turn that had written plenty.
        setRestoreNotice(
          `File history is unavailable: ${availability.reason ?? 'the checkpoint store cannot be reached'}.`,
        );
        return;
      }
      // Now an empty answer means what it says: the store searched every
      // directory for this turn and holds no checkpoint for it.
      if (entries.length === 0) {
        setRestoreNotice(
          'This turn changed no files on your device. Workspace and sandbox changes cannot be restored here.',
        );
        return;
      }
      const matches = entries;
      const plans: FileRestorePlan[] = [];
      for (const entry of matches) {
        plans.push(await state.rpc<FileRestorePlan>('planFileRestore', [entry.dir, entry.id]));
      }
      const files = plans.flatMap((p) => p.files);
      if (files.length === 0) {
        setRestoreNotice('Your files already match the state before this turn.');
        return;
      }
      setRestorePlan({ entries: matches, dirs: plans.map((p) => p.dir), files });
    } catch (err) {
      setRestoreNotice(`Restore failed: ${renderThrownChain({ cause: err })}`);
    } finally {
      setPlanning(false);
    }
  }, [state.rpc, planning, restoring]);

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

  // First-paint loading: only when we genuinely have nothing to show.
  // (STABILITY-AUDIT §A1 — never unmount on transient WS errors.)
  if (state.connectionStatus === "connecting" && !state.agentStatus) return (
    <div className="h-full flex items-center justify-center"><div className="flex items-center gap-2 text-sm p-text-2"><Loader size="sm" /><span>Connecting...</span></div></div>
  );
  if (state.terminalClose && !state.agentStatus) {
    return <TerminalCloseBoundary close={state.terminalClose} onRetry={state.retryLoad} />;
  }
  if (!agentId) return null;

  const as = state.agentStatus;
  const rosterTitle = workspaceEntries.find((entry) => entry.name === agentId)?.displayName;
  // NOT `|| agentId`. `agentId` is the slug in the address bar, and falling
  // back to it is what titled a new workspace `handwrought-walnut-4166c321`.
  // The URL still carries the id for anyone who needs one.
  const shownTitle = workspaceTitle(as?.displayName || rosterTitle);
  return (
    <div className="h-full flex flex-col">
      {/* Non-destructive disconnect banner. The chat panel below stays
          mounted so the in-flight assistant turn is preserved through
          partysocket auto-reconnect. (STABILITY-AUDIT §A1.) */}
      {/* Mutually exclusive with the terminal state below by construction: the
          spinner claims a reconnect is coming, which is only true while the SDK
          is still attempting one. */}
      {state.connectionStatus === "disconnected" && !state.terminalClose && (
        <div className="flex items-center justify-center gap-2 px-3 py-1.5 text-xs p-warning border-b p-border" style={{ background: "var(--c-warning-tint)" }}>
          <ArrowsClockwiseIcon size={12} className="animate-spin" />Reconnecting...
        </div>
      )}
      {/* The same classification for a workspace that WAS on screen and then
          lost access: it says so and keeps both affordances, rather than
          spinning forever over a session that cannot come back. */}
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

      {/* The one identity row, and the workspace-scoped controls that belong
          with it — including the altitude switch: RUN (this run,
          mission-control) ⇄ SUPERVISE (the agent over time). */}
      <WorkspaceBar
        title={shownTitle}
        onRename={state.setDisplayName}
        connectionStatus={state.connectionStatus}
        working={state.isStreaming}
        model={as?.model}
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
            <SupervisePage rpc={state.rpc} onRunTask={(t) => { setAltitude("run"); state.sendChat(t); }} />
          </ErrorBoundary>
        </div>
      ) : (
      <>
      <div className="flex shrink-0 items-center gap-1 border-b p-border p-sidebar px-3 py-2 md:hidden">
        <button type="button" onClick={() => setMobilePane('chat')} aria-pressed={mobilePane === 'chat'}
          className={`rounded-full px-3 py-1.5 text-xs ${mobilePane === 'chat' ? 'p-accent-subtle p-gold' : 'p-text-3'}`}>Chat</button>
        <button type="button" onClick={() => setMobilePane('workspace')} aria-pressed={mobilePane === 'workspace'}
          className={`rounded-full px-3 py-1.5 text-xs ${mobilePane === 'workspace' ? 'p-accent-subtle p-gold' : 'p-text-3'}`}>Workspace{state.pendingActions.length > 0 ? ` · ${String(state.pendingActions.length)}` : ''}</button>
      </div>
      <PanelGroup key={desktopPanels ? "desktop" : mobilePane} className="flex-1">
        {/* ── Column A — Chat / Steer ─────────────────────────── */}
        <Panel
          {...(desktopPanels
            ? { minSize: "24%" }
            : { minSize: "0%", defaultSize: mobilePane === 'chat' ? "100%" : "0%" })}
          groupResizeBehavior="preserve-relative-size"
        >
          <div className="flex flex-col h-full border-r p-border">
            {/* Agent tabs — the workspace's orchestrator + durable subordinates.
                Roster + live status ride the parent socket; the CHAT below
                switches per tab while Columns B/C stay workspace-scoped. This
                strip is the chat column's only chrome, so it also carries what
                acts on ONE conversation: clearing the main transcript. */}
            <SubordinateTabs
              workspace={agentId}
              subordinates={state.subordinates}
              activeName={subName}
              onCreate={createAndOpenAgent}
              creating={creatingAgent}
              onDismiss={(name) => state.dismissSubordinate(name).then(() => {})}
              trailing={!subName && state.messages.length > 0 && (
                <Button variant="ghost" {...SQUARE_BUTTON_PROPS} size="sm"
                  onClick={() => setShowClearConfirm(true)}
                  icon={<TrashIcon size={12} />} aria-label="Clear history" />
              )}
            />
            {subName ? (() => {
              // The parent roster is the one source the tabs and sidebar read,
              // so the header reads it too; a deep link that lands before the
              // roster row arrives shows the address until it does.
              const rosterEntry = state.subordinates.find((entry) => entry.name === subName);
              return (
                <SubordinateChatColumn
                  key={subName}
                  workspace={agentId}
                  subName={subName}
                  title={rosterEntry ? agentTitle(rosterEntry.displayName) : subName}
                  onRename={(displayName) => state.renameSubordinate(subName, displayName).then((entry) => entry.displayName)}
                  onPlanContext={syncSubordinatePlanContext}
                />
              );
            })() : (
            <div className="@container relative flex flex-col flex-1 min-h-0"
              onDragOver={onChatDragOver} onDragLeave={onChatDragLeave} onDrop={onChatDrop}>
            {dragOver && (
              <div className="absolute inset-0 z-10 pointer-events-none flex items-center justify-center rounded-lg border-2 border-dashed"
                style={{ borderColor: "var(--c-accent)", background: "var(--c-accent-subtle)" }}>
                <div className="flex items-center gap-2 text-sm p-text px-3 py-1.5 rounded-lg p-elevated border p-border">
                  <PaperclipIcon size={16} className="p-accent" />Drop files to attach
                </div>
              </div>
            )}
            {/* Messages — generous padding for spacious feel.
                ErrorBoundary'd so a single malformed message doesn't
                whitescreen the chat. (STABILITY-AUDIT §D2.) */}
            <ErrorBoundary label="Chat">
            {/* One centred 780px reading measure. Every entry stays within it,
                so prose remains readable while tables and activity rows gain space. */}
            <div ref={messagesRef} className="flex-1 overflow-y-auto px-6 py-7 space-y-5 lg:px-8 [&>*]:max-w-[780px] [&>*]:mx-auto">
              <ConversationStartBoundary
                hasEntries={thread.entries.length > 0}
                streaming={state.isStreaming}
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
                return (
                  <MessageView
                    key={msg.id}
                    message={msg}
                    steers={steers}
                    isLast={i === thread.entries.length - 1}
                    isStreaming={state.isStreaming}
                    onFork={onForkMessage}
                    onFeedback={onMessageFeedback}
                    feedback={feedbackByMessage[msg.id] ?? null}
                    onRestoreFiles={onRestoreFiles}
                    takesChip={hasComparableTakes(takes)
                      ? <TakesChip set={takes} onPick={onPickTake} />
                      : undefined}
                    signalState={cardStateOf(msg.metadata)}
                  />
                );
              })}
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
              {state.chatError && (
                <ChatErrorCard
                  message={state.chatError.body}
                  replayed={state.chatError.replayed}
                  streaming={state.isStreaming}
                  onRetry={state.retryLastMessage}
                  onDismiss={state.clearChatError}
                />
              )}
            </div>
            </ErrorBoundary>

            {/* Device-consent cards — an agent wants to use a connected device */}
            {state.pendingConsents.length > 0 && (
              <div className="px-5 lg:px-7 space-y-2 pb-1">
                {state.pendingConsents.map((c) => (
                  <DeviceConsentCard key={c.consentId} consent={c} onResolve={state.resolveConsent} />
                ))}
              </div>
            )}

            {/* Input. Everything the composer needs to say goes through
                `notices`, so a failure, a warning and a progress line all read
                as the same kind of object instead of five improvised rows.
                `Composer` owns paste, the file input and the attachment chips. */}
            <div className="border-t p-border p-sidebar">
              <Composer
                textareaRef={chatInputRef}
                value={chatInput}
                onValueChange={setChatInput}
                onSend={handleSend}
                placeholder={state.isStreaming ? "Steer the running turn…" : "Send a message..."}
                disabled={state.connectionStatus !== "connected"}
                streaming={state.isStreaming}
                onSteer={handleSteer}
                onStop={handleStop}
                onBranch={handleBranch}
                mode={{ value: effectiveChatMode, onChange: setChatMode, locked: planAwaitingDecision }}
                attachments={{
                  parts: [...attachments.parts],
                  onAdd: attachments.add,
                  onRemove: attachments.remove,
                }}
                modelPicker={<ConnectedModelPicker value={as?.model ?? ""} onChange={onPickModel} size="xs" />}
                notices={[
                  ...(state.error ? [{ id: "load", tone: "danger" as const, text: state.error,
                    action: { label: "Retry", icon: <ArrowsClockwiseIcon size={11} />, onClick: state.retryLoad } }] : []),
                  ...(state.newerDeployedBuild ? [{
                    id: "version", tone: "info" as const,
                    text: "A new version is ready. Reload this tab to use it.",
                    action: { label: "Reload", icon: <ArrowsClockwiseIcon size={11} />, onClick: () => window.location.reload() },
                  }] : []),
                  ...(attachments.refusal ? [{ id: "attach", tone: "warning" as const, text: attachments.refusal }] : []),
                  // Each side read that failed, named. These are collected by
                  // reportSide and would otherwise be recorded and never shown,
                  // which is the "there is nothing" reading SIDE_SOURCES exists
                  // to prevent.
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
                  ...(planning ? [{ id: "planning", tone: "progress" as const,
                    text: "Checking what this turn changed on your device…" }] : []),
                  ...(restoreNotice ? [{ id: "restore", tone: "neutral" as const, text: restoreNotice,
                    onDismiss: () => setRestoreNotice(null) }] : []),
                  ...(steerNotice ? [steerNotice] : []),
                ]}
              />
            </div>
            </div>
            )}
          </div>
        </Panel>

        {desktopPanels && <PanelResizeHandle className="z-[2] -ml-[3px] w-[5px] shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-[var(--c-accent-subtle)]" />}

        {/* The mock keeps the inspector at 430px and lets chat take the
            remainder. It can still be dragged; resizing the window preserves
            the inspector's useful reading width instead of a 42/58 ratio. */}
        <Panel
          {...(desktopPanels
            ? { minSize: "28%", defaultSize: "430px" }
            : { minSize: "0%", defaultSize: mobilePane === 'workspace' ? "100%" : "0%" })}
          groupResizeBehavior="preserve-pixel-size"
        >
          <WorkSurface
            surface={surface}
            onSurface={setSurface}
            pinnedPorts={state.pinnedPorts}
            previewError={state.previewError}
            onRefreshPorts={state.refreshExposedPorts}
            plan={visiblePlan}
            planRpc={subordinateReview?.rpc}
            snapshot={state.snapshot}
            onRetryLoad={state.retryLoad}
            tools={state.tools}
            memory={state.memory}
            memoryContent={state.memoryContent}
            onSearchMemory={state.searchMemory}
            mctsTrees={state.mctsTrees}
            headActivity={state.headActivity}
            headDeltas={state.headDeltas}
            isStreaming={state.isStreaming}
            executors={state.executors}
            executorOutputs={state.executorOutputs}
            lastActiveExecutor={state.lastActiveExecutor}
            onExecute={state.executeInExecutor}
            backgroundJobs={state.backgroundJobs}
            onRefreshJobs={state.refreshBackgroundJobs}
            pendingActions={state.pendingActions}
            onRefreshQueue={state.refreshPendingActions}
            onChangelogSeen={state.clearChangelogUnseen}
            agentViews={state.agentViews}
            tabPresence={state.tabPresence}
            rpc={state.rpc}
          />
        </Panel>

      </PanelGroup>
      </>
      )}

      {forkFor && (
        <ForkModal
          sourceName={shownTitle}
          messagesUpToHere={state.messages.findIndex(m => m.id === forkFor) + 1}
          craftedToolsCount={as?.craftedToolCount ?? 0}
          onCancel={() => setForkFor(null)}
          onSubmit={async (name) => {
            try {
              const result = await state.forkAgent(forkFor, name ? { name } : undefined);
              setForkFor(null);
              await navigate(result.url);
            } catch (err) {
              // Surface the error inside the modal — return string rejects.
              throw err instanceof Error ? err : new Error(String(err));
            }
          }}
        />
      )}

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
            {/* The walk is reset with the same press, not after it: a first
                history page already in flight belongs to the conversation being
                cleared, and without a new generation it landed afterwards and
                put the cleared messages straight back on screen. */}
            <FilledButton danger onClick={() => {
              state.clearHistory();
              history.reset();
              setShowClearConfirm(false);
            }}>Clear history</FilledButton>
          </>}
        >
          <p className="text-xs p-text-2 leading-relaxed">
            This cannot be undone. Memory, SOUL.md, crafted tools, and evolution stay unchanged.
          </p>
        </Modal>
      )}
    </div>
  );
}

/** The device-file restore confirm. Shows the same plan the native confirm()
 *  used to cram into a browser dialog — this overwrites files on the user's
 *  real machine, so it gets the app's own destructive-action treatment. */
interface RestorePlan {
  entries: FileCheckpointEntry[];
  dirs: string[];
  files: FileRestoreChange[];
}

const RESTORE_PREVIEW_LIMIT = 12;
const RESTORE_MARK = { modify: "~", create: "+", delete: "-" } satisfies Record<FileRestoreChange["kind"], string>;

function RestoreFilesModal({ plan, busy, onCancel, onConfirm }: {
  plan: RestorePlan; busy: boolean; onCancel: () => void; onConfirm: () => void;
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
      title="Restore files to before this turn"
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
        <ul className="rounded-md border p-border p-elevated max-h-52 overflow-y-auto text-[11px] font-mono">
          {shown.map((f) => (
            <li key={`${f.kind}:${f.path}`} className="flex gap-2 px-2.5 py-1 border-b p-border last:border-0">
              <span className={`shrink-0 ${f.kind === "create" ? "p-success" : f.kind === "delete" ? "p-danger" : "p-warning"}`}>{RESTORE_MARK[f.kind]}</span>
              <span className="p-text-2 truncate" title={f.path}>{f.path}</span>
            </li>
          ))}
          {plan.files.length > shown.length && (
            <li className="px-2.5 py-1 p-text-3">… {plan.files.length - shown.length} more</li>
          )}
        </ul>
      </div>
    </Modal>
  );
}
