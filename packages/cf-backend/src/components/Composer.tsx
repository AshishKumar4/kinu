/**
 * One composer for every chat surface. While a turn runs it offers Stop, Branch and Steer; which ones
 * show comes from `turnLiveness`, the same fold the transcript's live tail reads.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { InputArea, Loader } from "@cloudflare/kumo";
import {
  StopIcon, GitBranchIcon, ArrowBendUpRightIcon, ArrowsClockwiseIcon,
  WarningCircleIcon, InfoIcon, CheckCircleIcon, FileIcon, XIcon,
} from "@phosphor-icons/react";
import type { FileUIPart } from "ai";
import type { TurnLiveness } from "@kinu.run/core";
import { AttachmentChip } from "@/components/AttachmentChip";
import type { WorkspaceNotice } from "@/hooks/use-kinu";

const CHAT_MODES = ["build", "plan"] as const;

const RECOVER_LABEL = { idle: "Recover", busy: "Recovering…" } as const;

export type ChatMode = (typeof CHAT_MODES)[number];

/** `progress` is `neutral` plus a spinner, with no tint of its own. */
export type NoticeTone = "danger" | "warning" | "info" | "success" | "neutral" | "progress";

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
            <summary className="cursor-pointer underline decoration-dotted underline-offset-2">Technical details</summary>
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

function modeTitle(mode: ChatMode, locked: boolean): string {
  if (mode !== "build") return "Plan. Review a plan before anything changes.";

  if (locked) return "Approve the active plan before starting an Auto turn.";

  return "Auto. The agent makes the change and shows what it ran.";
}

/**
 * Plan is a trust boundary (`submit_plan` exists only on Plan turns), so it is a two-item segment,
 * not an ambiguous toggle. The wire value for Auto stays `build`.
 */
