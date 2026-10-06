/** A turn the person did not type, drawn as its card. */
import { useState } from "react";
import {
  CaretDownIcon, CaretRightIcon, CheckCircleIcon, ClockIcon, EyeIcon, GearSixIcon, LightningIcon, ProhibitIcon, WarningCircleIcon,
} from "@phosphor-icons/react";
import {
  ADVISOR_SEVERITY_LABEL, eventSourceLabel, eventVariantLabel, MAIN_AGENT, parseDrainedEvents,
  type AdvisorSeverity, type ClassifiedProgrammaticTurn, type DrainedEvent, type SignalCard,
} from "@kinu.run/core";

export type CardState = SignalCard["state"];

function ShownCaption({ state }: { state: CardState }) {
  return (
    <>
      <span aria-hidden>·</span>
      <span>{state === "pending" ? "to be shown to the agent" : "shown to the agent"}</span>
    </>
  );
}

function backgroundEventMeta(status: string) {
  if (status === "completed") return { Icon: CheckCircleIcon, tone: "p-success", verb: "completed" };

  if (status === "cancelled") return { Icon: ProhibitIcon, tone: "p-text-3", verb: "was cancelled" };

  return { Icon: WarningCircleIcon, tone: "p-danger", verb: "failed" };
}

function BackgroundEventCard({ kind, status, state }: { kind: string; status: string; state: CardState }) {
  const meta = backgroundEventMeta(status);

  return (
    <div className="animate-fade-in">
      <div className="flex w-full items-baseline gap-2.5 rounded-lg border border-[rgba(224,164,88,.25)] bg-[rgba(224,164,88,.05)] px-4 py-2.5">
        <span className="shrink-0 p-t-status p-accent">System</span>
        <div className="min-w-0 flex-1 p-row-text p-text-2 opacity-80">
          Background <span className="p-annotation">{kind}</span> task {meta.verb}
          <span className="ml-1 inline-flex items-center gap-1 p-text-3"><ShownCaption state={state} /></span>
        </div>
        <meta.Icon size={12} className={`shrink-0 ${meta.tone}`} weight="fill" />
      </div>
    </div>
  );
}

function DrainedEventRow({ event }: { event: DrainedEvent }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <button
      type="button"
      onClick={() => setExpanded(!expanded)}
      className="w-full rounded-md px-2 py-2 text-left transition-colors hover:p-elevated"
      data-drained-event={event.variant}
      data-reply-expected={event.replyExpected || undefined}
    >
      <div className="flex items-center gap-1.5 p-row-text">
        <span className="shrink-0 font-medium p-text-2">{eventVariantLabel(event.variant)}</span>
        <span className="min-w-0 truncate p-text-3">{eventSourceLabel(event.source)}</span>
        {event.replyExpected && (
          <span className="shrink-0 rounded-sm px-1 py-0.5 p-badge-warning" title="The sender is waiting on the agent's reply">
            reply expected
          </span>
        )}
        <span className="ml-auto shrink-0 p-text-3">
          {expanded ? <CaretDownIcon size={10} /> : <CaretRightIcon size={10} />}
        </span>
      </div>
      <div className={`mt-0.5 p-row-text p-text-2 opacity-80 ${expanded ? "whitespace-pre-wrap break-words" : "truncate"}`}>
        {event.brief}
      </div>
    </button>
  );
}

/** The operator did not type drained events, so they never wear the user bubble. */
function DrainedEventsCard({ text, state }: { text: string; state: CardState }) {
  const events = parseDrainedEvents(text);

  return (
    <div className="animate-fade-in">
      <div className="w-full rounded-lg border border-[rgba(224,164,88,.25)] bg-[rgba(224,164,88,.05)] px-4 py-2.5">
        <div className="flex items-baseline gap-2.5 p-row-text">
          <LightningIcon size={11} className={`shrink-0 ${state === "pending" ? "p-text-4" : "p-accent"}`} weight="fill" />
          <span className="shrink-0 font-semibold p-accent">System</span>
          <span className="p-text-3"><ShownCaption state={state} /></span>
          {events.length > 1 && <span className="ml-auto shrink-0 p-text-3 tabular-nums">{events.length} events</span>}
        </div>
        <div className="mt-1.5 divide-y divide-dashed divide-[var(--c-dash)]">
          {events.length > 0
            ? events.map((event, i) => <DrainedEventRow key={i} event={event} />)
            /* Format drift: show what the agent was given rather than nothing. */
            : <div className="p-row-text p-text-2 opacity-80 whitespace-pre-wrap break-words">{text}</div>}
        </div>
      </div>
    </div>
  );
}

