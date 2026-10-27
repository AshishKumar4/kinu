/** The chat column, the workspace's and each agent's alike: its transcript, its live tail and its composer. */
import { Effect } from "effect";
import { Fragment, useCallback, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { PhaseLinesAsk, phaseLinesAsker } from "@/components/ChatDisclosure";
import { ArrowSquareOutIcon, ArrowsClockwiseIcon, PaperclipIcon } from "@phosphor-icons/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { fmtUsd, isPlaceholderMission, liveTailRow, partInput, threadLiveTail, turnFailure, turnFailureFacts, type WorkspaceNotice } from "@kinu.run/core";
import { detach } from "@kinu.run/core/obs";
import { useOpenWorkspace } from "@/hooks/use-open-workspace";
import { useGatewayCredits } from "@/hooks/use-gateway-credits";
import { usePastedSecretGuard } from "@/components/secrets/PasteOffer";
import { limitRefusalOf } from "@/lib/limits-api";
import { AskedQuestionsContext } from "@/components/QuestionCard";
import { foldEventTurns } from "@/components/ChatEvents";
import { ChatLiveTail, MessageView, ModelFallbackRows, SteerBubble } from "@/components/MessageView";
import { Composer, useProviderWaitNotice, workspaceLoadNotice, type ComposerNotice } from "@/components/Composer";
import type { ComposerCommand } from "@/components/SlashMenu";
import { useChatCommands } from "@/hooks/use-chat-commands";
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
import { useOpeningMessage } from "@/components/workspaces/NewChatView";
import { Surface } from "@/components/ui/Surface";
import { DropHint } from "@/components/ui/FilePicker";

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
  /** Runs `words` beside the running turn, clearing `draft` from the field once the branch is taken. */
  readonly onBranch?: (words: string, draft: string) => void;
  /** Sends the message a new chat was opened with (`useOpeningMessage`), as a press of Send would. */
  readonly opening?: true;
  /** Floats over the transcript's end above the composer, and moves nothing: what works out of sight (1024-l). */
  readonly float?: ReactNode;
  /** The workspace's own slash commands, after the ones every chat runs (`chatCommands`); `say` tells what one did, or
   *  why it did nothing, in the column's notices. */
  readonly commands?: (say: (words: string, tone?: "info") => void) => readonly ComposerCommand[];
}