function ModeSegment({ value, onChange, locked, disabled }: {
  value: ChatMode; onChange: (mode: ChatMode) => void; locked: boolean; disabled: boolean;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Turn mode">
      {CHAT_MODES.map((mode) => {
        const build = mode === "build";
        const selected = value === mode;
        const title = modeTitle(mode, locked);

        return (
          <button
            key={mode}
            type="button"
            onClick={() => onChange(mode)}
            disabled={disabled || (locked && mode === "build")}
            aria-pressed={selected}
            title={title}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${
              selected
                ? "border-[rgba(224,164,88,.3)] bg-[rgba(224,164,88,.1)] p-accent"
                : "p-border p-text-3 hover:p-text-2 hover:border-[var(--c-accent)]"
            }`}
          >
            {build ? "Auto" : "Plan"}
          </button>
        );
      })}
    </div>
  );
}

/** Dedupe by item/File identity only: files with identical metadata can hold different bytes. */
function pastedFiles(data: DataTransfer): FileList {
  const { files, items } = data;

  if (files.length < 2) return files;
  const seenItems = new Set<DataTransferItem>();
  const seenFiles = new Set<File>();
  const unique = new DataTransfer();

  for (const item of items) {
    if (item.kind !== "file" || seenItems.has(item)) continue;
    seenItems.add(item);
    const file = item.getAsFile();

    if (file === null || seenFiles.has(file)) continue;
    seenFiles.add(file);
    unique.items.add(file);
  }

  // DataTransfer.files is authoritative when items supply no matching files.
  return unique.files.length === 0 || unique.files.length === files.length ? files : unique.files;
}

/**
 * Presence comes from string flavors, never content. An HTML-only flavor contributes its rendered
 * text, falling back to the raw string.
 */
function pastedText(data: DataTransfer): string {
  const plain = data.getData("text/plain");

  if (plain !== "") return plain;
  const html = data.getData("text/html");

  if (html === "") return "";
  const rendered = new DOMParser().parseFromString(html, "text/html").body.textContent;

  return rendered === null || rendered === "" ? html : rendered;
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
  mode?: { value: ChatMode; onChange: (mode: ChatMode) => void; locked: boolean };
  attachments?: {
    parts: readonly FileUIPart[];
    onAdd: (files: FileList | null | undefined) => void;
    onRemove: (index: number) => void;
    /** Send stays disabled until each failed upload is removed. */
    failed?: readonly string[];
    onRemoveFailed?: (index: number) => void;
  };
  /** Passed in so the composer stays renderable without a socket. */
  modelPicker?: ReactNode;
  /** Offered only mid-stream, never in Plan mode. */
  onBranch?: () => void;
  textareaRef?: React.Ref<HTMLTextAreaElement>;
}

export function Composer({
  value, onValueChange, onSend, placeholder, disabled, liveness, onStop, onRecover,
  notices, mode, attachments, modelPicker, onBranch, textareaRef,
}: ComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const empty = value.trim() === "" && (attachments?.parts.length ?? 0) === 0;
  const hasFailedAttachment = (attachments?.failed?.length ?? 0) > 0;
  const streaming = liveness.kind === "live";
  const stranded = liveness.kind === "stranded";
  const canBranch = Boolean(onBranch) && streaming && !empty && mode?.value !== "plan";
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
    <div data-composer-root className="@container mx-auto w-full max-w-[820px] px-4 py-3.5 sm:px-5"
      onPaste={(e) => {
        if (!attachments) return;
        const files = pastedFiles(e.clipboardData);

        if (files.length === 0) return; // a plain text paste — the browser's own insertion is right
        attachments.onAdd(files);
        const text = pastedText(e.clipboardData);

        // Never infer file-only from string content: a filename can be the intended text.
        if (text === "") {
          e.preventDefault();

          return;
        }

        // A plain flavor inserts natively (caret, undo stack). HTML-only needs
        // plain-text insertion because a textarea cannot take rich content.
        if (e.clipboardData.getData("text/plain") !== "") return;
        e.preventDefault();

        if (e.target instanceof HTMLTextAreaElement && document.execCommand("insertText", false, text)) return;
        onValueChange(value === "" ? text : `${value}\n${text}`);
      }}>
      {notices && notices.length > 0 && (
        <div className="mb-2 space-y-1.5">
          {notices.map((n) => <Notice key={n.id} notice={n} />)}
        </div>
      )}

      <div className="p-composer">
        {attachments && (attachments.parts.length > 0 || hasFailedAttachment) && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {attachments.parts.map((part, i) => (
              <AttachmentChip key={`${part.filename ?? "file"}-${i}`} part={part}
                onRemove={() => attachments.onRemove(i)} />
            ))}
            {(attachments.failed ?? []).map((name, i) => (
              <span key={`failed-${name}-${i}`}
                className="inline-flex max-w-56 items-center gap-1.5 rounded-md border p-border p-fill px-1.5 py-1 p-meta p-text-2"
                title={`Could not attach ${name}`}>
                <FileIcon size={13} className="shrink-0 p-text-3" />
                <span className="truncate font-mono">{name}</span>
                <span className="shrink-0 font-medium p-warning">failed</span>
                {attachments.onRemoveFailed && (
                  <button type="button" onClick={() => attachments.onRemoveFailed?.(i)} aria-label={`Remove ${name}`}
                    className="p-btn-ghost cursor-pointer p-0.5">
                    <XIcon size={11} />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}

        <InputArea ref={textareaRef} value={value} onValueChange={onValueChange}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;

            // Enter that commits IME composition belongs to the IME; keyCode 229
            // covers engines that fire keydown after compositionend.
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;

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
          className="w-full max-h-56 resize-none overflow-y-auto !border-0 px-4 pt-3 pb-1 !bg-transparent !shadow-none !outline-none !ring-0 focus:!ring-0" />

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 pt-2 pb-3">
          {attachments && (
            <>
              <input ref={fileInputRef} type="file" multiple className="hidden"
                onChange={(e) => { attachments.onAdd(e.currentTarget.files); e.currentTarget.value = ""; }} />
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={disabled}
                className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border p-border px-3 py-1 text-xs p-text-3 transition-colors hover:p-accent hover:border-[var(--c-accent)]"
                aria-label="Attach files" title="Attach files">
                <span aria-hidden className="text-[13px] leading-none">+</span>
                <span className="hidden @[26rem]:inline">Attach</span>
              </button>
            </>
          )}

          {mode && (
            <ModeSegment value={mode.value} onChange={mode.onChange} locked={mode.locked}
              disabled={disabled || streaming} />
          )}

          {modelPicker && (
            <div className="flex min-w-0 flex-1 basis-32 max-w-44 flex-col items-start gap-y-0.5 @[30rem]:max-w-[17.5rem] @[30rem]:flex-row @[30rem]:items-center @[30rem]:gap-x-3 [&>*]:min-w-0 [&_input]:!p-text-2 [&_input]:!bg-transparent [&_input]:!shadow-none [&_input]:!ring-0 [&_input]:transition-colors [&_input]:hover:!bg-[var(--c-elevated)] [&_input]:focus:!bg-[var(--c-elevated)]">
              {modelPicker}
            </div>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {streaming && (
              <button type="button" onClick={() => { setStopping(true); onStop(); }}
                className="p-btn-quiet inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 px-2"
                aria-label="Stop this turn"
                title="Stop this turn. Queued messages run next.">
                <StopIcon size={14} weight="fill" />
                <span className="hidden @[30rem]:inline p-meta">{stopping ? "Stopping…" : "Stop"}</span>
              </button>
            )}
            {stranded && onRecover && (
              <button type="button" disabled={recovering}
                onClick={async () => {
                  setRecovering(true);
                  // The outcome is the workspace notice's to report; the button only waits.
                  await onRecover();
                  setRecovering(false);
                }}
                className="p-btn-quiet inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 px-2 disabled:opacity-50"
                aria-label="Recover this turn"
                title="This turn's worker stopped without finishing. Settle it so the agent takes work again.">
                <ArrowsClockwiseIcon size={14} />
                <span className="hidden @[30rem]:inline p-meta">{recoverLabel}</span>
              </button>
            )}
            {canBranch && (
              <button type="button" onClick={onBranch}
                className="p-btn-quiet inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 px-2"
                aria-label="Run the draft as a parallel branch"
                title="Answer beside the live turn, then compare. Neither turn interrupts the other.">
                <GitBranchIcon size={15} />
                <span className="hidden @[30rem]:inline p-meta">Branch</span>
              </button>
            )}
            {streaming
              ? <button type="button" onClick={onSend} disabled={empty || disabled || hasFailedAttachment}
                  className="p-btn inline-flex h-[30px] cursor-pointer items-center justify-center gap-1.5 rounded-full px-[18px] text-[12.5px]"
                  aria-label="Steer the running turn"
                  title="Send this to the running turn. It arrives at the agent's next step.">
                  <ArrowBendUpRightIcon size={14} weight="bold" />
                  Steer
                </button>
              : <button type="button" onClick={onSend} disabled={empty || disabled || hasFailedAttachment}
                  className="p-btn inline-flex h-[30px] cursor-pointer items-center justify-center gap-1.5 rounded-full px-[18px] text-[12.5px]"
                  aria-label="Send">
                  Send
                </button>}
          </div>
        </div>
      </div>
    </div>
  );
}
