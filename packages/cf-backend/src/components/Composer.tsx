/**
 * One composer for every chat surface. While a turn runs it offers Stop, Branch and Steer; which ones
 * show comes from `turnLiveness`, the same fold the transcript's live tail reads.
 */
import { detach } from "@kinu.run/core/obs";
import { Effect } from "effect";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Loader } from "@/components/ui/Loader";
import {
  StopIcon, GitBranchIcon, ArrowBendUpRightIcon, ArrowsClockwiseIcon, ArrowUpIcon, CaretDownIcon, CaretRightIcon, CaretUpIcon,
  CheckIcon, CopyIcon, WarningCircleIcon, InfoIcon, CheckCircleIcon, XIcon, type Icon,
} from "@phosphor-icons/react";
import { fmtSpan, providerName, type TurnLiveness, type WorkMode } from "@kinu.run/core";
import { AttachButton, AttachmentTray, pasteAttachments, type AttachmentsControl } from "@/components/Attachments";
import type { WorkspaceNotice } from "@kinu.run/core";
import { composing } from "@/components/ui/form";
import type { ProviderWaitShown } from "@/hooks/use-chat-owner";
import { copyLabel, useCopy } from "@/hooks/use-copy";
import { TextArea } from "@/components/ui/Field";

const CHAT_MODES: readonly WorkMode[] = ["build", "plan"];

const RECOVER_LABEL = { idle: "Recover", busy: "Recovering…" } as const;

/** `progress` is `neutral` plus a spinner, with no tint of its own. */
type NoticeTone = "danger" | "warning" | "info" | "success" | "neutral" | "progress";

/**
 * One thing above the prompt box that is true now: what failed, waits or changed, with its one action. One line; a
 * notice with more to say opens into a card of the same edge.
 */
export interface ComposerNotice {
  id: string;
  tone: NoticeTone;
  /** Who or what it is about, in its own weight: a provider, a model, a load. */
  title?: string;
  text?: string;
  /** A count or time beside the words, in the quiet ink: "retrying in 8s · 2 of 5". */
  dim?: string;
  /** What it says once opened: one line of what happened, the facts it rests on, and the raw words behind them. */
  detail?: { summary?: string; facts?: readonly (readonly [string, string])[]; raw?: string };
  action?: { label: string; icon?: ReactNode; onClick: () => void; disabled?: boolean };
  onDismiss?: () => void;
  /** Data attributes the flows find it by. */
  hooks?: Readonly<Record<`data-${string}`, string>>;
}

const NOTICE_MARK = {
  danger: { tone: "danger", icon: WarningCircleIcon },
  warning: { tone: "warning", icon: WarningCircleIcon },
  info: { tone: "info", icon: InfoIcon },
  success: { tone: "success", icon: CheckCircleIcon },
  neutral: { tone: "quiet", icon: InfoIcon },
  progress: { tone: "quiet", icon: null },
} satisfies Record<NoticeTone, { tone: string; icon: Icon | null }>;

/** Past this many, the oldest fold into one count. */
const SHOWN_NOTICES = 3;

function NoticeMark({ tone }: { tone: NoticeTone }) {
  const { tone: ink, icon: Glyph } = NOTICE_MARK[tone];

  return (
    <span className="p-pill-mark" data-tone={ink}>
      {Glyph === null ? <Loader size="sm" /> : <Glyph size={15} weight="fill" aria-hidden />}
    </span>
  );
}

