import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, type DragEvent as ReactDragEvent } from "react";
import { useParams, useLocation, Link, useNavigate } from "react-router-dom";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { Button, Loader } from "@cloudflare/kumo";
import { btnSmCls } from "@/components/ui/form";
import {
  ArrowsClockwiseIcon, GitBranchIcon, CheckCircleIcon, TrashIcon,
  ClockIcon, WarningCircleIcon, DesktopTowerIcon, PaperclipIcon,
  ClockCounterClockwiseIcon, UserPlusIcon,
} from "@phosphor-icons/react";
import { convertFileListToFileUIParts } from "ai";
import type { FileUIPart } from "ai";
import {
  CLOUD_MAX_INLINE_ATTACHMENT_BYTES, mergeTranscript, pageSchema,
  isPlaceholderMission, planReviewAwaitingDecision, summarizeRestorePlan,
} from "@kinu.run/core";
import type {
  AlternateTakeSet, ChatHistoryEntry, FileCheckpointEntry, FileCheckpointListing,
  FileRestoreChange, FileRestorePlan, Page, TakePickOutcome,
} from "@kinu.run/core";
import * as v from "valibot";
import { useKinu, type SteerRun } from "@/hooks/use-kinu";
import { useGrowingScroll } from "@/hooks/use-growing-scroll";
import { usePagedScroll } from "@/hooks/use-paged-scroll";
import { useSteerActions } from "@/hooks/use-steer-actions";
import { touchWorkspace } from "@/lib/user-api";
import { describeError } from "@/hooks/use-async-resource";
import { ConnectedModelPicker } from "@/components/ModelPicker";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ConnectionIndicator } from "@/components/connection-indicator";
import { Modal } from "@/components/ui/Modal";
import { MessageView, ProgrammaticTurnCard, SteeredMark } from "@/components/MessageView";
import { TakesChip, BranchRunChip } from "@/components/AlternateTakes";
import { hasComparableTakes } from "@/components/alternate-takes-logic";
import { classifyProgrammaticTurn, messageSignalId } from "@/components/background-event";
import { WorkSurface, type SurfaceKind } from "@/components/surfaces/WorkSurface";
import { KinuMark } from "@/components/surfaces/shared";
import { SupervisePage } from "./SupervisePage";
import { SubordinateTabs } from "@/components/SubordinateTabs";
import { WorkspaceBar, type Altitude } from "@/components/WorkspaceBar";
import { Composer } from "@/components/Composer";
import { dataUrlRawBytes } from "@/components/AttachmentChip";
import type { PendingConsent, SubordinateActivityEvent } from "@/lib/protocol";
import { renderThrownChain } from "@kinu.run/core/obs";
// The model picker reads /api/user/models (which unions the connected
// providers' menus); the result is cached for the SPA session (see user-api).

/* ── Transcript chrome ────────────────────────────────────────── */

/** Messages per older-history request. Small enough that a page renders in one
 *  frame and the scroll stays smooth, large enough that a flick up does not
 *  need a dozen round trips. */
const CHAT_PAGE_SIZE = 40;
const ChatHistoryPageSchema: v.GenericSchema<Page<ChatHistoryEntry>> = pageSchema(v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  role: v.picklist(["user", "assistant", "system"]),
  content: v.string(),
  createdAt: v.union([v.string(), v.number()]),
}));
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
 * The top of the transcript: what is above the oldest message on screen.
 *
 * Four distinct answers, never collapsed into silence. "Failed" in particular
 * has to be its own state — rendering nothing there would tell the reader they
 * had reached the beginning of a conversation the pane simply could not fetch.
 *
 * All four are the same height, including the idle one. This row sits directly
 * above the prepend, so a row that changes size as it changes state moves the
 * transcript under the reader by the difference — measured at 15px per page
 * before it was pinned, which is small, constant, and accumulates once per
 * page for as long as someone keeps scrolling.
 */
