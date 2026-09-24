import { Fragment, memo, useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import {
  WrenchIcon, CaretDownIcon, CaretRightIcon,
  GitBranchIcon, CheckCircleIcon, ClockIcon,
  WarningCircleIcon, ProhibitIcon,
  ClockCounterClockwiseIcon, LightningIcon,
  ArrowBendUpRightIcon, GearSixIcon, EyeIcon,
  TerminalWindowIcon, FileTextIcon, UsersThreeIcon, BrainIcon,
  ListChecksIcon, GlobeIcon, ChartLineUpIcon, DotsThreeCircleIcon, DesktopTowerIcon,
  ThumbsUpIcon, ThumbsDownIcon,
} from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage, FileUIPart } from "ai";
import {
  ADVISOR_SEVERITY_LABEL,
  describeToolCall, rowText, summarizeToolCall,
} from "@kinu.run/core";
import type { AdvisorSeverity, InlineSteer, JsonObject, JsonValue, PlacedSteer, ToolCallEffect } from "@kinu.run/core";
import * as v from "valibot";
import { diagnostics, renderThrownChain } from "@kinu.run/core/obs";
import { PreviewFrame } from "@/components/PreviewFrame";
import { MarkdownContent, CodeBlock } from "@/components/surfaces/shared";
import { AttachmentChip } from "@/components/AttachmentChip";
import { extractPreviewUrl } from "@kinu.run/core";
import {
  groupMessageParts,
  partOutput, partInput, partEffect, callFailed, parseProvisionError,
  type AnyToolPart,
} from "@kinu.run/core";
import { drawnText, toolCallRunning, type LiveTail } from "@kinu.run/core";
import { redactPayload, redactSecrets, segmentBySteers } from "@kinu.run/core";
import {
  classifyProgrammaticTurn, endedMidWork, eventSourceLabel, eventVariantLabel, isSteeredMessage, parseDrainedEvents,
  type ClassifiedProgrammaticTurn, type DrainedEvent, type SignalCard,
} from "@kinu.run/core";
import { useToggledSet } from "@/hooks/use-toggled-set";
import type { UnavailableDevice } from "@/hooks/use-kinu";

const MessageCreatedAtSchema = v.looseObject({
  createdAt: v.optional(v.union([v.string(), v.number(), v.instance(Date)])),
});


/** The SDK's message type declares no timestamp; the transport's stamp is read off the value. */
function messageCreatedAt(message: UIMessage): string | number | Date | undefined {
  const parsed = v.safeParse(MessageCreatedAtSchema, message);

  return parsed.success ? parsed.output.createdAt : undefined;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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

  return <span className="p-annotation p-text-3 mt-1 block">{formatTime(d)}</span>;
}

// A settled call takes a line's gap, prose and grouped cards a section's. The block carries
// its own margin because a stack utility cannot be overridden per child.
const BLOCK_GAP = {
  row: "mt-1.5 first:mt-0",
  section: "mt-4 first:mt-0",
} as const;

// A pause and a reasoning block share one "Thinking" label so the indicator keeps its shape
// across transitions; reasoning text lands under the same line.
function ThinkingLabel({ live }: { live: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span className={`size-1.5 rounded-full p-dot-accent${live ? " p-dot-pulse" : ""}`} aria-hidden />
      <span className={`p-row-text font-medium${live ? " p-shimmer" : ""}`}>Thinking</span>
    </span>
  );
}

// A sibling of the message list, not a child of its last message: a turn with no assistant
// row yet has nothing to hang it on.
export function ChatLiveTail({ tail }: { tail: LiveTail | null }) {
  if (tail?.kind !== "thinking") return null;

  return (
    <div data-live-indicator="thinking" className="animate-fade-in py-1.5" aria-live="polite">
      <ThinkingLabel live />
    </div>
  );
}

