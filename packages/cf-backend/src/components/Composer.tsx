/**
 * One composer for every chat surface. While a turn runs it offers Stop, Branch and Steer; which ones
 * show comes from `turnLiveness`, the same fold the transcript's live tail reads.
 */
import { detach } from "@kinu.run/core/obs";
import { Effect } from "effect";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { InputArea, Loader } from "@cloudflare/kumo";
import {
  StopIcon, GitBranchIcon, ArrowBendUpRightIcon, ArrowsClockwiseIcon, ArrowUpIcon,
  WarningCircleIcon, InfoIcon, CheckCircleIcon,
} from "@phosphor-icons/react";
import { fmtSpan, type TurnLiveness } from "@kinu.run/core";
import { AttachButton, AttachmentTray, pasteAttachments, type AttachmentsControl } from "@/components/Attachments";
import type { WorkspaceNotice } from "@/hooks/use-kinu";
import { composing } from "@/components/ui/form";

const CHAT_MODES = ["build", "plan"] as const;

const RECOVER_LABEL = { idle: "Recover", busy: "Recovering…" } as const;

export type ChatMode = (typeof CHAT_MODES)[number];

/** `progress` is `neutral` plus a spinner, with no tint of its own. */
type NoticeTone = "danger" | "warning" | "info" | "success" | "neutral" | "progress";

export interface ComposerNotice {
  id: string;
  tone: NoticeTone;
  title?: string;
  text?: string;
  /** Raw technical string, shown only inside the "Technical details" disclosure. */
  detail?: string;
  action?: { label: string; icon?: ReactNode; onClick: () => void };
  onDismiss?: () => void;
}

const NOTICE_TONE = {
  danger:   { cls: "p-notice-danger",  icon: <WarningCircleIcon size={13} className="shrink-0" /> },
  warning:  { cls: "p-notice-warning", icon: <WarningCircleIcon size={13} className="shrink-0" /> },
  info:     { cls: "p-notice-info",    icon: <InfoIcon size={13} className="shrink-0" /> },
  success:  { cls: "p-notice-success", icon: <CheckCircleIcon size={13} className="shrink-0" /> },
  neutral:  { cls: "p-notice-neutral", icon: <InfoIcon size={13} className="shrink-0" /> },
  progress: { cls: "p-notice-neutral", icon: <Loader size="sm" /> },
} satisfies Record<NoticeTone, { cls: string; icon: ReactNode }>;

function Notice({ notice }: { notice: ComposerNotice }) {
  const { tone, title, text, detail, action, onDismiss } = notice;
  const { cls, icon } = NOTICE_TONE[tone];
  const [expanded, setExpanded] = useState(false);
  // SSR has no layout: guess by length, then measure on the client.
  const [overflows, setOverflows] = useState(() => (text?.length ?? 0) > 2 * 60);
  const textRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const el = textRef.current;

    if (el) setOverflows(el.scrollHeight > el.clientHeight);
  }, [text]);

  return (
    <div className={`flex items-start gap-2 px-2.5 py-1.5 p-meta ${cls}`}
      role={tone === "danger" ? "alert" : "status"}>
      <span className="mt-px shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        {title && <span className="block font-medium">{title}</span>}
        {text && <span ref={textRef} className={`block ${expanded ? "" : "line-clamp-2"}`} title={text}>{text}</span>}
        {text && overflows && (
          <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}
            className="mt-0.5 cursor-pointer p-meta p-text-3 underline decoration-dotted underline-offset-2 hover:p-text-2 focus-visible:ring-1 focus-visible:ring-[var(--c-accent)] focus-visible:outline-none">
            {expanded ? "Show less" : "Expand"}
          </button>
        )}
        {detail && (
          <details className="mt-0.5">
            <summary className="cursor-pointer underline decoration-dotted underline-offset-2 transition-colors hover:p-text hover:decoration-solid">Technical details</summary>
            <pre className="mt-1 max-h-32 overflow-auto font-mono whitespace-pre-wrap break-all">{detail}</pre>
          </details>
        )}
      </span>
      {action && (
        <button type="button" onClick={action.onClick}
          className="p-btn-quiet inline-flex shrink-0 cursor-pointer items-center gap-1 px-2 py-0.5">
          {action.icon}{action.label}
        </button>
      )}
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss"
          className="p-btn-ghost inline-flex shrink-0 cursor-pointer items-center p-1">
          <span aria-hidden className="text-[13px] leading-none">×</span>
        </button>
      )}
    </div>
  );
}