export function EmptyConversation({ mission }: { mission: string }) {
  const brief = isPlaceholderMission(mission) ? null : mission.trim();

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <KinuMark size={34} className="mb-4 p-accent opacity-70" />
      {brief && (
        <>
          <p className="t-label">Mission</p>
          <p className="t-title mt-2 max-w-md whitespace-pre-wrap p-text-2">{brief}</p>
        </>
      )}
      <p className="t-body mt-4 p-text-3">Send the first message to start.</p>
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
          <div className="max-w-4/5 space-y-2" style={{ width: row.width }}>
            <Surface look="clip" className="p-skeleton-bar h-3.5" />
            <Surface look="clip" className="p-skeleton-bar h-3.5 w-7/10" />
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

  // The day's limit on Kinu's models is the turn's own notice in the transcript, with its way on: said once.
  if (failure !== null && at.newest !== undefined && at.dismissed !== at.newest.id && limitRefusalOf({ cause: failure })?.limit !== "model_tokens") {
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

/** Whether `message` holds a web search that was refused. */
function searchRefused(message: UIMessage): boolean {
  return message.parts.some((part) => isToolUIPart(part) && getToolName(part) === "web" && part.state === "output-error" && partInput(part)?.op === "search");
}

/**
 * Once the newest answer's web search was refused while searches through Cloudflare have no AI credits: the way to buy
 * them, then the purchase landing (`useGatewayCredits`). Nothing where credits are held, or Kinu has none of the
 * person's to read.
 */
function useSearchCreditsNotice(newest: UIMessage | undefined): ComposerNotice[] {
  const refused = newest !== undefined && searchRefused(newest);
  const { read, empty, waiting, changed, buy } = useGatewayCredits(refused);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const answer = newest?.id ?? null;

  if (!refused || read === null || dismissed === answer) return [];
  const notice = { id: "search-credits", title: "Web search", onDismiss: () => setDismissed(answer) };

  if (waiting) return [{ ...notice, tone: "progress", text: "Waiting for Cloudflare…", hooks: { "data-search-credits": "waiting" } }];

  if (empty) {
    return [{
      ...notice, tone: "warning", text: "Out of AI credits.",
      detail: { summary: "Cloudflare sells AI credits on its own page, which opens beside this one. A search key of your own, in Settings › Web search, pays for searches instead." },
      action: { label: "Add credits", icon: <ArrowSquareOutIcon size={11} />, onClick: buy }, hooks: { "data-search-credits": "empty" },
    }];
  }

  return changed ? [{ ...notice, tone: "success", text: `AI credits added: ${fmtUsd(read.credits.balance)} left. Ask again to search.`, hooks: { "data-search-credits": "held" } }] : [];
}

/** Files hovering over the column. */
function DropOverlay() {
  return (
    <DropHint flush><PaperclipIcon size={16} weight="bold" />Drop files to attach</DropHint>
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

  // A pane's agent is asked for by its id, so none is asked until its id is known.
  const askLines = useMemo(() => (state.isSubagent && state.paneActorId === null ? null : phaseLinesAsker(state.rpc, state.paneActorId)),
    [state.isSubagent, state.paneActorId, state.rpc]);

  // The answer whose failure notice was dismissed: its line in the thread keeps the Retry.
  const [dismissedFailure, setDismissedFailure] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const providerWait = useProviderWaitNotice(state.providerWait);
  const searchCredits = useSearchCreditsNotice(thread.entries.at(-1)?.message);
  const { attachments, drop } = extras;
  const repeats = useMemo(() => foldEventTurns(thread.entries.map(({ message }) => message)), [thread.entries]);

  useAutogrow(inputRef, ui.draft);
  // Every message the owner sends, by Enter, Send, a steer, a command or a queued line, brings the transcript to its
  // newest row and follows the reply (the owner, 2026-10-25): its one way into the scroller (`useGrowingScroll`'s `sent`).
  const [sent, setSent] = useState(0);

  const { notice: steerNotice, send, sendWords, stop } = useSteerActions({
    sendChat: (text, files, mode = ui.mode) => {
      const landing = state.sendChat(text, [...files], mode);

      if (landing !== null) setSent((count) => count + 1);

      return landing;
    },
    abortChat: state.abortChat,
    draft: ui.draft,
    setDraft: ui.updateDraft,
    ...(attachments !== undefined && { attachments: { parts: attachments.parts, clear: attachments.clear } }),
    steerRuns: state.steerRuns,
  });

  useOpeningMessage(extras.opening === true && state.connectionStatus === "connected", sendWords);

  // A branch beside the running turn is the owner's send too.
  const { onBranch } = extras;

  const branch = useMemo(() => (onBranch === undefined ? undefined : (words: string, draft: string) => {
    setSent((count) => count + 1);
    onBranch(words, draft);
  }), [onBranch]);

  // This chat's workspace: a secret moved out of a draft here is allowed there.
  const secretGuard = usePastedSecretGuard({ draft: ui.draft, setDraft: ui.setDraft, workspace: useOpenWorkspace() ?? undefined });

  const pickModel = useCallback((spec: string) => detach(Effect.promise(async () => state.setModel(spec))), [state]);

  const commands = useChatCommands({
    draft: ui.draft, own: extras.commands, send,
    chat: {
      history: chat.readAll, name: as?.displayName, label, stop, draft: ui.draft.trim(),
      setModel: state.setModel, setEffort: state.setReasoningEffort, mode: ui.mode, setMode: ui.setMode, setDraft: ui.setDraft,
      send: (words, mode) => sendWords(words, [], mode), live, branchBeside: branch,
    },
  });

  const pickEffort = useCallback((effort: Parameters<typeof state.setReasoningEffort>[0]) => detach(Effect.promise(async () => state.setReasoningEffort(effort))), [state]);

  // An admitted turn with the operator's message last has no assistant row to ask, so the
  // live indicator is decided here. See `threadLiveTail`.
  const tail = threadLiveTail({ last: thread.entries.at(-1)?.message, liveness: state.liveness });
  const liveRow = liveTailRow({ rows: thread.entries.map(({ message }) => message), liveness: state.liveness, stored: state.stored });
  const newest = thread.entries.at(-1)?.message;

  return (
    <div className="@container relative flex flex-col flex-1 min-h-0" data-agent-pane={pane} {...drop?.handlers}>
      {drop?.dragOver === true && <DropOverlay />}
      <ErrorBoundary label={label}>
        <AskedQuestionsContext.Provider value={asked}><PhaseLinesAsk.Provider value={askLines}>
          <TranscriptViewport chat={chat} live={live} startFirst={layout.startFirst} padClass={layout.padClass}
            scroll={{ initialScroll: ui.savedScroll, onScrollPosition: ui.rememberScroll, settled: state.transcriptSeeded, sent }}
            pending={<ConversationSkeleton />}
            empty={empty}
            rows={(before) => thread.entries.map(({ message: msg, steers, landed }, i) => (
              <Fragment key={msg.id}>
                {before(msg.id)}
                {extras.before?.(i)}
                {repeats[i] !== 0 && <MessageView {...extras.row?.(msg, i)} message={msg} steers={steers} landed={landed} repeats={repeats[i]}
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
        </PhaseLinesAsk.Provider></AskedQuestionsContext.Provider>
      </ErrorBoundary>

      {!input && <ViewOnlyBar running={live} onStop={stop} />}
      {input && <div className="p-composer-dock">
        <Composer
          textareaRef={inputRef}
          value={ui.draft}
          onValueChange={ui.setDraft}
          // A draft naming a command runs it, once the guard has seen its words, as a message would be.
          onSend={secretGuard.guarded("send", commands.submit)}
          placeholder={placeholder}
          disabled={state.connectionStatus !== "connected"}
          liveness={state.liveness}
          onRecover={state.recoverTurn}
          onStop={stop}
          {...(branch !== undefined && { onBranch: secretGuard.guarded("branch", () => { branch(ui.draft.trim(), ui.draft.trim()); }) })}
          attention={<>{secretGuard.offer}{attention}</>}
          float={extras.float}
          mode={{ value: ui.mode, onChange: ui.setMode }}
          slash={commands.slash}
          {...(attachments !== undefined && { attachments: { parts: [...attachments.parts], onAdd: attachments.add, onRemove: attachments.remove } })}
          modelPicker={<ConnectedModelPicker value={as?.model.model ?? ""} onChange={pickModel} size="xs"
            effort={{ value: as?.reasoningEffort ?? null, onChange: pickEffort }} />}
          notices={[
            ...loadNotices(state.error, state.retryLoad),
            ...(state.newerDeployedBuild ? [VERSION_NOTICE] : []),
            ...(attachments?.refusal ? [{ id: "attach", tone: "warning" as const, text: attachments.refusal }] : []),
            ...commands.notices,
            ...(extras.notices ?? []),
            ...turnEndNotices({
              newest, live, retryOwed, dismissed: dismissedFailure, chatError: state.chatError,
              retry: state.retryLastMessage, dismiss: setDismissedFailure, clearChatError: state.clearChatError,
            }),
            ...searchCredits,
            ...providerWait,
            ...(steerNotice ? [steerNotice] : []),
          ]}
        />
      </div>}
    </div>
  );
}
