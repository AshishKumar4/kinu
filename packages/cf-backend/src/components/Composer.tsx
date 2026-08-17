/**
 * The composer — the one place a user acts on a conversation.
 *
 * One component for all three chat surfaces (workspace chat, subordinate chat,
 * and the design gallery). It used to be three hand-copied blocks, and they had
 * already drifted apart in the way that matters most: the gallery's copy — the
 * surface the product is screenshotted from — had no mode control, no
 * attachments and no status row, so it photographed a composer that did not
 * exist.
 *
 * Layout follows the arrangement the owner uses in his own agent workspace
 * (OpenSeal's session composer): the draft on top, then ONE toolbar inside the
 * same card, with the controls that describe HOW the turn runs on the left
 * (mode, model) and the actions that START or STOP it on the right. No divider
 * between draft and toolbar — the card is one object, not two stacked strips.
 *
 * The model selector belongs here rather than in the workspace bar because it is
 * a property of the turn you are about to send. It already sat beside the
 * subordinate composer, so the bar was the outlier, not this.
 *
 * While a turn runs the right-hand group is THREE actions, not one: Stop
 * abandons the turn, Branch answers the draft beside it, and Steer hands the
 * draft to the turn already running. Before this the only mid-stream action was
 * Stop and a bare Branch glyph — Enter called a send that early-returned while
 * streaming, so typing to a working agent did nothing at all and said nothing
 * about it.
 */
import { useRef, type ReactNode } from "react";
import { InputArea, Loader } from "@cloudflare/kumo";
import {
  PaperPlaneRightIcon, PaperclipIcon, StopIcon, GitBranchIcon, ArrowBendUpRightIcon,
  LightningIcon, NotePencilIcon, WarningCircleIcon, InfoIcon, CheckCircleIcon,
} from "@phosphor-icons/react";
import type { FileUIPart } from "ai";
import { AttachmentChip } from "@/components/AttachmentChip";

export type ChatMode = "plan" | "build";

/** Tones a status row can take. `progress` is `neutral` plus a spinner — it is
 *  a state, not a colour, so it gets no tint of its own. */
export type NoticeTone = "danger" | "warning" | "info" | "success" | "neutral" | "progress";

/**
 * One inline status. This is the composer's answer to "no spam, but no
 * silence": something that failed or changed stays on screen, in the tone that
 * says which it was, carrying the action that resolves it — rather than raw
 * coloured text, or a toast that has already gone.
 */
export interface ComposerNotice {
  id: string;
  tone: NoticeTone;
  text: string;
  /** The way out. A notice reporting a failure should almost always have one. */
  action?: { label: string; icon?: ReactNode; onClick: () => void };
  onDismiss?: () => void;
}

/** Tone → the tint class and the glyph naming what kind of status it is. */
const NOTICE_TONE = {
  danger:   { cls: "p-notice-danger",  icon: <WarningCircleIcon size={13} className="shrink-0" /> },
  warning:  { cls: "p-notice-warning", icon: <WarningCircleIcon size={13} className="shrink-0" /> },
  info:     { cls: "p-notice-info",    icon: <InfoIcon size={13} className="shrink-0" /> },
  success:  { cls: "p-notice-success", icon: <CheckCircleIcon size={13} className="shrink-0" /> },
  neutral:  { cls: "p-notice-neutral", icon: <InfoIcon size={13} className="shrink-0" /> },
  progress: { cls: "p-notice-neutral", icon: <Loader size="sm" /> },
} satisfies Record<NoticeTone, { cls: string; icon: ReactNode }>;

