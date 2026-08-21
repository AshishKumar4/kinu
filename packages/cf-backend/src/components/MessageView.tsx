/**
 * The chat message renderer — one `UIMessage` as the transcript shows it.
 *
 * Lives beside the transcripts that render it rather than inside the workspace
 * route, so the main chat, a node transcript and the gallery can all reach the
 * one renderer without importing a page. Everything a message can contain owns
 * a piece of this file: prose, reasoning, tool runs, files, the programmatic
 * turns the backend enqueued, and the per-message affordances.
 */
import { memo, useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import {
  WrenchIcon, CaretDownIcon, CaretRightIcon,
  BrainIcon, GitBranchIcon, CheckCircleIcon, ClockIcon,
  WarningCircleIcon, ProhibitIcon,
  ClockCounterClockwiseIcon, LightningIcon,
  StackIcon, SparkleIcon, ArrowBendUpRightIcon, GearSixIcon, EyeIcon,
} from "@phosphor-icons/react";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage, FileUIPart } from "ai";
import {
  ADVISOR_SEVERITY_LABEL, JsonObjectSchema, JsonValueSchema,
  describeToolCall, isToolCallFailed, summarizeToolCall, summarizeToolRun,
} from "@kinu.run/core";
import type { AdvisorSeverity, JsonObject, JsonValue } from "@kinu.run/core";
import * as v from "valibot";
import { tolerate } from "@kinu.run/core/obs";
import { PreviewFrame } from "@/components/PreviewFrame";
import { MarkdownContent, CodeBlock } from "@/components/surfaces/shared";
import { AttachmentChip } from "@/components/AttachmentChip";
import { extractPreviewUrl } from "@/lib/preview-origin";
import { groupMessageParts, type AnyToolPart } from "@/components/tool-call-grouping";
import { liveTail } from "@/components/message-live-tail";
import {
  classifyProgrammaticTurn, eventVariantLabel, isSteeredMessage, parseDrainedEvents,
  type DrainedEvent, type ProgrammaticTurn, type SignalCard,
} from "@/components/background-event";

function getMessageText(msg: UIMessage): string {
  return msg.parts.filter(p => p.type === "text").map(p => p.text).join("");
}

const MessageCreatedAtSchema = v.looseObject({
  createdAt: v.optional(v.union([v.string(), v.number(), v.instance(Date)])),
});

const ProvisionErrorSchema = v.object({
  error: v.literal("runtime_not_provisioned"),
  runtime: v.string(),
  message: v.optional(v.string()),
});

