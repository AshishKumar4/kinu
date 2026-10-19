/**
 * The long turn in the real chat (`frame=workspacepage&transcript=longturn`), for the owner to read each way its phases
 * can be named. Settled by default; `&at=<calls>` stops it live with that call running, and `&thinking=1` with the
 * thought after it streaming instead; `&live=1` plays it from its first thought and settles it. `&lines=model` gives
 * each phase the line Workers AI's fast model wrote for it, landing as long after the phase as it took to write; until
 * then, and without it, the line is the one the calls make. A note in the corner says which, and what each line took.
 */
import { isToolUIPart, type UIMessage } from "ai";
import { groupMessageParts, phaseCalls, PHASE_TITLES_METADATA_KEY, TURN_TITLE_METADATA_KEY } from "@kinu.run/core";
import { galleryChatWindow, galleryServerPush, seedGalleryChat } from "@/gallery-agent-stub";
import { LONG_TURN_ASK, LONG_TURN_PARTS } from "@/gallery-long-turn";
import { LINES_MODEL, PHASE_LINES, TURN_LINE, type MeasuredLine } from "@/gallery-long-turn-lines";

type Part = UIMessage["parts"][number];

const NOW = Date.now();

const TURN_ID = "lt-u1";

const ASK: UIMessage & { createdAt: number } = { id: TURN_ID, role: "user", createdAt: NOW - 12 * 60e3, parts: [{ type: "text", state: "done", text: LONG_TURN_ASK }] };

const params = new URLSearchParams(location.search);

const MODEL_LINES = params.get("lines") === "model";

/** A part as the turn shows it while it is the newest: a call running, words or a thought still streaming. */
function going(part: Part): Part {
  // The turn's calls are all the static kind; a dynamic one would need its tool's name carried too.
  if (isToolUIPart(part) && part.type !== "dynamic-tool") return { type: part.type, toolCallId: part.toolCallId, state: "input-available", input: part.input };

  return part.type === "text" || part.type === "reasoning" ? { ...part, state: "streaming" } : part;
}

/** The phases shown so far whose words have come after them, so whose line a model can have written, by first call. */
function endedPhases(parts: readonly Part[]): string[] {
  const blocks = groupMessageParts(parts);

  return blocks.flatMap((block, at) => {
    const [first] = block.kind === "run" ? phaseCalls(block.steps) : [];
    const ended = blocks.slice(at + 1).some((after) => after.kind === "part" && after.part.type === "text");

    return first !== undefined && ended ? [first.toolCallId] : [];
  });
}

/** A message's metadata as the model's lines sit in it. */
interface WrittenLines {
  [PHASE_TITLES_METADATA_KEY]: Record<string, string>;
  [TURN_TITLE_METADATA_KEY]?: string;
}

/** The model's lines for `phases`, and for the whole turn once it has `turn`, as the message's metadata holds them. */
function written(phases: readonly string[], turn: boolean): WrittenLines | undefined {
  if (!MODEL_LINES) return undefined;
  const lines: WrittenLines = { [PHASE_TITLES_METADATA_KEY]: {} };

  for (const first of phases) {
    const line = PHASE_LINES.get(first);

    if (line !== undefined) lines[PHASE_TITLES_METADATA_KEY][first] = line.title;
  }

  if (turn) lines[TURN_TITLE_METADATA_KEY] = TURN_LINE.title;

  return lines;
}

function turnOf(parts: readonly Part[], metadata: WrittenLines | undefined): UIMessage {
  const message: UIMessage = { id: "lt-a1", role: "assistant", parts: [...parts] };

  if (metadata !== undefined) message.metadata = metadata;

  return message;
}

/** The turn's parts up to its `calls`th call, running; with `thinking`, that call done and the thought after it streaming. */
function stoppedAt(calls: number, thinking: boolean): Part[] {
  let seen = 0;
  const at = LONG_TURN_PARTS.findIndex((part) => isToolUIPart(part) && ++seen === calls);

  if (at < 0) return [...LONG_TURN_PARTS];

  if (!thinking) return [...LONG_TURN_PARTS.slice(0, at), going(LONG_TURN_PARTS[at] ?? { type: "step-start" })];
  const next = LONG_TURN_PARTS.findIndex((part, after) => after > at && part.type === "reasoning");

  return next < 0 ? LONG_TURN_PARTS.slice(0, at + 1) : [...LONG_TURN_PARTS.slice(0, next), going(LONG_TURN_PARTS[next] ?? { type: "step-start" })];
}