/** Approved commands have not executed yet (the agent re-issuing them runs them), so never "ran". */
function DeferredApprovalCard({ decision, count, state }: {
  decision: string; count: number; state: CardState;
}) {
  const approved = decision === "approved";
  const Icon = approved ? CheckCircleIcon : ProhibitIcon;

  return (
    <div className="flex justify-center animate-fade-in py-1">
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full p-elevated border p-border p-row-text p-text-2">
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

function SystemEventCard({ label = "System", event, text, state }: {
  label?: string; event: string; text: string; state: CardState;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="animate-fade-in" data-system-event={event}>
      <div className="w-full rounded-lg border border-[rgba(224,164,88,.25)] bg-[rgba(224,164,88,.05)] px-4 py-2.5">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-baseline gap-2.5 text-left p-row-text"
          aria-expanded={expanded}
        >
          <GearSixIcon size={11} className="shrink-0 p-accent" weight="fill" />
          <span className="shrink-0 font-semibold p-accent">{label}</span>
          <span className="p-text-4">{event.replace(/_/g, " ")}</span>
          <span className="p-text-3"><ShownCaption state={state} /></span>
          <span className="ml-auto shrink-0 p-text-3">
            {expanded ? <CaretDownIcon size={10} /> : <CaretRightIcon size={10} />}
          </span>
        </button>
        <div className={`mt-1 p-row-text p-text-2 opacity-80 ${expanded ? "whitespace-pre-wrap break-words" : "truncate"}`}>
          {text}
        </div>
      </div>
    </div>
  );
}

const ADVISOR_TONES = {
  nit: { panel: "border p-border p-elevated", icon: "p-text-3", badge: "p-badge-neutral" },
  concern: { panel: "p-notice-warning", icon: "p-warning", badge: "p-badge-warning" },
  blocker: { panel: "p-notice-danger", icon: "p-danger", badge: "p-badge-danger" },
} satisfies Record<AdvisorSeverity, { panel: string; icon: string; badge: string }>;

function AdvisorCard({ severity, text, state }: {
  severity: AdvisorSeverity; text: string; state: CardState;
}) {
  const tone = ADVISOR_TONES[severity];

  return (
    <div className="flex justify-center animate-fade-in py-1" data-advisor-severity={severity}>
      <div className={`w-full max-w-[85%] rounded-xl px-3 py-2 ${tone.panel}`}>
        <div className="flex items-center gap-1.5 p-meta p-text-3">
          <EyeIcon size={11} className={`shrink-0 ${tone.icon}`} weight="fill" />
          <span className="font-medium p-text-2">Advisor</span>
          <span className={`px-1.5 ${tone.badge}`}>{ADVISOR_SEVERITY_LABEL[severity]}</span>
          <ShownCaption state={state} />
        </div>
        <div className="mt-1 p-row-text p-text-2 whitespace-pre-wrap break-words">{text}</div>
      </div>
    </div>
  );
}

interface TurnCardProps {
  turn: ClassifiedProgrammaticTurn; text: string; state: CardState;
}

/** The workspace's own opening turn is provenance and draws nothing; every other card says where its signal is. */
export function ProgrammaticTurnCard(props: TurnCardProps) {
  if (props.turn.kind === "workspace_created") return null;

  return <div data-signal-card={props.state}><TurnCard {...props} /></div>;
}

function TurnCard({ turn, text, state }: TurnCardProps) {
  if (turn.kind === "background_job") {
    return <BackgroundEventCard kind={turn.jobKind} status={turn.status} state={state} />;
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

  if (turn.kind === "delegated_task") {
    return <SystemEventCard label="Task" event={`from ${turn.from === MAIN_AGENT ? "Main" : turn.from}`} text={text} state={state} />;
  }

  return <DrainedEventsCard text={text} state={state} />;
}
