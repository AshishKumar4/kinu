/** A turn the person did not type, drawn as quiet event rows: one line each, open on a click, repeats folded. */
import { useState, type ReactNode } from "react";
import {
  CaretRightIcon, CheckCircleIcon, ClockIcon, EyeIcon, GearSixIcon, LightningIcon, ProhibitIcon, WarningCircleIcon,
  type Icon,
} from "@phosphor-icons/react";
import {
  ADVISOR_SEVERITY_LABEL, eventSourceLabel, eventVariantLabel, MAIN_AGENT, parseDrainedEvents,
  type AdvisorSeverity, type ClassifiedProgrammaticTurn, type DrainedEvent, type SignalCard,
} from "@kinu.run/core";

export type CardState = SignalCard["state"];

/** Whether the agent has been shown the event yet, as a mark: the words sit in its title. */
function DeliveryMark({ state }: { state: CardState }) {
  const said = state === "pending" ? "Waiting to be shown to the agent" : "Shown to the agent";
  const Mark = state === "pending" ? ClockIcon : EyeIcon;

  return (
    <span className="inline-flex items-center" title={said} data-delivery={state}>
      <Mark size={11} aria-hidden />
      <span className="sr-only">{said}</span>
    </span>
  );
}

interface EventRowProps {
  readonly icon: Icon;
  readonly tone: string;
  /** What happened, short: "Agent report", "Background job". */
  readonly label: ReactNode;
  /** Who or what it came from. */
  readonly source?: ReactNode;
  /** The event's words: one line until opened. */
  readonly body: string;
  readonly state?: CardState;
  /** The same event this many times in a row, drawn once. */
  readonly count?: number;
  readonly badge?: ReactNode;
  /** Open from the start: what blocks the agent is not folded away. */
  readonly open?: boolean;
  /** One control beside the row, outside its toggle: a link to the agent the event is about. */
  readonly action?: ReactNode;
  readonly hooks?: Readonly<Record<`data-${string}`, string | undefined>>;
}

