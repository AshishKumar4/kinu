import { Effect, Cause } from 'effect';
import { createContext, Fragment, memo, useContext, useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import {
  ArrowClockwiseIcon,
  WrenchIcon, CaretRightIcon,
  GitBranchIcon, CheckCircleIcon,
  WarningCircleIcon,
  ClockCounterClockwiseIcon, LightningIcon,
  ArrowBendUpRightIcon,
  TerminalWindowIcon, FileTextIcon, UsersThreeIcon, BrainIcon,
  ListChecksIcon, GlobeIcon, ChartLineUpIcon, DotsThreeCircleIcon, DesktopTowerIcon, ArrowsLeftRightIcon,
  ThumbsUpIcon, ThumbsDownIcon,
} from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import { AskRecord } from "@/components/QuestionCard";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage, FileUIPart, ReasoningUIPart } from "ai";
import {
  describeToolCall, executorLabel, rowText, summarizeToolCall,
} from "@kinu.run/core";
import type { DiffAnchor, InlineSteer, JsonObject, JsonValue, PlacedSteer, ToolCallEffect } from "@kinu.run/core";
import { ASK_OWNER_TOOL, changeNotesCard, clockTime, slatesChanged } from "@kinu.run/core";
import { FeedbackCard } from "@/components/surfaces/changes/FeedbackCard";
import * as v from "valibot";
import { diagnostics, renderThrownChain, detach } from "@kinu.run/core/obs";
import { PreviewFrame } from "@/components/PreviewFrame";
import { AnswerText, MarkdownContent, CodeBlock, SlateLink, type AnswerChat } from "@/components/surfaces/shared";
import { AttachmentChip } from "@/components/AttachmentChip";
import { AnswerPicturesContext, PartPictures, useAnswerPictures } from "@/components/ChatImages";
import { extractPreviewUrl } from "@kinu.run/core";
import {
  groupMessageParts, phaseCalls, phaseTitle, rollUpTurn, writtenTitles,
  partOutput, partInput, partEffect, callFailed, parseProvisionError,
  type AnyToolPart, type PartBlock,
} from "@kinu.run/core";
import { drawnText, toolCallRunning, type LiveTail } from "@kinu.run/core";
import { redactPayload, redactSecrets, segmentBySteers, splicesSeenOn, type SignalCard } from "@kinu.run/core";
import { classifyProgrammaticTurn, endedMidWork, isSteeredMessage, systemEventTurn, turnFailure, turnFailureFacts } from "@kinu.run/core";
import { EventRow, foldRepeats, ProgrammaticTurnCard, type CardState } from "@/components/ProgrammaticTurnCard";
import { useToggledSet } from "@/hooks/use-toggled-set";
import { StatusDot } from "@/components/ui/Status";
import { ChatDisclosure, ToolRun, TurnRollup, useSeenRunning, WorkLabel } from "@/components/ChatDisclosure";
import type { UnavailableDevice } from "@/hooks/use-workspace-reads";

const MessageCreatedAtSchema = v.looseObject({
  createdAt: v.optional(v.union([v.string(), v.number(), v.instance(Date)])),
});


/** The SDK's message type declares no timestamp; the transport's stamp is read off the value. */
function messageCreatedAt(message: UIMessage): string | number | Date | undefined {
  const parsed = v.safeParse(MessageCreatedAtSchema, message);

  return parsed.success ? parsed.output.createdAt : undefined;
}

/** When the message was written, in ms since the epoch; undefined when the transport did not stamp it. */
export function messageTime(message: UIMessage): number | undefined {
  const at = messageCreatedAt(message);

  if (at === undefined) return undefined;

  if (at instanceof Date) return at.getTime();
  const ms = typeof at === "number" ? at : Date.parse(at);

  return Number.isFinite(ms) ? ms : undefined;
}

/** What a turn nobody typed draws as, to fold the same one in a row; null for a turn a person wrote. */
export function eventTurnKey(message: UIMessage): string | null {
  const programmatic = classifyProgrammaticTurn({ metadata: message.metadata });
  const kind = programmatic?.kind ?? (message.role === "system" ? "system" : null);

  if (kind === null || kind === "workspace_created") return null;

  return JSON.stringify([kind, rowText(message)]);
}