function Notice({ notice }: { notice: ComposerNotice }) {
  const { tone, title, text, dim, detail, action, onDismiss, hooks } = notice;
  const [open, setOpen] = useState(false);
  // A line cut short opens like a notice with details: its words wrap in the card.
  const [cut, setCut] = useState(false);
  const words = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const line = words.current;

    if (line !== null) setCut([...line.children].some((part) => part.scrollWidth > part.clientWidth));
  }, [text, dim, open]);

  const opens = detail !== undefined || cut;
  const role = tone === "danger" ? "alert" : "status";

  const actionButton = action && (
    <button type="button" onClick={action.onClick} disabled={action.disabled} className="p-pill-action disabled:opacity-50">
      {action.icon}{action.label}
    </button>
  );

  const dismiss = onDismiss && (
    <button type="button" onClick={onDismiss} aria-label="Dismiss" className="p-pill-icon"><XIcon size={13} weight="bold" /></button>
  );

  if (open) {
    return (
      <div className="p-pill" data-tone={tone} data-notice={tone} data-open role={role} {...hooks}>
        <div className="p-pill-head">
          <NoticeMark tone={tone} />
          <span className="p-pill-body">
            {title && <span className="p-pill-source">{title}</span>}
            {text && <span className="p-pill-text">{text}</span>}
            {dim && <span className="p-pill-dim">{dim}</span>}
          </span>
          <span className="p-pill-controls">
            <button type="button" className="p-pill-icon" aria-label="Show less" aria-expanded onClick={() => setOpen(false)}>
              <CaretUpIcon size={13} weight="bold" />
            </button>
            {dismiss}
          </span>
        </div>
        {detail?.summary && <p className="t-body mt-1 ml-6 p-text-3">{detail.summary}</p>}
        {detail?.facts && detail.facts.length > 0 && (
          <dl className="p-pill-facts">
            {detail.facts.map(([label, value]) => <Fragment key={label}><dt>{label}</dt><dd>{value}</dd></Fragment>)}
          </dl>
        )}
        {detail?.raw && (
          <details className="p-pill-raw">
            <summary><CaretRightIcon size={10} weight="bold" />Raw response</summary>
            <pre className="p-pill-detail">{detail.raw}</pre>
          </details>
        )}
        {(detail?.raw !== undefined || action !== undefined) && (
          <div className="p-pill-foot">
            {detail?.raw && <CopyRawButton text={detail.raw} />}
            {actionButton}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="p-pill" data-tone={tone} data-notice={tone} role={role} {...hooks}>
      <NoticeMark tone={tone} />
      <span ref={words} className="p-pill-body">
        {title && <span className="p-pill-source">{title}</span>}
        {text && <span className="p-pill-text">{text}</span>}
        {dim && <span className="p-pill-dim">{dim}</span>}
      </span>
      {opens && (
        <button type="button" className="p-pill-icon" aria-label="Show more" aria-expanded={false} onClick={() => setOpen(true)}>
          <CaretDownIcon size={13} weight="bold" />
        </button>
      )}
      {actionButton}
      {dismiss}
    </div>
  );
}

/** Copies a notice's raw detail, saying whether it took, as every copy in the app does. */
function CopyRawButton({ text }: { text: string }) {
  const { status, copy } = useCopy();

  return (
    <button type="button" onClick={() => copy(text)}
      className={`p-pill-action !bg-transparent ${status === "failed" ? "p-danger" : "p-text-3"}`}>
      {status === "copied" ? <CheckIcon size={13} /> : <CopyIcon size={13} />}{copyLabel(status)}
    </button>
  );
}

/** The notices, newest nearest the prompt box; past {@link SHOWN_NOTICES}, the oldest wait behind one count. */
function Notices({ notices }: { notices: readonly ComposerNotice[] }) {
  const [all, setAll] = useState(false);
  const folded = all ? 0 : Math.max(0, notices.length - SHOWN_NOTICES);

  if (notices.length === 0) return null;

  return (
    <div className="p-pills" aria-label="Notices">
      {folded > 0 && (
        <button type="button" className="p-pill-more" onClick={() => setAll(true)}>
          <CaretUpIcon size={11} weight="bold" />{folded} more
        </button>
      )}
      {notices.slice(folded).map((n) => <Notice key={n.id} notice={n} />)}
    </div>
  );
}

/** Who a provider's wait is on, and for how long, until the wait ends. */
export function useProviderWaitNotice(wait: ProviderWaitShown | null): ComposerNotice[] {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (wait === null) return undefined;
    let tick: number | undefined;

    // On each whole second the wait has left, so the count reads 3s, 2s, 1s and the notice leaves at the wait's end.
    const count = () => {
      const at = Date.now();
      const left = wait.untilMs - at;

      setNow(at);

      const partial = left % 1_000;

      if (left > 0) tick = window.setTimeout(count, partial === 0 ? 1_000 : partial);
    };

    count();

    return () => window.clearTimeout(tick);
  }, [wait]);

  const left = wait === null ? 0 : wait.untilMs - now;

  if (wait === null || left <= 0) return [];

  const of = wait.retry === undefined || wait.retries === undefined ? "" : ` · ${String(wait.retry)} of ${String(wait.retries)}`;

  return [{
    id: "provider-wait", tone: "progress", title: providerName(wait.provider), text: "asked to wait",
    dim: `retrying in ${fmtSpan(Math.ceil(left / 1_000) * 1_000)}${of}`,
  }];
}

