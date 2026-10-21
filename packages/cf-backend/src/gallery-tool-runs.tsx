/**
 * A turn's runs of tool calls in the real chat (`frame=workspacepage&transcript=toolruns`), as an agent fixes a Worker's
 * failing deploy: an answer that tailed the Worker's errors and read its way to the cause, a long fix with a failed
 * test run mid-way and a subagent hired for the routes, and a run split by a preview it started and by a question for the
 * owner. `gallery:tool-run` with `{ calls, failAt?, answer?, agent? }` shows `agent`'s chat (the
 * workspace's by default) with a newest turn of that many calls, the newest running unless the answer has started; a
 * test drives the run through its states with it, against the claim it pushes. `&live=1` plays that turn itself, a
 * call at a time, for a reader to watch the live run follow its newest step and settle.
 */
import type { UIMessage } from "ai";
import * as v from "valibot";
import { hostedActorSocketPath } from "@kinu.run/core";
import { galleryChatWindow, galleryServerPush, seedGalleryChat } from "@/gallery-agent-stub";
import { SLATE_GALLERY_URL } from "@/gallery-slate-fallback";

type Part = UIMessage["parts"][number];

const NOW = Date.now();

const at = (minutesAgo: number) => NOW - minutesAgo * 60e3;

/** A message as the transport stamps it. */
const row = (message: UIMessage & { createdAt: number }) => message;

const said = (text: string): Part => ({ type: "text", state: "done", text });

const thought = (text: string): Part => ({ type: "reasoning", state: "done", text });

const read = (id: string, path: string): Part => ({ type: "tool-file", toolCallId: id, state: "output-available", input: { op: "read", path }, output: "…" });

const edit = (id: string, path: string): Part => ({ type: "tool-file", toolCallId: id, state: "output-available", input: { op: "edit", path, edits: [{}] }, output: "ok" });

const command = (id: string, line: string, output = "ok"): Part => ({ type: "tool-shell", toolCallId: id, state: "output-available", input: { runtime: "workspace", command: line }, output });

const failed = (id: string, line: string, error: string): Part => ({ type: "tool-shell", toolCallId: id, state: "output-error", input: { runtime: "workspace", command: line }, errorText: error });

const search = (id: string, query: string): Part => ({ type: "tool-web", toolCallId: id, state: "output-available", input: { op: "search", query }, output: "…" });

const page = (id: string, url: string): Part => ({ type: "tool-web", toolCallId: id, state: "output-available", input: { op: "fetch", url }, output: "…" });

const STEP: Part = { type: "step-start" };

/** The subagent the fix hires, whose chat holds the thread too. */
const HIRED = "route-checker";

/** The ask a run stops at, as `ask_owner` puts it. */
const DEPLOY_ASK = {
  questions: [{
    id: "deploy", header: "Deploy", question: "Staging is healthy on the fix. Deploy it to production now?", recommended: 0,
    options: [{ label: "Deploy now", description: "Production gets the fix in about a minute." }, { label: "Wait", description: "Keep it on staging; deploy later." }],
  }],
};

/** A subagent the run hires for the routes, as the agents tool puts it. */
const hire = (id: string, name: string, role: string): Part => ({
  type: "tool-agents", toolCallId: id, state: "output-available", input: { op: "hire", name, role, lifetime: "task" }, output: `${name} is checking`,
});