function FilePartView({ part }: { part: FileUIPart }) {
  return part.mediaType.startsWith("image/")
    ? <img src={part.url} alt={part.filename ?? "image"} className="max-h-48 max-w-full rounded-lg border p-border" />
    : <AttachmentChip part={part} />;
}

function MessageTimestamp({ createdAt }: { createdAt?: string | number | Date }) {
  if (!createdAt) return null;
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt);

  if (isNaN(d.getTime())) return null;

  return <span className="p-annotation p-text-3 mt-1 block">{clockTime(d)}</span>;
}

// A settled call takes a line's gap, prose and grouped cards a section's. The block carries
// its own margin because a stack utility cannot be overridden per child.
const BLOCK_GAP = {
  row: "mt-1.5 first:mt-0",
  section: "mt-4 first:mt-0",
} as const;

// A sibling of the message list, not a child of its last message: a turn with no assistant
// row yet has nothing to hang it on.
export function ChatLiveTail({ tail }: { tail: LiveTail | null }) {
  if (tail?.kind !== "thinking") return null;

  return (
    <div data-live-indicator="thinking" className="animate-fade-in py-1.5" aria-live="polite">
      {/* A pause and a reasoning block share one "Thinking" label, so the indicator keeps its shape. */}
      <WorkLabel live>Thinking</WorkLabel>
    </div>
  );
}

/** Folds by rendered height, never source lines (m1111); while live, a few lines that follow the newest. */
function ReasoningBlock({ text, live = false }: { text: string; live?: boolean }) {
  return (
    <ChatDisclosure label="Thinking" live={live} folded="preview" follow={text} viewport="max-h-[4lh]" liveIndicator="reasoning"
      bodyClass="prose-thinking" data-reasoning="">
      <MarkdownContent content={text} />
    </ChatDisclosure>
  );
}

/** Where a turn stopped on a failure: one quiet line in the provider's own words, the raw response a click away. The
 *  notice above the prompt box acts on the newest; dismissed, this line keeps its Retry. */
function FailedTurnRow({ message, live, onRetry }: { message: UIMessage; live: boolean; onRetry: (() => void) | undefined }) {
  const failure = live ? null : turnFailure({ metadata: message.metadata });
  const [open, setOpen] = useState(false);

  if (failure === null) return null;
  const { provider, words, raw } = turnFailureFacts(failure);
  const said = provider === null ? words : `${provider}: ${words}`;

  return (
    <div className="py-0.5" role="status" data-turn-failure>
      <div className="p-turn-mark">
        <WarningCircleIcon size={14} weight="fill" className="p-danger" aria-hidden />
        <span className="min-w-0 truncate" title={said}><span className="p-text-2">This turn stopped.</span> {said}</span>
        <button type="button" className="p-turn-mark-link" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide" : "Details"}</button>
        {onRetry !== undefined && (
          <button type="button" onClick={onRetry} className="p-turn-mark-link inline-flex items-center gap-1">
            <ArrowClockwiseIcon size={11} aria-hidden />Retry
          </button>
        )}
      </div>
      {open && <pre className="p-pill-detail !ml-[21px]">{raw}</pre>}
    </div>
  );
}

/** A turn its owner stopped before its work was done: the failure line's quiet shape, with nothing to act on. */
function StoppedMidWorkRow() {
  return (
    <div className="p-turn-mark py-0.5" role="status">
      <span className="ml-1 mr-0.5 size-1.5 shrink-0 self-center rounded-full p-dot-danger" aria-hidden />
      <span>Stopped before the work was finished</span>
    </div>
  );
}

function jsonString(input: JsonObject | undefined, key: string): string | null {
  const value = input?.[key];

  return v.is(v.string(), value) ? value : null;
}

function displayToolValue(value: JsonValue): string {
  return v.is(v.string(), value) ? value : JSON.stringify(value, null, 2) ?? "";
}

const TOOL_LABELS = new Map(Object.entries({
  run: "Run command",
  eval: "Tool program",
  file: "Files",
  agents: "Agents",
  memory: "Memory",
  tasks: "Tasks",
  web: "Web",
  report: "Report",
}));

function toolLabel(toolName: string): string {
  return TOOL_LABELS.get(toolName) ?? toolName;
}