/**
 * What failed to load, why in the reasons' own words, and what still works in the quiet ink: one line, which opens
 * when it is cut. Neither tone disables the composer; that belongs to the socket.
 */
export function workspaceLoadNotice(notice: WorkspaceNotice, onRetry: () => void): ComposerNotice {
  const mapped: ComposerNotice = {
    id: "load",
    tone: notice.severity === "blocking" ? "danger" : "warning",
    title: notice.title,
  };

  if (notice.detail !== "") mapped.text = notice.detail;

  if (notice.scope !== "") mapped.dim = notice.scope;

  if (notice.retry !== null) mapped.action = { label: notice.retry, onClick: onRetry };

  return mapped;
}

const MODE_TITLE = {
  build: "Auto. The agent makes the change, or submits a plan first when you ask for one or the work warrants it.",
  plan: "Plan. Review a plan before anything changes.",
} satisfies Record<WorkMode, string>;

/**
 * Plan is a trust boundary (the agent changes nothing until a plan is approved), so it is a two-item segment,
 * not an ambiguous toggle. The wire value for Auto stays `build`.
 */
function ModeSegment({ value, onChange, disabled }: {
  value: WorkMode; onChange: (mode: WorkMode) => void; disabled: boolean;
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

interface ComposerProps {
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
  mode?: { value: WorkMode; onChange: (mode: WorkMode) => void };
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
    <div data-composer-root className="@container mx-auto w-full max-w-[var(--layout-composer)] px-3 pb-3 sm:px-5 sm:pb-4"
      onPaste={(e) => {
        if (attachments) pasteAttachments(e, attachments, (text) => onValueChange(value === "" ? text : `${value}\n${text}`));
      }}>
      {notices && <Notices notices={notices} />}

      {attention}

      <div className="p-composer">
        {attachments && <AttachmentTray attachments={attachments} />}

        {/* Shift+Enter is the field's own line break; Enter alone sends. */}
        <TextArea bare data-composer-field ref={textareaRef} value={value} onChange={(e) => onValueChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || composing(e.nativeEvent)) return;

            e.preventDefault();
            submit?.();
          }}
          placeholder={placeholder} disabled={disabled} rows={1} className="t-composer max-h-56 overflow-y-auto" />

        <div className="flex flex-wrap items-center gap-x-1 gap-y-2 px-2 pt-1 pb-2">
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
                <span className="t-meta hidden @[30rem]:inline">{recoverLabel}</span>
              </button>
            )}
            {canBranch && (
              <button type="button" onClick={onBranch}
                className="p-composer-quiet"
                aria-label="Run the draft as a parallel branch"
                title="Answer beside the live turn, then compare. Neither turn interrupts the other.">
                <GitBranchIcon size={15} />
                <span className="t-meta hidden @[30rem]:inline">Branch</span>
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