/** The middle of a line's measured latencies: when it lands after its phase, as the played turn shows it. */
function landsAfter(line: MeasuredLine): number {
  const sorted = [...line.ms].sort((a, b) => a - b);

  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** The turn from its first thought, a part a beat; each model line lands as long after its phase's words as it took. */
function play(): void {
  const visible = LONG_TURN_PARTS.flatMap((part, at) => (part.type === "step-start" ? [] : [at]));
  const endedAt = new Map<string, number>();
  let beat = 0;
  let settledAt = 0;

  const tick = (): void => {
    const now = Date.now();

    if (beat === 0) {
      endedAt.clear();
      galleryServerPush(JSON.stringify({ type: "turn_claim", claim: { kind: "admitted", turnId: TURN_ID, claimedAt: now } }));
    }

    const last = visible[Math.min(beat, visible.length - 1)] ?? 0;
    const done = beat >= visible.length;
    const parts = done ? [...LONG_TURN_PARTS] : [...LONG_TURN_PARTS.slice(0, last), going(LONG_TURN_PARTS[last] ?? { type: "step-start" })];

    for (const first of endedPhases(parts)) if (!endedAt.has(first)) endedAt.set(first, now);

    if (done && settledAt === 0) {
      settledAt = now;
      galleryServerPush(JSON.stringify({ type: "turn_claim", claim: { kind: "settled" } }));
    }

    const landed = [...endedAt].flatMap(([first, at]) => {
      const line = PHASE_LINES.get(first);

      return line !== undefined && now - at >= landsAfter(line) ? [first] : [];
    });


    galleryChatWindow("", [ASK, turnOf(parts, written(landed, done && now - settledAt >= landsAfter(TURN_LINE)))], null);
    beat += 1;

    // Settled and held long enough to read, then again from the start.
    if (done && now - settledAt > 20_000) {
      beat = 0;
      settledAt = 0;
    }
  };

  window.setInterval(tick, 1100);
}

export function seedLongTurn(transcript: string | null): void {
  if (transcript !== "longturn") return;
  const calls = Number(params.get("at") ?? 0);

  if (params.get("live") === "1") {
    seedGalleryChat([ASK]);
    play();

    return;
  }

  if (calls > 0) {
    const parts = stoppedAt(calls, params.get("thinking") === "1");

    seedGalleryChat([ASK, turnOf(parts, written(endedPhases(parts), false))]);
    // Said again each second: a frame sent before the page's socket opens reaches no one.
    window.setInterval(() => galleryServerPush(JSON.stringify({ type: "turn_claim", claim: { kind: "admitted", turnId: TURN_ID, claimedAt: NOW } })), 1000);

    return;
  }

  seedGalleryChat([ASK, turnOf(LONG_TURN_PARTS, written([...PHASE_LINES.keys()], true))]);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Where the review switches the turn's state and its lines, linked so a reload keeps them. */
function linkTo(change: Record<string, string | null>): string {
  const next = new URLSearchParams(location.search);

  for (const [key, value] of Object.entries(change)) {
    if (value === null) next.delete(key);
    else next.set(key, value);
  }

  return `?${next.toString()}`;
}

/** Which of the turn's states the page shows: played, stopped at a call, or settled. */
function turnState(): "live" | "at" | "settled" {
  if (params.get("live") === "1") return "live";

  return params.has("at") ? "at" : "settled";
}

/** The review's note, over the inspector's column: which lines the chat shows, the states to read them in, and what each model line took. */
export function LongTurnNotes() {
  const lines = [...PHASE_LINES];
  const state = turnState();

  const option = (label: string, href: string, on: boolean) => (
    <a href={href} className={`rounded-full px-2 py-0.5 ${on ? "p-accent-subtle p-accent" : "p-text-3 hover:p-text"}`}>{label}</a>
  );

  // Open beside the chat; on a phone it would cover it, so it waits behind its summary there.
  return (
    <details data-long-turn-notes open={window.matchMedia("(min-width: 1024px)").matches}
      className="fixed bottom-3 right-3 z-50 w-[22rem] max-w-[calc(100vw-1.5rem)] rounded-xl border p-border p-elevated p-3 text-[11.5px] leading-snug p-text-2 shadow-lg">
      <summary className="cursor-pointer font-medium p-text">Review: the phases' lines</summary>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <span className="mr-1 font-medium p-text">Lines</span>
        {option("From the calls", linkTo({ lines: null }), !MODEL_LINES)}
        {option("Written by the model", linkTo({ lines: "model" }), MODEL_LINES)}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <span className="mr-1 font-medium p-text">Turn</span>
        {option("Settled", linkTo({ live: null, at: null, thinking: null }), state === "settled")}
        {option("Live, in production", linkTo({ live: null, at: "37", thinking: null }), state === "at")}
        {option("Play it", linkTo({ live: "1", at: null, thinking: null }), state === "live")}
      </div>
      {MODEL_LINES && (
        <>
          <p className="mt-2.5">
            Written by <span className="font-mono">{LINES_MODEL.model}</span> on Workers AI (effort {LINES_MODEL.effort}), each phase's prompt
            run {LINES_MODEL.runs} times on {LINES_MODEL.measured}. Until a line lands, the phase shows the line its calls make.
          </p>
          <table className="mt-2 w-full border-collapse">
            <tbody>
              {[...lines, ["turn", TURN_LINE] as const].map(([first, line]) => (
                <tr key={first} className="border-t p-border align-top">
                  <td className="py-1 pr-2 p-text">{line.title}</td>
                  <td className="whitespace-nowrap py-1 text-right tabular-nums">
                    {seconds(Math.min(...line.ms))}–{seconds(Math.max(...line.ms))}
                    <div className="p-text-3">{line.prompt} in · {line.completion} out · {Math.round(line.neurons)} neurons</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 p-text-3">{LINES_MODEL.note}</p>
        </>
      )}
    </details>
  );
}
