/**
 * The chat's one disclosure for the work a turn does on its way to its answer (the owner, 2026-10-17): a dot and a line,
 * live while the work goes on; and a body that, while live, is a small view following its newest line, and opens in
 * full on a click. A turn's thinking and a run of its tool calls both draw through it; what the owner reads or answers
 * never does.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { CaretRightIcon } from "@phosphor-icons/react";
import { toolRunSummary, type RunStep, type ToolRunSummary } from "@kinu.run/core";
import { detach, diagnostics, toKinuError } from "@kinu.run/core/obs";
import { Effect } from "effect";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";

/** The dot and words a piece of work is headed by: pulsing and shimmering while it runs. */
export function WorkLabel({ live, failed = false, children }: { live: boolean; failed?: boolean; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className={`size-1.5 shrink-0 rounded-full ${failed ? "p-dot-danger" : "p-dot-accent"}${live ? " p-dot-pulse" : ""}`} aria-hidden />
      <span className={`t-item min-w-0 truncate${live ? " p-shimmer" : ""}`}>{children}</span>
    </span>
  );
}

/** Asks that a settled answer's phases be named; absent where nothing names them, as in a transcript or the gallery. */
export const PhaseLinesAsk = createContext<((messageId: string) => Effect.Effect<void>) | null>(null);

/** Answers this tab has asked for, so each is asked once however often it is drawn. */
const askedPhases = new Set<string>();

/** Asks through `rpc` for the caller's own chat, or the pane's agent named by `actor`. An answer not yet committed, or an
 *  ask that failed, is forgotten, so its next sighting asks again. */
export function phaseLinesAsker(rpc: WorkspaceRpc, actor: string | null): (messageId: string) => Effect.Effect<void> {
  return (messageId) => Effect.suspend(() => {
    const key = `${actor ?? ""}:${messageId}`;

    if (askedPhases.has(key)) return Effect.void;
    askedPhases.add(key);

    return Effect.catchCause(Effect.promise(async () => {
      if (!await rpc("namePhases", [actor === null ? { messageId } : { messageId, actor }])) askedPhases.delete(key);
    }), (cause) => Effect.sync(() => {
      askedPhases.delete(key);
      diagnostics.failure("chat.phase_lines_ask_failed", toKinuError({ doing: "asking for an answer's phase lines", cause, otherwise: "unavailable" }), { messageId });
    }));
  });
}

/** What a settled answer's lines ask once on screen; undefined while it runs, or where nothing names its phases. */
export function usePhaseLinesOnSeen(messageId: string, live: boolean): (() => Effect.Effect<void>) | undefined {
  const ask = useContext(PhaseLinesAsk);

  if (ask === null || live || messageId === "") return undefined;

  return () => ask(messageId);
}

/** Whether the element has been on screen; watched only while `wanted`. */
function useFirstSeen(element: RefObject<HTMLElement | null>, wanted: boolean): boolean {
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const box = element.current;

    if (!wanted || seen || box === null) return;

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;

      observer.disconnect();
      setSeen(true);
    });

    observer.observe(box);

    return () => observer.disconnect();
  }, [element, wanted, seen]);

  return seen;
}

/** What a closed, settled body shows: its first lines, or nothing. */
type Folded = "preview" | "hidden";

/** Whether a body folded to its first lines holds more than they show; one that folds away entirely always does. */
function useOverflows(body: RefObject<HTMLDivElement | null>, folded: Folded, measuring: boolean, follow: string): boolean {
  const [long, setLong] = useState(folded === "hidden");

  useLayoutEffect(() => {
    const box = body.current;

    if (folded === "hidden" || !measuring || box === null) return;
    const measure = () => setLong(box.scrollHeight > box.clientHeight + 1);
    const observer = new ResizeObserver(measure);

    measure();
    observer.observe(box);

    return () => observer.disconnect();
  }, [body, folded, measuring, follow]);

  return long;
}

