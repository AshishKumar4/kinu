import { memo, useState, useRef, useEffect, useLayoutEffect, useCallback, type DragEvent as ReactDragEvent } from "react";
import { useParams, useLocation, Link, useNavigate } from "react-router-dom";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle, usePanelRef } from "react-resizable-panels";
import { Button, Badge, InputArea, Loader } from "@cloudflare/kumo";
import {
  PaperPlaneRightIcon, StopIcon, WrenchIcon, CaretDownIcon, CaretRightIcon,
  ArrowsClockwiseIcon, BrainIcon, GitBranchIcon, CheckCircleIcon, TrashIcon,
  GearIcon, ArrowSquareOutIcon, GearSixIcon, TimerIcon, TreeStructureIcon, ClockIcon,
  WarningCircleIcon, ProhibitIcon, DesktopTowerIcon, PaperclipIcon, XIcon, FileIcon,
  ClockCounterClockwiseIcon,
} from "@phosphor-icons/react";
import { isToolUIPart, getToolName, convertFileListToFileUIParts } from "ai";
import type { UIMessage, FileUIPart } from "ai";
import { MAX_INLINE_ATTACHMENT_BYTES, summarizeRestorePlan } from "@proteus/core";
import type { AlternateTakeSet, FileCheckpointEntry, FileRestorePlan, TakePickOutcome } from "@proteus/core";
import { useProteus } from "@/hooks/use-proteus";
import { usePinToBottom } from "@/hooks/use-pin-to-bottom";
import { cloudflareReconnectPath, touchAgent, listAvailableModels, type ModelMenuEntry } from "@/lib/user-api";
import { ModelPicker } from "@/components/ModelPicker";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ConnectionIndicator } from "@/components/connection-indicator";
import { PreviewFrame } from "@/components/PreviewFrame";
import { Modal } from "@/components/ui/Modal";
import { MarkdownContent, extractPreviewUrl, CodeBlock } from "@/components/surfaces/shared";
import { TakesChip, BranchRunChip } from "@/components/AlternateTakes";
import { hasComparableTakes } from "@/components/alternate-takes-logic";
import { RunTimeline } from "@/components/surfaces/RunTimeline";
import { WorkSurface, type SurfaceKind } from "@/components/surfaces/WorkSurface";
import { SupervisePage } from "./SupervisePage";
import type { TimelineSpan, TimelineKind, PendingConsent } from "@/lib/protocol";
// The model picker reads /api/user/models (which unions the connected
// providers' menus); the result is cached for the SPA session (see user-api).

/* ── Message rendering ────────────────────────────────────────── */

function getMessageText(msg: UIMessage): string {
  return msg.parts.filter(p => p.type === "text").map(p => (p as { type: "text"; text: string }).text).join("");
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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
    <span className="inline-flex items-center gap-1.5 max-w-56 rounded-md border p-border p-elevated pl-1.5 pr-1.5 py-1 text-[11px] p-text-2">
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
    <div className="p-card rounded-lg px-3 py-2 my-1.5" style={{ borderLeftWidth: 2, borderLeftColor: "var(--c-accent)" }}>
      <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-2 text-xs w-full text-left" style={{ color: "var(--c-sage)" }}>
        <GearIcon size={12} className="shrink-0" />
        <span className="font-medium">Thinking</span>
        {expanded ? <CaretDownIcon size={12} className="ml-auto" /> : <CaretRightIcon size={12} className="ml-auto" />}
      </button>
      <div className={`mt-1 text-xs p-text-2 whitespace-pre-wrap ${!expanded ? "line-clamp-2" : ""}`}>
        {expanded ? text : text.length > 100 ? text.slice(0, 100) + "..." : text}
      </div>
    </div>
  );
}

/** Color-coded badge for the runtime a `run` tool call dispatched on. */
const RUNTIME_COLORS: Record<string, string> = {
  workspace: 'bg-stone-700/60 text-stone-200',
  nimbus:    'bg-sky-700/60 text-sky-100',
  sandbox:   'bg-emerald-700/60 text-emerald-100',
  laptop:    'bg-amber-700/60 text-amber-100',
};

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

