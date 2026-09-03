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
  StopIcon, GitBranchIcon, ArrowBendUpRightIcon,
  WarningCircleIcon, InfoIcon, CheckCircleIcon,
} from "@phosphor-icons/react";
import type { FileUIPart } from "ai";
import { AttachmentChip } from "@/components/AttachmentChip";

const CHAT_MODES = ["build", "plan"] as const;
export type ChatMode = (typeof CHAT_MODES)[number];

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
  return (
    <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Turn mode">
      {CHAT_MODES.map((mode) => {
        const build = mode === "build";
        const selected = value === mode;
        const title = build && locked
          ? "Approve the active plan before starting an Auto turn."
          : build
            ? "Auto. The agent makes the change and shows what it ran."
            : "Plan. Review a plan before anything changes.";
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
                ? "border-[rgba(224,164,88,.3)] bg-[rgba(224,164,88,.1)] p-gold"
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

/** The clipboard's files, deduplicated only by repeated item/File identity.
 *
 * A clipboard source can expose the SAME File through repeated item flavors, and
 * attaching it twice claims the user pasted two. File metadata is NOT identity:
 * two receipts can share a name, byte length, MIME type and timestamp while
 * holding different bytes, so the old metadata key silently dropped one.
 */
export function pastedFiles(data: DataTransfer): FileList {
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
  // DataTransfer.files is authoritative when a browser supplies no matching
  // items. Keep it intact rather than guessing file identity from metadata.
  return unique.files.length === 0 || unique.files.length === files.length ? files : unique.files;
}

/** Clipboard text alongside files, if any. Presence is decided by the
 * clipboard's string flavors, never by inspecting their content: a path or
 * filename can be exactly what the user meant to paste. A textarea cannot keep
 * HTML formatting, so an HTML-only flavor contributes its rendered text and
 * falls back to the raw string when the markup has no text node. */
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
  /** The socket is not usable — every control goes inert. */
  disabled: boolean;
  streaming: boolean;
  onStop: () => void;
  /** Statuses above the draft, oldest first. Empty renders nothing. */
  notices?: readonly ComposerNotice[];
  /** Turn mode. Every agent conversation passes its own; omitted only on
   *  static gallery frames that photograph the composer without one. */
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
    <div data-composer-root className="@container mx-auto w-full max-w-[820px] px-4 py-3.5 sm:px-5"
      onPaste={(e) => {
        if (!attachments) return;
        const files = pastedFiles(e.clipboardData);
        if (files.length === 0) return; // a plain text paste — the browser's own insertion is right
        attachments.onAdd(files);
        const text = pastedText(e.clipboardData);
        // File-only means the clipboard carries no string flavor. Never infer
        // that from the string's content: a filename can be the intended text.
        if (text === "") { e.preventDefault(); return; }
        // Mixed content. When a plain flavor exists, the browser's insertion
        // preserves it at the caret and in the undo stack, so only the files
        // need our handling. An HTML-only flavor needs plain-text insertion
        // because a textarea cannot accept rich content.
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
        {attachments && attachments.parts.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {attachments.parts.map((part, i) => (
              <AttachmentChip key={`${part.filename ?? "file"}-${i}`} part={part}
                onRemove={() => attachments.onRemove(i)} />
            ))}
          </div>
        )}

        <InputArea ref={textareaRef} value={value} onValueChange={onValueChange}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            // An Enter that commits IME composition belongs to the IME, not the
            // composer: submitting on it sends a half-composed draft. keyCode
            // 229 is the same fact on engines that fire a trailing keydown
            // after compositionend.
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
            if (e.shiftKey) {
              // Kumo's controlled InputArea does not supply the textarea's
              // native line break. Insert at the selection and restore its
              // caret after React commits the controlled value.
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

        {/* One toolbar: how the turn runs on the left, what starts it on the
            right. It WRAPS, because a chat column can be dragged to ~190px and
            an unwrapped row pushed the send button off the card entirely. When
            it wraps, the model picker and the actions take the second line and
            `ml-auto` keeps send on the right. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 pt-2 pb-3">
          {attachments && (
            <>
              <input ref={fileInputRef} type="file" multiple className="hidden"
                onChange={(e) => { attachments.onAdd(e.currentTarget.files); e.currentTarget.value = ""; }} />
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={disabled}
                className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border p-border px-3 py-1 text-xs p-text-3 transition-colors hover:p-gold hover:border-[var(--c-accent)]"
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
            <div className="min-w-0 flex-1 basis-32 max-w-44 focus-within:rounded-sm focus-within:ring-1 focus-within:ring-[var(--c-accent)] [&_input]:!bg-transparent [&_input]:!ring-transparent">
              {modelPicker}
            </div>
          )}

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
                title="Stop this turn. Queued messages run next.">
                <StopIcon size={14} weight="fill" />
                <span className="hidden @[30rem]:inline p-meta">Stop</span>
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
              ? <button type="button" onClick={onSteer} disabled={empty || disabled || !onSteer}
                  className="p-btn inline-flex h-[30px] cursor-pointer items-center justify-center gap-1.5 rounded-full px-[18px] text-[12.5px]"
                  aria-label="Steer the running turn"
                  title="Send this to the running turn. It arrives at the agent's next step.">
                  <ArrowBendUpRightIcon size={14} weight="bold" />
                  Steer
                </button>
              : <button type="button" onClick={onSend} disabled={empty || disabled}
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