function toolIcon(toolName: string): ReactNode {
  if (toolName === "shell") return <TerminalWindowIcon size={15} />;

  if (toolName === "eval") return <LightningIcon size={15} />;

  if (toolName === "file") return <FileTextIcon size={15} />;

  if (toolName === "agents") return <UsersThreeIcon size={15} />;

  if (toolName === "memory") return <BrainIcon size={15} />;

  if (toolName === "tasks") return <ListChecksIcon size={15} />;

  if (toolName === "web") return <GlobeIcon size={15} />;

  if (toolName === "report") return <ChartLineUpIcon size={15} />;

  return <DotsThreeCircleIcon size={15} />;
}

/** Where a one-question helper's chat opens, relative to the chat its `agents` call sits in; null draws no link. */
export const HelperChatBase = createContext<{ readonly base: string; readonly parent: string | null } | null>(null);

const AnsweredHelperObject = v.looseObject({ agent: v.string(), lifetime: v.literal("task") });

const AnsweredHelperSchema = v.union([AnsweredHelperObject, v.pipe(v.string(), v.parseJson(), AnsweredHelperObject)]);

/** A task-lifetime helper has no tab and makes no report card: the call that asked it is its durable door. */
function HelperChatLink({ output }: { output?: JsonValue }) {
  const base = useContext(HelperChatBase);
  const helper = v.safeParse(AnsweredHelperSchema, output);

  if (base === null || !helper.success) return null;
  const name = helper.output.agent;

  return (
    <Link to={`${base.base}${encodeURIComponent(name)}${base.parent === null ? "" : `?parent=${encodeURIComponent(base.parent)}`}`} aria-label={`Open ${name}'s conversation`}
      className="ml-10 inline-block p-annotation p-accent hover:underline">{name}</Link>
  );
}

/** What a tool printed, as it printed it; a tool that printed nothing says so instead of drawing an empty box. */
function ToolOutput({ output }: { output: JsonValue }) {
  const printed = displayToolValue(redactPayload(output));

  return (
    <div>
      <div className="p-eyebrow mb-1">Output</div>
      {printed.trim() === ""
        ? <p className="p-meta p-text-3">Nothing printed.</p>
        : <pre className="p-t-code p-text-2 max-h-40 overflow-auto whitespace-pre-wrap break-words m-0">{printed}</pre>}
    </div>
  );
}