/** Twenty calls fixing the deploy, a test run failing in the middle and a subagent hired for the routes. */
const FIX_RUN: Part[] = [
  thought("**Fixing the binding**\n\nThe config renamed the database binding to `SESSIONS_DB`; the code still reads `env.DB`."),
  ...["src/index.ts", "src/db.ts", "wrangler.jsonc", "migrations/0007_sessions.sql"].map((file, index) => read(`fix-read-${String(index)}`, file)),
  edit("fix-edit-1", "wrangler.jsonc"),
  STEP,
  failed("fix-test-1", "bun test", "2 failed: health › reports the database; sessions › reads a stored session"),
  thought("The binding in `wrangler.jsonc` is right now, but `openDb` still asks for `env.DB`. It must read the binding by its new name."),
  read("fix-read-4", "src/db.ts"),
  edit("fix-edit-2", "src/db.ts"),
  command("fix-test-2", "bun test", "38 pass, 0 fail"),
  STEP,
  thought("Any route could read the old binding directly. A subagent can check them while I read the hot ones."),
  hire("fix-hire", HIRED, "check every route for env.DB"),
  ...["health.ts", "sessions.ts", "users.ts", "admin.ts", "webhooks.ts"].map((file, index) => read(`fix-route-${String(index)}`, `src/routes/${file}`)),
  edit("fix-edit-3", "src/routes/webhooks.ts"),
  command("fix-test-3", "bun test", "41 pass, 0 fail"),
  command("fix-dry-run", "bunx wrangler deploy --dry-run", "Total Upload: 212.40 KiB / gzip: 48.11 KiB"),
  edit("fix-notes", "CHANGELOG.md"),
  command("fix-git", "git commit -am 'fix(api): read the sessions database by its new binding'", "[fix/sessions-binding 3f2a91c]"),
];

const THREAD: UIMessage[] = [
  row({ id: "tr-u1", role: "user", createdAt: at(30), parts: [said("The api Worker went out an hour ago and /api/health has answered 500 since. Find out why.")] }),
  row({
    id: "tr-a1", role: "assistant", createdAt: at(29),
    parts: [
      thought("**Reading the failure**\n\nFirst what the Worker logs as it fails, then the deploy's config."),
      STEP,
      command("why-tail", "bunx wrangler tail api --format pretty --status error", "GET /api/health 500 · TypeError: Cannot read properties of undefined (reading 'prepare') at openDb (src/db.ts:12)"),
      read("why-read-1", "src/db.ts"),
      read("why-read-2", "wrangler.jsonc"),
      thought("`env.DB` is undefined at runtime. The config now binds the database as `SESSIONS_DB`. Does a renamed D1 binding keep its old name for a deploy?"),
      search("why-search", "Cloudflare Workers D1 binding renamed undefined after deploy"),
      page("why-page-1", "https://developers.cloudflare.com/d1/worker-api/"),
      page("why-page-2", "https://developers.cloudflare.com/workers/wrangler/configuration/#d1-databases"),
      STEP,
      said("The 500 is `openDb` reading `env.DB`: yesterday's config change renamed the sessions database's binding to `SESSIONS_DB`, and a binding exists only under the name the config gives it. Every request that opens the database fails, and /api/health is the first to."),
    ],
  }),
  row({ id: "tr-u2", role: "user", createdAt: at(20), parts: [said("Fix it, and run the tests.")] }),
  row({
    id: "tr-a2", role: "assistant", createdAt: at(19),
    parts: [...FIX_RUN, STEP, said("Fixed. The Worker reads the sessions database by its new binding everywhere, the webhook route included, and all 41 tests pass. The first test run caught `openDb` still asking for the old name.")],
  }),
  row({ id: "tr-u3", role: "user", createdAt: at(10), parts: [said("Run it, put it on staging, and ask me before production.")] }),
  row({
    id: "tr-a3", role: "assistant", createdAt: at(9),
    parts: [
      command("pv-migrate", "bunx wrangler d1 migrations apply SESSIONS_DB --local", "Applied 1 migration"),
      command("pv-serve", "bunx wrangler dev --port 8789", "Ready on http://localhost:8789"),
      { type: "tool-shell", toolCallId: "pv-expose", state: "output-available", input: { runtime: "workspace", command: "kinu expose 8789" }, output: { url: SLATE_GALLERY_URL, port: 8789 } },
      command("pv-health", "curl -s localhost:8789/api/health", "{\"ok\":true,\"db\":\"up\"}"),
      command("pv-staging", "bunx wrangler deploy --env staging", "Deployed api-staging (3.12 sec)"),
      STEP,
      said("The Worker runs on the fix: /api/health answers `ok` with the database up, here and on staging."),
      { type: "tool-ask_owner", toolCallId: "pv-ask", state: "input-available", input: DEPLOY_ASK },
    ],
  }),
];

