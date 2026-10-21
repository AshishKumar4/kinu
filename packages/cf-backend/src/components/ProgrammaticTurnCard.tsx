/** A turn the person did not type, drawn as quiet event rows: one line each, open on a click, repeats folded. */
import { useState, type ReactNode } from "react";
import {
  CaretUpIcon, CheckCircleIcon, CheckIcon, ClockIcon, EnvelopeSimpleIcon, EyeIcon, GearSixIcon, LightningIcon, ProhibitIcon, WarningCircleIcon,
  type Icon,
} from "@phosphor-icons/react";
import {
  ADVISOR_SEVERITY_LABEL, eventSourceLabel, eventVariantLabel, keptAdvisorNote, MAIL_HANDED_EVENT, MAIN_AGENT, parseDrainedEvents,
  type AdvisorSeverity, type ClassifiedProgrammaticTurn, type DrainedEvent, type SignalCard,
} from "@kinu.run/core";

export type CardState = SignalCard["state"];

/** Amber while the event waits for the agent or is being read, green once the step that read it has ended. */
const DELIVERY = {
  pending: { mark: ClockIcon, tone: "p-warning", word: "waiting", said: "Waiting for the agent to read it" },
  shown: { mark: ClockIcon, tone: "p-warning", word: "waiting", said: "The agent is reading it" },
  seen: { mark: CheckIcon, tone: "p-success", word: "seen", said: "Seen by the agent" },
} as const satisfies Record<CardState, { readonly mark: Icon; readonly tone: string; readonly word: string; readonly said: string }>;

/** Whether the agent has seen the event yet, in a word and a mark. */
function DeliveryMark({ state }: { state: CardState }) {
  const { mark: Mark, tone, word, said } = DELIVERY[state];

  return (
    <span className={`p-pill-said ${tone}`} title={said} data-delivery={state}>
      <Mark size={11} weight="bold" aria-hidden />{word}
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
  /** The event's words: one line until opened. Absent when it has none beyond its label. */
  readonly body?: string | undefined;
  /** More words, shown only once opened: what a person wrote that came with it. */
  readonly detail?: string | undefined;
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

/** One event where it happened: a quiet pill with what happened, from whom, its words on one line, and whether the
 *  agent has seen it. A click opens it in place into a card of the same edge. */
export function EventRow({ icon: Mark, tone, label, source, body, detail, state, count = 1, badge, open: opened = false, action, hooks }: EventRowProps) {
  const [open, setOpen] = useState(opened);

  const tail = (
    <>
      {count > 1 && <span className="p-pill-count" data-event-repeats={count}>×{count}</span>}
      {state !== undefined && <DeliveryMark state={state} />}
    </>
  );

  const who = (
    <span data-event-source className="p-pill-source">
      {label}
      {source !== undefined && <span className="ml-2 font-normal p-text-3">{source}</span>}
    </span>
  );

  return (
    <div className="flex justify-center py-px animate-fade-in" {...hooks}>
      {open ? (
        <div className="p-pill" data-history data-open>
          <div className="p-pill-head">
            <span className="p-pill-mark"><Mark size={14} weight="fill" className={tone} aria-hidden /></span>
            <span className="p-pill-body">{who}{badge}</span>
            {tail}
            <button type="button" className="p-pill-icon -my-1 -mr-2" aria-label="Show less" aria-expanded onClick={() => setOpen(false)}>
              <CaretUpIcon size={12} weight="bold" />
            </button>
          </div>
          {body !== undefined && <p data-event-brief className="t-body mt-2 ml-6 whitespace-pre-wrap break-words p-text-2">{body}</p>}
          {detail !== undefined && <p className="t-body mt-2 ml-6 whitespace-pre-wrap break-words p-text-3">{detail}</p>}
          {action !== undefined && <div className="mt-2 ml-6">{action}</div>}
        </div>
      ) : (
        <span className="p-pill-line">
          <button type="button" className="p-pill" data-history aria-expanded={false} onClick={() => setOpen(true)}>
            <span className="p-pill-mark"><Mark size={14} weight="fill" className={tone} aria-hidden /></span>
            <span className="p-pill-body">
              {who}
              {badge}
              {body !== undefined && <span data-event-brief className="p-pill-text truncate">{body}</span>}
            </span>
            {tail}
          </button>
          {action}
        </span>
      )}
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

  // Format drift: what the agent was given is its own to read, so the person is told only that events came.
  if (events.length === 0) {
    return <EventRow icon={LightningIcon} tone="p-accent" label="Events" state={state} count={count} />;
  }

  return foldRepeats(events, drainedKey).map(({ item: event, count: repeats }, index) => (
    <EventRow
      key={index}
      icon={event.variant === "email" ? EnvelopeSimpleIcon : LightningIcon}
      tone={DELIVERY[state].tone}
      label={eventVariantLabel(event.variant)}
      source={eventSourceLabel(event.source)}
      body={event.brief}
      state={state}
      count={repeats * count}
      badge={event.replyExpected && (
        <span className="t-meta shrink-0 rounded-sm px-1 p-badge-warning" title="The sender is waiting on the agent's reply">reply expected</span>
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

    // A job of no named kind is classified as kind `task`: said once, not "task task".
    const what = turn.jobKind === "task" ? "task" : `${turn.jobKind} task`;

    return <EventRow icon={meta.icon} tone={meta.tone} label="Background job" body={`${what} ${meta.verb}`} state={state} count={count} />;
  }

  if (turn.kind === "deferred_approval") {
    // `always` approves too, and stops the asking for those checks; only `denied` refuses.
    const approved = turn.decision === "approved" || turn.decision === "always";
    let said = approved ? "approved" : "denied";

    if (turn.decision === "always") said = "always allowed";

    // Approved commands have not executed yet (the agent re-issuing them runs them), so never "ran".
    return (
      <EventRow
        icon={approved ? CheckCircleIcon : ProhibitIcon}
        tone={approved ? "p-success" : "p-text-3"}
        label={`You ${said}`}
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
        badge={<span className={`t-meta shrink-0 px-1 ${tone.badge}`}>{ADVISOR_SEVERITY_LABEL[turn.severity]}</span>}
        body={turn.note ?? keptAdvisorNote(text, turn.severity) ?? undefined}
        state={state}
        count={count}
        open={turn.severity !== "nit"}
        hooks={{ "data-advisor-severity": turn.severity }}
      />
    );
  }

  // A hirer's task is its message, written for the agent to do: the person reads it as sent.
  if (turn.kind === "delegated_task") {
    const from = `from ${turn.from === MAIN_AGENT ? "Main" : turn.from}`;

    return <EventRow icon={GearSixIcon} tone="p-accent" label="Task" source={from} body={text} state={state} count={count} hooks={{ "data-system-event": from }} />;
  }

  if (turn.kind === "system_event") {
    const { label, about, line, detail } = turn.summary;

    return (
      <EventRow
        icon={turn.event === MAIL_HANDED_EVENT ? EnvelopeSimpleIcon : GearSixIcon}
        tone="p-accent"
        label={label}
        source={about}
        body={line}
        detail={detail}
        state={state}
        count={count}
        hooks={{ "data-system-event": turn.event }}
      />
    );
  }

  // The owner's answers in a line written for the transcript (`answeredSummary`), which the model never reads.
  if (turn.kind === "owner_answer") {
    return <EventRow icon={CheckCircleIcon} tone="p-success" label="You answered" body={text} state={state} count={count} />;
  }

  return <DrainedEvents text={text} state={state} count={count} />;
}
