/**
 * The long turn in the real chat (`frame=workspacepage&transcript=longturn`), for the owner to read each way its phases
 * can be named. Settled by default; `&at=<calls>` stops it live with that call running, and `&thinking=1` with the
 * thought after it streaming instead; `&live=1` plays it from its first thought and settles it. `&lines=model` gives
 * each phase the line Workers AI's fast model wrote for it, landing as long after the phase as it took to write; until
 * then, and without it, the line is the one the calls make. A note in the corner says which, and what each line took.
 */
import { isToolUIPart, type UIMessage } from "ai";
import * as v from "valibot";
import { groupMessageParts, phaseCalls, PHASE_TITLES_METADATA_KEY, TURN_TITLE_METADATA_KEY } from "@kinu.run/core";
import { galleryChatWindow, galleryServerPush, seedGalleryChat } from "@/gallery-agent-stub";

type Part = UIMessage["parts"][number];

/* The turn: an agent finds why the api Worker answers 500, fixes it, puts it on staging, then production, and watches
   production after. Five phases, 42 calls, the thinking before and between them and its words to the owner after each
   phase, as a reasoning model writes them. */

const said = (text: string): Part => ({ type: "text", state: "done", text });

const thought = (text: string): Part => ({ type: "reasoning", state: "done", text });

const read = (id: string, path: string): Part => ({ type: "tool-file", toolCallId: id, state: "output-available", input: { op: "read", path }, output: "…" });

const edit = (id: string, path: string): Part => ({ type: "tool-file", toolCallId: id, state: "output-available", input: { op: "edit", path, edits: [{}] }, output: "ok" });

const shell = (id: string, command: string, output: string): Part => ({ type: "tool-shell", toolCallId: id, state: "output-available", input: { runtime: "workspace", command }, output });

const failed = (id: string, command: string, error: string): Part => ({ type: "tool-shell", toolCallId: id, state: "output-error", input: { runtime: "workspace", command }, errorText: error });

const web = (id: string, input: { op: "search"; query: string } | { op: "fetch"; url: string }): Part => ({ type: "tool-web", toolCallId: id, state: "output-available", input, output: "…" });

const agents = (id: string, input: Record<string, string>, output: string): Part => ({ type: "tool-agents", toolCallId: id, state: "output-available", input, output });

const STEP: Part = { type: "step-start" };

const LONG_TURN_ASK = "/api/health on the api Worker has answered 500 since this morning's deploy. Find out why, fix it, put it on staging, then production, and watch production after.";