function ToolCallBlock({ toolName, input, output, isRunning, isError }: {
  toolName: string; input?: Record<string, unknown>; output?: unknown; isRunning: boolean; isError: boolean;
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

  return (
    <div className="my-1.5">
      <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-2 text-xs p-text-2 hover:p-text transition-colors">
        {isRunning ? <Loader size="sm" /> : isError || provisionErr ? <WrenchIcon size={12} className="text-red-400" /> : <CheckCircleIcon size={12} className="text-green-400" />}
        <span className="font-mono">{toolName}</span>
        {runtime && (
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${RUNTIME_COLORS[runtime] ?? 'bg-stone-700/60 text-stone-200'}`}
                title={`Runtime: ${runtime}`}>
            {runtime}
          </span>
        )}
        {isRunning && <span className="text-amber-400/80 text-[11px]">running...</span>}
        {durationLabel && !isRunning && <span className="p-text-3 text-[10px] flex items-center gap-0.5"><TimerIcon size={10} />{durationLabel}</span>}
        {expanded ? <CaretDownIcon size={10} /> : <CaretRightIcon size={10} />}
      </button>
      {provisionErr && (
        <div className="mt-1.5 ml-5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs p-text-2 flex items-start gap-2">
          <WrenchIcon size={12} className="text-amber-400 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <div>
              The agent asked for the <code className="font-mono bg-amber-500/10 px-1 rounded">{provisionErr.runtime}</code> runtime
              but it isn't provisioned yet.
            </div>
            <div className="p-text-3">{provisionErr.message}</div>
            <div className="p-text-3">
              Open the <span className="font-medium">Devices</span> surface to provision it.
            </div>
          </div>
        </div>
      )}
      {expanded && (
        <div className="mt-1.5 ml-5 space-y-1 animate-scale-in">
          {/* execute_tools is the agent's primary doing-mechanism: render the
              LLM-authored JS program legibly, not as escaped JSON. */}
          {toolName === "execute_tools" && typeof input?.code === "string" ? (
            <CodeBlock className="language-js">{input.code}</CodeBlock>
          ) : input != null ? (
            <pre className="rounded-lg p-elevated border p-border p-2.5 text-xs font-mono p-text-2 max-h-40 overflow-auto">{JSON.stringify(input, null, 2)}</pre>
          ) : null}
          {output != null && <pre className="rounded-lg p-elevated border p-border p-2.5 text-xs font-mono p-text-2 max-h-40 overflow-auto whitespace-pre-wrap">{typeof output === "string" ? output : JSON.stringify(output, null, 2)}</pre>}
        </div>
      )}
    </div>
  );
}

/** Consent card: an agent wants to use a connected device. */
function DeviceConsentCard({ consent, onResolve }: {
  consent: PendingConsent;
  onResolve: (consentId: string, decision: "once" | "always" | "deny") => void;
}) {
  return (
    <div className="rounded-xl border border-amber-500/40 p-3 animate-fade-in" style={{ background: "rgba(245,158,11,0.06)" }}>
      <div className="flex items-start gap-2">
        <DesktopTowerIcon size={16} className="text-amber-400 shrink-0 mt-0.5" weight="fill" />
        <div className="min-w-0 flex-1">
          <div className="text-xs p-text">
            This agent wants to use <span className="font-medium">{consent.deviceLabel}</span> for a local action:
          </div>
          <code className="block mt-1 text-[11px] p-text-2 font-mono break-all p-elevated rounded px-2 py-1">{consent.command || "(command)"}</code>
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

/** A background task returning into the conversation — rendered as a centered
 *  marker, not a chat bubble. The agent's synthesis reply follows as normal. */
function BackgroundEventCard({ kind, status }: { kind: string; status: string }) {
  const meta = status === "completed" ? { Icon: CheckCircleIcon, tone: "text-emerald-400", verb: "completed" }
    : status === "cancelled" ? { Icon: ProhibitIcon, tone: "p-text-3", verb: "was cancelled" }
    : { Icon: WarningCircleIcon, tone: "text-red-400", verb: "failed" };
  return (
    <div className="flex justify-center animate-fade-in py-1">
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full p-elevated border p-border text-[11px] p-text-2">
        <meta.Icon size={13} className={meta.tone} weight="fill" />
        <span>Background <span className="font-medium p-text">{kind}</span> task {meta.verb}</span>
        <ClockIcon size={11} className="p-text-3" />
      </div>
    </div>
  );
}

// Memoized: @ai-sdk's replaceMessage only clones the streaming message, so
// historical messages keep referential identity across stream ticks and skip
// re-rendering (and re-parsing their markdown) entirely.
const MessageView = memo(function MessageView({
  message, isLast, isStreaming, onFork, onFeedback, feedback, onRestoreFiles, takes, onPickTake,
}: {
  message: UIMessage;
  isLast: boolean;
  isStreaming: boolean;
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

  // System-injected background-job wake — render as a distinct event card, not
  // a user bubble (the agent reads its text as a synthesis prompt; the operator
  // sees a marker that work returned from the background).
  const bgEvent = (message as { metadata?: { proteusEvent?: string; kind?: string; status?: string } }).metadata;
  if (bgEvent?.proteusEvent === "background_job") {
    return <BackgroundEventCard kind={bgEvent.kind ?? "task"} status={bgEvent.status ?? "completed"} />;
  }

  if (isUser) {
    const fileParts = message.parts.filter((p): p is FileUIPart => p.type === "file");
    return (
      <div className="flex flex-col items-end animate-fade-in group">
        <div className="relative max-w-[75%] px-4 py-3 rounded-2xl rounded-br-sm p-user-bubble text-sm leading-relaxed whitespace-pre-wrap">
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
        <div className="flex gap-1">
          <span className="size-1.5 rounded-full bg-[var(--c-text-3)] animate-bounce [animation-delay:0ms]" />
          <span className="size-1.5 rounded-full bg-[var(--c-text-3)] animate-bounce [animation-delay:150ms]" />
          <span className="size-1.5 rounded-full bg-[var(--c-text-3)] animate-bounce [animation-delay:300ms]" />
        </div>
        <span className="text-xs p-text-3">Thinking...</span>
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
      {message.parts.map((part, i) => {
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
          const isLastText = message.parts.slice(i + 1).every(p => p.type !== "text");
          return (
            <div key={i} className="prose-chat p-text">
              <MarkdownContent content={t} />
              {isLive && isLastText && <span className="inline-block w-0.5 h-[1em] ml-0.5 align-text-bottom animate-blink-cursor" style={{ background: "var(--c-accent)" }} />}
            </div>
          );
        }
        if (isToolUIPart(part)) {
          const output = part.state === "output-available" ? (part as { output?: unknown }).output : undefined;
          const previewUrl = extractPreviewUrl(output);
          return (
            <div key={part.toolCallId}>
              <ToolCallBlock toolName={getToolName(part)}
                input={part.input as Record<string, unknown> | undefined}
                output={output}
                isRunning={part.state === "input-available" || part.state === "input-streaming"}
                isError={part.state === "output-error"} />
              {/* Inline preview card — when a tool returns a /_preview/ URL,
                  surface a live iframe under the tool block so the user sees
                  the running app inline (also promoted to the Output surface). */}
              {previewUrl && (
                <div className="mt-2 h-64 rounded-md border p-border overflow-hidden">
                  <PreviewFrame url={previewUrl} />
                </div>
              )}
            </div>
          );
        }
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
      {failed && <span className="text-[10px] text-red-400">couldn't save — try again</span>}
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
      footer={<>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button size="sm" variant="primary" onClick={submit} disabled={busy}>
          {busy ? <><Loader size="sm" /><span className="ml-1">Forking…</span></> : "Fork"}
        </Button>
      </>}
    >
      <div className="text-xs p-text-2 leading-relaxed space-y-1.5">
        <p>Create a new agent that branches off of <span className="font-mono p-text">{sourceName}</span> at this message.</p>
        <ul className="list-disc list-inside space-y-0.5 p-text-3">
          <li>Copies: SOUL.md, {messagesUpToHere} message{messagesUpToHere === 1 ? "" : "s"}, memory, {craftedToolsCount} crafted tool{craftedToolsCount === 1 ? "" : "s"}</li>
          <li>Resets: MCTS tree, evolution events, scaffold, craft scores</li>
          <li>Source agent is unaffected</li>
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
        <div className="text-xs text-red-400 border border-red-400/40 rounded-md px-3 py-2" style={{ background: "rgba(248,113,113,0.08)" }}>
          {err}
        </div>
      )}
    </Modal>
  );
}

function ModelSelector({ current, onChange }: { current: string; onChange: (id: string) => void }) {
  // Tri-state: null = loading, "error" = transient fetch failure (retryable),
  // [] = the fetch succeeded and genuinely no provider is connected. Only the
  // last one earns the amber reconnect CTA — flashing it during load or on a
  // flaky request sent connected users through a full OAuth prompt=login.
  const [models, setModels] = useState<ModelMenuEntry[] | null | "error">(null);
  const fetchModels = useCallback(() => {
    setModels(null);
    listAvailableModels()
      .then(setModels)
      .catch(() => setModels("error"));
  }, []);
  useEffect(() => { fetchModels(); }, [fetchModels]);
  if (models === null) {
    return (
      <span className="inline-flex items-center rounded-md border p-border px-1.5 py-1 text-[11px] p-text-3" aria-label="Loading models">
        …
      </span>
    );
  }
  if (models === "error") {
    return (
      <button
        type="button"
        onClick={fetchModels}
        className="inline-flex items-center gap-1 rounded-md border p-border px-2 py-1 text-[11px] p-text-3 hover:p-text-2"
        title="Couldn't load the model list — click to retry"
      >
        <ArrowsClockwiseIcon size={11} />
        models unavailable
      </button>
    );
  }
  if (models.length === 0) {
    return (
      <a
        href={cloudflareReconnectPath(window.location.pathname)}
        className="inline-flex items-center gap-1.5 rounded-md border border-amber-400/40 px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-400/10"
        title="Reconnect Cloudflare with Workers AI permissions"
      >
        <WarningCircleIcon size={12} />
        Connect Workers AI
      </a>
    );
  }
  return (
    <ModelPicker
      models={models}
      value={current}
      onChange={onChange}
      size="xs"
      className="w-52"
    />
  );
}

/** Which work surface a clicked timeline span should reveal. Returns null for
 *  spans with no specific home (the surface stays put; only the selection moves). */
function surfaceForKind(kind: TimelineKind): SurfaceKind | null {
  switch (kind) {
    case "mcts": case "head-split": case "head-merge": case "gepa": return "Reasoning";
    case "scaffold": case "shadow-eval": case "craft": case "reflection": case "curriculum": case "skills": return "Brain";
    case "runtime-exec": return "Devices";
    default: return null;
  }
}

/* ── Main page ────────────────────────────────────────────────── */

export default function WorkspacePage() {
  const { agentId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const state = useProteus(agentId);
  const [altitude, setAltitude] = useState<"run" | "supervise">("run");
  const [surface, setSurface] = useState<SurfaceKind>("Brain");
  const [chatInput, setChatInput] = useState("");
  const [forkFor, setForkFor] = useState<string | null>(null); // message id to fork at, or null
  const [follow, setFollow] = useState(true);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  // Run Timeline (Column B) is collapsed by default — it's a spine you summon,
  // not an always-on firehose. (feedback: the live timeline was distracting.)
  const timelineRef = usePanelRef();
  const [timelineOpen, setTimelineOpen] = useState(false);
  const toggleTimeline = useCallback(() => {
    const t = timelineRef.current;
    if (!t) return;
    if (t.isCollapsed()) t.resize("24%"); else t.collapse();
  }, [timelineRef]);
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
    // MAX_INLINE_ATTACHMENT_BYTES is a per-message AGGREGATE: all pending
    // data-URL parts persist inside one DO message row (see core/cloud-wire).
    let budget = MAX_INLINE_ATTACHMENT_BYTES
      - pendingAttachments.reduce((sum, p) => sum + dataUrlRawBytes(p.url), 0);
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const f of Array.from(files)) {
      if (f.size <= budget) { accepted.push(f); budget -= f.size; }
      else rejected.push(f.name);
    }
    setAttachError(rejected.length > 0
      ? `Chat attachments are capped at ${MAX_INLINE_ATTACHMENT_BYTES / (1024 * 1024)} MB per message — ${rejected.join(", ")} did not fit. Upload larger files via the Files tab on the Devices surface.`
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

  useEffect(() => { if (agentId) touchAgent(agentId).catch(() => {}); }, [agentId]);

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

  // A timeline span drives the work surface (Column C): pin the selection and,
  // when the span maps to a specific surface, switch to it. Turning off Follow
  // so the spine stops auto-scrolling while the user inspects.
  const onTimelineSelect = useCallback((span: TimelineSpan) => {
    setFollow(false);
    if (span.refId) setSelectedRef(span.refId);
    const s = surfaceForKind(span.kind);
    if (s) setSurface(s);
  }, []);

  // Send the creation mission as the opening message — once, deterministically,
  // the moment the socket is connected. The mission rides in via navigation
  // state from CreateAgentModal; we clear it (replace) right after sending so a
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
    state.rpc<{ accepted: boolean; reason?: string }>("branchTurn", [t])
      .then((r) => { if (!r.accepted) setBranchNotice(r.reason ?? "Branching is unavailable right now."); })
      .catch((err) => setBranchNotice(err instanceof Error ? err.message : String(err)));
    setChatInput("");
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
  const onRestoreFiles = useCallback(async (mid: string) => {
    setRestoreNotice(null);
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
      const { modified, created, deleted } = summarizeRestorePlan(files);
      const counts = [
        modified ? `${modified} modified` : null,
        created ? `${created} recreated` : null,
        deleted ? `${deleted} removed` : null,
      ].filter(Boolean).join(', ');
      const preview = files.slice(0, 12).map((f) => `  ${f.kind === 'modify' ? '~' : f.kind === 'create' ? '+' : '-'} ${f.path}`).join('\n');
      const more = files.length > 12 ? `\n  … ${files.length - 12} more` : '';
      if (!confirm(`Restore ${plans.map((p) => p.dir).join(', ')} to before this turn?\n${counts}\n${preview}${more}`)) return;
      for (const entry of matches) {
        await state.rpc('restoreFileCheckpoint', [entry.dir, entry.id]);
      }
      setRestoreNotice(`Restored ${files.length} file(s) to before this turn. Restoring again undoes the undo.`);
    } catch (err) {
      setRestoreNotice(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [state.rpc]);

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

  const as = state.agentStatus;
  return (
    <div className="h-full flex flex-col">
      {/* Non-destructive disconnect banner. The chat panel below stays
          mounted so the in-flight assistant turn is preserved through
          partysocket auto-reconnect. (STABILITY-AUDIT §A1.) */}
      {state.connectionStatus === "disconnected" && (
        <div className="flex items-center justify-center gap-2 px-3 py-1.5 text-xs text-amber-300 border-b p-border" style={{ background: "var(--c-accent-subtle)" }}>
          <ArrowsClockwiseIcon size={12} className="animate-spin" />Reconnecting...
        </div>
      )}

      {/* Altitude toggle: RUN (this run, mission-control) ⇄ SUPERVISE (the
          agent over time — curriculum, runs, automations). */}
      <div className="flex items-center px-4 py-1.5 border-b p-border shrink-0">
        <span className="text-xs p-text-2 font-medium truncate">{as?.displayName || agentId}</span>
        <div className="ml-auto flex items-center gap-0.5 p-elevated rounded-md p-0.5">
          {(["run", "supervise"] as const).map((a) => (
            <button key={a} onClick={() => setAltitude(a)}
              className={`px-2.5 py-1 text-[11px] rounded capitalize transition-colors ${altitude === a ? "p-card p-text font-medium" : "p-text-3 hover:p-text-2"}`}>
              {a}
            </button>
          ))}
        </div>
      </div>

      {altitude === "supervise" ? (
        <div className="flex-1 min-h-0">
          <ErrorBoundary label="Supervise">
            <SupervisePage rpc={state.rpc} onRunTask={(t) => { setAltitude("run"); state.sendChat(t); }} onOpenTasks={() => { setAltitude("run"); setSurface("Tasks"); }} />
          </ErrorBoundary>
        </div>
      ) : (
      <PanelGroup className="flex-1">
        {/* ── Column A — Chat / Steer ─────────────────────────── */}
        <Panel minSize={24} defaultSize={42}>
          <div className="relative flex flex-col h-full border-r p-border"
            onDragOver={onChatDragOver} onDragLeave={onChatDragLeave} onDrop={onChatDrop}>
            {dragOver && (
              <div className="absolute inset-0 z-10 pointer-events-none flex items-center justify-center rounded-lg border-2 border-dashed"
                style={{ borderColor: "var(--c-accent)", background: "var(--c-accent-subtle)" }}>
                <div className="flex items-center gap-2 text-sm p-text px-3 py-1.5 rounded-lg p-elevated border p-border">
                  <PaperclipIcon size={16} className="p-accent" />Drop files to attach
                </div>
              </div>
            )}
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b p-border">
              <div className="flex items-center gap-3">
                <ConnectionIndicator status={state.connectionStatus} />
                <span className="font-medium text-sm p-text truncate max-w-[180px]">{as?.displayName || agentId}</span>
                {state.isStreaming && <Badge variant="primary">streaming</Badge>}
                {as?.forkLineage && (
                  <Link
                    to={`/agent/${as.forkLineage.sourceAgentName}`}
                    className="flex items-center gap-1 text-[10px] p-text-3 hover:p-text transition-colors px-1.5 py-0.5 rounded border p-border"
                    title={`Forked from ${as.forkLineage.sourceAgentName} at message ${as.forkLineage.sourceMessageId} on ${new Date(as.forkLineage.forkedAt).toLocaleString()}`}
                  >
                    <GitBranchIcon size={10} />
                    <span className="font-mono">{as.forkLineage.sourceAgentName}</span>
                  </Link>
                )}
              </div>
              <div className="flex items-center gap-2">
                <ModelSelector current={as?.model ?? ""} onChange={state.setModel} />
                <button
                  onClick={toggleTimeline}
                  title={timelineOpen ? "Hide run timeline" : "Show run timeline"}
                  aria-label="Toggle run timeline"
                  className={`p-1 rounded transition-colors cursor-pointer ${timelineOpen ? "p-accent" : "p-text-3 hover:p-text-2"}`}
                >
                  <ClockIcon size={14} />
                </button>
                {state.messages.length > 0 && (
                  <Button variant="ghost" shape="square" size="sm"
                    onClick={() => { if (confirm("Clear this agent's entire conversation history? This cannot be undone.")) state.clearHistory(); }}
                    icon={<TrashIcon size={12} />} aria-label="Clear history" />
                )}
                <Link to={`/settings/${agentId}`} className="p-text-2 hover:p-text transition-colors" title="Settings">
                  <GearSixIcon size={14} />
                </Link>
                <Link to={`/mcts/${agentId}`} className="flex items-center gap-1 text-[11px] p-accent hover:opacity-80 transition-opacity">
                  <TreeStructureIcon size={12} />MCTS<ArrowSquareOutIcon size={10} />
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
                />
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
              {state.error && <div className="mb-2 text-xs text-red-400 p-card rounded-lg px-3 py-1.5">{state.error}</div>}
              {attachError && <div className="mb-2 text-xs text-amber-300 p-card rounded-lg px-3 py-1.5">{attachError}</div>}
              {branchNotice && (
                <div className="mb-2 flex items-center justify-between gap-2 text-xs text-amber-300 p-card rounded-lg px-3 py-1.5">
                  <span className="truncate">Branch unavailable: {branchNotice}</span>
                  <button onClick={() => setBranchNotice(null)} className="p-text-3 hover:p-text cursor-pointer shrink-0" aria-label="Dismiss"><XIcon size={11} /></button>
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
              <div className="flex items-end gap-3 p-card rounded-xl p-3 p-focus transition-all">
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
        </Panel>

        <PanelResizeHandle className="w-[3px] bg-[var(--c-border)] hover:bg-[var(--c-accent-subtle)] transition-colors cursor-col-resize" />

        {/* ── Column B — Run Timeline (the spine; collapsed by default) ── */}
        <Panel panelRef={timelineRef} collapsible collapsedSize={0} defaultSize={0} minSize={15}
          onResize={(s) => setTimelineOpen(s.asPercentage > 0.5)}>
          <div className="flex flex-col h-full border-r p-border">
            <ErrorBoundary label="Timeline">
              <RunTimeline
                spans={state.runTimeline}
                selectedRef={selectedRef}
                onSelect={onTimelineSelect}
                follow={follow}
                onToggleFollow={() => setFollow(f => !f)}
                onClose={toggleTimeline}
              />
            </ErrorBoundary>
          </div>
        </Panel>

        <PanelResizeHandle className="w-[3px] bg-[var(--c-border)] hover:bg-[var(--c-accent-subtle)] transition-colors cursor-col-resize" />

        {/* ── Column C — Work Surface ─────────────────────────── */}
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
            executors={state.executors}
            executorOutputs={state.executorOutputs}
            lastActiveExecutor={state.lastActiveExecutor}
            onExecute={state.executeInExecutor}
            agentName={agentId}
            backgroundJobs={state.backgroundJobs}
            runningTaskCount={state.runningTaskCount}
            onRefreshTasks={state.refreshBackgroundJobs}
            changelogUnseen={state.changelogUnseen}
            onChangelogSeen={state.clearChangelogUnseen}
            rpc={state.rpc}
          />
        </Panel>

      </PanelGroup>
      )}

      {forkFor && (
        <ForkModal
          sourceName={as?.displayName || agentId || ""}
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
    </div>
  );
}