/** Who a provider's wait is on, and for how long. `untilMs` is this browser's clock. */
export function useProviderWaitNotice(wait: { provider: string; untilMs: number } | null): ComposerNotice[] {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (wait === null) return undefined;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1_000);

    return () => clearInterval(tick);
  }, [wait]);

  if (wait === null) return [];

  return [{ id: "provider-wait", tone: "progress", text: `Waiting on ${wait.provider} · retrying in ${fmtSpan(Math.max(0, wait.untilMs - now))}` }];
}

/** Neither tone disables the composer; that belongs to the socket. */
export function workspaceLoadNotice(notice: WorkspaceNotice, onRetry: () => void): ComposerNotice {
  const mapped: ComposerNotice = {
    id: "load",
    tone: notice.severity === "blocking" ? "danger" : "warning",
    title: notice.title,
  };

  if (notice.scope !== "") mapped.text = notice.scope;

  if (notice.detail !== "") mapped.detail = notice.detail;

  if (notice.retry !== null) mapped.action = { label: notice.retry, onClick: onRetry };

  return mapped;
}

const MODE_TITLE = {
  build: "Auto. The agent makes the change and shows what it ran.",
  plan: "Plan. Review a plan before anything changes.",
} satisfies Record<ChatMode, string>;

/**
 * Plan is a trust boundary (`submit_plan` exists only on Plan turns), so it is a two-item segment,
 * not an ambiguous toggle. The wire value for Auto stays `build`.
 */
function ModeSegment({ value, onChange, disabled }: {
  value: ChatMode; onChange: (mode: ChatMode) => void; disabled: boolean;
}) {
  return (
    <div className="p-composer-mode" role="group" aria-label="Turn mode">
      {CHAT_MODES.map((mode) => {
        const build = mode === "build";
        const selected = value === mode;
        const title = MODE_TITLE[mode];

        return (
          <button
            key={mode}
            type="button"
            onClick={() => onChange(mode)}
            disabled={disabled}
            aria-pressed={selected}
            title={title}
            className="p-composer-quiet disabled:opacity-40"
          >
            {build ? "Auto" : "Plan"}
          </button>
        );
      })}
    </div>
  );
}

export interface ComposerProps {
  value: string;
  onValueChange: (value: string) => void;
  onSend: () => void;
  placeholder: string;
  disabled: boolean;
  liveness: TurnLiveness;
  onStop: () => void;
  /** Offered only for a stranded turn. Resolves the failure reason, or null once settled; rejects on RPC failure. */
  onRecover?: () => Promise<string | null>;
  notices?: readonly ComposerNotice[];
  mode?: { value: ChatMode; onChange: (mode: ChatMode) => void };
  attachments?: AttachmentsControl;
  /** Passed in so the composer stays renderable without a socket. */
  modelPicker?: ReactNode;
  /** Offered only mid-stream, never in Plan mode. */
  onBranch?: () => void;
  textareaRef?: React.Ref<HTMLTextAreaElement>;
  /** What waits on the owner's answer, attached to the prompt box's top edge (`AttentionStack`). */
  attention?: ReactNode;
}