export function HistoryBoundary({ loading, error, exhausted, onRetry }: {
  loading: boolean;
  error: string | null;
  exhausted: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-7 items-center justify-center gap-2 text-xs">
      {error ? (
        <>
          <WarningCircleIcon size={13} className="p-danger shrink-0" />
          <span className="p-text-3">Could not load earlier messages.</span>
          <button onClick={onRetry} className="p-accent hover:underline">Retry</button>
        </>
      ) : loading ? (
        <span className="flex items-center gap-2 p-text-3"><Loader size="sm" />Loading earlier messages…</span>
      ) : exhausted ? (
        <>
          <span className="h-px flex-1 p-border border-t" />
          <span className="p-text-3 text-[11px]">Beginning of the conversation</span>
          <span className="h-px flex-1 p-border border-t" />
        </>
      ) : null}
    </div>
  );
}

/** Consent card: an agent wants to use a connected device. */
export function DeviceConsentCard({ consent, onResolve }: {
  consent: PendingConsent;
  onResolve: (consentId: string, decision: "once" | "always" | "deny") => void;
}) {
  return (
    <div className="p-tint-warning rounded-xl border p-3 animate-fade-in">
      <div className="flex items-start gap-2">
        <DesktopTowerIcon size={16} className="p-warning shrink-0 mt-0.5" weight="fill" />
        <div className="min-w-0 flex-1">
          <div className="text-xs p-text">
            This agent wants to use <span className="font-medium">{consent.deviceLabel}</span> for a local action:
          </div>
          <code className="block mt-1 text-[11px] p-text-2 font-mono break-all p-fill rounded-sm px-2 py-1">{consent.command || "(command)"}</code>
          <div className="mt-1 text-[10px] p-text-3">
            Always allow grants this agent all future local actions on this device until revoked.
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2.5 justify-end">
        <button onClick={() => onResolve(consent.consentId, "deny")}
          className="px-2.5 py-1 text-[11px] rounded-md p-text-3 hover:p-text">Deny</button>
        <button onClick={() => onResolve(consent.consentId, "once")}
          className="px-2.5 py-1 text-[11px] p-card p-card-hover p-text-2">Allow once</button>
        <button onClick={() => onResolve(consent.consentId, "always")}
          className="px-2.5 py-1 text-[11px] rounded-md font-medium p-accent-bg p-accent hover:opacity-90">Always allow local</button>
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
              ? "Nothing is failing right now — this is the outcome the server kept from the last turn that ran here, and it will keep reporting it until another turn does. Retrying re-runs that turn."
              : "Retrying runs the same turn again against the same conversation. It does not send your message a second time."}
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

/** A steer the server has taken but whose durable user row has not reached the
 *  chat yet. Deliberately the SAME bubble a user message gets: it IS one, and
 *  the only difference worth drawing is whether the model has it yet. */
function SteerBubble({ steer }: { steer: SteerRun }) {
  return (
    <div className="flex flex-col items-end animate-fade-in">
      <div className="max-w-[75%] px-4 py-2.5 rounded-xl rounded-br-md p-user-bubble p-body whitespace-pre-wrap">
        {steer.text}
      </div>
      <SteeredMark state={steer.status} />
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
        <button className={`p-btn ${btnSmCls}`} onClick={submit} disabled={busy}>
          {busy ? <><Loader size="sm" /><span className="ml-1">Forking…</span></> : "Fork"}
        </button>
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

/** Drives one subordinate's conversation over its own facet socket. The Work
 *  Surface and Timeline stay workspace-scoped on the parent socket (§A5) — only
 *  the chat switches here. A focused surface: messages, model pick, send/stop
 *  (no fork/feedback/takes/restore — the facet exposes none of those). */
function SubordinateChatColumn({ workspace, subName }: { workspace: string; subName: string }) {
  const state = useKinu({ workspace, subordinate: subName });

  // The picker is fire-and-forget: setModel records the failure on state.error
  // and rolls the picker back to the stored spec, so this call site has nothing
  // to add to what the banner already shows.
  const setModel = state.setModel;
  const onPickModel = useCallback((spec: string) => { void setModel(spec); }, [setModel]);
  const [input, setInput] = useState("");
  // No older-history walk: a subordinate facet's transcript is one delegation,
  // and the SDK's seed already carries all of it. `prepended` is therefore
  // constant — nothing is ever inserted above the live list here.
  const messagesRef = useGrowingScroll<HTMLDivElement>({ grows: "up", content: state.messages, fetched: null });
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  const send = useCallback(() => {
    const t = input.trim();
    if (!t || state.isStreaming) return;
    state.sendChat(t);
    setInput("");
  }, [input, state]);

  const messageIds = useMemo(() => state.messages.map((msg) => msg.id), [state.messages]);
  const { notice: steerNotice, steer, stop, liveSteers } = useSteerActions({
    steerChat: state.steerChat,
    abortChat: state.abortChat,
    sendChat: (text) => state.sendChat(text),
    draft: input,
    setDraft: setInput,
    steerRuns: state.steerRuns,
    messageIds,
  });

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
              <span className="font-medium text-sm p-text truncate">{as?.displayName || subName}</span>
              {state.isStreaming && (
                  <span className="shrink-0 inline-flex items-center gap-1.5 px-1.5 @[34rem]:px-2 py-0.5 rounded-full p-accent-subtle" title="The agent is working">
                    <span className="size-1.5 rounded-full p-dot-accent animate-pulse" />
                    <span className="hidden @[34rem]:inline p-meta p-accent font-medium">working</span>
                  </span>
                )}
            </div>
            {as?.purpose && <span className="block text-[11px] p-text-3 truncate">{as.purpose}</span>}
          </div>
        </div>
      </div>

      <ErrorBoundary label="Subordinate chat">
        <div ref={messagesRef} className="flex-1 overflow-y-auto px-6 py-5 space-y-5 lg:px-8">
          {state.messages.length === 0 && !state.isStreaming && (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <KinuMark size={30} className="mb-3 text-[var(--c-accent)] opacity-60" />
              <p className="text-sm p-text-3">This subordinate's conversation starts here.</p>
              {as?.soul && <p className="mt-2 max-w-sm whitespace-pre-wrap text-xs p-text-3">{as.soul}</p>}
            </div>
          )}
          {state.messages.map((msg, i) => (
            <MessageView
              key={msg.id}
              message={msg}
              isLast={i === state.messages.length - 1}
              isStreaming={state.isStreaming}
            />
          ))}
          {liveSteers.map((s) => <SteerBubble key={s.steerId} steer={s} />)}
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

      <div className="border-t p-border">
        <Composer
          textareaRef={inputRef}
          value={input}
          onValueChange={setInput}
          onSend={send}
          placeholder={state.isStreaming
            ? `Steer ${as?.displayName || subName}…`
            : `Message ${as?.displayName || subName}…`}
          disabled={state.connectionStatus !== "connected"}
          streaming={state.isStreaming}
          onSteer={steer}
          onStop={stop}
          modelPicker={<ConnectedModelPicker value={as?.model ?? ""} onChange={onPickModel} size="xs" className="min-w-0 flex-1 basis-32 max-w-44" />}
          notices={[
            ...(state.error
              ? [{ id: "load", tone: "danger" as const, text: state.error,
                   action: { label: "Retry", icon: <ArrowsClockwiseIcon size={11} />, onClick: state.retryLoad } }]
              : []),
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

  // The picker is fire-and-forget: setModel records the failure on state.error
  // and rolls the picker back to the stored spec, so this call site has nothing
  // to add to what the banner already shows.
  const setModel = state.setModel;
  const onPickModel = useCallback((spec: string) => { void setModel(spec); }, [setModel]);
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
  // Output still takes over the moment there is something running to look at.
  const [surface, setSurface] = useState<SurfaceKind>("Work");
  const [chatMode, setChatMode] = useState<"plan" | "build">("build");
  const planAwaitingDecision = planReviewAwaitingDecision(state.activePlan);
  const effectiveChatMode = planAwaitingDecision ? "plan" : chatMode;
  const [chatInput, setChatInput] = useState("");
  const [forkFor, setForkFor] = useState<string | null>(null); // message id to fork at, or null
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  // ── Older history ────────────────────────────────────────────────────────
  // `state.messages` is the LIVE list: the SDK's `get-messages` seed (which is
  // `Think.messages`, a bounded newest window governed by hydrationByteBudget)
  // plus everything the socket has streamed since. Anything older than that
  // window exists only in storage and is reached one cursored page at a time.
  const oldest = state.messages[0]?.id;
  const history = usePagedScroll<ChatHistoryEntry>({
    grows: "up",
    fetchPage: useCallback(
      (cursor) => state.rpc<unknown>("getChatHistoryPage", [{ cursor, limit: CHAT_PAGE_SIZE }])
        .then((page) => v.parse(ChatHistoryPageSchema, page)),
      [state.rpc],
    ),
    // The first anchor is the oldest message the live list is showing: the SDK
    // seeds without a cursor, so this is the only place the walk can start.
    startFrom: useCallback(() => oldest ? { after: oldest } : null, [oldest]),
  });

  const transcript = useMemo(
    () => mergeTranscript(history.fetched, state.messages),
    [history.fetched, state.messages]);

  // Two clauses, both load-bearing. The connect frame settles the ordinary case
  // whatever the transcript turns out to hold, including empty. It is NOT sent
  // when a stream was already running at connect — that path goes through the
  // resume handshake instead — and there the arriving messages are the proof.
  const transcriptPending = !state.transcriptSeeded && transcript.length === 0;

  const messagesRef = useGrowingScroll<HTMLDivElement>({
    grows: "up",
    content: transcript,
    fetched: history.fetched,
    onReachEdge: history.loadMore,
  });
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  // Pending chat attachments — fed by the attach button, paste, and drag-drop
  // onto the chat column; rendered as removable chips above the input.
  const [pendingAttachments, setPendingAttachments] = useState<FileUIPart[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const addFiles = useCallback(async (files: FileList | null | undefined) => {
    if (!files || files.length === 0) return;
    // CLOUD_MAX_INLINE_ATTACHMENT_BYTES is a per-message AGGREGATE: all pending
    // data-URL parts persist inside one DO message row (see core/cloud-wire).
    let budget = CLOUD_MAX_INLINE_ATTACHMENT_BYTES
      - pendingAttachments.reduce((sum, p) => sum + dataUrlRawBytes(p.url), 0);
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const f of Array.from(files)) {
      if (f.size <= budget) { accepted.push(f); budget -= f.size; }
      else rejected.push(f.name);
    }
    setAttachError(rejected.length > 0
      ? `Chat attachments are capped at ${CLOUD_MAX_INLINE_ATTACHMENT_BYTES / (1024 * 1024)} MB per message. ${rejected.join(", ")} did not fit. Upload larger files via the Files pane on the Environment tab.`
      : null);
    if (accepted.length === 0) return;
    const dt = new DataTransfer();
    for (const f of accepted) dt.items.add(f);
    const parts = await convertFileListToFileUIParts(dt.files);
    setPendingAttachments((prev) => [...prev, ...parts]);
  }, [pendingAttachments]);

  const onChatDragOver = useCallback((e: ReactDragEvent) => {
    if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); }
  }, []);
  const onChatDragLeave = useCallback((e: ReactDragEvent) => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setDragOver(false);
  }, []);
  const onChatDrop = useCallback((e: ReactDragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    setDragOver(false);
    void addFiles(e.dataTransfer.files);
  }, [addFiles]);

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
    touchWorkspace(agentId).then(
      () => reportSide("visit", null),
      (err) => reportSide("visit", describeError(err)),
    );
  }, [agentId, reportSide]);

  // Bridge the open workspace's live status to the sidebar roster (running dot +
  // unseen-evolution dot). Only the mounted workspace has a live socket, so the
  // roster reflects status for workspaces visited this session.
  useEffect(() => {
    if (!agentId) return;
    const running = state.isStreaming || state.backgroundJobs.some((j) => j.status === "running");
    window.dispatchEvent(new CustomEvent("kinu:workspace-activity", {
      detail: { name: agentId, running, unseenChangelog: state.changelogUnseen },
    }));
  }, [agentId, state.isStreaming, state.backgroundJobs, state.changelogUnseen]);

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
      || state.activePlan?.status === "pending"
      || state.activePlan?.status === "changes_requested";
    if (n > prevPortCountRef.current && !planOwnsOutput) setSurface("Output");
    prevPortCountRef.current = n;
  }, [chatMode, state.activePlan?.status, state.pinnedPorts.length]);

  // A new durable revision owns focus once. Annotation saves update the same
  // revision and must not keep dragging the owner back after they navigate.
  const previousPlanRef = useRef<string | null>(null);
  useEffect(() => {
    const key = state.activePlan ? `${state.activePlan.id}/${state.activePlan.revision}` : null;
    if (key && key !== previousPlanRef.current) setSurface("Output");
    if (planAwaitingDecision) setChatMode("plan");
    else if (state.activePlan?.status === "approved") setChatMode("build");
    previousPlanRef.current = key;
  }, [planAwaitingDecision, state.activePlan?.id, state.activePlan?.revision, state.activePlan?.status]);

  const handleSend = useCallback(() => {
    const t = chatInput.trim();
    if ((!t && pendingAttachments.length === 0) || state.isStreaming) return;
    state.sendChat(t, pendingAttachments, effectiveChatMode);
    setChatInput("");
    setPendingAttachments([]);
    setAttachError(null);
  }, [chatInput, pendingAttachments, effectiveChatMode, state]);

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
    state.rpc<{ accepted: boolean; reason?: string }>("branchTurn", [t])
      .then((r) => {
        if (r.accepted) setChatInput((current) => current.trim() === t ? "" : current);
        else setBranchNotice(r.reason ?? "Branching is unavailable right now.");
      })
      .catch((err) => setBranchNotice(renderThrownChain({ cause: err })));
  }, [chatInput, effectiveChatMode, state]);

  /**
   * Steer and Stop — the composer's mid-turn pair, shared with the subordinate
   * column so both surfaces give the same account of where a message went.
   */
  const messageIds = useMemo(() => state.messages.map((msg) => msg.id), [state.messages]);
  const { notice: steerNotice, steer: handleSteer, stop: handleStop, liveSteers } = useSteerActions({
    steerChat: state.steerChat,
    abortChat: state.abortChat,
    sendChat: (text) => state.sendChat(text, [], effectiveChatMode),
    draft: chatInput,
    setDraft: setChatInput,
    hasAttachments: pendingAttachments.length > 0,
    steerRuns: state.steerRuns,
    messageIds,
  });

  // Identity-stable handlers so memo(MessageView) holds across stream ticks.
  const onForkMessage = useCallback((mid: string) => setForkFor(mid), []);

  // Thumbs feedback — hydrated from the server (it remembers across reloads)
  // and only committed locally when the RPC succeeds; failures propagate to
  // MessageFeedback so the toggle never lies about evolution-scoring input.
  const [feedbackByMessage, setFeedbackByMessage] = useState<Record<string, 'positive' | 'negative'>>({});
  useEffect(() => {
    if (state.connectionStatus !== "connected") return;
    state.rpc<Record<string, 'positive' | 'negative'>>('listTurnFeedback').then(
      (loaded) => { setFeedbackByMessage(loaded); reportSide("feedback", null); },
      (err) => reportSide("feedback", describeError(err)),
    );
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
    state.rpc<Record<string, AlternateTakeSet>>('listAlternateTakes').then(
      (loaded) => { setTakesByTurn(loaded); reportSide("takes", null); },
      (err) => reportSide("takes", describeError(err)),
    );
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
          'This turn changed no files on your machine. File history covers your own device only — '
          + 'changes the agent made in its workspace or in a sandbox are not restorable here.',
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
        setRestoreNotice('Files already match the state before this turn. Nothing to restore.');
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
      setRestoreNotice(`Restored ${restorePlan.files.length} file(s) to before this turn. Restoring again undoes the undo.`);
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
  if (!agentId) return null;

  const as = state.agentStatus;
  const workspaceTitle = as?.displayName || "Workspace";
  return (
    <div className="h-full flex flex-col">
      {/* Non-destructive disconnect banner. The chat panel below stays
          mounted so the in-flight assistant turn is preserved through
          partysocket auto-reconnect. (STABILITY-AUDIT §A1.) */}
      {state.connectionStatus === "disconnected" && (
        <div className="flex items-center justify-center gap-2 px-3 py-1.5 text-xs p-warning border-b p-border" style={{ background: "var(--c-warning-tint)" }}>
          <ArrowsClockwiseIcon size={12} className="animate-spin" />Reconnecting...
        </div>
      )}

      {/* The one identity row, and the workspace-scoped controls that belong
          with it — including the altitude switch: RUN (this run,
          mission-control) ⇄ SUPERVISE (the agent over time). */}
      <WorkspaceBar
        title={workspaceTitle}
        onRename={state.setDisplayName}
        connectionStatus={state.connectionStatus}
        working={state.isStreaming}
        {...(as?.forkLineage ? { forkParent: { workspace: as.forkLineage.sourceWorkspaceName, forkedAt: as.forkLineage.forkedAt } } : {})}
        settingsHref={`/settings/${agentId}`}
        altitude={altitude}
        onAltitude={setAltitude}
      />

      {altitude === "supervise" ? (
        <div className="flex-1 min-h-0">
          <ErrorBoundary label="Supervise">
            <SupervisePage rpc={state.rpc} onRunTask={(t) => { setAltitude("run"); state.sendChat(t); }} />
          </ErrorBoundary>
        </div>
      ) : (
      <PanelGroup className="flex-1">
        {/* ── Column A — Chat / Steer ─────────────────────────── */}
        <Panel minSize={24} defaultSize={42}>
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
              onSpawn={state.spawnSubordinate}
              onDismiss={(name) => state.dismissSubordinate(name).then(() => {})}
              trailing={!subName && state.messages.length > 0 && (
                <Button variant="ghost" {...SQUARE_BUTTON_PROPS} size="sm"
                  onClick={() => setShowClearConfirm(true)}
                  icon={<TrashIcon size={12} />} aria-label="Clear history" />
              )}
            />
            {subName ? (
              <SubordinateChatColumn key={subName} workspace={agentId} subName={subName} />
            ) : (
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
            <div ref={messagesRef} className="flex-1 overflow-y-auto px-6 py-5 space-y-5 lg:px-8">
              {transcriptPending && <ConversationSkeleton />}
              {!transcriptPending && transcript.length === 0 && !state.isStreaming && (
                <EmptyConversation mission={as?.purpose ?? ""} />
              )}
              {transcript.length > 0 && (
                <HistoryBoundary
                  loading={history.loading} error={history.error}
                  exhausted={history.exhausted} onRetry={history.loadMore} />
              )}
              {transcript.map((msg, i) => {
                const takes = takesByTurn[msg.id];
                return (
                  <MessageView
                    key={msg.id}
                    message={msg}
                    isLast={i === transcript.length - 1}
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
              {liveSteers.map((steer) => <SteerBubble key={steer.steerId} steer={steer} />)}
              {state.branchRuns.map((run) => (
                <BranchRunChip
                  key={run.branchId}
                  run={run}
                  takes={run.turnId ? takesByTurn[run.turnId] : undefined}
                  rpc={state.rpc}
                  headActivity={state.headActivity}
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
            <div className="border-t p-border">
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
                  parts: pendingAttachments,
                  onAdd: (files) => { void addFiles(files); },
                  onRemove: (i) => setPendingAttachments(prev => prev.filter((_, j) => j !== i)),
                }}
                modelPicker={<ConnectedModelPicker value={as?.model ?? ""} onChange={onPickModel} size="xs" className="min-w-0 flex-1 basis-32 max-w-44" />}
                notices={[
                  ...(state.error ? [{ id: "load", tone: "danger" as const, text: state.error,
                    action: { label: "Retry", icon: <ArrowsClockwiseIcon size={11} />, onClick: state.retryLoad } }] : []),
                  ...(attachError ? [{ id: "attach", tone: "warning" as const, text: attachError }] : []),
                  // Each side read that failed, named. These are collected by
                  // reportSide and would otherwise be recorded and never shown,
                  // which is the "there is nothing" reading SIDE_SOURCES exists
                  // to prevent.
                  ...SIDE_SOURCES.flatMap(({ source, label }) => {
                    const message = sideErrors[source];
                    return message
                      ? [{ id: `side-${source}`, tone: "warning" as const,
                          text: `Couldn't ${label}: ${message}`,
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

        <PanelResizeHandle className="w-[3px] bg-[var(--c-border)] hover:bg-[var(--c-accent-subtle)] transition-colors cursor-col-resize" />

        {/* ── Work Surface ────────────────────────────────────── */}
        <Panel minSize={28} defaultSize={58}>
          <WorkSurface
            surface={surface}
            onSurface={setSurface}
            pinnedPorts={state.pinnedPorts}
            previewError={state.previewError}
            onRefreshPorts={state.refreshExposedPorts}
            plan={state.activePlan}
            agentStatus={state.agentStatus}
            tools={state.tools}
            memory={state.memory}
            memoryContent={state.memoryContent}
            onSearchMemory={state.searchMemory}
            mctsTrees={state.mctsTrees}
            headActivity={state.headActivity}
            isStreaming={state.isStreaming}
            executors={state.executors}
            executorOutputs={state.executorOutputs}
            lastActiveExecutor={state.lastActiveExecutor}
            onExecute={state.executeInExecutor}
            backgroundJobs={state.backgroundJobs}
            onRefreshJobs={state.refreshBackgroundJobs}
            pendingActions={state.pendingActions}
            onChangelogSeen={state.clearChangelogUnseen}
            agentViews={state.agentViews}
            rpc={state.rpc}
          />
        </Panel>

      </PanelGroup>
      )}

      {forkFor && (
        <ForkModal
          sourceName={workspaceTitle}
          messagesUpToHere={state.messages.findIndex(m => m.id === forkFor) + 1}
          craftedToolsCount={as?.craftedToolCount ?? 0}
          onCancel={() => setForkFor(null)}
          onSubmit={async (name) => {
            try {
              const result = await state.forkAgent(forkFor, name ? { name } : undefined);
              setForkFor(null);
              navigate(result.url);
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
            <button className={`p-btn-danger ${btnSmCls}`} onClick={() => { state.clearHistory(); setShowClearConfirm(false); }}>Clear history</button>
          </>}
        >
          <p className="text-xs p-text-2 leading-relaxed">
            This permanently clears this agent's entire conversation history. It cannot be undone.
            The agent's memory, SOUL.md, crafted tools, and evolution state are kept.
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
        <button className={`p-btn ${btnSmCls}`} onClick={onConfirm} disabled={busy}>
          {busy ? <><Loader size="sm" /><span className="ml-1">Restoring…</span></> : `Restore ${plan.files.length} file${plan.files.length === 1 ? "" : "s"}`}
        </button>
      </>}
    >
      <div className="space-y-2">
        <p className="text-xs p-text-2 leading-relaxed">
          This rewrites files under <span className="font-mono p-text">{plan.dirs.join(", ")}</span> on your
          device: {counts}. A safety snapshot is taken first, so restoring again undoes the undo.
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
