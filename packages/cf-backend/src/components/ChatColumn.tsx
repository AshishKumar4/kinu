/** The chat column, the workspace's and each agent's alike: its transcript, its live tail and its composer. */
import { Effect } from "effect";
import { Fragment, useCallback, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { ArrowsClockwiseIcon, PaperclipIcon } from "@phosphor-icons/react";
import type { UIMessage } from "ai";
import { isPlaceholderMission, liveTailRow, threadLiveTail, turnFailure, turnFailureFacts, type WorkspaceNotice } from "@kinu.run/core";
import { detach } from "@kinu.run/core/obs";
import { AskedQuestionsContext } from "@/components/QuestionCard";
import { foldEventTurns } from "@/components/ChatEvents";
import { ChatLiveTail, MessageView, ModelFallbackRows, SteerBubble } from "@/components/MessageView";
import { Composer, useProviderWaitNotice, workspaceLoadNotice, type ComposerNotice } from "@/components/Composer";
import { ConnectedModelPicker } from "@/components/ModelPicker";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { TranscriptViewport } from "@/components/TranscriptViewport";
import { ViewOnlyBar } from "@/components/ViewOnlyBar";
import { KinuMark } from "@/components/ui/KinuLogo";
import { useAutogrow } from "@/hooks/use-autogrow";
import type { useChatOwner } from "@/hooks/use-chat-owner";
import type { ChatThread } from "@/hooks/use-chat-thread";
import type { ConversationUiState } from "@/hooks/use-conversation-ui-state";
import type { useFileDrop } from "@/hooks/use-file-drop";
import type { usePendingAttachments } from "@/hooks/use-pending-attachments";
import { useSteerActions } from "@/hooks/use-steer-actions";

type ChatState = ReturnType<typeof useChatOwner>["chat"];

type RowProps = Omit<ComponentProps<typeof MessageView>, "message" | "steers" | "repeats" | "answerSlates" | "liveTail" | "onRetry">;

/** What the workspace's own chat adds to the column; an agent's pane has none of it. */
interface ChatColumnExtras {
  /** Each row's own controls (fork, feedback, takes, revert), and what was placed before it. */
  readonly row?: (message: UIMessage, index: number) => RowProps;
  readonly before?: (index: number) => ReactNode;
  /** Drawn after the live tail, before the queued steers. */
  readonly afterTail?: ReactNode;
  /** Drawn last in the transcript. */
  readonly trailing?: ReactNode;
  /** The column's own notices, after the load and version notices and before how the last turn ended. */
  readonly notices?: readonly ComposerNotice[];
  readonly attachments?: ReturnType<typeof usePendingAttachments>;
  readonly drop?: ReturnType<typeof useFileDrop>;
  readonly onBranch?: () => void;
}

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

/**
 * What the prompt box says about how the last turn ended: the newest answer's recorded failure until it is dismissed,
 * an answer stream's error no answer recorded, and a retry on its way. Retry runs the failed turn again from its
 * message instead of appending a duplicate. A `refused` stream error is the runtime refusing this tab, in its own
 * words, which no turn caused and no retry of one answers.
 */
export function turnEndNotices(at: {
  readonly newest: UIMessage | undefined;
  readonly live: boolean;
  readonly retryOwed: boolean;
  readonly dismissed: string | null;
  readonly chatError: { readonly body: string; readonly refused: boolean } | null;
  readonly retry: () => void;
  readonly dismiss: (messageId: string) => void;
  readonly clearChatError: () => void;
}): ComposerNotice[] {
  const notices: ComposerNotice[] = [];
  const retry = { label: "Retry", icon: <ArrowsClockwiseIcon size={12} />, onClick: at.retry, disabled: at.live || at.retryOwed };
  const failure = at.newest === undefined || at.live ? null : turnFailure({ metadata: at.newest.metadata });

  if (failure !== null && at.newest !== undefined && at.dismissed !== at.newest.id) {
    const { provider, words, facts, raw } = turnFailureFacts(failure);
    const id = at.newest.id;
    const stopped = provider === null ? "This turn stopped before its answer was done" : `${provider} refused the model call, so this turn stopped`;

    notices.push({
      id: "turn-failure", tone: "danger", ...(provider !== null && { title: provider }), text: words,
      detail: { summary: `${stopped}. Retry runs it again from your message.`, facts, raw },
      action: retry, onDismiss: () => at.dismiss(id), hooks: { "data-turn-failure-notice": "" },
    });
  }

  if (at.chatError?.refused === true) {
    notices.push({
      id: "chat-error-refused", tone: "neutral", text: `This tab couldn't reconnect: ${at.chatError.body}`,
      onDismiss: at.clearChatError, hooks: { "data-chat-error": "refused" },
    });
  } else if (at.chatError !== null) {
    const { provider, words, facts, raw } = turnFailureFacts(at.chatError.body);

    notices.push({
      id: "chat-error", tone: "danger", ...(provider !== null && { title: provider }), text: words,
      detail: { summary: "The answer stopped streaming, and this turn produced no answer. Retry runs it again from your message.", facts, raw },
      action: retry, onDismiss: at.clearChatError, hooks: { "data-chat-error": "live" },
    });
  }

  if (at.retryOwed) notices.push({ id: "retry-owed", tone: "progress", text: "Retry is on its way. The agent runs it when it next wakes." });

  return notices;
}

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

const VERSION_NOTICE: ComposerNotice = {
  id: "version", tone: "info",
  text: "A new version is ready. Reload this tab to use it.",
  action: { label: "Reload", icon: <ArrowsClockwiseIcon size={11} />, onClick: () => window.location.reload() },
};

/** Files hovering over the column. */
function DropOverlay() {
  return (
    <div className="absolute inset-0 z-10 pointer-events-none flex items-center justify-center rounded-lg border-2 border-dashed"
      style={{ borderColor: "var(--c-accent)", background: "var(--c-accent-subtle)" }}>
      <div className="flex items-center gap-2 text-sm p-text px-3 py-1.5 rounded-lg p-elevated border p-border">
        <PaperclipIcon size={16} className="p-accent" />Drop files to attach
      </div>
    </div>
  );
}

/**
 * One chat's column. `pane` names it as its UI state does; `retryOwed` is the caller's, which knows whose retries the
 * owed intents hold; `input` false shows the view-only bar in place of the composer.
 */
export function ChatColumn({ pane, label, state, ui, chat, retryOwed, input, placeholder, attention, empty, asked, answerSlates, layout, extras = {} }: {
  pane: string;
  label: string;
  state: ChatState;
  ui: ConversationUiState;
  chat: ChatThread;
  retryOwed: boolean;
  input: boolean;
  placeholder: string;
  attention: ReactNode;
  empty: ReactNode;
  asked: ComponentProps<typeof AskedQuestionsContext.Provider>["value"];
  answerSlates: ComponentProps<typeof MessageView>["answerSlates"];
  layout: { readonly startFirst: boolean; readonly padClass: string };
  extras?: ChatColumnExtras;
}) {
  const live = state.liveness.kind === "live";
  const { thread } = chat;
  const as = state.actorSnapshot;
  // The answer whose failure notice was dismissed: its line in the thread keeps the Retry.
  const [dismissedFailure, setDismissedFailure] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const providerWait = useProviderWaitNotice(state.providerWait);
  const { attachments, drop } = extras;
  const repeats = useMemo(() => foldEventTurns(thread.entries.map(({ message }) => message)), [thread.entries]);

  useAutogrow(inputRef, ui.draft);

  const { notice: steerNotice, send, stop } = useSteerActions({
    sendChat: (text, files) => state.sendChat(text, [...files], ui.mode),
    abortChat: state.abortChat,
    draft: ui.draft,
    setDraft: ui.updateDraft,
    ...(attachments !== undefined && { attachments: { parts: attachments.parts, clear: attachments.clear } }),
    steerRuns: state.steerRuns,
  });

  const pickModel = useCallback((spec: string) => detach(Effect.promise(async () => state.setModel(spec))), [state]);
  const pickEffort = useCallback((effort: Parameters<typeof state.setReasoningEffort>[0]) => detach(Effect.promise(async () => state.setReasoningEffort(effort))), [state]);

  // An admitted turn with the operator's message last has no assistant row to ask, so the
  // live indicator is decided here. See `threadLiveTail`.
  const tail = threadLiveTail({ last: thread.entries.at(-1)?.message, liveness: state.liveness });
  const liveRow = liveTailRow({ rows: thread.entries.map(({ message }) => message), liveness: state.liveness });
  const newest = thread.entries.at(-1)?.message;

  return (
    <div className="@container relative flex flex-col flex-1 min-h-0" data-agent-pane={pane} {...drop?.handlers}>
      {drop?.dragOver === true && <DropOverlay />}
      <ErrorBoundary label={label}>
        <AskedQuestionsContext.Provider value={asked}>
          <TranscriptViewport chat={chat} live={live} startFirst={layout.startFirst} padClass={layout.padClass}
            scroll={{ initialScroll: ui.savedScroll, onScrollPosition: ui.rememberScroll, settled: state.transcriptSeeded }}
            pending={<ConversationSkeleton />}
            empty={empty}
            rows={(before) => thread.entries.map(({ message: msg, steers }, i) => (
              <Fragment key={msg.id}>
                {before(msg.id)}
                {extras.before?.(i)}
                {repeats[i] !== 0 && <MessageView {...extras.row?.(msg, i)} message={msg} steers={steers} repeats={repeats[i]}
                  answerSlates={answerSlates} liveTail={msg.id === liveRow ? tail : null}
                  onRetry={i === thread.entries.length - 1 && !live && !retryOwed && dismissedFailure === msg.id ? state.retryLastMessage : undefined} />}
              </Fragment>
            ))}>
            <ChatLiveTail tail={tail} />
            {extras.afterTail}
            {thread.trailing.map((steer) => <SteerBubble key={steer.id} steer={steer} />)}
            <ModelFallbackRows notices={state.modelFallbacks} />
            {extras.trailing}
          </TranscriptViewport>
        </AskedQuestionsContext.Provider>
      </ErrorBoundary>

      {!input && <ViewOnlyBar running={live} onStop={stop} />}
      {input && <div className="p-composer-dock">
        <Composer
          textareaRef={inputRef}
          value={ui.draft}
          onValueChange={ui.setDraft}
          onSend={send}
          placeholder={placeholder}
          disabled={state.connectionStatus !== "connected"}
          liveness={state.liveness}
          onRecover={state.recoverTurn}
          onStop={stop}
          {...(extras.onBranch !== undefined && { onBranch: extras.onBranch })}
          attention={attention}
          mode={{ value: ui.mode, onChange: ui.setMode }}
          {...(attachments !== undefined && { attachments: { parts: [...attachments.parts], onAdd: attachments.add, onRemove: attachments.remove } })}
          modelPicker={<ConnectedModelPicker value={as?.model.model ?? ""} onChange={pickModel} size="xs"
            effort={{ value: as?.reasoningEffort ?? null, onChange: pickEffort }} />}
          notices={[
            ...loadNotices(state.error, state.retryLoad),
            ...(state.newerDeployedBuild ? [VERSION_NOTICE] : []),
            ...(attachments?.refusal ? [{ id: "attach", tone: "warning" as const, text: attachments.refusal }] : []),
            ...(extras.notices ?? []),
            ...turnEndNotices({
              newest, live, retryOwed, dismissed: dismissedFailure, chatError: state.chatError,
              retry: state.retryLastMessage, dismiss: setDismissedFailure, clearChatError: state.clearChatError,
            }),
            ...providerWait,
            ...(steerNotice ? [steerNotice] : []),
          ]}
        />
      </div>}
    </div>
  );
}