export function Composer({
  value, onValueChange, onSend, placeholder, disabled, liveness, onStop, onRecover,
  notices, mode, attachments, modelPicker, onBranch, textareaRef, attention,
}: ComposerProps) {
  const empty = value.trim() === "" && (attachments?.parts.length ?? 0) === 0;
  const streaming = liveness.kind === "live";
  const stranded = liveness.kind === "stranded";
  // A branch runs the draft's words as a parallel head: attachments alone give it nothing to run.
  const canBranch = Boolean(onBranch) && streaming && value.trim() !== "" && mode?.value !== "plan";
  const [stopping, setStopping] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const recoverLabel = RECOVER_LABEL[recovering ? "busy" : "idle"];
  // The runtime sends no stopped event; `streaming` going false confirms the stop.
  useEffect(() => { if (!streaming) setStopping(false); }, [streaming]);
  useEffect(() => { if (!stranded) setRecovering(false); }, [stranded]);
  // Enter while a turn runs steers it; it is never a no-op.
  const submit = onSend;

  return (
    // @container: the action row collapses to icons in a narrow chat column.
    <div data-composer-root className="@container mx-auto w-full max-w-[820px] px-3 pb-3 sm:px-5 sm:pb-4"
      onPaste={(e) => {
        if (attachments) pasteAttachments(e, attachments, (text) => onValueChange(value === "" ? text : `${value}\n${text}`));
      }}>
      {notices && notices.length > 0 && (
        <div className="mb-2 space-y-1.5">
          {notices.map((n) => <Notice key={n.id} notice={n} />)}
        </div>
      )}

      {attention}

      <div className="p-composer">
        {attachments && <AttachmentTray attachments={attachments} />}

        <InputArea ref={textareaRef} value={value} onValueChange={onValueChange}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;

            if (composing(e.nativeEvent)) return;

            if (e.shiftKey) {
              // Kumo's controlled InputArea drops the native line break; insert it
              // and restore the caret after React commits.
              e.preventDefault();
              const input = e.currentTarget;
              const start = input.selectionStart;
              const end = input.selectionEnd;
              onValueChange(`${value.slice(0, start)}\n${value.slice(end)}`);
              requestAnimationFrame(() => input.setSelectionRange(start + 1, start + 1));

              return;
            }

            e.preventDefault();
            submit?.();
          }}
          placeholder={placeholder} disabled={disabled} rows={1}
          className="w-full max-h-56 resize-none overflow-y-auto !border-0 px-[18px] pt-3.5 pb-1 !bg-transparent !text-[15px] !leading-6 pointer-coarse:!text-[16px] !shadow-none !outline-none !ring-0 focus:!ring-0" />

        <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5 px-2.5 pt-1 pb-2.5">
          {attachments && <AttachButton attachments={attachments} disabled={disabled} />}

          {mode && (
            <ModeSegment value={mode.value} onChange={mode.onChange} disabled={disabled || streaming} />
          )}

          <div className="ml-auto flex min-w-0 items-center gap-1">
            {modelPicker && <div className="p-composer-model">{modelPicker}</div>}
            {stranded && onRecover && (
              <button type="button" disabled={recovering}
                onClick={() => detach(Effect.promise(async () => {
                  setRecovering(true);
                  // The outcome is the workspace notice's to report; the button only waits.
                  await onRecover();
                  setRecovering(false);
                }))}
                className="p-composer-quiet disabled:opacity-50"
                aria-label="Recover this turn"
                title="This turn's worker stopped without finishing. Settle it so the agent takes work again.">
                <ArrowsClockwiseIcon size={14} />
                <span className="hidden @[30rem]:inline p-meta">{recoverLabel}</span>
              </button>
            )}
            {canBranch && (
              <button type="button" onClick={onBranch}
                className="p-composer-quiet"
                aria-label="Run the draft as a parallel branch"
                title="Answer beside the live turn, then compare. Neither turn interrupts the other.">
                <GitBranchIcon size={15} />
                <span className="hidden @[30rem]:inline p-meta">Branch</span>
              </button>
            )}
            <SendControls streaming={streaming} empty={empty} blocked={disabled} stopping={stopping}
              onSend={onSend} onStop={() => { setStopping(true); onStop(); }} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** The one filled shape: Send at rest; while a turn runs, Stop, with Steer beside it once there is a draft. */
function SendControls({ streaming, empty, blocked, stopping, onSend, onStop }: {
  streaming: boolean; empty: boolean; blocked: boolean; stopping: boolean; onSend: () => void; onStop: () => void;
}) {
  if (!streaming) {
    return (
      <button type="button" onClick={onSend} disabled={empty || blocked} className="p-composer-send" aria-label="Send" title="Send">
        <ArrowUpIcon size={16} weight="bold" />
      </button>
    );
  }

  return (
    <>
      <button type="button" onClick={onStop} className={empty ? "p-composer-send" : "p-composer-round"} data-stop disabled={stopping}
        aria-label="Stop this turn" title={stopping ? "Stopping…" : "Stop this turn. Queued messages run next."}>
        <StopIcon size={13} weight="fill" />
      </button>
      {!empty && (
        <button type="button" onClick={onSend} disabled={blocked} className="p-composer-send"
          aria-label="Steer the running turn" title="Send this to the running turn. It arrives at the agent's next step.">
          <ArrowBendUpRightIcon size={16} weight="bold" />
        </button>
      )}
    </>
  );
}