/** The turn's parts in the order the model wrote them. */
const LONG_TURN_PARTS: readonly Part[] = [
  thought("**Reading the failure**\n\nWhat the Worker logs as it fails first, then the deploy's config and what changed in it."),
  STEP,
  shell("f1", "bunx wrangler tail api --format pretty --status error", "GET /api/health 500 · TypeError: Cannot read properties of undefined (reading 'prepare') at openDb (src/db.ts:12)"),
  STEP,
  read("f2", "src/db.ts"),
  read("f3", "wrangler.jsonc"),
  STEP,
  thought("`env.DB` is undefined at runtime, and the config binds the sessions database as `SESSIONS_DB`. When did that change?"),
  shell("f4", "git log -3 --format='%h %s' -- wrangler.jsonc", "8c1d2e0 chore(config): name the sessions database SESSIONS_DB\n51a0b7f chore(config): staging gets its own database"),
  STEP,
  web("f5", { op: "search", query: "Cloudflare D1 binding renamed undefined after deploy" }),
  web("f6", { op: "fetch", url: "https://developers.cloudflare.com/d1/worker-api/" }),
  web("f7", { op: "fetch", url: "https://developers.cloudflare.com/workers/wrangler/configuration/#d1-databases" }),
  STEP,
  thought("A binding exists only under the name the config gives it, so every read of `env.DB` is undefined now."),
  said("Found it: yesterday's config change renamed the sessions database's binding from `DB` to `SESSIONS_DB`, and `openDb` still reads `env.DB`. Fixing the reader now."),
  STEP,
  thought("**Fixing the reader**\n\nRead the binding once, in `openDb`, by its new name, and by the old one until every environment has redeployed."),
  read("x1", "src/db.ts"),
  read("x2", "src/env.d.ts"),
  STEP,
  edit("x3", "src/db.ts"),
  edit("x4", "src/env.d.ts"),
  STEP,
  failed("x5", "bun test", "2 failed: health › reports the database; sessions › reads a stored session"),
  STEP,
  thought("The test helpers still bind only `DB`, so the fix finds nothing there."),
  read("x6", "test/helpers.ts"),
  edit("x7", "test/helpers.ts"),
  STEP,
  shell("x8", "bun test", "41 pass, 0 fail"),
  shell("x9", "bun run typecheck", "ok"),
  STEP,
  said("Fixed: `openDb` reads `SESSIONS_DB`, and the old name until every environment has redeployed. The first test run caught the test helpers binding only the old name; all 41 tests pass."),
  STEP,
  thought("**Checking the routes**\n\nAny route could still read `env.DB` itself. A subagent can check the cold ones while I read the two that matched."),
  shell("r1", "rg -n \"env\\.DB\\b\" src", "src/routes/webhooks.ts:14\nsrc/routes/admin.ts:31\nsrc/db.ts:9"),
  STEP,
  agents("r2", { op: "hire", name: "route-checker", role: "check every route for a read of env.DB", lifetime: "task" }, "route-checker is checking"),
  read("r3", "src/routes/webhooks.ts"),
  read("r4", "src/routes/admin.ts"),
  STEP,
  edit("r5", "src/routes/webhooks.ts"),
  edit("r6", "src/routes/admin.ts"),
  STEP,
  thought("route-checker should have read the rest by now."),
  agents("r7", { op: "message", agent: "route-checker", message: "Anything besides webhooks and admin?" }, "route-checker: no other route reads the binding itself"),
  shell("r8", "bun test", "43 pass, 0 fail"),
  shell("r9", "git commit -am \"fix(api): read the sessions database by its new binding\"", "[fix/sessions-binding 3f2a91c] fix(api): read the sessions database by its new binding"),
  STEP,
  said("Two routes read the binding themselves, webhooks and admin; both go through `openDb` now, and route-checker found no other. 43 tests pass; committed as `3f2a91c`."),
  STEP,
  thought("**Staging**\n\nThe migration first, then the deploy, then the routes that failed this morning."),
  shell("s1", "git push origin fix/sessions-binding", "To github.com:acme/api.git\n * [new branch] fix/sessions-binding -> fix/sessions-binding"),
  shell("s2", "bunx wrangler d1 migrations list SESSIONS_DB --env staging --remote", "0007_sessions_expiry.sql  pending"),
  shell("s3", "bunx wrangler d1 migrations apply SESSIONS_DB --env staging --remote", "Applied 1 migration"),
  STEP,
  shell("s4", "bunx wrangler deploy --dry-run --env staging", "Total Upload: 212.40 KiB / gzip: 48.11 KiB"),
  shell("s5", "bunx wrangler deploy --env staging", "Deployed api-staging (3.12 sec)"),
  STEP,
  shell("s6", "curl -s https://api-staging.example.com/api/health", "{\"ok\":true,\"db\":\"up\"}"),
  shell("s7", "curl -s -o /dev/null -w '%{http_code}' https://api-staging.example.com/api/sessions/current", "200"),
  shell("s8", "bunx wrangler tail api-staging --status error --format json", "0 errors in 60 s"),
  STEP,
  said("Staging runs the fix: /api/health answers ok with the database up, sessions read again, and no errors in a minute of traffic. Production next, as you asked."),
  STEP,
  thought("**Production**\n\nThe same order as staging, then five minutes of errors and latency before calling it fixed."),
  shell("p1", "bunx wrangler d1 migrations apply SESSIONS_DB --remote", "Applied 1 migration"),
  shell("p2", "bunx wrangler deploy", "Deployed api (3.40 sec)"),
  STEP,
  shell("p3", "curl -s https://api.example.com/api/health", "{\"ok\":true,\"db\":\"up\"}"),
  shell("p4", "bunx wrangler tail api --status error --format json", "0 errors in 120 s"),
  STEP,
  thought("No errors. Latency next: p95 was 41 ms before the rename."),
  shell("p5", "curl -s -o /dev/null -w '%{time_total}' https://api.example.com/api/health", "0.038"),
  shell("p6", "bunx wrangler d1 execute SESSIONS_DB --remote --command \"SELECT count(*) FROM sessions WHERE expires_at > unixepoch()\"", "count(*)\n18402"),
  shell("p7", "bunx wrangler tail api --status error --format json", "0 errors in 180 s"),
  STEP,
  { type: "tool-memory", toolCallId: "p8", state: "output-available", input: { op: "note", text: "A renamed D1 binding: read both names until every environment has redeployed." }, output: "saved" },
  { type: "tool-tasks", toolCallId: "p9", state: "output-available", input: { op: "update", id: "t1", status: "done" }, output: "ok" },
  STEP,
  thought("Five minutes clean on production, p95 at 38 ms. Done."),
  said("Production is fixed. /api/health has answered 200 since 14:32 with the database up, no route has errored in five minutes of traffic, and p95 is back to 38 ms. The cause was yesterday's rename of the sessions database's binding: `openDb` read `env.DB`, which no longer existed. It now reads `SESSIONS_DB`, and the old name until every environment has redeployed; the webhook and admin routes read it through `openDb` too. 43 tests pass."),
];