function ToolCallBlock({ toolName, input, output, effect, isRunning, isError, errorText, expanded, onToggleExpand }: {
  toolName: string; input?: JsonObject; output?: JsonValue; isRunning: boolean; isError: boolean;
  effect: ToolCallEffect;
  /** Protocol-level failure reason; never present together with `output`. */
  errorText?: string;
  /** Keyed by toolCallId on the message: a row that joins a fold mid-stream remounts. */
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const startTime = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const wasRunning = useRef(false);

  useEffect(() => {
    if (isRunning) {
      startTime.current = Date.now();
      wasRunning.current = true;
      setElapsed(null);
    } else if (wasRunning.current && startTime.current) {
      setElapsed(Date.now() - startTime.current);
      wasRunning.current = false;
    }
    // Mounted already settled: never observed running, so no duration.
  }, [isRunning]);

  const durationLabel = elapsed !== null && elapsed > 100 ? `${(elapsed / 1000).toFixed(1)}s` : null;

  const runtime = toolName === 'shell'
    ? executorLabel(jsonString(input, "runtime") ?? 'workspace')
    : null;

  const provisionErr = parseProvisionError(output);
  const summary = summarizeToolCall(toolName, input);
  const description = describeToolCall(toolName, input);

  const failed = isError || provisionErr !== null;

  // Free-text previews bypass the structured `redactPayload` walk, so they pass through
  // `redactSecrets` here.
  let codePreview: string | null = null;

  if (toolName === "eval") codePreview = jsonString(input, "code");
  else if (toolName === "shell") codePreview = jsonString(input, "command");

  let stateName = "done";
  let stateTone = "p-badge-success";
  let stateBadge: ReactNode = <><CheckCircleIcon size={11} weight="fill" />{durationLabel ?? "Done"}</>;

  if (isRunning) {
    stateName = "running";
    stateTone = "p-accent-subtle p-accent";
    stateBadge = <><StatusDot tone="live" />Running</>;
  } else if (failed) {
    stateName = "failed";
    stateTone = "p-fill p-text-4";
    stateBadge = <><WarningCircleIcon size={11} weight="fill" />Failed</>;
  }

  return (
    <div>
      <button
        type="button"
        onClick={onToggleExpand}
        aria-expanded={expanded}
        data-tool-state={stateName}
        data-tool-effect={effect}
        className="group/tool grid w-full cursor-pointer grid-cols-[20px_minmax(0,1fr)_auto_auto] items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--c-elevated)]"
      >
        <span className="flex size-5 items-center justify-center p-text-4">
          {toolIcon(toolName)}
        </span>
        <span className="flex min-w-0 items-baseline gap-2">
          <strong className="min-w-0 truncate p-row-text font-medium p-text-2">{description || toolLabel(toolName)}</strong>
          <span className="min-w-0 flex-1 truncate p-annotation p-text-4" title={[summary, description].filter(Boolean).join(" · ")}>{summary || "Tool call"}</span>
          {runtime && <span className="shrink-0 p-annotation p-text-4">{runtime}</span>}
        </span>
        <span className={`inline-flex min-h-6 shrink-0 items-center gap-1.5 rounded-full px-2 p-t-status ${stateTone}`}>
          {stateBadge}
        </span>
        <CaretRightIcon size={11} aria-hidden className={`shrink-0 p-text-3 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`} />
      </button>
      {toolName === "agents" && <HelperChatLink output={output} />}
      {expanded && provisionErr && (
        <div className="p-tint-warning mt-1.5 ml-5 rounded-lg border px-3 py-2 text-xs p-text-2 flex items-start gap-2">
          <WrenchIcon size={12} className="p-warning mt-0.5 shrink-0" />
          <div className="space-y-1">
            <div>
              The agent asked for <span className="font-medium">{executorLabel(provisionErr.runtime)}</span>, which isn't
              provisioned yet.
            </div>
            <div className="p-text-3">{provisionErr.message}</div>
            <div className="p-text-3">
              Open the <span className="font-medium">Environment</span> tab to provision it.
            </div>
          </div>
        </div>
      )}
      {expanded && (
        <div className="border-t border-dashed border-[var(--c-dash)] px-4 py-3 space-y-2 animate-scale-in bg-[var(--c-recessed)]">
          {errorText && (
            <div>
              <div className="p-eyebrow mb-1 p-danger">Error</div>
              <pre className="p-t-code p-danger max-h-40 overflow-auto whitespace-pre-wrap m-0">{redactSecrets(errorText)}</pre>
            </div>
          )}
          {/* eval and shell args render as source, not JSON: JSON escapes every quote and newline. */}
          {codePreview !== null && (
            <CodeBlock className={toolName === "eval" ? "language-js" : "language-bash"}>{redactSecrets(codePreview)}</CodeBlock>
          )}
          {codePreview === null && input != null && (
            <div>
              <div className="p-eyebrow mb-1">Input</div>
              <div className="max-h-40 overflow-auto"><CodeBlock wrap className="language-json">{JSON.stringify(redactPayload(input), null, 2)}</CodeBlock></div>
            </div>
          )}
          {output != null && <ToolOutput output={output} />}
        </div>
      )}
    </div>
  );
}

function ToolCallPart({ part, expanded, onToggleExpand }: { part: AnyToolPart; expanded: boolean; onToggleExpand: () => void }) {
  const output = partOutput(part);
  const input = partInput(part);
  const running = toolCallRunning(part);

  useSeenRunning(part.toolCallId, running);

  // A call the SDK refused asked nothing: it reads as any refused call does.
  if (getToolName(part) === ASK_OWNER_TOOL && part.state !== "output-error") return <AskRecord callId={part.toolCallId} input={input} />;

  const previewUrl = extractPreviewUrl(output);

  return (
    <div>
      <ToolCallBlock
        toolName={getToolName(part)}
        input={input}
        output={output}
        effect={partEffect(part)}
        isRunning={running}
        isError={callFailed(part)}
        errorText={part.state === "output-error" ? part.errorText : undefined}
        expanded={expanded}
        onToggleExpand={onToggleExpand}
      />
      {previewUrl && (
        <div className="mt-2 h-64 overflow-hidden rounded-md border p-border">
          <PreviewFrame url={previewUrl} />
        </div>
      )}
      <PartPictures part={part} size="thumb" />
    </div>
  );
}

/** Shown when it happens, as the chat's other events are; the agent reads it at its next step. */
export function DeviceOfflineRow({ devices }: { devices: ReadonlyArray<UnavailableDevice> | null }) {
  if (devices === null) return null;
  const [only] = devices;

  let offline = "No machine connected";

  if (only !== undefined && devices.length === 1) {
    offline = `${only.label} is offline`;
  } else if (devices.length > 1) {
    offline = "Your machines are offline";
  }

  return (
    <EventRow
      icon={DesktopTowerIcon}
      tone="p-warning"
      label="Machine"
      body={offline}
      action={devices.length === 0 ? <Link to="/devices" className="mt-1 mr-2 shrink-0 p-row-text p-accent hover:underline">Connect</Link> : undefined}
      hooks={{ "data-device-offline": String(devices.length) }}
    />
  );
}

export function ModelFallbackRows({ notices }: { notices: readonly string[] }) {
  return foldRepeats(notices, (notice) => notice).map(({ item: notice, count }, index) => (
    <div key={`${String(index)}:${notice}`} role="status">
      <EventRow icon={ArrowsLeftRightIcon} tone="p-warning" label="Model" body={notice} count={count} hooks={{ "data-model-fallback": "" }} />
    </div>
  ));
}

/** `wrap-anywhere`: a long unbroken token must break inside the bubble, not widen the column. */
const USER_BUBBLE_CLASS =
  "relative max-w-[min(80%,42rem)] rounded-t-2xl rounded-br-[4px] rounded-bl-2xl border p-user-border px-[18px] py-3 p-user-bubble p-t-chat whitespace-pre-wrap wrap-anywhere";

export function SteerBubble({ steer, onFork }: {
  steer: InlineSteer;
  onFork?: (messageId: string) => void;
}) {
  return (
    <div className="group flex flex-col items-end animate-fade-in" data-steer={steer.state}>
      <div className={USER_BUBBLE_CLASS}>
        {steer.text}
        {onFork && steer.state === "landed" && (
          <button
            onClick={() => onFork(steer.id)}
            className="absolute -left-9 top-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity flex items-center gap-1 p-text-3 hover:p-text px-1.5 py-0.5 rounded-sm"
            title="Fork the workspace from here"
          >
            <GitBranchIcon size={12} />
          </button>
        )}
      </div>
      <SteeredMark state={steer.state === "queued" ? "queued" : "landed"} />
    </div>
  );
}

function SteeredMark({ state }: { state: "queued" | "landed" }) {
  return (
    <span className="mt-1 inline-flex items-center gap-1 p-meta p-text-3">
      <ArrowBendUpRightIcon size={10} weight="bold" />
      {state === "queued" ? "queued for the next step" : "steered mid-turn"}
    </span>
  );
}

/** An event the agent read mid-answer, with where it read it and how far it has got. */
interface AnswerSplice {
  readonly id: string;
  readonly atStep: number;
  readonly text: string;
  readonly metadata: JsonObject;
  readonly state: CardState;
}

/** What the answer keeps, seen, then the live cards it does not keep yet. */
function answerSplices(message: UIMessage, live: readonly SignalCard[] = []): readonly AnswerSplice[] {
  const kept = splicesSeenOn({ metadata: message.metadata }).map((splice) => ({ ...splice, state: "seen" as const }));
  const keptIds = new Set(kept.map((splice) => splice.id));

  return [...kept, ...live.flatMap((card) => (card.atStep === undefined || keptIds.has(card.id) ? [] : [{
    id: card.id, atStep: card.atStep, text: card.text, metadata: { ...card.metadata }, state: card.state,
  }]))];
}

/** Drawn between the parts it arrived between: the step before it, and the step that read it. */
function SplicedEvent({ splice }: { splice: AnswerSplice }) {
  const turn = classifyProgrammaticTurn({ metadata: splice.metadata });

  return turn === null ? null : (
    <div data-spliced-signal={splice.id}>
      <ProgrammaticTurnCard turn={turn} text={splice.text} state={splice.state} />
    </div>
  );
}

// Memoized: @ai-sdk's replaceMessage clones only the streaming message, so history keeps
// referential identity and skips re-rendering.
export const MessageView = memo(function MessageView({
  message, liveTail: tail = null, onFork, onFeedback, feedback, onRevert, takesChip,
  signalState, steers, splices, onOpenChangeNote, answerSlates, onRetry, repeats,
}: {
  message: UIMessage;
  /** A turn nobody typed that came this many times in a row ({@link eventTurnKey}), drawn once. */
  repeats?: number;
  /** Resolved once by the thread owner (`threadLiveTail`), passed to the last row only; null means history. */
  liveTail?: LiveTail | null;
  signalState?: CardState;
  onFork?: (messageId: string) => void;
  onRevert?: (messageId: string) => void;
  /** Pass null to clear. Rejects on RPC failure. */
  onFeedback?: (messageId: string, feedback: 'positive' | 'negative' | null) => Promise<void>;
  feedback?: 'positive' | 'negative' | null;
  /** A slot rather than an import: TakesChip renders a node transcript, which renders MessageView. */
  takesChip?: ReactNode;
  steers?: readonly PlacedSteer[];
  /** Events spliced into this answer as it ran, live; once it is kept, the answer carries its own (`splicesSeenOn`). */
  splices?: readonly SignalCard[];
  onOpenChangeNote?: (source: string, anchor: DiffAnchor | undefined) => void;
  /** The chat an answer's `<slate-ui>` blocks resolve in; absent, a transcript shows their source. */
  answerSlates?: AnswerChat | undefined;
  /** Re-runs this answer's turn: the newest answer's, when it failed. */
  onRetry?: (() => void) | undefined;
}) {
  const isUser = message.role === "user";
  const isLive = tail !== null;
  const { pictures: answerPictures, lightbox } = useAnswerPictures(message, tail);
  // The mid-stream last assistant message is not persisted yet, so it cannot be forked.
  const canFork = !isLive && onFork !== undefined && message.id !== "";
  const { set: callToggles, toggle: toggleCall } = useToggledSet();

  const callExpanded = (part: AnyToolPart) => callToggles.has(part.toolCallId);

  // Backend-enqueued turns are stored as `user` rows, their author stamped in their metadata.
  const programmatic = classifyProgrammaticTurn({ metadata: message.metadata });

  // A kept row with no live card is a turn that ran: its agent has seen it.
  if (programmatic) {
    return (
      <ProgrammaticTurnCard
        turn={programmatic} text={rowText(message)} state={signalState ?? "seen"} count={repeats} />
    );
  }

  if (message.role === "system") {
    return <ProgrammaticTurnCard turn={systemEventTurn("system", { metadata: null })}
      text={rowText(message)} state={signalState ?? "seen"} count={repeats} />;
  }

  const sentNotes = isUser ? changeNotesCard({ metadata: message.metadata }) : null;

  if (sentNotes !== null) {
    const createdAt = messageCreatedAt(message);

    return (
      <FeedbackCard card={sentNotes} sentAt={createdAt === undefined ? Date.now() : new Date(createdAt).getTime()} now={Date.now()}
        {...(onOpenChangeNote !== undefined && { onOpen: (anchor: DiffAnchor | undefined) => onOpenChangeNote(sentNotes.source, anchor) })} />
    );
  }

  if (isUser) {
    const fileParts = message.parts.filter((p): p is FileUIPart => p.type === "file");

    return (
      <div className="flex flex-col items-end animate-fade-in group">
        <div className={USER_BUBBLE_CLASS}>
          {fileParts.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {fileParts.map((p, i) => <FilePartView key={i} part={p} />)}
            </div>
          )}
          {rowText(message)}
          {canFork && (
            <button
              onClick={() => onFork(message.id)}
              className="absolute -left-9 top-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity flex items-center gap-1 p-text-3 hover:p-text px-1.5 py-0.5 rounded-sm"
              title="Fork the workspace from here"
            >
              <GitBranchIcon size={12} />
            </button>
          )}
          {!isLive && onRevert && message.id && (
            <button
              onClick={() => onRevert(message.id)}
              data-revert-turn={message.id}
              className="absolute -left-9 top-8 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity flex items-center gap-1 p-text-3 hover:p-text px-1.5 py-0.5 rounded-sm"
              title="Revert to before this turn"
            >
              <ClockCounterClockwiseIcon size={12} />
            </button>
          )}
        </div>
        {isSteeredMessage({ metadata: message.metadata }) && <SteeredMark state="landed" />}
        <MessageTimestamp createdAt={messageCreatedAt(message)} />
      </div>
    );
  }

  const segments = segmentBySteers(message.parts, steers ?? [], answerSplices(message, splices));
  // The fork button goes on the first segment that draws anything: a steer at step 0 leaves the first empty.
  const forkSegment = segments.findIndex((segment) => segment.parts.length > 0);

  const renderContentPart = (part: UIMessage["parts"][number], key: string | number) => {

    const isTailPart = (tail?.kind === "text" || tail?.kind === "reasoning") && tail.part === part;

    if (part.type === "file") {
      return <div key={key} className="my-1.5"><FilePartView part={part} /></div>;
    }

    if (part.type === "text") {
      const t = drawnText(part);

      if (t === null) return null;

      // `p-streaming` draws the caret inside the last markdown block; a sibling element would land on its own line.
      return (
        <Fragment key={key}>
          <div {...(isTailPart ? { "data-live-indicator": "text" } : {})}
            className={`prose-chat p-text${isTailPart ? " p-streaming" : ""}`}>
            <AnswerText text={t} place={{ messageId: message.id, stored: tail === null, chat: answerSlates }} />
          </div>
          <PartPictures part={part} size="full" />
        </Fragment>
      );
    }

    return null;
  };

  // Thoughts in a row are one block, live while its newest part is the turn's tail.
  const renderThought = (parts: readonly ReasoningUIPart[]) => (
    <ReasoningBlock text={parts.flatMap((part) => drawnText(part) ?? []).join("\n\n")}
      live={tail?.kind === "reasoning" && parts.some((part) => part === tail.part)} />
  );

  const renderToolRow = (part: AnyToolPart) => (
    <ToolCallPart part={part}
      expanded={callExpanded(part)} onToggleExpand={() => toggleCall(part.toolCallId)} />
  );

  // A model's lines for this turn's phases, by each phase's first call, and for the whole turn.
  const written = writtenTitles({ metadata: message.metadata });

  const renderBlock = (block: PartBlock, i: number, live: boolean) => {
    if (block.kind === "run") {
      const [first] = phaseCalls(block.steps);

      return (
        <div key={first?.toolCallId ?? i} className={BLOCK_GAP.section}>
          <ToolRun steps={block.steps} live={live} written={first === undefined ? undefined : written.phases.get(first.toolCallId)}>
            {block.steps.map((step, j) => (step.kind === "tool"
              ? <div key={step.part.toolCallId} className={BLOCK_GAP.row}>{renderToolRow(step.part)}</div>
              : <div key={`thought-${String(j)}`} className={BLOCK_GAP.row}>{renderThought(step.parts)}</div>))}
          </ToolRun>
        </div>
      );
    }

    if (block.kind === "reasoning") return <div key={i} className={BLOCK_GAP.section}>{renderThought(block.parts)}</div>;

    const part = block.part;

    if (isToolUIPart(part)) {
      return <div key={part.toolCallId} className={BLOCK_GAP.row}>{renderToolRow(part)}</div>;
    }

    const content = renderContentPart(part, i);

    return content === null ? null : <div key={i} className={BLOCK_GAP.section}>{content}</div>;
  };

  return (
    <AnswerPicturesContext.Provider value={answerPictures}>
    <div className="group/msg space-y-1 animate-fade-in">
      {lightbox}
      {segments.map((segment, s) => (
        <Fragment key={s}>
          {segment.steer && <SteerBubble steer={segment.steer} onFork={onFork} />}
          {segment.signal && <SplicedEvent splice={segment.signal} />}
          {segment.parts.length > 0 && (
            <div className="group relative flex w-full flex-col">
              {s === forkSegment && canFork && (
                <button
                  onClick={() => onFork(message.id)}
                  className="absolute -right-9 top-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity flex items-center gap-1 p-text-3 hover:p-text px-1.5 py-0.5 rounded-sm"
                  title="Fork the workspace from here"
                >
                  <GitBranchIcon size={12} />
                </button>
              )}
              {rollUpTurn(groupMessageParts(segment.parts), isLive && s === segments.length - 1).map((block, i, blocks) => {
                if (block.kind !== "turn") {
                  // Live while the turn runs and nothing but thinking follows it: words after it are the answer starting.
                  const live = isLive && s === segments.length - 1 && blocks.slice(i + 1).every((after) => after.kind === "reasoning");

                  return renderBlock(block, i, live);
                }

                const calls = block.blocks.flatMap((rolled) => {
                  if (rolled.kind === "run") return phaseCalls(rolled.steps);

                  return rolled.kind === "part" && isToolUIPart(rolled.part) ? [rolled.part] : [];
                });

                const done = !isLive || s < segments.length - 1;

                // Until the turn's own line lands, the model's line for the newest phase rolled up says where it got to.
                const newestWritten = block.blocks.reduce<string | null>((found, rolled) => {
                  const [first] = rolled.kind === "run" ? phaseCalls(rolled.steps) : [];

                  return (first === undefined ? undefined : written.phases.get(first.toolCallId)) ?? found;
                }, null);

                return (
                  <div key={`turn-${String(i)}`} className={BLOCK_GAP.section}>
                    <TurnRollup line={phaseTitle(calls)} phases={block.blocks.filter((rolled) => rolled.kind === "run").length}
                      written={(done ? written.turn : null) ?? newestWritten}>
                      {block.blocks.map((rolled, j) => renderBlock(rolled, j, false))}
                    </TurnRollup>
                  </div>
                );
              })}
            </div>
          )}
        </Fragment>
      ))}
      {!isLive && endedMidWork({ metadata: message.metadata }) && <StoppedMidWorkRow />}
      <FailedTurnRow message={message} live={isLive} onRetry={onRetry} />
      {!isLive && <ChangedSlates message={message} />}
      {!isLive && (
        <div className="flex items-center gap-2">
          <MessageTimestamp createdAt={messageCreatedAt(message)} />
          {takesChip}
          {message.id && onFeedback && (
            <MessageFeedback
              messageId={message.id}
              current={feedback ?? null}
              onFeedback={onFeedback}
            />
          )}
        </div>
      )}
    </div>
    </AnswerPicturesContext.Provider>
  );
});