function messageCreatedAt<Message>(message: Message): string | number | Date | undefined {
  const parsed = v.safeParse(MessageCreatedAtSchema, message);
  return parsed.success ? parsed.output.createdAt : undefined;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Render one file part inside a message: inline preview for images, a
 *  filename chip for everything else. */
function FilePartView({ part }: { part: FileUIPart }) {
  return part.mediaType.startsWith("image/")
    ? <img src={part.url} alt={part.filename ?? "image"} className="max-h-48 max-w-full rounded-lg border p-border" />
    : <AttachmentChip part={part} />;
}

function MessageTimestamp({ createdAt }: { createdAt?: string | number | Date }) {
  if (!createdAt) return null;
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (isNaN(d.getTime())) return null;
  return <span className="text-[10px] p-text-3 mt-1 block">{formatTime(d)}</span>;
}

/**
 * The turn's live tail when nothing is arriving — between a settled call and
 * whatever the model does next, or before its first token.
 *
 * Rendered only where `liveTail` says the stream is open with no active part,
 * so it stops the moment anything lands. The shimmer is the same one the
 * running tool name carries; live work reads as light moving through text
 * everywhere in this UI, and a second vocabulary for the same fact would be
 * decoration.
 */
function ThinkingRow() {
  return (
    <div className="flex items-center gap-2 animate-fade-in py-1" aria-live="polite">
      <span className="size-1.5 rounded-full p-dot-accent animate-pulse" aria-hidden />
      <span className="p-row-text p-shimmer font-medium">Thinking</span>
    </div>
  );
}

function ReasoningBlock({ text, live = false }: { text: string; live?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="my-1.5">
      <button onClick={() => setExpanded(!expanded)} className="group/reason flex items-center gap-2 p-row-text p-text-3 hover:p-text-2 w-full text-left transition-colors cursor-pointer">
        {live
          ? <span className="size-1.5 mx-[6px] shrink-0 rounded-full p-dot-accent animate-pulse" aria-hidden />
          : <BrainIcon size={14} className="shrink-0" />}
        <span className={`font-medium ${live ? "p-shimmer" : ""}`}>{expanded ? "Thoughts" : "Thinking"}</span>
        {!expanded && <span className="min-w-0 truncate p-meta p-text-3 opacity-70">{text.slice(0, 90)}</span>}
        <CaretRightIcon size={11} className={`shrink-0 transition-transform duration-150 ${expanded ? "rotate-90" : ""} opacity-0 group-hover/reason:opacity-100`} />
      </button>
      {expanded && (
        <div className="mt-1.5 ml-[7px] border-l p-border pl-4 p-meta p-text-2 whitespace-pre-wrap leading-relaxed">
          {text}
        </div>
      )}
    </div>
  );
}

/** Try to parse `{error:'runtime_not_provisioned', runtime, message}` from a
 *  string-ified tool output. Returns null if the output doesn't match. */
function parseProvisionError<Output>(output: Output):
  { runtime: string; message: string } | null {
  const text = v.safeParse(v.string(), output);
  if (!text.success || !text.output.includes('runtime_not_provisioned')) return null;
  // Output that names the runtime but isn't JSON is not this error shape; any
  // other failure here is real and must not read as "not a provision error".
  const parsed = v.safeParse(
    ProvisionErrorSchema,
    tolerate<unknown>(() => JSON.parse(text.output), 'malformed-input'),
  );
  return parsed.success
    ? { runtime: parsed.output.runtime, message: parsed.output.message ?? 'Runtime not available.' }
    : null;
}

function jsonString(input: JsonObject | undefined, key: string): string | null {
  const value = input?.[key];
  return v.is(v.string(), value) ? value : null;
}

function displayToolValue(value: JsonValue): string {
  return v.is(v.string(), value) ? value : JSON.stringify(value, null, 2) ?? "";
}

function ToolCallBlock({ toolName, input, output, isRunning, isError, errorText }: {
  toolName: string; input?: JsonObject; output?: JsonValue; isRunning: boolean; isError: boolean;
  /** The transport's own reason for a protocol-level failure (a crashed
   *  executor, a timeout) — distinct from `output`, which a tool that caught
   *  its own failure returns as an ordinary result. Never present together. */
  errorText?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const startTime = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const wasRunning = useRef(false);

  useEffect(() => {
    if (isRunning) {
      // Tool just started running — record the start time
      startTime.current = Date.now();
      wasRunning.current = true;
      setElapsed(null);
    } else if (wasRunning.current && startTime.current) {
      // Tool finished — we actually observed it running, so compute real duration
      setElapsed(Date.now() - startTime.current);
      wasRunning.current = false;
    }
    // If component mounts with isRunning=false and wasRunning is false,
    // we never observed the tool running — don't show any duration.
  }, [isRunning]);

  const durationLabel = elapsed !== null && elapsed > 100 ? `${(elapsed / 1000).toFixed(1)}s` : null;

  // Surface the runtime the `run` tool dispatched on so the user can see
  // at a glance whether the agent ran something in workspace / sandbox /
  // laptop. Default = workspace.
  const runtime = toolName === 'run'
    ? (jsonString(input, "runtime") ?? 'workspace')
    : null;
  const provisionErr = parseProvisionError(output);
  // What this call is actually about, from its own arguments — without it a
  // row of `agents` chips is six identical rows for six different calls.
  const summary = summarizeToolCall(toolName, input);
  const description = describeToolCall(toolName, input);

  const failed = isError || !!provisionErr;
  return (
    <div className="my-0.5">
      <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded} className="group/tool flex w-full min-h-7 items-center gap-2 rounded-md px-1 text-left p-row-text p-text-2 hover:p-text transition-colors cursor-pointer">
        <span className="shrink-0 flex w-4 items-center justify-center" aria-hidden>
          {isRunning ? <span className="size-1.5 rounded-full p-dot-accent animate-pulse" />
            : failed ? <span className="size-1.5 rounded-full p-dot-danger" />
            : <WrenchIcon size={13} className="p-text-3 opacity-60" />}
        </span>
        <span className={`font-mono text-[12px] shrink-0 ${isRunning ? "p-shimmer" : failed ? "p-danger" : ""}`}>{toolName}</span>
        {/* What the call does, then what it was passed. The description is
            derived from the same arguments as the summary — when they do
            not say, it is absent rather than invented. */}
        {description && <span className="shrink-0 p-text">{description}</span>}
        {summary && (
          <span className="min-w-0 truncate p-text-3" title={summary}>{summary}</span>
        )}
        {runtime && runtime !== "workspace" && (
          <span className="shrink-0 font-mono text-[11px] p-text-3" title={`Runtime: ${runtime}`}>@{runtime}</span>
        )}
        {durationLabel && !isRunning && <span className="shrink-0 p-text-3 p-num text-[11px]">{durationLabel}</span>}
        <CaretRightIcon size={11} className={`shrink-0 p-text-3 transition-transform duration-150 ${expanded ? "rotate-90" : ""} opacity-0 group-hover/tool:opacity-100 ${expanded ? "opacity-100" : ""}`} />
      </button>
      {provisionErr && (
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
        <div className="mt-1 ml-[7px] border-l p-border pl-4 space-y-2 animate-scale-in">
          {/* A protocol-level failure (crashed executor, timeout) carries its
              reason here, never in `output` — without this, expanding one of
              these showed a red row and then nothing: the actual cause was
              dropped on the floor. */}
          {errorText && (
            <div>
              <div className="p-eyebrow mb-1 p-danger">Error</div>
              <pre className="text-[12px] font-mono p-danger max-h-40 overflow-auto whitespace-pre-wrap m-0">{errorText}</pre>
            </div>
          )}
          {/* execute_tools is the agent's primary doing-mechanism: render the
              LLM-authored JS program legibly, not as escaped JSON. A `run`
              command gets the same treatment — its args are just
              {runtime, command}, and pretty-printed JSON turns every quote
              and newline in the command into an escape sequence, which is
              unreadable for exactly the multi-line commands worth expanding
              to read. The runtime stays visible in the collapsed row's `@x`
              badge, so nothing is lost by not repeating it here. */}
          {toolName === "execute_tools" && jsonString(input, "code") ? (
            <CodeBlock className="language-js">{jsonString(input, "code")}</CodeBlock>
          ) : toolName === "run" && jsonString(input, "command") ? (
            <CodeBlock className="language-bash">{jsonString(input, "command")}</CodeBlock>
          ) : input != null ? (
            <div>
              <div className="p-eyebrow mb-1">Input</div>
              <pre className="text-[12px] font-mono p-text-2 max-h-40 overflow-auto whitespace-pre-wrap m-0">{JSON.stringify(input, null, 2)}</pre>
            </div>
          ) : null}
          {output != null && (
            <div>
              <div className="p-eyebrow mb-1">Output</div>
              <pre className="text-[12px] font-mono p-text-2 max-h-40 overflow-auto whitespace-pre-wrap m-0">{displayToolValue(output)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A run of consecutive finished tool calls, as one row.
 *
 * A repair is rarely one call — it is read, read, edit, write, delegate, run
 * — and rendering each as its own row turns a turn into a wall of identical
 * chrome that buries the prose around it. The run collapses to a single line
 * carrying the tally, and opens to the same rows as before.
 *
 * Only FINISHED calls are folded in; a call still running keeps its own row
 * so the count never changes under the reader's eye while the agent works.
 */
/** The live output value of a finished part — undefined while it's still
 *  running or never finished, which is exactly when there is nothing to read
 *  a failure out of yet. Shared by the group's failure tally and the part's
 *  own card so the two can never disagree about the same call. */
function partOutput(part: AnyToolPart): JsonValue | undefined {
  if (part.state !== "output-available") return undefined;
  const parsed = v.safeParse(JsonValueSchema, part.output);
  return parsed.success ? parsed.output : undefined;
}

/** Whether this part failed — protocol-level (`output-error`) or the quieter
 *  kind a built-in catches and returns as a normal result (isToolCallFailed). */
function partFailed(part: AnyToolPart): boolean {
  return isToolCallFailed(getToolName(part), part.input, partOutput(part), part.state === "output-error");
}

function ToolCallGroup({ parts }: { parts: readonly AnyToolPart[] }) {
  const [expanded, setExpanded] = useState(false);
  // Reads every call's own output, not just the transport state — a run of
  // calls whose failure is a `run` tool's `Error (exit 1)` (caught and
  // returned as a normal result) used to collapse into a group that looked
  // exactly like a clean one; expanding it was the only way to find out which
  // row, if any, was the problem.
  const failed = parts.some(partFailed);
  const headline = summarizeToolRun(parts.map((p) => ({ toolName: getToolName(p), input: p.input })));

  return (
    <div className="my-0.5">
      <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded}
        className="group/tool flex w-full min-h-7 items-center gap-2 rounded-md px-1 text-left p-row-text p-text-2 hover:p-text transition-colors cursor-pointer">
        <span className="shrink-0 flex w-4 items-center justify-center" aria-hidden>
          {failed ? <span className="size-1.5 rounded-full p-dot-danger" />
            : <StackIcon size={13} className="p-text-3 opacity-60" />}
        </span>
        {/* title: the tally can run longer than the column and truncate —
            every other row in this card offers the untruncated text on
            hover, and this one didn't. */}
        <span className="min-w-0 truncate" title={headline}>{headline}</span>
        <CaretRightIcon size={11} className={`ml-auto shrink-0 p-text-3 transition-transform duration-150 ${expanded ? "rotate-90 opacity-100" : "opacity-0 group-hover/tool:opacity-100"}`} />
      </button>
      {expanded && (
        <div className="mt-0.5 ml-[7px] border-l p-border pl-3 animate-scale-in">
          {parts.map((part) => <ToolCallPart key={part.toolCallId} part={part} />)}
        </div>
      )}
    </div>
  );
}

/** One tool part: its row, plus the live preview a tool can return. */
function ToolCallPart({ part }: { part: AnyToolPart }) {
  const output = partOutput(part);
  const parsedInput = v.safeParse(JsonObjectSchema, part.input);
  const previewUrl = extractPreviewUrl(output);
  return (
    <div>
      <ToolCallBlock toolName={getToolName(part)}
        input={parsedInput.success ? parsedInput.output : undefined}
        output={output}
        isRunning={part.state === "input-available" || part.state === "input-streaming"}
        isError={partFailed(part)}
        errorText={part.state === "output-error" ? part.errorText : undefined} />
      {/* Inline preview card — when an executor returns a preview URL, surface
          a live iframe under the tool block so the user sees the running app
          inline (also promoted to the Output surface). */}
      {previewUrl && (
        <div className="mt-2 h-64 rounded-md border p-border overflow-hidden">
          <PreviewFrame url={previewUrl} />
        </div>
      )}
    </div>
  );
}

/** Whether the agent has read this event yet. An event is shown to the user
 *  when it HAPPENS; the agent reads it at its next step, which may be a while
 *  later — so the card says which of the two it is, and flips in place. */
type CardState = SignalCard["state"];

/** The lifecycle caption, in the event cards' existing language. */
function ShownCaption({ state }: { state: CardState }) {
  return (
    <>
      <span aria-hidden>·</span>
      <span>{state === "pending" ? "to be shown to the agent" : "shown to the agent"}</span>
    </>
  );
}

/** A background job returning into the conversation — rendered as a centered
 *  marker, not a chat bubble. The agent's synthesis reply follows as normal. */
function BackgroundEventCard({ kind, status, state }: { kind: string; status: string; state: CardState }) {
  const meta = status === "completed" ? { Icon: CheckCircleIcon, tone: "p-success", verb: "completed" }
    : status === "cancelled" ? { Icon: ProhibitIcon, tone: "p-text-3", verb: "was cancelled" }
    : { Icon: WarningCircleIcon, tone: "p-danger", verb: "failed" };
  return (
    <div className="flex justify-center animate-fade-in py-1">
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full p-elevated border p-border text-[11px] p-text-2">
        <meta.Icon size={13} className={meta.tone} weight="fill" />
        <span>Background <span className="font-medium p-text">{kind}</span> task {meta.verb}</span>
        <span className="flex items-center gap-1 p-text-3"><ShownCaption state={state} /></span>
        <ClockIcon size={11} className="p-text-3" />
      </div>
    </div>
  );
}

/** One hub event inside a drain card: what it was and where it came from, with
 *  the body the agent read on demand. */
function DrainedEventRow({ event }: { event: DrainedEvent }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setExpanded(!expanded)}
      className="w-full text-left p-card p-card-hover transition-colors px-2 py-1.5"
    >
      <div className="flex items-center gap-1.5 text-[10px]">
        <span className="shrink-0 font-medium p-text-2">{eventVariantLabel(event.variant)}</span>
        <span className="min-w-0 truncate p-text-3">{event.source}</span>
        {event.replyExpected && (
          <span className="shrink-0 rounded-sm px-1 py-0.5 p-badge-warning" title="The sender is waiting on the agent's reply">
            reply expected
          </span>
        )}
        <span className="ml-auto shrink-0 p-text-3">
          {expanded ? <CaretDownIcon size={10} /> : <CaretRightIcon size={10} />}
        </span>
      </div>
      <div className={`mt-0.5 text-[11px] p-text-2 ${expanded ? "whitespace-pre-wrap break-words" : "truncate"}`}>
        {event.brief}
      </div>
    </button>
  );
}

/** The reactor's drain: events that arrived while the operator was away, handed
 *  to the agent as turn input or spliced into the turn it was already running.
 *  The operator did not type this, so it never wears their bubble — it is a
 *  captioned, quieter event card. */
function DrainedEventsCard({ text, state }: { text: string; state: CardState }) {
  const events = parseDrainedEvents(text);
  return (
    <div className="flex justify-center animate-fade-in">
      <div className="w-full max-w-[85%] rounded-xl border p-border p-elevated px-3 py-2">
        <div className="flex items-center gap-1.5 text-[10px] p-text-3">
          <LightningIcon size={11} className={`shrink-0 ${state === "pending" ? "p-text-3" : "p-warning"}`} weight="fill" />
          <span className="font-medium">Background event</span>
          <ShownCaption state={state} />
          {events.length > 1 && <span className="ml-auto shrink-0 tabular-nums">{events.length} events</span>}
        </div>
        <div className="mt-1.5 space-y-1">
          {events.length > 0
            ? events.map((event, i) => <DrainedEventRow key={i} event={event} />)
            /* Format drift: show what the agent was given rather than nothing. */
            : <div className="text-[11px] p-text-2 whitespace-pre-wrap break-words">{text}</div>}
        </div>
      </div>
    </div>
  );
}

/** The owner's answer on commands the agent parked, coming back to the agent.
 *  Says approved/denied and how many — never "ran": the approved commands have
 *  not executed yet, and the agent re-issuing them is what runs them. */
function DeferredApprovalCard({ decision, count, state }: {
  decision: string; count: number; state: CardState;
}) {
  const approved = decision === "approved";
  const Icon = approved ? CheckCircleIcon : ProhibitIcon;
  return (
    <div className="flex justify-center animate-fade-in py-1">
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full p-elevated border p-border text-[11px] p-text-2">
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

/** The workspace opening itself. The owner gave a MISSION in the New workspace
 *  dialog, not a message — so the first thing in the transcript is the agent
 *  being handed its own workspace, not the owner speaking. */
function WorkspaceCreatedCard({ state }: { state: CardState }) {
  return (
    <div className="flex justify-center animate-fade-in py-1">
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full p-elevated border p-border text-[11px] p-text-2">
        <SparkleIcon size={13} className="p-accent" weight="fill" />
        <span>Workspace created — acting on its mission</span>
        <span className="flex items-center gap-1 p-text-3"><ShownCaption state={state} /></span>
      </div>
    </div>
  );
}

/**
 * Every other turn the harness enqueued: the ones with no card of their own —
 * a fork whose heads were left running, a context-overflow retry, the one-shot
 * completion gate, the take the owner picked being handed back.
 *
 * Collapsed, because the words are the harness talking to the model and the
 * owner needs to know one happened far more often than they need to read it.
 * Never a bubble: this row is exactly the population that used to arrive in the
 * owner's own, four lines above things they had actually typed.
 */
function SystemEventCard({ event, text, state }: {
  event: string; text: string; state: CardState;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex justify-center animate-fade-in py-1" data-system-event={event}>
      <div className="w-full max-w-[85%] rounded-xl border p-border p-elevated px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-1.5 text-left text-[10px] p-text-3"
          aria-expanded={expanded}
        >
          <GearSixIcon size={11} className="shrink-0 p-text-3" weight="fill" />
          <span className="font-medium p-text-2">{event.replace(/_/g, " ")}</span>
          <ShownCaption state={state} />
          <span className="ml-auto shrink-0">
            {expanded ? <CaretDownIcon size={10} /> : <CaretRightIcon size={10} />}
          </span>
        </button>
        <div className={`mt-1 text-[11px] p-text-2 ${expanded ? "whitespace-pre-wrap break-words" : "truncate"}`}>
          {text}
        </div>
      </div>
    </div>
  );
}

/** The severity ladder as surfaces: `nit` is an ordinary quiet card, `concern`
 *  wears the warning notice, `blocker` the danger one. The tints and borders
 *  are the notice tokens the composer already uses, so both themes hold. */
const ADVISOR_TONES = {
  nit: { panel: "border p-border p-elevated", icon: "p-text-3", badge: "p-badge-neutral" },
  concern: { panel: "p-notice-warning", icon: "p-warning", badge: "p-badge-warning" },
  blocker: { panel: "p-notice-danger", icon: "p-danger", badge: "p-badge-danger" },
} satisfies Record<AdvisorSeverity, { panel: string; icon: string; badge: string }>;

/** The advisor's one note on a finished turn. Unlike `SystemEventCard` the
 *  words are FOR the owner, not the model, so the note is never folded behind
 *  a disclosure — severity carries the colour, the note carries the point. */
function AdvisorCard({ severity, text, state }: {
  severity: AdvisorSeverity; text: string; state: CardState;
}) {
  const tone = ADVISOR_TONES[severity];
  return (
    <div className="flex justify-center animate-fade-in py-1" data-advisor-severity={severity}>
      <div className={`w-full max-w-[85%] rounded-xl px-3 py-2 ${tone.panel}`}>
        <div className="flex items-center gap-1.5 text-[10px] p-text-3">
          <EyeIcon size={11} className={`shrink-0 ${tone.icon}`} weight="fill" />
          <span className="font-medium p-text-2">Advisor</span>
          <span className={`px-1.5 text-[10px] ${tone.badge}`}>{ADVISOR_SEVERITY_LABEL[severity]}</span>
          <ShownCaption state={state} />
        </div>
        <div className="mt-1 text-[11px] p-text-2 whitespace-pre-wrap break-words">{text}</div>
      </div>
    </div>
  );
}

/** One programmatic turn as the chat shows it — the durable message a queued
 *  signal became, or the live card of one spliced into a running turn. Same
 *  classifier, same cards, one rendering. */
export function ProgrammaticTurnCard({ turn, text, state }: {
  turn: ProgrammaticTurn; text: string; state: CardState;
}) {
  if (turn.kind === "background_job") {
    return <BackgroundEventCard kind={turn.jobKind} status={turn.status} state={state} />;
  }
  if (turn.kind === "workspace_created") {
    return <WorkspaceCreatedCard state={state} />;
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

/** The label a user message carries when it reached the model mid-turn instead
 *  of starting a turn of its own. Without it a user bubble in the middle of an
 *  assistant's work reads like a rendering bug rather than the steer it is. */
export function SteeredMark({ state }: { state: "queued" | "landed" }) {
  return (
    <span className="mt-1 inline-flex items-center gap-1 text-[10px] p-text-3">
      <ArrowBendUpRightIcon size={10} weight="bold" />
      {state === "queued" ? "queued — lands at the next step" : "steered mid-turn"}
    </span>
  );
}

// Memoized: @ai-sdk's replaceMessage only clones the streaming message, so
// historical messages keep referential identity across stream ticks and skip
// re-rendering (and re-parsing their markdown) entirely.
export const MessageView = memo(function MessageView({
  message, isLast, isStreaming, onFork, onFeedback, feedback, onRestoreFiles, takesChip,
  signalState,
}: {
  message: UIMessage;
  isLast: boolean;
  isStreaming: boolean;
  /** For a message a signal enqueued: where that signal's card is in its
   *  lifecycle. Undefined once the card's live state is gone (a reload, or a
   *  session that started after it landed) — history is by definition shown. */
  signalState?: CardState;
  /** Called with the message id when user clicks "Fork from here". */
  onFork?: (messageId: string) => void;
  /** Restore device files to the shadow-git checkpoint taken before this
   *  turn (user messages only — the turn's checkpoint is keyed on them). */
  onRestoreFiles?: (messageId: string) => void;
  /** Called with the message id + new feedback when user clicks 👍 / 👎.
   *  Pass null to clear. Rejects on RPC failure. */
  onFeedback?: (messageId: string, feedback: 'positive' | 'negative' | null) => Promise<void>;
  /** Server-recorded feedback for this message (hydrated on load). */
  feedback?: 'positive' | 'negative' | null;
  /** Alternate-takes chrome for this message, supplied by the surface that owns
   *  the takes data. A slot rather than an import: TakesChip opens a comparison
   *  that renders a node transcript, which renders MessageView. */
  takesChip?: ReactNode;
}) {
  const isUser = message.role === "user";
  const isLive = isLast && isStreaming && !isUser;
  // Fork button disabled on the mid-stream last assistant — that message
  // isn't durably persisted yet.
  const canFork = !isLive && !!onFork && !!message.id;

  // Turns the backend enqueued on the agent's behalf are stored as `user`
  // messages so the model reads them as its input — but the operator did not
  // type them, so they get their own presentation instead of a user bubble.
  // The id goes in too: it is the provenance marker on rows written before the
  // author stamp existed, and the owner's oldest workspaces are full of them.
  const programmatic = classifyProgrammaticTurn(message.metadata, message.id);
  if (programmatic) {
    return (
      <ProgrammaticTurnCard
        turn={programmatic} text={getMessageText(message)} state={signalState ?? "shown"} />
    );
  }

  if (isUser) {
    const fileParts = message.parts.filter((p): p is FileUIPart => p.type === "file");
    return (
      <div className="flex flex-col items-end animate-fade-in group">
        <div className="relative max-w-[75%] px-4 py-2.5 rounded-xl rounded-br-md p-user-bubble p-body whitespace-pre-wrap">
          {fileParts.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {fileParts.map((p, i) => <FilePartView key={i} part={p} />)}
            </div>
          )}
          {getMessageText(message)}
          {canFork && (
            <button
              onClick={() => onFork!(message.id)}
              className="absolute -left-9 top-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity flex items-center gap-1 text-[11px] p-text-3 hover:p-text px-1.5 py-0.5 rounded-sm"
              title="Fork from here"
            >
              <GitBranchIcon size={12} />
            </button>
          )}
          {!isLive && onRestoreFiles && message.id && (
            <button
              onClick={() => onRestoreFiles(message.id)}
              className="absolute -left-9 top-8 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity flex items-center gap-1 text-[11px] p-text-3 hover:p-text px-1.5 py-0.5 rounded-sm"
              title="Restore files to before this turn"
            >
              <ClockCounterClockwiseIcon size={12} />
            </button>
          )}
        </div>
        {isSteeredMessage(message.metadata) && <SteeredMark state="landed" />}
        <MessageTimestamp createdAt={messageCreatedAt(message)} />
      </div>
    );
  }

  // The one live affordance, and where it goes — read from the stream's own
  // part states rather than inferred from part order. See message-live-tail.ts.
  const tail = isLive ? liveTail(message.parts) : null;

  return (
    <div className="group relative max-w-[85%] space-y-1 animate-fade-in">
      {canFork && (
        <button
          onClick={() => onFork!(message.id)}
          className="absolute -right-9 top-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity flex items-center gap-1 text-[11px] p-text-3 hover:p-text px-1.5 py-0.5 rounded-sm"
          title="Fork from here"
        >
          <GitBranchIcon size={12} />
        </button>
      )}
      {groupMessageParts(message.parts).map((block, i) => {
        if (block.kind === "tool-run") {
          const first = block.parts[0];
          return first ? <ToolCallGroup key={first.toolCallId} parts={block.parts} /> : null;
        }
        const part = block.part;
        const isTailPart = (tail?.kind === "text" || tail?.kind === "reasoning") && tail.part === part;
        if (part.type === "reasoning") {
          const t = part.text;
          return t ? <ReasoningBlock key={i} text={t} live={isTailPart} /> : null;
        }
        if (part.type === "file") {
          return <div key={i} className="my-1.5"><FilePartView part={part} /></div>;
        }
        if (part.type === "text") {
          const t = part.text;
          if (!t) return null;
          // `p-streaming` draws the caret inside the last block the markdown
          // emitted. As a sibling element it landed on a line of its own below
          // the paragraph, which is the misplacement that was reported.
          return (
            <div key={i} className={`prose-chat p-text${isTailPart ? " p-streaming" : ""}`}>
              <MarkdownContent content={t} />
            </div>
          );
        }
        if (isToolUIPart(part)) return <ToolCallPart key={part.toolCallId} part={part} />;
        return null;
      })}
      {tail?.kind === "thinking" && <ThinkingRow />}
      {!isLive && (
        <div className="flex items-center gap-2">
          <MessageTimestamp createdAt={messageCreatedAt(message)} />
          {!isUser && takesChip}
          {!isUser && message.id && onFeedback && (
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
    const apply = current === next ? null : next; // click again to clear
    try {
      await onFeedback(messageId, apply);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [busy, current, messageId, onFeedback]);

  return (
    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
      <button
        type="button"
        onClick={() => toggle('positive')}
        disabled={busy}
        className={`text-[11px] p-1 rounded-sm p-card-hover transition-colors ${
          current === 'positive' ? 'p-text' : 'p-text-3'
        }`}
        title="Mark this response as helpful (feeds evolution scoring)"
      >👍</button>
      <button
        type="button"
        onClick={() => toggle('negative')}
        disabled={busy}
        className={`text-[11px] p-1 rounded-sm p-card-hover transition-colors ${
          current === 'negative' ? 'p-text' : 'p-text-3'
        }`}
        title="Mark this response as poor (feeds evolution scoring)"
      >👎</button>
      {failed && <span className="text-[10px] p-danger">couldn't save, try again</span>}
    </div>
  );
}