/** The turn a test drives live, asked after the thread above. */
const TOOL_RUN_TURN = "tr-u4";

const ASKED: UIMessage = row({ id: TOOL_RUN_TURN, role: "user", createdAt: at(1), parts: [said("Check the other Workers for the same binding rename.")] });

/** The kinds of call a live run cycles through, so its line has work of several kinds to name. */
const LIVE_CALLS: readonly ((id: string, index: number) => Part)[] = [
  (id, index) => read(id, `workers/worker-${String(index)}/wrangler.jsonc`),
  (id, index) => read(id, `workers/worker-${String(index)}/src/db.ts`),
  (id) => search(id, "wrangler D1 binding rename existing Workers"),
  (id, index) => command(id, `rg -n "env\\.DB\\b" workers/worker-${String(index)}`, "2 matches"),
];

const RunAskedSchema = v.object({ calls: v.number(), failAt: v.optional(v.number()), answer: v.optional(v.boolean()), agent: v.optional(v.string()) });

/** The newest turn with `calls` calls so far, a thought every fifth; the newest runs until the answer starts. */
function liveTurn({ calls, failAt, answer = false }: v.InferOutput<typeof RunAskedSchema>): UIMessage {
  const parts: Part[] = [];

  for (let index = 0; index < calls; index += 1) {
    if (index % 5 === 0) parts.push(STEP, thought(`Workers ${String(index + 1)} to ${String(index + 5)}: each reads its database by the binding its config names, or still by \`env.DB\`?`));
    const id = `live-${String(index)}`;
    const call = LIVE_CALLS[index % LIVE_CALLS.length]?.(id, index) ?? read(id, "src/index.ts");

    if (index === failAt) parts.push(failed(id, `rg -n "env\\.DB" workers/legacy`, "rg: workers/legacy: No such file or directory"));
    else if (index === calls - 1 && !answer && "toolCallId" in call) parts.push({ type: "tool-shell", toolCallId: id, state: "input-available", input: { runtime: "workspace", command: `bunx wrangler deploy --dry-run --config workers/worker-${String(index)}/wrangler.jsonc` } });
    else parts.push(call);
  }

  if (answer) parts.push(STEP, { type: "text", state: "streaming", text: "Every other Worker already reads its database by the binding its config names, so" });

  return { id: "tr-a4", role: "assistant", parts };
}


/** `transcript=toolruns`: the thread above, in the workspace's own chat and in a hired agent's. */
export function seedToolRuns(transcript: string | null): void {
  if (transcript !== "toolruns") return;
  seedGalleryChat(THREAD);
  seedGalleryChat(THREAD, hostedActorSocketPath(HIRED));

  const show = (asked: v.InferOutput<typeof RunAskedSchema>): void => {
    galleryChatWindow(asked.agent === undefined ? "" : hostedActorSocketPath(asked.agent), [...THREAD, ASKED, liveTurn(asked)], null);
  };

  window.addEventListener("gallery:tool-run", (event: Event) => {
    const asked = event instanceof CustomEvent ? v.safeParse(RunAskedSchema, event.detail) : null;

    if (asked?.success === true) show(asked.output);
  });

  if (new URLSearchParams(location.search).get("live") === "1") playLive(show);
}

/** Calls the played turn makes before its answer starts, and the one that fails. */
const PLAYED_CALLS = 22;

const PLAYED_FAILURE = 4;

/** The newest turn as a reader would watch it: admitted, a call at a time, then its answer, then again from the start. */
function playLive(show: (asked: v.InferOutput<typeof RunAskedSchema>) => void): void {
  let step = 0;

  const tick = (): void => {
    if (step === 0) galleryServerPush(JSON.stringify({ type: "turn_claim", claim: { kind: "admitted", turnId: TOOL_RUN_TURN, claimedAt: Date.now() } }));

    if (step < PLAYED_CALLS) show({ calls: step + 1, failAt: PLAYED_FAILURE });
    else show({ calls: PLAYED_CALLS, failAt: PLAYED_FAILURE, answer: true });
    step = step >= PLAYED_CALLS + 4 ? 0 : step + 1;
  };

  window.setInterval(tick, 900);
}
