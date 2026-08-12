import { memo, useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, type DragEvent as ReactDragEvent, type FormEvent } from "react";
import { useParams, useLocation, Link, useNavigate } from "react-router-dom";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { Button, Badge, InputArea, Loader } from "@cloudflare/kumo";
import { btnSmCls } from "@/components/ui/form";
import {
  PaperPlaneRightIcon, StopIcon, WrenchIcon, CaretDownIcon, CaretRightIcon,
  ArrowsClockwiseIcon, BrainIcon, GitBranchIcon, CheckCircleIcon, TrashIcon,
  GearIcon, GearSixIcon, TimerIcon, ClockIcon,
  WarningCircleIcon, ProhibitIcon, DesktopTowerIcon, PaperclipIcon, XIcon, FileIcon,
  ClockCounterClockwiseIcon, PencilSimpleIcon, CheckIcon, UserPlusIcon, LightningIcon,
  StackIcon,
} from "@phosphor-icons/react";
import { isToolUIPart, getToolName, convertFileListToFileUIParts } from "ai";
import type { UIMessage, FileUIPart } from "ai";
import { CLOUD_MAX_INLINE_ATTACHMENT_BYTES, summarizeRestorePlan } from "@proteus/core";
import type { AlternateTakeSet, FileCheckpointEntry, FileRestoreChange, FileRestorePlan, TakePickOutcome } from "@proteus/core";
import { useProteus } from "@/hooks/use-proteus";
import { usePinToBottom } from "@/hooks/use-pin-to-bottom";
import { touchWorkspace } from "@/lib/user-api";
import { ConnectedModelPicker } from "@/components/ModelPicker";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ConnectionIndicator } from "@/components/connection-indicator";
import { PreviewFrame } from "@/components/PreviewFrame";
import { Modal } from "@/components/ui/Modal";
import { MarkdownContent, CodeBlock } from "@/components/surfaces/shared";
import { extractPreviewUrl } from "@/lib/preview-origin";
import { TakesChip, BranchRunChip } from "@/components/AlternateTakes";
import { hasComparableTakes } from "@/components/alternate-takes-logic";
import { describeToolCall, isToolCallFailed, summarizeToolCall, summarizeToolRun } from "@/components/tool-call-summary";
import { groupMessageParts, type AnyToolPart } from "@/components/tool-call-grouping";
import {
  classifyProgrammaticTurn, eventVariantLabel, messageSignalId, parseDrainedEvents,
  type DrainedEvent, type ProgrammaticTurn, type SignalCard,
} from "@/components/background-event";
import { WorkSurface, type SurfaceKind } from "@/components/surfaces/WorkSurface";
import { SupervisePage } from "./SupervisePage";
import { SubordinateTabs } from "@/components/SubordinateTabs";
import type { PendingConsent, SubordinateActivityEvent } from "@/lib/protocol";
// The model picker reads /api/user/models (which unions the connected
// providers' menus); the result is cached for the SPA session (see user-api).

/* ── Message rendering ────────────────────────────────────────── */

function getMessageText(msg: UIMessage): string {
  return msg.parts.filter(p => p.type === "text").map(p => (p as { type: "text"; text: string }).text).join("");
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** The workspace's load/action failure, with the retry it needs. The hook keeps
 *  the message until a load succeeds, so this is the only way back. */
function WorkspaceErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mb-2 flex items-center gap-2 text-xs p-danger p-card rounded-lg px-3 py-1.5">
      <span className="min-w-0 flex-1 truncate" title={message}>{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 inline-flex items-center gap-1 rounded-md border p-border px-2 py-0.5 p-text-2 hover:p-text cursor-pointer"
      >
        <ArrowsClockwiseIcon size={11} /> Retry
      </button>
    </div>
  );
}

function InlineWorkspaceTitle({ title, onRename }: {
  title: string;
  onRename: (displayName: string) => Promise<string>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (!editing) setValue(title); }, [editing, title]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const displayName = value.trim();
    if (!displayName || saving) return;
    setSaving(true);
    setError(null);
    try {
      setValue(await onRename(displayName));
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rename failed");
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <form onSubmit={save} className="flex min-w-0 items-center gap-1">
        <input
          autoFocus
          value={value}
          maxLength={60}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape" && !saving) { setEditing(false); setError(null); } }}
          className="w-44 rounded-md border p-border p-elevated px-2 py-1 text-sm p-text focus:outline-none focus:border-[var(--c-accent)] focus:ring-1 focus:ring-[var(--c-accent-subtle)]"
          aria-label="Workspace display name"
        />
        <button
          type="submit"
          disabled={!value.trim() || saving}
          className="rounded p-1 p-text-3 hover:p-text hover:p-card-hover disabled:opacity-40"
          aria-label="Save workspace name"
        ><CheckIcon size={13} /></button>
        <button
          type="button"
          onClick={() => { setEditing(false); setError(null); }}
          disabled={saving}
          className="rounded p-1 p-text-3 hover:p-text hover:p-card-hover"
          aria-label="Cancel rename"
        ><XIcon size={13} /></button>
        {error && <span role="alert" className="text-[10px] p-danger" title={error}>Rename failed</span>}
      </form>
    );
  }

  return (
    <div className="group/title flex min-w-0 items-center gap-1">
      <span className="font-medium text-sm p-text truncate max-w-[180px]" title={title}>{title}</span>
      <button
        onClick={() => setEditing(true)}
        className="shrink-0 rounded p-1 opacity-0 group-hover/title:opacity-60 focus-visible:opacity-100 hover:!opacity-100 p-text-3 hover:p-text transition-all"
        title="Rename"
        aria-label={`Rename workspace ${title}`}
      ><PencilSimpleIcon size={12} /></button>
    </div>
  );
}