function ReasoningBlock({ text, live = false }: { text: string; live?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!live) return;
    setExpanded(false);

    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [live, text]);

  return (
    <div className="py-0.5 p-row-text p-text-4">
      {live ? (
        <>
          <span data-live-indicator="reasoning"><ThinkingLabel live /></span>
          <div ref={viewport} data-reasoning-viewport className="mt-1 ml-3.5 max-h-[4lh] overflow-y-auto scroll-auto whitespace-pre-wrap">{text}</div>
        </>
      ) : (
        <>
          <button onClick={() => setExpanded(!expanded)} className="group/reason w-full text-left cursor-pointer" aria-expanded={expanded}>
            <ThinkingLabel live={false} />
            {!expanded && <span className="ml-3.5 block opacity-80">{text.slice(0, 120)}</span>}
            {text.length > 120 && (
              <span className="ml-3.5 font-medium p-accent">{expanded ? "collapse" : "expand"}</span>
            )}
          </button>
          {expanded && <div className="mt-1 ml-3.5 whitespace-pre-wrap">{text}</div>}
        </>
      )}
    </div>
  );
}

function StoppedMidWorkRow() {
  return (
    <div className="flex items-center gap-2 p-row-text p-text-3" role="status">
      <span className="size-1.5 rounded-full p-dot-danger" aria-hidden />
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
    ? (jsonString(input, "runtime") ?? 'workspace')
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
    stateBadge = <><span className="size-1.5 rounded-full p-dot-accent p-dot-pulse" />Running</>;
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
      {expanded && provisionErr && (
        <div className="p-tint-warning mt-1.5 ml-5 rounded-lg border px-3 py-2 text-xs p-text-2 flex items-start gap-2">
          <WrenchIcon size={12} className="p-warning mt-0.5 shrink-0" />
          <div className="space-y-1">
            <div>
              The agent asked for the <code className="font-mono p-fill px-1 rounded-sm">{provisionErr.runtime}</code> runtime
              but it isn't provisioned yet.
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
              <div className="max-h-40 overflow-auto"><CodeBlock className="language-json">{JSON.stringify(redactPayload(input), null, 2)}</CodeBlock></div>
            </div>
          )}
          {output != null && (
            <div>
              <div className="p-eyebrow mb-1">Output</div>
              <pre className="p-t-code p-text-2 max-h-40 overflow-auto whitespace-pre-wrap m-0">{displayToolValue(redactPayload(output))}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A run of read-only calls long enough to fold: its first and last rows stand,
 *  and the calls between them wait behind one control until the reader asks. */
function ToolCallFold({ parts, expandedCalls, onToggleCall }: {
  parts: readonly AnyToolPart[];
  expandedCalls: ReadonlySet<string>;
  onToggleCall: (toolCallId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const middle = parts.slice(1, -1);

  const row = (part: AnyToolPart) => (
    <div key={part.toolCallId} className={BLOCK_GAP.row}>
      <ToolCallPart part={part} expanded={expandedCalls.has(part.toolCallId)} onToggleExpand={() => onToggleCall(part.toolCallId)} />
    </div>
  );

  return (
    <>
      {parts.slice(0, 1).map(row)}
      {open ? middle.map(row) : (
        <button type="button" onClick={() => setOpen(true)} aria-expanded={false}
          className={`${BLOCK_GAP.row} w-full px-3 py-1.5 text-left p-t-control p-accent`}>
          {middle.length} more
        </button>
      )}
      {parts.slice(-1).map(row)}
    </>
  );
}

function ToolCallPart({ part, expanded, onToggleExpand }: { part: AnyToolPart; expanded: boolean; onToggleExpand: () => void }) {
  const output = partOutput(part);
  const input = partInput(part);
  const previewUrl = extractPreviewUrl(output);

  return (
    <div>
      <ToolCallBlock
        toolName={getToolName(part)}
        input={input}
        output={output}
        effect={partEffect(part)}
        isRunning={toolCallRunning(part)}
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
    </div>
  );
}

/** Shown when the event happens; the agent reads it at its next step. */
type CardState = SignalCard["state"];

function ShownCaption({ state }: { state: CardState }) {
  return (
    <>
      <span aria-hidden>·</span>
      <span>{state === "pending" ? "to be shown to the agent" : "shown to the agent"}</span>
    </>
  );
}

function backgroundEventMeta(status: string) {
  if (status === "completed") return { Icon: CheckCircleIcon, tone: "p-success", verb: "completed" };

  if (status === "cancelled") return { Icon: ProhibitIcon, tone: "p-text-3", verb: "was cancelled" };

  return { Icon: WarningCircleIcon, tone: "p-danger", verb: "failed" };
}

function BackgroundEventCard({ kind, status, state }: { kind: string; status: string; state: CardState }) {
  const meta = backgroundEventMeta(status);

  return (
    <div className="animate-fade-in">
      <div className="flex w-full items-baseline gap-2.5 rounded-lg border border-[rgba(224,164,88,.25)] bg-[rgba(224,164,88,.05)] px-4 py-2.5">
        <span className="shrink-0 p-t-status p-accent">System</span>
        <div className="min-w-0 flex-1 p-row-text p-text-2 opacity-80">
          Background <span className="p-annotation">{kind}</span> task {meta.verb}
          <span className="ml-1 inline-flex items-center gap-1 p-text-3"><ShownCaption state={state} /></span>
        </div>
        <meta.Icon size={12} className={`shrink-0 ${meta.tone}`} weight="fill" />
      </div>
    </div>
  );
}

function DrainedEventRow({ event }: { event: DrainedEvent }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <button
      type="button"
      onClick={() => setExpanded(!expanded)}
      className="w-full rounded-md px-2 py-2 text-left transition-colors hover:p-elevated"
    >
      <div className="flex items-center gap-1.5 p-row-text">
        <span className="shrink-0 font-medium p-text-2">{eventVariantLabel(event.variant)}</span>
        <span className="min-w-0 truncate p-text-3">{eventSourceLabel(event.source)}</span>
        {event.replyExpected && (
          <span className="shrink-0 rounded-sm px-1 py-0.5 p-badge-warning" title="The sender is waiting on the agent's reply">
            reply expected
          </span>
        )}
        <span className="ml-auto shrink-0 p-text-3">
          {expanded ? <CaretDownIcon size={10} /> : <CaretRightIcon size={10} />}
        </span>
      </div>
      <div className={`mt-0.5 p-row-text p-text-2 opacity-80 ${expanded ? "whitespace-pre-wrap break-words" : "truncate"}`}>
        {event.brief}
      </div>
    </button>
  );
}

/** The operator did not type drained events, so they never wear the user bubble. */
function DrainedEventsCard({ text, state }: { text: string; state: CardState }) {
  const events = parseDrainedEvents(text);

  return (
    <div className="animate-fade-in">
      <div className="w-full rounded-lg border border-[rgba(224,164,88,.25)] bg-[rgba(224,164,88,.05)] px-4 py-2.5">
        <div className="flex items-baseline gap-2.5 p-row-text">
          <LightningIcon size={11} className={`shrink-0 ${state === "pending" ? "p-text-4" : "p-accent"}`} weight="fill" />
          <span className="shrink-0 font-semibold p-accent">System</span>
          <span className="p-text-3"><ShownCaption state={state} /></span>
          {events.length > 1 && <span className="ml-auto shrink-0 p-text-3 tabular-nums">{events.length} events</span>}
        </div>
        <div className="mt-1.5 divide-y divide-dashed divide-[var(--c-dash)]">
          {events.length > 0
            ? events.map((event, i) => <DrainedEventRow key={i} event={event} />)
            /* Format drift: show what the agent was given rather than nothing. */
            : <div className="p-row-text p-text-2 opacity-80 whitespace-pre-wrap break-words">{text}</div>}
        </div>
      </div>
    </div>
  );
}

/** Approved commands have not executed yet (the agent re-issuing them runs them), so never "ran". */
function DeferredApprovalCard({ decision, count, state }: {
  decision: string; count: number; state: CardState;
}) {
  const approved = decision === "approved";
  const Icon = approved ? CheckCircleIcon : ProhibitIcon;

  return (
    <div className="flex justify-center animate-fade-in py-1">
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full p-elevated border p-border p-row-text p-text-2">
        <Icon size={13} className={approved ? "p-success" : "p-text-3"} weight="fill" />
        <span>
          You <span className="font-medium p-text">{approved ? "approved" : "denied"}</span>{" "}
          {count} queued command{count === 1 ? "" : "s"}
        </span>
        <span className="flex items-center gap-1 p-text-3"><ShownCaption state={state} /></span>
        <ClockIcon size={11} className="p-text-3" />
      </div>
    </div>
  );
}

/** Rendered inline, not via a shared wrapper: a two-caller same-file export trips the wiring gate. */
const SYSTEM_PILL = "inline-flex items-center gap-2 px-3 py-1.5 rounded-full p-elevated border p-border p-row-text p-text-2";

export function DeviceOfflineRow({ devices }: { devices: ReadonlyArray<UnavailableDevice> | null }) {
  if (devices === null) return null;
  const [only] = devices;

  let offline: ReactNode = <span>No machine connected <Link to="/devices" className="p-accent hover:underline">Connect</Link></span>;

  if (only !== undefined && devices.length === 1) {
    offline = <span>{only.label} is offline</span>;
  } else if (devices.length > 1) {
    offline = <span>Your machines are offline</span>;
  }

  return (
    <div className="flex justify-center animate-fade-in py-1">
      <div className={SYSTEM_PILL}>
        <DesktopTowerIcon size={13} className="p-warning" weight="fill" />
        {offline}
      </div>
    </div>
  );
}


function SystemEventCard({ event, text, state }: {
  event: string; text: string; state: CardState;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="animate-fade-in" data-system-event={event}>
      <div className="w-full rounded-lg border border-[rgba(224,164,88,.25)] bg-[rgba(224,164,88,.05)] px-4 py-2.5">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-baseline gap-2.5 text-left p-row-text"
          aria-expanded={expanded}
        >
          <GearSixIcon size={11} className="shrink-0 p-accent" weight="fill" />
          <span className="shrink-0 font-semibold p-accent">System</span>
          <span className="p-text-4">{event.replace(/_/g, " ")}</span>
          <span className="p-text-3"><ShownCaption state={state} /></span>
          <span className="ml-auto shrink-0 p-text-3">
            {expanded ? <CaretDownIcon size={10} /> : <CaretRightIcon size={10} />}
          </span>
        </button>
        <div className={`mt-1 p-row-text p-text-2 opacity-80 ${expanded ? "whitespace-pre-wrap break-words" : "truncate"}`}>
          {text}
        </div>
      </div>
    </div>
  );
}

const ADVISOR_TONES = {
  nit: { panel: "border p-border p-elevated", icon: "p-text-3", badge: "p-badge-neutral" },
  concern: { panel: "p-notice-warning", icon: "p-warning", badge: "p-badge-warning" },
  blocker: { panel: "p-notice-danger", icon: "p-danger", badge: "p-badge-danger" },
} satisfies Record<AdvisorSeverity, { panel: string; icon: string; badge: string }>;

function AdvisorCard({ severity, text, state }: {
  severity: AdvisorSeverity; text: string; state: CardState;
}) {
  const tone = ADVISOR_TONES[severity];

  return (
    <div className="flex justify-center animate-fade-in py-1" data-advisor-severity={severity}>
      <div className={`w-full max-w-[85%] rounded-xl px-3 py-2 ${tone.panel}`}>
        <div className="flex items-center gap-1.5 p-meta p-text-3">
          <EyeIcon size={11} className={`shrink-0 ${tone.icon}`} weight="fill" />
          <span className="font-medium p-text-2">Advisor</span>
          <span className={`px-1.5 ${tone.badge}`}>{ADVISOR_SEVERITY_LABEL[severity]}</span>
          <ShownCaption state={state} />
        </div>
        <div className="mt-1 p-row-text p-text-2 whitespace-pre-wrap break-words">{text}</div>
      </div>
    </div>
  );
}

export function ProgrammaticTurnCard({ turn, text, state }: {
  turn: ClassifiedProgrammaticTurn; text: string; state: CardState;
}) {
  if (turn.kind === "workspace_created") return null;

  if (turn.kind === "background_job") {
    return <BackgroundEventCard kind={turn.jobKind} status={turn.status} state={state} />;
  }


  if (turn.kind === "deferred_approval") {
    return <DeferredApprovalCard decision={turn.decision} count={turn.count} state={state} />;
  }

  if (turn.kind === "advisor") {
    return <AdvisorCard severity={turn.severity} text={text} state={state} />;
  }

  if (turn.kind === "system_event") {
    return <SystemEventCard event={turn.event} text={text} state={state} />;
  }

  return <DrainedEventsCard text={text} state={state} />;
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

// Memoized: @ai-sdk's replaceMessage clones only the streaming message, so history keeps
// referential identity and skips re-rendering.
export const MessageView = memo(function MessageView({
  message, liveTail: tail = null, onFork, onFeedback, feedback, onRevert, takesChip,
  signalState, steers,
}: {
  message: UIMessage;
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
}) {
  const isUser = message.role === "user";
  const isLive = tail !== null;
  // The mid-stream last assistant message is not persisted yet, so it cannot be forked.
  const canFork = !isLive && onFork !== undefined && message.id !== "";
  const { set: callToggles, toggle: toggleCall } = useToggledSet();

  const callExpanded = (part: AnyToolPart) => callToggles.has(part.toolCallId);

  // Backend-enqueued turns are stored as `user` rows. The id is the provenance marker on rows
  // written before the author stamp existed.
  const programmatic = classifyProgrammaticTurn({ metadata: message.metadata, id: message.id });

  if (programmatic) {
    return (
      <ProgrammaticTurnCard
        turn={programmatic} text={rowText(message)} state={signalState ?? "shown"} />
    );
  }

  if (message.role === "system") {
    return <ProgrammaticTurnCard turn={{ kind: "system_event", event: "system" }}
      text={rowText(message)} state={signalState ?? "shown"} />;
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

  const segments = segmentBySteers(message.parts, steers ?? []);
  // The fork button goes on the first segment that draws anything: a steer at step 0 leaves the first empty.
  const forkSegment = segments.findIndex((segment) => segment.parts.length > 0);

  const renderContentPart = (part: UIMessage["parts"][number], key: string | number) => {

    const isTailPart = (tail?.kind === "text" || tail?.kind === "reasoning") && tail.part === part;

    if (part.type === "reasoning") {
      const t = drawnText(part);

      return t === null ? null : <ReasoningBlock key={key} text={t} live={isTailPart} />;
    }

    if (part.type === "file") {
      return <div key={key} className="my-1.5"><FilePartView part={part} /></div>;
    }

    if (part.type === "text") {
      const t = drawnText(part);

      if (t === null) return null;

      // `p-streaming` draws the caret inside the last markdown block; a sibling element would land on its own line.
      return (
        <div key={key} {...(isTailPart ? { "data-live-indicator": "text" } : {})}
          className={`prose-chat p-text${isTailPart ? " p-streaming" : ""}`}>
          <MarkdownContent content={t} />
        </div>
      );
    }

    return null;
  };

  const renderToolRow = (part: AnyToolPart) => (
    <ToolCallPart part={part}
      expanded={callExpanded(part)} onToggleExpand={() => toggleCall(part.toolCallId)} />
  );

  return (
    <div className="group/msg space-y-1 animate-fade-in">
      {segments.map((segment, s) => (
        <Fragment key={s}>
          {segment.steer && <SteerBubble steer={segment.steer} onFork={onFork} />}
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
              {groupMessageParts(segment.parts).map((block, i) => {
                if (block.kind === "fold") {
                  return <ToolCallFold key={block.parts[0]?.toolCallId ?? i} parts={block.parts} expandedCalls={callToggles} onToggleCall={toggleCall} />;
                }

                const part = block.part;

                if (isToolUIPart(part)) {
                  return <div key={part.toolCallId} className={BLOCK_GAP.row}>{renderToolRow(part)}</div>;
                }

                const content = renderContentPart(part, i);

                return content === null ? null : <div key={i} className={BLOCK_GAP.section}>{content}</div>;
              })}
            </div>
          )}
        </Fragment>
      ))}
      {!isLive && endedMidWork({ metadata: message.metadata }) && <StoppedMidWorkRow />}
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
  );
});

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

  const toggle = useCallback(async (next: 'positive' | 'negative') => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const apply = current === next ? null : next;

    try {
      await onFeedback(messageId, apply);
    } catch (error) {
      diagnostics.event('ui.feedback_failed', { error: renderThrownChain({ cause: error }) });
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [busy, current, messageId, onFeedback]);

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