function ChangedSlates({ message }: { message: UIMessage }) {
  return slatesChanged({ metadata: message.metadata }).map((id) => <SlateLink key={id} id={id} />);
}

function MessageFeedback({
  messageId, current, onFeedback,
}: {
  messageId: string;
  /** Server-confirmed state — the toggle only flips when the RPC succeeds. */
  current: 'positive' | 'negative' | null;
  onFeedback: (messageId: string, feedback: 'positive' | 'negative' | null) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const toggle = useCallback((next: 'positive' | 'negative') => detach(Effect.gen(function* () {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const apply = current === next ? null : next;

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      yield* Effect.promise(async () => onFeedback(messageId, apply));
    }), (refused) => Effect.sync(() => {
      diagnostics.event('ui.feedback_failed', { error: renderThrownChain({ cause: Cause.squash(refused) }) });
      setFailed(true);
    })), Effect.sync(() => {
      setBusy(false);
    }));
  })), [busy, current, messageId, onFeedback]);

  return (
    <div className={`flex items-center gap-1 transition-opacity ${current === null ? 'opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100' : ''}`}>
      <button
        type="button"
        onClick={() => toggle('positive')}
        disabled={busy}
        className={`flex items-center p-1 rounded-sm p-card-hover transition-colors ${
          current === 'positive' ? 'p-text' : 'p-text-3 hover:p-text focus-visible:p-text'
        }`}
        title="Mark this response helpful. Feeds evolution scoring."
        aria-label="Mark this response helpful"
      ><ThumbsUpIcon size={12} weight={current === 'positive' ? 'fill' : 'regular'} /></button>
      <button
        type="button"
        onClick={() => toggle('negative')}
        disabled={busy}
        className={`flex items-center p-1 rounded-sm p-card-hover transition-colors ${
          current === 'negative' ? 'p-text' : 'p-text-3 hover:p-text focus-visible:p-text'
        }`}
        title="Mark this response poor. Feeds evolution scoring."
        aria-label="Mark this response poor"
      ><ThumbsDownIcon size={12} weight={current === 'negative' ? 'fill' : 'regular'} /></button>
      {failed && <span className="p-t-status p-danger">Could not save. Try again.</span>}
    </div>
  );
}