/**
 * The long turn's lines as Workers AI's fast model wrote them: `@cf/zai-org/glm-5.3`, Kinu's fast tier when none is assigned
 * (core providers/model-registry.ts), at effort `low`, each phase's prompt run three times on 2026-10-19, a call every
 * 7 s. Each line is its first run's; `ms` is every run's latency, end to end from this machine.
 */

interface MeasuredLine {
  readonly title: string;
  readonly ms: readonly number[];
  readonly prompt: number;
  readonly completion: number;
  readonly neurons: number;
}

const LINES_MODEL = {
  model: "@cf/zai-org/glm-5.3", effort: "low", runs: 3, measured: "2026-10-19",
  note: "Over 18 calls: median 3.2 s, p90 18.6 s, slowest 66 s; 2 refused by the account's per-minute limit and retried. At Workers AI's list price for glm-5.3 ($1.40 a million tokens in, $4.40 out) a phase's line costs about $0.0007, this turn's six lines $0.0039; the free 10,000 neurons a day cover about 180 lines.",
} as const;

/** By each phase's first call. */
const PHASE_LINES: ReadonlyMap<string, MeasuredLine> = new Map([
  ["f1", { title: "Traced 500 to renamed D1 binding", ms: [1683, 3830, 3210], prompt: 467, completion: 16, neurons: 19.4 }],
  ["x1", { title: "Fixed reader and test helpers for renamed D1 binding", ms: [66113, 1479, 1753], prompt: 405, completion: 17, neurons: 58.3 }],
  ["r1", { title: "Audited routes and fixed the DB binding reads", ms: [2330, 3263, 18264], prompt: 483, completion: 16, neurons: 54.6 }],
  ["s1", { title: "Migrated DB and deployed fix to staging", ms: [10007, 2060, 3609], prompt: 472, completion: 15, neurons: 52.8 }],
  ["p1", { title: "Deployed to production and verified health", ms: [3157, 1236, 18631], prompt: 506, completion: 14, neurons: 56.7 }],
]);

const TURN_LINE: MeasuredLine = { title: "Fixed D1 binding 500 and deployed", ms: [54848, 5134, 3090], prompt: 176, completion: 15, neurons: 28.4 };

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
  return MODEL_LINES ? linesFor(phases, turn) : undefined;
}

function linesFor(phases: readonly string[], turn: boolean): WrittenLines {
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

/** `&lines=asked`: the lines are written only once the page asks, as the workspace writes them. */
const ASKED_LINES = params.get("lines") === "asked";

const NamePhasesSchema = v.tuple([v.object({ messageId: v.string(), actor: v.optional(v.string()) })]);

/** As the workspace answers `namePhases`: each ask recorded on the page. A running turn's answer is not committed, so
 *  none is found; a settled one's, with `&lines=asked`, has its lines stamped a moment later and its room shown it again. */
export function longTurnNamePhases(args?: unknown[]): boolean {
  const [{ messageId }] = v.parse(NamePhasesSchema, args);
  const root = document.documentElement;
  const settled = !params.has("at") && params.get("live") !== "1";

  root.dataset.phaseLinesAsked = `${root.dataset.phaseLinesAsked ?? ""}${messageId};`;

  if (!settled || messageId !== "lt-a1") return false;

  if (ASKED_LINES) window.setTimeout(() => { galleryChatWindow("", [ASK, turnOf(LONG_TURN_PARTS, linesFor([...PHASE_LINES.keys()], true))], null); }, 300);

  return true;
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
    <a href={href} className={`rounded-full px-2 py-0.5 ${on ? "p-selected p-accent-fg" : "p-text-3 hover:p-text"}`}>{label}</a>
  );

  // Open beside the chat; on a phone it would cover it, so it waits behind its summary there, under the header.
  return (
    <details data-long-turn-notes open={window.matchMedia("(min-width: 1024px)").matches}
      className="fixed bottom-3 right-3 z-50 w-[22rem] max-w-[calc(100vw-1.5rem)] max-md:bottom-auto max-md:top-14 rounded-xl border p-border p-fill p-3 t-meta p-text-2 shadow-lg">
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