/** One event in a chat, in the chat's own row language: an icon, what happened, from whom, its words, a caret. */
export function EventRow({ icon: Mark, tone, label, source, body, state, count = 1, badge, open: opened = false, action, hooks }: EventRowProps) {
  const [open, setOpen] = useState(opened);

  return (
    <div className="flex items-start animate-fade-in" {...hooks}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="grid min-w-0 flex-1 cursor-pointer grid-cols-[20px_minmax(0,1fr)_auto_auto] items-baseline gap-2 rounded-md px-3 py-1 text-left transition-colors hover:bg-[var(--c-elevated)]"
      >
        <span className="flex size-5 items-center justify-center self-center">
          <Mark size={11} weight="fill" className={tone} aria-hidden />
        </span>
        <span className="flex min-w-0 items-baseline gap-2">
          {/* Gives way before the words do: on a phone a long sender left the event's words no room. */}
          <span data-event-source className="min-w-0 max-w-[55%] shrink overflow-hidden text-ellipsis whitespace-nowrap p-row-text font-medium p-text-2">
            {label}
            {source !== undefined && <span className="ml-1.5 font-normal p-text-3">{source}</span>}
          </span>
          {badge}
          <span data-event-brief className={`min-w-0 flex-1 p-row-text p-text-3 ${open ? "whitespace-pre-wrap break-words" : "truncate"}`}>
            {body}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 self-center p-meta p-text-4">
          {count > 1 && <span className="tabular-nums" data-event-repeats={count}>×{count}</span>}
          {state !== undefined && <DeliveryMark state={state} />}
        </span>
        <CaretRightIcon size={10} aria-hidden className={`shrink-0 self-center p-text-4 transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
      </button>
      {action}
    </div>
  );
}

/** Runs of the same thing in a row, each drawn once with how many times it came. */
export function foldRepeats<T>(items: readonly T[], keyOf: (item: T) => string): { item: T; count: number }[] {
  const folded: { item: T; key: string; count: number }[] = [];

  for (const item of items) {
    const key = keyOf(item);
    const last = folded.at(-1);

    if (last?.key === key) last.count += 1;
    else folded.push({ item, key, count: 1 });
  }

  return folded.map(({ item, count }) => ({ item, count }));
}

function backgroundEventMeta(status: string) {
  if (status === "completed") return { icon: CheckCircleIcon, tone: "p-success", verb: "completed" };

  if (status === "cancelled") return { icon: ProhibitIcon, tone: "p-text-3", verb: "was cancelled" };

  return { icon: WarningCircleIcon, tone: "p-danger", verb: "failed" };
}

const drainedKey = (event: DrainedEvent): string => JSON.stringify([event.variant, event.source, event.brief, event.replyExpected]);

/** The events the agent was handed in one batch, one row each; the same event twice in a row is one row. */
function DrainedEvents({ text, state, count }: { text: string; state: CardState; count: number }) {
  const events = parseDrainedEvents(text);

  // Format drift: show what the agent was given rather than nothing.
  if (events.length === 0) {
    return <EventRow icon={LightningIcon} tone="p-accent" label="System" body={text} state={state} count={count} />;
  }

  return foldRepeats(events, drainedKey).map(({ item: event, count: repeats }, index) => (
    <EventRow
      key={index}
      icon={LightningIcon}
      tone={state === "pending" ? "p-text-4" : "p-accent"}
      label={eventVariantLabel(event.variant)}
      source={eventSourceLabel(event.source)}
      body={event.brief}
      state={state}
      count={repeats * count}
      badge={event.replyExpected && (
        <span className="shrink-0 rounded-sm px-1 p-meta p-badge-warning" title="The sender is waiting on the agent's reply">reply expected</span>
      )}
      hooks={{ "data-drained-event": event.variant, "data-reply-expected": event.replyExpected ? "" : undefined }}
    />
  ));
}

const ADVISOR_TONES = {
  nit: { icon: "p-text-3", badge: "p-badge-neutral" },
  concern: { icon: "p-warning", badge: "p-badge-warning" },
  blocker: { icon: "p-danger", badge: "p-badge-danger" },
} satisfies Record<AdvisorSeverity, { icon: string; badge: string }>;

interface TurnCardProps {
  turn: ClassifiedProgrammaticTurn; text: string; state: CardState;
  /** The same turn this many times in a row, drawn once. */
  count?: number | undefined;
}

/** The workspace's own opening turn is provenance and draws nothing; every other says what happened and whether the agent saw it. */
export function ProgrammaticTurnCard(props: TurnCardProps) {
  if (props.turn.kind === "workspace_created") return null;

  return <div data-signal-card={props.state}><TurnCard {...props} /></div>;
}

function TurnCard({ turn, text, state, count = 1 }: TurnCardProps) {
  if (turn.kind === "background_job") {
    const meta = backgroundEventMeta(turn.status);

    return <EventRow icon={meta.icon} tone={meta.tone} label="Background job" body={`${turn.jobKind} task ${meta.verb}`} state={state} count={count} />;
  }

  if (turn.kind === "deferred_approval") {
    const approved = turn.decision === "approved";

    // Approved commands have not executed yet (the agent re-issuing them runs them), so never "ran".
    return (
      <EventRow
        icon={approved ? CheckCircleIcon : ProhibitIcon}
        tone={approved ? "p-success" : "p-text-3"}
        label={`You ${approved ? "approved" : "denied"}`}
        body={`${String(turn.count)} queued command${turn.count === 1 ? "" : "s"}`}
        state={state}
        count={count}
      />
    );
  }

  if (turn.kind === "advisor") {
    const tone = ADVISOR_TONES[turn.severity];

    return (
      <EventRow
        icon={EyeIcon}
        tone={tone.icon}
        label="Advisor"
        badge={<span className={`shrink-0 px-1.5 p-meta ${tone.badge}`}>{ADVISOR_SEVERITY_LABEL[turn.severity]}</span>}
        body={text}
        state={state}
        count={count}
        open={turn.severity !== "nit"}
        hooks={{ "data-advisor-severity": turn.severity }}
      />
    );
  }

  if (turn.kind === "system_event" || turn.kind === "delegated_task") {
    const task = turn.kind === "delegated_task";
    const event = task ? `from ${turn.from === MAIN_AGENT ? "Main" : turn.from}` : turn.event;

    return (
      <EventRow
        icon={GearSixIcon}
        tone="p-accent"
        label={task ? "Task" : "System"}
        source={event.replace(/_/g, " ")}
        body={text}
        state={state}
        count={count}
        hooks={{ "data-system-event": event }}
      />
    );
  }

  return <DrainedEvents text={text} state={state} count={count} />;
}