export function ChatDisclosure({ label, after, live, failed = false, folded, follow, viewport, liveIndicator, bodyClass = "", onSeen, children, ...data }: {
  /** The header's words, shimmering while live. */
  label: ReactNode;
  /** Said after them and never shimmering: a failure, a duration. */
  after?: ReactNode;
  live: boolean;
  failed?: boolean;
  folded: Folded;
  /** Changes as a live body grows, so its view follows to the newest line. */
  follow: string;
  /** The live view's height. */
  viewport: string;
  /** Names the header as the chat's live state while it is one. */
  liveIndicator?: string;
  bodyClass?: string;
  /** Run once the line is first on screen. */
  onSeen?: (() => Effect.Effect<void>) | undefined;
  children: ReactNode;
  [attribute: `data-${string}`]: string | number | undefined;
}) {
  const [open, setOpen] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const seen = useFirstSeen(root, onSeen !== undefined);
  const whenSeen = useRef(onSeen);

  whenSeen.current = onSeen;
  useEffect(() => {
    const run = whenSeen.current;

    if (!seen || run === undefined) return;
    detach(run());
  }, [seen]);
  const following = live && !open;
  const long = useOverflows(body, folded, !live && !open, follow);
  const canOpen = live || long;

  useEffect(() => {
    if (following && body.current !== null) body.current.scrollTop = body.current.scrollHeight;
  }, [following, follow]);

  let shown = "";
  let bodyState = open ? "open" : "closed";

  if (following) bodyState = "live";

  // Following, it fades in at the top, so a step scrolled half out of view reads as going rather than cut.
  if (following) shown = `${viewport} overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent,#000_1.25rem)]`;
  else if (!open && folded === "hidden") shown = "hidden";

  return (
    <div ref={root} className="t-body py-0.5 p-text-3" {...data}>
      {/* The whole line is the control, its chevron turning as it opens: a quiet mark, as a tool row's is. */}
      <button type="button" onClick={() => setOpen(!open)} disabled={!canOpen} aria-expanded={canOpen ? open : undefined}
        className="group/disclosure flex w-full items-center gap-2 text-left enabled:cursor-pointer">
        <span className="min-w-0" data-disclosure-label {...(live && liveIndicator !== undefined ? { "data-live-indicator": liveIndicator } : {})}>
          <WorkLabel live={live} failed={failed}>{label}</WorkLabel>
        </span>
        {after !== undefined && <span className="flex shrink-0" data-disclosure-after>{after}</span>}
        {canOpen && (
          <CaretRightIcon size={11} aria-hidden data-disclosure-turn
            className={`shrink-0 p-text-3 p-fold-turn group-hover/disclosure:p-text-2 ${open ? "rotate-90" : ""}`} />
        )}
      </button>
      <div ref={body} className={`mt-1 ml-3.5 ${bodyClass} ${shown}`} data-disclosure-body={bodyState}
        data-folded={!live && !open && folded === "preview" ? "" : undefined} data-overflows={long ? "" : undefined}>
        {children}
      </div>
    </div>
  );
}

/** When this tab first saw each call run, and when each run settled under its eyes: what a run's line says it took. */
const seen = { running: new Map<string, number>(), settled: new Map<string, number>() };

/** Held for this many calls and runs at most, the oldest let go first. */
const SEEN_KEPT = 2000;

function keep(moments: Map<string, number>, id: string): void {
  if (moments.has(id)) return;
  moments.set(id, Date.now());

  for (const oldest of moments.keys()) {
    if (moments.size <= SEEN_KEPT) break;
    moments.delete(oldest);
  }
}

/** A call drawn running: its run's time counts from the first call this tab saw start. */
export function useSeenRunning(callId: string, running: boolean): void {
  useEffect(() => { if (running) keep(seen.running, callId); }, [callId, running]);
}

/** "38 s", "2 min 5 s". */
function spanWords(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));

  if (s < 60) return `${String(s)} s`;

  return s % 60 === 0 ? `${String(Math.floor(s / 60))} min` : `${String(Math.floor(s / 60))} min ${String(s % 60)} s`;
}

/**
 * How long a run took, from the first of its calls this tab saw run to when it saw the run settle; null for one it only
 * ever saw done.
 */