/** A status row: what happened, and the way out of it. */
function Notice({ notice }: { notice: ComposerNotice }) {
  const { tone, text, action, onDismiss } = notice;
  const { cls, icon } = NOTICE_TONE[tone];
  return (
    <div className={`flex items-start gap-2 px-2.5 py-1.5 p-meta ${cls}`}
      role={tone === "danger" ? "alert" : "status"}>
      <span className="mt-px shrink-0">{icon}</span>
      {/* Wraps to two lines rather than truncating: in a narrow chat column a
          single-line clamp cut "Couldn't refresh live data for MCTS." down to
          "Co…", which is a silence wearing the costume of a status. */}
      <span className="min-w-0 flex-1 line-clamp-2" title={text}>{text}</span>
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

/**
 * Auto ⇄ Plan. Kept as a two-item segment rather than the single toggle the
 * owner's own composer uses, because Plan here is a mechanical trust boundary
 * (`submit_plan` exists only on a Plan turn) rather than a label: a lone chip
 * reading "Plan" cannot say whether that is the current mode or the one you
 * would switch to, and getting that wrong picks the wrong tool surface. With a
 * plan awaiting a decision the segment locks to Plan and says why, instead of
 * silently refusing the click.
 *
 * The unrestricted mode is shown as "Auto" while the wire value stays `build`
 * (`WorkMode = 'plan' | 'build'` in core): the label is what the system calls
 * this to a person, and it must not disagree with the rest of the product.
 */
function ModeSegment({ value, onChange, locked, disabled }: {
  value: ChatMode; onChange: (mode: ChatMode) => void; locked: boolean; disabled: boolean;
}) {
  const item = (mode: ChatMode, Icon: typeof LightningIcon, label: string, hint: string, activeCls: string) => (
    <button type="button" onClick={() => onChange(mode)}
      disabled={disabled || (locked && mode === "build")}
      aria-pressed={value === mode}
      title={locked && mode === "build" ? "Approve the active plan before starting an Auto turn." : hint}
      className={`flex items-center gap-1 rounded-sm px-2 py-1 p-meta font-medium transition-colors disabled:opacity-40 ${value === mode ? activeCls : "p-text-3 hover:p-text-2"}`}>
      <Icon size={12} />{label}
    </button>
  );
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-md border p-border p-fill p-0.5"
      role="group" aria-label="Turn mode">
      {item("build", LightningIcon, "Auto", "Auto — the agent implements the change and shows you what it ran.", "p-surface p-text")}
      {item("plan", NotePencilIcon, "Plan", "Plan — review a plan before anything changes.", "p-accent-subtle p-accent")}
    </div>
  );
}

export interface ComposerProps {
  value: string;
  onValueChange: (value: string) => void;
  onSend: () => void;
  placeholder: string;
  /** The socket is not usable — every control goes inert. */
  disabled: boolean;
  streaming: boolean;
  onStop: () => void;
  /** Statuses above the draft, oldest first. Empty renders nothing. */
  notices?: readonly ComposerNotice[];
  /** Turn mode. Omitted on surfaces that have none (subordinates inherit it). */
  mode?: { value: ChatMode; onChange: (mode: ChatMode) => void; locked: boolean };
  /** Attachments. Omitted where the surface cannot take files. */
  attachments?: {
    parts: readonly FileUIPart[];
    onAdd: (files: FileList | null | undefined) => void;
    onRemove: (index: number) => void;
  };
  /** The model selector, passed in because it is a connected component and this
   *  one has to stay renderable without a socket. */
  modelPicker?: ReactNode;
  /**
   * Send WITHOUT stopping the turn: the draft is spliced into the agent's next
   * step. Wired ⇒ the composer keeps a working submit action while streaming,
   * which is the difference between "you must stop the agent to say anything"
   * and a conversation.
   */
  onSteer?: () => void;
  /** Run the draft as a parallel take instead of steering or interrupting.
   *  Only offered mid-stream, and never in Plan mode. */
  onBranch?: () => void;
  textareaRef?: React.Ref<HTMLTextAreaElement>;
}

export function Composer({
  value, onValueChange, onSend, placeholder, disabled, streaming, onStop,
  notices, mode, attachments, modelPicker, onSteer, onBranch, textareaRef,
}: ComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const empty = value.trim() === "" && (attachments?.parts.length ?? 0) === 0;
  const canBranch = Boolean(onBranch) && streaming && !empty && mode?.value !== "plan";
  // While a turn runs the primary action STEERS it. Enter has to reach the same
  // thing the button does — an Enter that silently does nothing is the defect
  // this replaces, and the composer was in exactly that state whenever the
  // agent was working.
  const submit = streaming ? onSteer : onSend;

  return (
    // @container: the action row labels itself when there is room and falls back
    // to icons in a dragged-narrow chat column, without depending on which
    // surface mounted it.
    <div className="@container px-4 py-3 lg:px-6"
      onPaste={(e) => {
        if (attachments && e.clipboardData.files.length > 0) {
          e.preventDefault();
          attachments.onAdd(e.clipboardData.files);
        }
      }}>
      {notices && notices.length > 0 && (
        <div className="mb-2 space-y-1.5">
          {notices.map((n) => <Notice key={n.id} notice={n} />)}
        </div>
      )}

      <div className="p-composer">
        {attachments && attachments.parts.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {attachments.parts.map((part, i) => (
              <AttachmentChip key={`${part.filename ?? "file"}-${i}`} part={part}
                onRemove={() => attachments.onRemove(i)} />
            ))}
          </div>
        )}

        <InputArea ref={textareaRef} value={value} onValueChange={onValueChange}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit?.(); } }}
          placeholder={placeholder} disabled={disabled} rows={1}
          className="w-full max-h-56 resize-none overflow-y-auto !border-0 px-3.5 pt-3 pb-1 !bg-transparent !shadow-none !outline-none !ring-0 focus:!ring-0" />

        {/* One toolbar: how the turn runs on the left, what starts it on the
            right. It WRAPS, because a chat column can be dragged to ~190px and
            an unwrapped row pushed the send button off the card entirely. When
            it wraps, the model picker and the actions take the second line and
            `ml-auto` keeps send on the right. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-2.5 pb-2.5">
          {attachments && (
            <>
              <input ref={fileInputRef} type="file" multiple className="hidden"
                onChange={(e) => { attachments.onAdd(e.currentTarget.files); e.currentTarget.value = ""; }} />
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={disabled}
                className="p-btn-ghost shrink-0 cursor-pointer p-1.5" aria-label="Attach files" title="Attach files">
                <PaperclipIcon size={15} />
              </button>
            </>
          )}

          {mode && (
            <ModeSegment value={mode.value} onChange={mode.onChange} locked={mode.locked}
              disabled={disabled || streaming} />
          )}

          {modelPicker}

          {/* Three actions, one model, while the agent works: Stop abandons the
              turn, Branch answers the draft beside it, Steer hands the draft to
              the turn already running. They are named rather than tooltipped —
              the moment a user needs to tell them apart is the moment they are
              deciding, and a hover title is not available then. */}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {streaming && (
              <button type="button" onClick={onStop}
                className="p-btn-quiet inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 px-2"
                aria-label="Stop this turn"
                title="Stop: abandon this turn. Anything you have queued comes back to the composer.">
                <StopIcon size={14} weight="fill" />
                <span className="hidden @[30rem]:inline p-meta">Stop</span>
              </button>
            )}
            {canBranch && (
              <button type="button" onClick={onBranch}
                className="p-btn-quiet inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 px-2"
                aria-label="Run the draft as a parallel branch"
                title="Branch: answer this beside the live turn, then compare. Neither one interrupts the other.">
                <GitBranchIcon size={15} />
                <span className="hidden @[30rem]:inline p-meta">Branch</span>
              </button>
            )}
            {streaming
              ? <button type="button" onClick={onSteer} disabled={empty || disabled || !onSteer}
                  className="p-btn inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 px-2.5"
                  aria-label="Steer the running turn"
                  title="Steer: give this to the turn already running. It lands at the agent's next step — nothing is interrupted.">
                  <ArrowBendUpRightIcon size={15} weight="bold" />
                  <span className="hidden @[30rem]:inline p-meta">Steer</span>
                </button>
              : <button type="button" onClick={onSend} disabled={empty || disabled}
                  className="p-btn inline-flex size-8 cursor-pointer items-center justify-center"
                  aria-label="Send">
                  <PaperPlaneRightIcon size={15} />
                </button>}
          </div>
        </div>
      </div>
    </div>
  );
}