/* ── Chat attachments ─────────────────────────────────────────── */

/** Raw bytes a data-URL file part encodes (base64 ≈ 4/3 × raw). */
function dataUrlRawBytes(url: string): number {
  return Math.floor(((url.length - url.indexOf(",") - 1) * 3) / 4);
}

/** A file attachment chip — thumbnail for images, file icon otherwise.
 *  With onRemove it's a pending-composer chip; without, a message chip. */
function AttachmentChip({ part, onRemove }: { part: FileUIPart; onRemove?: () => void }) {
  const name = part.filename ?? "file";
  return (
    <span className="inline-flex items-center gap-1.5 max-w-56 rounded-md border p-border p-fill pl-1.5 pr-1.5 py-1 text-[11px] p-text-2">
      {part.mediaType.startsWith("image/")
        ? <img src={part.url} alt={name} className="size-5 rounded object-cover shrink-0" />
        : <FileIcon size={13} className="p-text-3 shrink-0" />}
      <span className="truncate font-mono">{name}</span>
      {onRemove && (
        <button onClick={onRemove} className="p-0.5 rounded hover:p-card-hover p-text-3 hover:p-text cursor-pointer" aria-label={`Remove ${name}`}>
          <XIcon size={11} />
        </button>
      )}
    </span>
  );
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

function ReasoningBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="my-1.5">
      <button onClick={() => setExpanded(!expanded)} className="group/reason flex items-center gap-2 p-row-text p-text-3 hover:p-text-2 w-full text-left transition-colors cursor-pointer">
        <BrainIcon size={14} className="shrink-0" />
        <span className="font-medium">{expanded ? "Thoughts" : "Thinking"}</span>
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
function parseProvisionError(output: unknown):
  { runtime: string; message: string } | null {
  if (typeof output !== 'string') return null;
  if (!output.includes('runtime_not_provisioned')) return null;
  try {
    const obj = JSON.parse(output) as { error?: string; runtime?: string; message?: string };
    if (obj.error === 'runtime_not_provisioned' && typeof obj.runtime === 'string') {
      return { runtime: obj.runtime, message: obj.message ?? 'Runtime not available.' };
    }
  } catch { /* fall through */ }
  return null;
}

function ToolCallBlock({ toolName, input, output, isRunning, isError, errorText }: {
  toolName: string; input?: Record<string, unknown>; output?: unknown; isRunning: boolean; isError: boolean;
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
  // at a glance whether the agent ran something in workspace / nimbus /
  // sandbox / laptop. Default = workspace.
  const runtime = toolName === 'run'
    ? (typeof input?.runtime === 'string' ? input.runtime : 'workspace')
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
              The agent asked for the <code className="font-mono p-fill px-1 rounded">{provisionErr.runtime}</code> runtime
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
          {toolName === "execute_tools" && typeof input?.code === "string" ? (
            <CodeBlock className="language-js">{input.code}</CodeBlock>
          ) : toolName === "run" && typeof input?.command === "string" ? (
            <CodeBlock className="language-bash">{input.command}</CodeBlock>
          ) : input != null ? (
            <div>
              <div className="p-eyebrow mb-1">Input</div>
              <pre className="text-[12px] font-mono p-text-2 max-h-40 overflow-auto whitespace-pre-wrap m-0">{JSON.stringify(input, null, 2)}</pre>
            </div>
          ) : null}
          {output != null && (
            <div>
              <div className="p-eyebrow mb-1">Output</div>
              <pre className="text-[12px] font-mono p-text-2 max-h-40 overflow-auto whitespace-pre-wrap m-0">{typeof output === "string" ? output : JSON.stringify(output, null, 2)}</pre>
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
function partOutput(part: AnyToolPart): unknown {
  return part.state === "output-available" ? (part as { output?: unknown }).output : undefined;
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
  const previewUrl = extractPreviewUrl(output);
  return (
    <div>
      <ToolCallBlock toolName={getToolName(part)}
        input={part.input as Record<string, unknown> | undefined}
        output={output}
        isRunning={part.state === "input-available" || part.state === "input-streaming"}
        isError={partFailed(part)}
        errorText={part.state === "output-error" ? (part as { errorText?: string }).errorText : undefined} />
      {/* Inline preview card — when a tool returns a /_preview/ URL, surface a
          live iframe under the tool block so the user sees the running app
          inline (also promoted to the Output surface). */}
      {previewUrl && (
        <div className="mt-2 h-64 rounded-md border p-border overflow-hidden">
          <PreviewFrame url={previewUrl} />
        </div>
      )}
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
          <code className="block mt-1 text-[11px] p-text-2 font-mono break-all p-fill rounded px-2 py-1">{consent.command || "(command)"}</code>
          <div className="mt-1 text-[10px] p-text-3">
            Always allow grants this agent all future local actions on this device until revoked.
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2.5 justify-end">
        <button onClick={() => onResolve(consent.consentId, "deny")}
          className="px-2.5 py-1 text-[11px] rounded-md p-text-3 hover:p-text">Deny</button>
        <button onClick={() => onResolve(consent.consentId, "once")}
          className="px-2.5 py-1 text-[11px] rounded-md p-card hover:p-card-hover p-text-2">Allow once</button>
        <button onClick={() => onResolve(consent.consentId, "always")}
          className="px-2.5 py-1 text-[11px] rounded-md font-medium p-accent-bg p-accent hover:opacity-90">Always allow local</button>
      </div>
    </div>
  );
}

/** Terminal chat error — the turn failed (provider error, stream break) and
 *  produced no visible answer. Shows the honest error body with a retry
 *  affordance; the hook clears it on the next send. */
export function ChatErrorCard({ message, streaming, onRetry, onDismiss }: {
  message: string;
  streaming: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="rounded-xl border p-3 animate-fade-in p-elevated" style={{ borderColor: "var(--c-danger)" }}>
      <div className="flex items-start gap-2">
        <WarningCircleIcon size={16} className="p-danger shrink-0 mt-0.5" weight="fill" />
        <div className="min-w-0 flex-1">
          <div className="text-xs p-text font-medium">The last turn failed</div>
          <code className="block mt-1 text-[11px] p-text-2 font-mono break-all p-card rounded px-2 py-1 max-h-28 overflow-y-auto">{message}</code>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2.5 justify-end">
        <button onClick={onDismiss}
          className="px-2.5 py-1 text-[11px] rounded-md p-text-3 hover:p-text cursor-pointer">Dismiss</button>
        <button onClick={onRetry} disabled={streaming}
          className="px-2.5 py-1 text-[11px] rounded-md font-medium p-accent-bg p-accent hover:opacity-90 disabled:opacity-40 cursor-pointer flex items-center gap-1">
          <ArrowsClockwiseIcon size={11} />Retry last message
        </button>
      </div>
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
      className="w-full text-left rounded-lg p-card hover:p-card-hover transition-colors px-2 py-1.5"
    >
      <div className="flex items-center gap-1.5 text-[10px]">
        <span className="shrink-0 font-medium p-text-2">{eventVariantLabel(event.variant)}</span>
        <span className="min-w-0 truncate p-text-3">{event.source}</span>
        {event.replyExpected && (
          <span className="shrink-0 rounded px-1 py-0.5 p-badge-warning" title="The sender is waiting on the agent's reply">
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

/** One programmatic turn as the chat shows it — the durable message a queued
 *  signal became, or the live card of one spliced into a running turn. Same
 *  classifier, same cards, one rendering. */
function ProgrammaticTurnCard({ turn, text, state }: {
  turn: ProgrammaticTurn; text: string; state: CardState;
}) {
  return turn.kind === "background_job"
    ? <BackgroundEventCard kind={turn.jobKind} status={turn.status} state={state} />
    : <DrainedEventsCard text={text} state={state} />;
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
        className="inline-flex max-w-[80%] items-center gap-2 rounded-full border p-border p-elevated px-3 py-1.5 text-[11px] p-text-2 hover:p-card-hover transition-colors"
      >
        <Icon size={13} className={`${tone} shrink-0`} weight="fill" />
        <span className="truncate"><span className="font-medium p-text">{event.subordinate}</span> {verb}: {detail}</span>
      </Link>
    </div>
  );
}

// Memoized: @ai-sdk's replaceMessage only clones the streaming message, so
// historical messages keep referential identity across stream ticks and skip
// re-rendering (and re-parsing their markdown) entirely.
export const MessageView = memo(function MessageView({
  message, isLast, isStreaming, onFork, onFeedback, feedback, onRestoreFiles, takes, onPickTake,
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
  /** Near-tied takes the turn's think convergence weighed for this answer. */
  takes?: AlternateTakeSet;
  /** Records a take pick (the explicit preference signal). */
  onPickTake?: (takeId: string, nodeId: string) => Promise<TakePickOutcome>;
}) {
  const isUser = message.role === "user";
  const isLive = isLast && isStreaming && !isUser;
  // Fork button disabled on the mid-stream last assistant — that message
  // isn't durably persisted yet.
  const canFork = !isLive && !!onFork && !!message.id;

  // Turns the backend enqueued on the agent's behalf are stored as `user`
  // messages so the model reads them as its input — but the operator did not
  // type them, so they get their own presentation instead of a user bubble.
  const programmatic = classifyProgrammaticTurn((message as { metadata?: unknown }).metadata);
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
        <div className="relative max-w-[75%] px-4 py-2.5 rounded-[14px] rounded-br-md p-user-bubble p-body whitespace-pre-wrap">
          {fileParts.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {fileParts.map((p, i) => <FilePartView key={i} part={p} />)}
            </div>
          )}
          {getMessageText(message)}
          {canFork && (
            <button
              onClick={() => onFork!(message.id)}
              className="absolute -left-9 top-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity flex items-center gap-1 text-[11px] p-text-3 hover:p-text px-1.5 py-0.5 rounded"
              title="Fork from here"
            >
              <GitBranchIcon size={12} />
            </button>
          )}
          {!isLive && onRestoreFiles && message.id && (
            <button
              onClick={() => onRestoreFiles(message.id)}
              className="absolute -left-9 top-8 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity flex items-center gap-1 text-[11px] p-text-3 hover:p-text px-1.5 py-0.5 rounded"
              title="Restore files to before this turn"
            >
              <ClockCounterClockwiseIcon size={12} />
            </button>
          )}
        </div>
        <MessageTimestamp createdAt={(message as { createdAt?: string }).createdAt} />
      </div>
    );
  }

  const hasContent = message.parts.some(p =>
    (p.type === "text" && (p as { text: string }).text) ||
    (p.type === "reasoning" && (p as { text?: string }).text) ||
    p.type === "file" ||
    isToolUIPart(p)
  );

  if (isLive && !hasContent) {
    return (
      <div className="flex items-center gap-2 animate-fade-in py-2">
        <span className="size-1.5 rounded-full p-dot-accent animate-pulse" />
        <span className="p-row-text p-shimmer font-medium">Thinking</span>
      </div>
    );
  }

  return (
    <div className="group relative max-w-[85%] space-y-1 animate-fade-in">
      {canFork && (
        <button
          onClick={() => onFork!(message.id)}
          className="absolute -right-9 top-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity flex items-center gap-1 text-[11px] p-text-3 hover:p-text px-1.5 py-0.5 rounded"
          title="Fork from here"
        >
          <GitBranchIcon size={12} />
        </button>
      )}
      {groupMessageParts(message.parts).map((block, i) => {
        if (block.kind === "tool-run") {
          return <ToolCallGroup key={block.parts[0]!.toolCallId} parts={block.parts} />;
        }
        const part = block.part;
        if (part.type === "reasoning") {
          const t = (part as { text?: string }).text;
          return t ? <ReasoningBlock key={i} text={t} /> : null;
        }
        if (part.type === "file") {
          return <div key={i} className="my-1.5"><FilePartView part={part} /></div>;
        }
        if (part.type === "text") {
          const t = (part as { text: string }).text;
          if (!t) return null;
          const isLastText = message.parts.slice(message.parts.indexOf(part) + 1).every(p => p.type !== "text");
          return (
            <div key={i} className="prose-chat p-text">
              <MarkdownContent content={t} />
              {isLive && isLastText && <span className="inline-block w-0.5 h-[1em] ml-0.5 align-text-bottom animate-blink-cursor" style={{ background: "var(--c-accent)" }} />}
            </div>
          );
        }
        if (isToolUIPart(part)) return <ToolCallPart key={part.toolCallId} part={part} />;
        return null;
      })}
      {!isLive && (
        <div className="flex items-center gap-2">
          <MessageTimestamp createdAt={(message as { createdAt?: string }).createdAt} />
          {!isUser && hasComparableTakes(takes) && onPickTake && (
            <TakesChip set={takes} onPick={onPickTake} />
          )}
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
        className={`text-[11px] p-1 rounded hover:p-card-hover transition-colors ${
          current === 'positive' ? 'p-text' : 'p-text-3'
        }`}
        title="Mark this response as helpful (feeds evolution scoring)"
      >👍</button>
      <button
        type="button"
        onClick={() => toggle('negative')}
        disabled={busy}
        className={`text-[11px] p-1 rounded hover:p-card-hover transition-colors ${
          current === 'negative' ? 'p-text' : 'p-text-3'
        }`}
        title="Mark this response as poor (feeds evolution scoring)"
      >👎</button>
      {failed && <span className="text-[10px] p-danger">couldn't save — try again</span>}
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
      setErr(e instanceof Error ? e.message : String(e));
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
        <p>Create a new workspace that branches off of <span className="font-mono p-text">{sourceName}</span> at this message.</p>
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
          className="w-full px-3 py-1.5 rounded-md border p-border p-card text-sm font-mono focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]"
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
  const state = useProteus({ workspace, subordinate: subName });

  // The picker is fire-and-forget; setModel rejects when the write didn't land
  // and the hook has already surfaced that through state.error.
  const setModel = state.setModel;
  const onPickModel = useCallback((spec: string) => { void setModel(spec).catch(() => {}); }, [setModel]);
  const [input, setInput] = useState("");
  const messagesRef = usePinToBottom<HTMLDivElement>(state.messages);
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
        <ConnectedModelPicker value={as?.model ?? ""} onChange={onPickModel} size="xs" className="shrink-0 w-28 @[30rem]:w-36 @[42rem]:w-44" />
      </div>

      <ErrorBoundary label="Subordinate chat">
        <div ref={messagesRef} className="flex-1 overflow-y-auto px-6 py-5 space-y-5 lg:px-8">
          {state.messages.length === 0 && !state.isStreaming && (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <BrainIcon size={36} className="p-text-3 mb-3" />
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
          {state.chatError && (
            <ChatErrorCard
              message={state.chatError}
              streaming={state.isStreaming}
              onRetry={state.retryLastMessage}
              onDismiss={state.clearChatError}
            />
          )}
        </div>
      </ErrorBoundary>

      <div className="px-5 py-3 border-t p-border lg:px-7">
        {state.error && <WorkspaceErrorBanner message={state.error} onRetry={state.retryLoad} />}
        <div className="flex items-end gap-2.5 p-composer p-2.5">
          <InputArea ref={inputRef} value={input} onValueChange={setInput}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder={`Message ${as?.displayName || subName}…`} disabled={state.connectionStatus !== "connected"} rows={1}
            className="flex-1 resize-none max-h-40 overflow-y-auto !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none" />
          {state.isStreaming
            ? <Button variant="secondary" shape="square" onClick={state.abortChat} icon={<StopIcon size={16} weight="fill" />} aria-label="Stop" className="mb-0.5" />
            : <button onClick={send} disabled={!input.trim() || state.connectionStatus !== "connected"} className="p-btn rounded-lg p-2 mb-0.5 cursor-pointer" aria-label="Send"><PaperPlaneRightIcon size={16} /></button>}
        </div>
      </div>
    </div>
  );
}

/* ── Main page ────────────────────────────────────────────────── */

export default function WorkspacePage() {
  const { agentId, subName } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const state = useProteus(agentId);

  // The picker is fire-and-forget; setModel rejects when the write didn't land
  // and the hook has already surfaced that through state.error.
  const setModel = state.setModel;
  const onPickModel = useCallback((spec: string) => { void setModel(spec).catch(() => {}); }, [setModel]);
  // ?altitude=supervise deep-links straight to the Supervise altitude (the
  // /triggers/:id redirect and settings' Automations link use it).
  const [altitude, setAltitude] = useState<"run" | "supervise">(
    () => new URLSearchParams(location.search).get("altitude") === "supervise" ? "supervise" : "run",
  );
  const [surface, setSurface] = useState<SurfaceKind>("Self");
  const [chatInput, setChatInput] = useState("");
  const [forkFor, setForkFor] = useState<string | null>(null); // message id to fork at, or null
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const messagesRef = usePinToBottom<HTMLDivElement>(state.messages);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const initialPromptSent = useRef(false);
  // Pending chat attachments — fed by the attach button, paste, and drag-drop
  // onto the chat column; rendered as removable chips above the input.
  const [pendingAttachments, setPendingAttachments] = useState<FileUIPart[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      ? `Chat attachments are capped at ${CLOUD_MAX_INLINE_ATTACHMENT_BYTES / (1024 * 1024)} MB per message — ${rejected.join(", ")} did not fit. Upload larger files via the Files pane on the Environment tab.`
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

  useEffect(() => { if (agentId) touchWorkspace(agentId).catch(() => {}); }, [agentId]);

  // Bridge the open workspace's live status to the sidebar roster (running dot +
  // unseen-evolution dot). Only the mounted workspace has a live socket, so the
  // roster reflects status for workspaces visited this session.
  useEffect(() => {
    if (!agentId) return;
    const running = state.isStreaming || state.runningJobCount > 0;
    window.dispatchEvent(new CustomEvent("proteus:workspace-activity", {
      detail: { name: agentId, running, unseenChangelog: state.changelogUnseen },
    }));
  }, [agentId, state.isStreaming, state.runningJobCount, state.changelogUnseen]);

  // Auto-switch the work surface to the live Preview the moment a new sandbox
  // port is exposed — the running app becomes the centre of attention.
  // (Port discovery itself lives in useProteus' live-data poll, so this fires
  // from any surface.)
  const prevPortCountRef = useRef(0);
  useEffect(() => {
    const n = state.pinnedPorts.length;
    if (n > prevPortCountRef.current) setSurface("Output");
    prevPortCountRef.current = n;
  }, [state.pinnedPorts.length]);

  // Send the creation mission as the opening message — once, deterministically,
  // the moment the socket is connected. The mission rides in via navigation
  // state from CreateWorkspaceModal; we clear it (replace) right after sending so a
  // refresh or back-nav never re-fires it.
  useEffect(() => {
    if (initialPromptSent.current) return;
    const ns = location.state as { initialPrompt?: string } | null;
    if (!ns?.initialPrompt || state.connectionStatus !== "connected") return;
    initialPromptSent.current = true;
    // No setDisplayName here: a user-origin name would suppress the agent's own
    // AI auto-titling. The agent titles itself from this opening message.
    state.sendChat(ns.initialPrompt);
    navigate(location.pathname, { replace: true, state: null });
  }, [state.connectionStatus, location.state, location.pathname, navigate]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = useCallback(() => {
    const t = chatInput.trim();
    if ((!t && pendingAttachments.length === 0) || state.isStreaming) return;
    state.sendChat(t, pendingAttachments);
    setChatInput("");
    setPendingAttachments([]);
    setAttachError(null);
  }, [chatInput, pendingAttachments, state]);

  // Steer-as-Branch: while the agent streams, the composer's split affordance
  // runs the draft as a parallel head (branchTurn) — the live turn continues;
  // progress arrives as branch_status broadcasts (state.branchRuns).
  const [branchNotice, setBranchNotice] = useState<string | null>(null);
  const handleBranch = useCallback(() => {
    const t = chatInput.trim();
    if (!t || !state.isStreaming) return;
    setBranchNotice(null);
    // The composer is cleared only once the branch was actually accepted — a
    // refused or failed branch used to destroy what the user had typed. The
    // identity check leaves anything typed while the RPC was in flight alone.
    state.rpc<{ accepted: boolean; reason?: string }>("branchTurn", [t])
      .then((r) => {
        if (r.accepted) setChatInput((current) => current.trim() === t ? "" : current);
        else setBranchNotice(r.reason ?? "Branching is unavailable right now.");
      })
      .catch((err) => setBranchNotice(err instanceof Error ? err.message : String(err)));
  }, [chatInput, state]);

  // Identity-stable handlers so memo(MessageView) holds across stream ticks.
  const onForkMessage = useCallback((mid: string) => setForkFor(mid), []);

  // Thumbs feedback — hydrated from the server (it remembers across reloads)
  // and only committed locally when the RPC succeeds; failures propagate to
  // MessageFeedback so the toggle never lies about evolution-scoring input.
  const [feedbackByMessage, setFeedbackByMessage] = useState<Record<string, 'positive' | 'negative'>>({});
  useEffect(() => {
    if (state.connectionStatus !== "connected") return;
    state.rpc<Record<string, 'positive' | 'negative'>>('listTurnFeedback')
      .then(setFeedbackByMessage)
      .catch(() => {});
  }, [state.connectionStatus, state.rpc]);

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
    const id = messageSignalId((msg as { metadata?: unknown }).metadata);
    return id ? [id] : [];
  })), [state.messages]);
  const looseCards = useMemo(() => state.signalCards.flatMap((card) => {
    if (messageCardIds.has(card.id)) return [];
    const turn = classifyProgrammaticTurn(card.metadata);
    return turn ? [{ card, turn }] : [];
  }), [state.signalCards, messageCardIds]);
  const cardStateOf = (metadata: unknown) => {
    const id = messageSignalId(metadata);
    return id ? cardStates.get(id) : undefined;
  };

  const settledBranchCount = state.branchRuns.filter((b) => b.status === "settled").length;
  useEffect(() => {
    if (state.connectionStatus !== "connected" || state.isStreaming) return;
    state.rpc<Record<string, AlternateTakeSet>>('listAlternateTakes')
      .then(setTakesByTurn)
      .catch(() => {});
    // settledBranchCount: a branch settling after the turn ended persists a
    // fresh set — refetch so its chip can hydrate the comparison.
  }, [state.connectionStatus, state.isStreaming, state.rpc, settledBranchCount]);

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
      const entries = await state.rpc<FileCheckpointEntry[]>('listFileCheckpoints', [200]);
      const matches = entries.filter((e) => e.turnId === mid);
      if (matches.length === 0) {
        setRestoreNotice('No file checkpoint for this turn — it changed no device files.');
        return;
      }
      const plans: FileRestorePlan[] = [];
      for (const entry of matches) {
        plans.push(await state.rpc<FileRestorePlan>('planFileRestore', [entry.dir, entry.id]));
      }
      const files = plans.flatMap((p) => p.files);
      if (files.length === 0) {
        setRestoreNotice('Files already match the state before this turn — nothing to restore.');
        return;
      }
      setRestorePlan({ entries: matches, dirs: plans.map((p) => p.dir), files });
    } catch (err) {
      setRestoreNotice(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
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
      setRestoreNotice(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
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

      {/* Altitude toggle: RUN (this run, mission-control) ⇄ SUPERVISE (the
          agent over time — curriculum, runs, automations). */}
      <div className="flex items-center px-4 py-1.5 border-b p-border shrink-0">
        <span className="text-xs p-text-2 font-medium truncate">{workspaceTitle}</span>
        <div className="ml-auto flex items-center gap-0.5 p-recessed rounded-md p-0.5">
          {(["run", "supervise"] as const).map((a) => (
            <button key={a} onClick={() => setAltitude(a)}
              className={`px-2.5 py-1 text-[11px] rounded capitalize transition-colors ${altitude === a ? "p-fill p-text font-medium" : "p-text-3 hover:p-text-2"}`}>
              {a}
            </button>
          ))}
        </div>
      </div>

      {altitude === "supervise" ? (
        <div className="flex-1 min-h-0">
          <ErrorBoundary label="Supervise">
            <SupervisePage rpc={state.rpc} onRunTask={(t) => { setAltitude("run"); state.sendChat(t); }} onOpenJobs={() => { setAltitude("run"); setSurface("Jobs"); }} />
          </ErrorBoundary>
        </div>
      ) : (
      <PanelGroup className="flex-1">
        {/* ── Column A — Chat / Steer ─────────────────────────── */}
        <Panel minSize={24} defaultSize={42}>
          <div className="flex flex-col h-full border-r p-border">
            {/* Agent tabs — the workspace's orchestrator + durable subordinates.
                Roster + live status ride the parent socket; the CHAT below
                switches per tab while Columns B/C stay workspace-scoped. */}
            <SubordinateTabs
              workspace={agentId}
              subordinates={state.subordinates}
              activeName={subName}
              onSpawn={state.spawnSubordinate}
              onDismiss={(name) => state.dismissSubordinate(name).then(() => {})}
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
            {/* Header. Below ~26rem the row cannot hold a title, a model picker
                and two buttons at once — the title is what loses, and a
                workspace called "Checkout co…" is the one thing on this bar
                that has to survive. So the title takes a full row of its own
                at phone widths and the controls drop beneath it, rather than
                every element being squeezed until the name is unreadable. */}
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-5 py-3 @[26rem]:py-3.5 border-b p-border">
              <div className="flex min-w-0 basis-full @[26rem]:basis-0 @[26rem]:flex-1 items-center gap-3">
                <ConnectionIndicator status={state.connectionStatus} />
                <InlineWorkspaceTitle title={workspaceTitle} onRename={state.setDisplayName} />
                {state.isStreaming && (
                  <span className="shrink-0 inline-flex items-center gap-1.5 px-1.5 @[34rem]:px-2 py-0.5 rounded-full p-accent-subtle" title="The agent is working">
                    <span className="size-1.5 rounded-full p-dot-accent animate-pulse" />
                    <span className="hidden @[34rem]:inline p-meta p-accent font-medium">working</span>
                  </span>
                )}
                {as?.forkLineage && (
                  <Link
                    to={`/workspace/${as.forkLineage.sourceWorkspaceName}`}
                    className="shrink-0 flex items-center gap-1 text-[10px] p-text-3 hover:p-text transition-colors px-1.5 py-0.5 rounded border p-border"
                    title={`Open parent workspace from ${new Date(as.forkLineage.forkedAt).toLocaleString()}`}
                  >
                    <GitBranchIcon size={10} />
                    <span>Parent workspace</span>
                  </Link>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2 ml-auto">
                <ConnectedModelPicker value={as?.model ?? ""} onChange={onPickModel} size="xs" className="shrink-0 w-32 @[30rem]:w-36 @[42rem]:w-44" />
                {state.messages.length > 0 && (
                  <Button variant="ghost" shape="square" size="sm"
                    onClick={() => setShowClearConfirm(true)}
                    icon={<TrashIcon size={12} />} aria-label="Clear history" />
                )}
                <Link to={`/settings/${agentId}`} className="p-text-2 hover:p-text transition-colors" title="Settings">
                  <GearSixIcon size={14} />
                </Link>
              </div>
            </div>

            {/* Messages — generous padding for spacious feel.
                ErrorBoundary'd so a single malformed message doesn't
                whitescreen the chat. (STABILITY-AUDIT §D2.) */}
            <ErrorBoundary label="Chat">
            <div ref={messagesRef} className="flex-1 overflow-y-auto px-6 py-5 space-y-5 lg:px-8">
              {state.messages.length === 0 && !state.isStreaming && (
                <div className="flex flex-col items-center justify-center h-full">
                  <BrainIcon size={36} className="p-text-3 mb-3" />
                  <p className="text-sm p-text-3">Send a message to start</p>
                </div>
              )}
              {state.messages.map((msg, i) => (
                <MessageView
                  key={msg.id}
                  message={msg}
                  isLast={i === state.messages.length - 1}
                  isStreaming={state.isStreaming}
                  onFork={onForkMessage}
                  onFeedback={onMessageFeedback}
                  feedback={feedbackByMessage[msg.id] ?? null}
                  onRestoreFiles={onRestoreFiles}
                  takes={takesByTurn[msg.id]}
                  onPickTake={onPickTake}
                  signalState={cardStateOf((msg as { metadata?: unknown }).metadata)}
                />
              ))}
              {looseCards.map(({ card, turn }) => (
                <ProgrammaticTurnCard key={card.id} turn={turn} text={card.text} state={card.state} />
              ))}
              {state.branchRuns.map((run) => (
                <BranchRunChip
                  key={run.branchId}
                  run={run}
                  takes={run.turnId ? takesByTurn[run.turnId] : undefined}
                  onPick={onPickTake}
                  onDismiss={() => state.dismissBranchRun(run.branchId)}
                />
              ))}
              {state.subordinateEvents.map((event) => (
                <SubordinateEventCard key={event.id} event={event} workspace={agentId} />
              ))}
              {state.chatError && (
                <ChatErrorCard
                  message={state.chatError}
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

            {/* Input — paste handled on the wrapper so clipboard files attach
                regardless of which composer child holds focus. */}
            <div className="px-5 py-3 border-t p-border lg:px-7"
              onPaste={e => { if (e.clipboardData.files.length > 0) { e.preventDefault(); void addFiles(e.clipboardData.files); } }}>
              {state.error && <WorkspaceErrorBanner message={state.error} onRetry={state.retryLoad} />}
              {attachError && <div className="mb-2 text-xs p-warning p-card rounded-lg px-3 py-1.5">{attachError}</div>}
              {branchNotice && (
                <div className="mb-2 flex items-center justify-between gap-2 text-xs p-warning p-card rounded-lg px-3 py-1.5">
                  <span className="truncate">Branch unavailable: {branchNotice}</span>
                  <button onClick={() => setBranchNotice(null)} className="p-text-3 hover:p-text cursor-pointer shrink-0" aria-label="Dismiss"><XIcon size={11} /></button>
                </div>
              )}
              {planning && (
                <div className="mb-2 flex items-center gap-1.5 text-xs p-text-3 p-card rounded-lg px-3 py-1.5">
                  <Loader size="sm" /><span>Checking what this turn changed on your device…</span>
                </div>
              )}
              {restoreNotice && (
                <div className="mb-2 flex items-center justify-between gap-2 text-xs p-text-2 p-card rounded-lg px-3 py-1.5">
                  <span className="flex items-center gap-1.5 min-w-0"><ClockCounterClockwiseIcon size={12} className="shrink-0" /><span className="truncate">{restoreNotice}</span></span>
                  <button onClick={() => setRestoreNotice(null)} className="p-text-3 hover:p-text cursor-pointer shrink-0" aria-label="Dismiss"><XIcon size={11} /></button>
                </div>
              )}
              {pendingAttachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {pendingAttachments.map((p, i) => (
                    <AttachmentChip key={`${p.filename ?? "file"}-${i}`} part={p}
                      onRemove={() => setPendingAttachments(prev => prev.filter((_, j) => j !== i))} />
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2.5 p-composer p-2.5">
                <input ref={fileInputRef} type="file" multiple className="hidden"
                  onChange={e => { void addFiles(e.currentTarget.files); e.currentTarget.value = ""; }} />
                <button onClick={() => fileInputRef.current?.click()} disabled={state.connectionStatus !== "connected"}
                  className="p-text-3 hover:p-text transition-colors p-1.5 mb-0.5 cursor-pointer" aria-label="Attach files" title="Attach files">
                  <PaperclipIcon size={16} />
                </button>
                <InputArea ref={chatInputRef} value={chatInput} onValueChange={setChatInput}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                  placeholder="Send a message..." disabled={state.connectionStatus !== "connected"} rows={1}
                  className="flex-1 resize-none max-h-40 overflow-y-auto !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none" />
                {state.isStreaming
                  ? <>
                      {chatInput.trim() !== "" && (
                        <button onClick={handleBranch}
                          className="p-text-2 hover:p-text transition-colors p-2 mb-0.5 rounded-lg border p-border cursor-pointer"
                          aria-label="Run as a parallel branch"
                          title="Branch: run this as a parallel take without interrupting the live turn — compare answers when both finish">
                          <GitBranchIcon size={16} />
                        </button>
                      )}
                      <Button variant="secondary" shape="square" onClick={state.abortChat} icon={<StopIcon size={16} weight="fill" />} aria-label="Stop" className="mb-0.5" />
                    </>
                  : <button onClick={handleSend} disabled={(!chatInput.trim() && pendingAttachments.length === 0) || state.connectionStatus !== "connected"} className="p-btn rounded-lg p-2 mb-0.5 cursor-pointer" aria-label="Send"><PaperPlaneRightIcon size={16} /></button>}
              </div>
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
            agentStatus={state.agentStatus}
            tools={state.tools}
            memory={state.memory}
            memoryContent={state.memoryContent}
            onSearchMemory={state.searchMemory}
            mctsTree={state.mctsTree}
            isStreaming={state.isStreaming}
            executors={state.executors}
            executorOutputs={state.executorOutputs}
            lastActiveExecutor={state.lastActiveExecutor}
            onExecute={state.executeInExecutor}
            backgroundJobs={state.backgroundJobs}
            runningJobCount={state.runningJobCount}
            onRefreshJobs={state.refreshBackgroundJobs}
            changelogUnseen={state.changelogUnseen}
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
const RESTORE_MARK: Record<FileRestoreChange["kind"], string> = { modify: "~", create: "+", delete: "-" };

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
          device — {counts}. A safety snapshot is taken first, so restoring again undoes the undo.
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