function useRunSpan(calls: readonly string[], live: boolean): string | null {
  const firstCall = calls[0] ?? "";
  const wasLive = useRef(live);
  // Drawn again once it is seen to settle, as the moment is kept after the draw that saw it.
  const [, settled] = useState(false);

  useEffect(() => {
    if (live) {
      wasLive.current = true;

      return;
    }

    if (!wasLive.current) return;
    keep(seen.settled, firstCall);
    settled(true);
  }, [firstCall, live]);

  const started = calls.flatMap((call) => seen.running.get(call) ?? []);
  const from = started.length === 0 ? undefined : Math.min(...started);
  const to = seen.settled.get(firstCall);

  return live || from === undefined || to === undefined ? null : spanWords(to - from);
}

/** A phase's line in words: what it did, and what is running now; before any call has words, what is running leads. */
function phaseWords(summary: ToolRunSummary, live: boolean, written: string | undefined) {
  const title = live ? summary.title : written ?? summary.title;
  const now = live && summary.now !== "" ? summary.now : null;

  if (title === "") return { label: `${now ?? "Working"}…`, nowLeads: now !== null, now: null };

  return { label: title, nowLeads: false, now };
}

/** Said after a phase's line, never shimmering: what is running now, a failure inside it, how long it took. */
function PhaseAfter({ now, failed, span }: { now: string | null; failed: number; span: string | null }) {
  if (now === null && failed === 0 && span === null) return null;

  return (
    <span className="t-body shrink-0 p-text-3">
      {now !== null && <> · <span data-tool-run-now>{now}…</span></>}
      {failed > 0 && <> · <span className="p-danger" data-tool-run-failed={failed}>{failed} failed</span></>}
      {span !== null && <> · {span}</>}
    </span>
  );
}

/**
 * A phase, its calls and the thinking between them, as one group: while it runs, what it has done so far and what is
 * running now, over a small view of its newest steps; settled, what it did in a few words, its steps a click away. A
 * model's line for it replaces the calls' own once it lands. A failure inside says so on its line.
 */
export function ToolRun({ steps, live, written, onSeen, children }: { steps: readonly RunStep[]; live: boolean; written: string | undefined; onSeen?: (() => Effect.Effect<void>) | undefined; children: ReactNode }) {
  const summary = toolRunSummary(steps);
  const span = useRunSpan(steps.flatMap((step) => (step.kind === "tool" ? [step.part.toolCallId] : [])), live);
  const last = steps.at(-1);
  const follow = `${String(steps.length)}:${last?.kind === "tool" ? last.part.state : String(last?.parts.map((part) => part.text.length).join())}`;
  const words = phaseWords(summary, live, written);
  const fromModel = written !== undefined && !live;

  return (
    <ChatDisclosure live={live} failed={!live && summary.failed > 0} folded="hidden" follow={follow} viewport="max-h-36"
      label={<span key={words.label} className={fromModel ? "animate-fade-in" : undefined} data-tool-run-now={words.nowLeads ? "" : undefined}>{words.label}</span>}
      after={<PhaseAfter now={words.now} failed={summary.failed} span={span} />}
      data-tool-run={live ? "live" : "settled"} data-tool-run-calls={summary.calls} data-tool-run-span={span ?? undefined}
      data-phase-title={fromModel ? "model" : "calls"} onSeen={onSeen}>
      {children}
    </ChatDisclosure>
  );
}

/**
 * A long turn's earlier work under one line: what all its calls did, in the few words a phase's line has, or the model's
 * line for the whole turn once it lands; opening it shows the phases, the thinking and the words among them, as they were.
 */
export function TurnRollup({ line, phases, written, onSeen, children }: { line: string; phases: number; written: string | null; onSeen?: (() => Effect.Effect<void>) | undefined; children: ReactNode }) {
  return (
    <ChatDisclosure live={false} folded="hidden" follow={String(phases)} viewport="max-h-36"
      label={<span key={written ?? ""} className={written === null ? undefined : "animate-fade-in"}>{written ?? line}</span>}
      after={<span className="t-body shrink-0 p-text-3"> · {phases} {phases === 1 ? "phase" : "phases"}</span>}
      data-turn-rollup={phases} data-phase-title={written === null ? "calls" : "model"} onSeen={onSeen}>
      {children}
    </ChatDisclosure>
  );
}
