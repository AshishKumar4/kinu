#!/usr/bin/env bun
/**
 * liveness-capture — one real swarm run, every link of the live-update chain
 * timestamped.
 *
 * Answers the liveness audit with evidence instead of code reading: a real
 * ideate swarm (>= 3 nodes; a tight token budget mixes the outcomes) runs on a
 * real backend while this script records, per link, the first moment it saw
 * each node:
 *
 *   spawn      the journal announced it (mcts-progress / head_activity push)
 *   journal    the node's rows appeared in getHeadRun
 *   canvas     the canvas read model contained it (getExplorationCanvas)
 *   broadcast  the page's own socket delivered the push
 *   dom        the rendered Exploration surface drew it
 *
 * and, for the run as a whole, how long the detached phase (no streaming turn)
 * took to move the surface — the window the idle revalidation cadence governs.
 *
 * Point it at any deployment:
 *   KINU_LIVENESS_ORIGIN=https://staging.kinu.run bun scripts/liveness-capture.ts
 * The origin must already authenticate the browser (dev synthesizes an identity
 * from DEV_USER_EMAIL; staging needs a signed-in session) and the workspace
 * needs a working default model. KINU_LIVENESS_EXPECT_RESTART=1 keeps the
 * capture alive across a server restart (deploy/eviction), recording the
 * recovery instead of failing on the dropped sockets.
 */

import { existsSync } from "node:fs";
import * as v from "valibot";
import puppeteer, { type Browser, type Page } from "puppeteer";

const ORIGIN = (process.env.KINU_LIVENESS_ORIGIN ?? "http://localhost:5174").replace(/\/+$/, "");
const WORKSPACE = process.env.KINU_LIVENESS_WORKSPACE ?? "liveness-proof";
const BRANCHES = Number(process.env.KINU_LIVENESS_BRANCHES ?? 4);
const BUDGET_TOKENS = Number(process.env.KINU_LIVENESS_BUDGET_TOKENS ?? 25_000);
const MAX_WAIT_MS = Number(process.env.KINU_LIVENESS_MAX_WAIT_MS ?? 420_000);
const EXPECT_RESTART = process.env.KINU_LIVENESS_EXPECT_RESTART === "1";
const POLL_MS = 400;
const CHROME_CANDIDATES = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];

interface CaptureEvent {
  t: number;
  kind: string;
  detail: string;
}

const t0 = Date.now();
const events: CaptureEvent[] = [];
const seen = new Set<string>();

function record(kind: string, detail: string): void {
  const key = `${kind}:${detail}`;
  if (seen.has(key)) return;
  seen.add(key);
  events.push({ t: Date.now(), kind, detail });
}

function elapsed(): string {
  return `+${String(Date.now() - t0).padStart(6)}ms`;
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/* ── the workspace ──────────────────────────────────────────────── */

async function ensureWorkspace(): Promise<void> {
  const exists = await fetch(`${ORIGIN}/api/user/workspaces/${encodeURIComponent(WORKSPACE)}`);
  if (exists.ok) return;
  const created = await fetch(`${ORIGIN}/api/user/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: WORKSPACE, displayName: `Liveness proof ${new Date().toISOString()}` }),
  });
  if (!created.ok) throw new Error(`workspace create -> ${String(created.status)}: ${(await created.text()).slice(0, 300)}`);
  log(`workspace ${WORKSPACE} created`);
}

/* ── the wire shapes, parsed at their boundaries ────────────────── */

const CanvasNodeSchema = v.object({ id: v.string(), status: v.optional(v.string()) });
const CanvasEntrySchema = v.object({
  run: v.object({ id: v.string(), status: v.string() }),
  tree: v.array(CanvasNodeSchema),
  head: v.nullable(v.object({ nodes: v.array(CanvasNodeSchema) })),
});
const CanvasPageSchema = v.object({ items: v.array(CanvasEntrySchema) });
const HeadRunViewSchema = v.nullable(v.object({
  rootId: v.string(),
  nodes: v.array(v.object({ id: v.string(), status: v.string() })),
}));
const JobRowsSchema = v.array(v.object({ id: v.string(), kind: v.string(), status: v.string() }));

/** One socket frame that answers a driver RPC. */
const RpcFrameSchema = v.object({
  type: v.literal("rpc"),
  id: v.string(),
  success: v.optional(v.boolean()),
  result: v.optional(v.unknown()),
  error: v.optional(v.unknown()),
});

/** One push the page's own socket may receive, as the capture hears it. */
const BroadcastFrameSchema = v.variant("type", [
  v.object({
    type: v.literal("mcts-progress"),
    rootId: v.optional(v.string()),
    nodes: v.optional(v.array(v.object({ id: v.string() }))),
  }),
  v.object({ type: v.literal("head_activity"), headId: v.optional(v.string()) }),
]);

/** One durable run event off the SSE stream. */
const RunEventFrameSchema = v.object({
  type: v.optional(v.string()),
  eventIndex: v.optional(v.number()),
});

/* ── the driver's own socket: the read models, polled ───────────── */

/** The answer body exactly as the wire carried it; the caller's schema parses it. */
export interface RpcAnswer {
  readonly body: unknown;
}

class DriverSocket {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, { resolve: (value: RpcAnswer) => void; reject: (error: Error) => void }>();
  private closedForGood = false;

  connect(): Promise<void> {
    if (this.closedForGood) return Promise.reject(new Error("driver socket closed for good"));
    const url = `${ORIGIN.replace(/^http/, "ws")}/agents/orchestrator-agent/${encodeURIComponent(WORKSPACE)}`;
    const attempt = Promise.withResolvers<void>();
    const ws = new WebSocket(url);
    const fail = setTimeout(() => attempt.reject(new Error("driver socket timed out")), 15_000);
    ws.addEventListener("open", () => {
      clearTimeout(fail);
      this.ws = ws;
      attempt.resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(fail);
      if (!this.ws) attempt.reject(new Error("driver socket failed"));
    });
    ws.addEventListener("close", () => {
      this.ws = null;
      for (const entry of this.pending.values()) entry.reject(new Error("driver socket closed"));
      this.pending.clear();
      if (!this.closedForGood && EXPECT_RESTART) setTimeout(() => void this.connect().catch(function onReconnectFailure(err: Error): void {
        console.error(`driver socket reconnect failed: ${err.message}`);
      }), 2_000);
    });
    ws.addEventListener("message", (ev) => this.onMessage(String(ev.data)));
    return attempt.promise;
  }

  private onMessage(raw: string): void {
    const frame = v.safeParse(RpcFrameSchema, JSON.parse(raw));
    if (!frame.success || frame.output.type !== "rpc") return;
    const entry = this.pending.get(frame.output.id);
    if (!entry) return;
    this.pending.delete(frame.output.id);
    // A missing success flag means the Think SDK answered a failure.
    if (frame.output.success === true) entry.resolve({ body: frame.output.result });
    else entry.reject(new Error(`rpc failed: ${JSON.stringify(frame.output.error)?.slice(0, 200)}`));
  }

  /** Raw round trip — callers parse `body` with the schema it belongs to. */
  call(method: string, args: unknown[] = []): Promise<RpcAnswer> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("driver socket not open"));
    const id = String(this.nextId++);
    const entry = Promise.withResolvers<RpcAnswer>();
    this.pending.set(id, entry);
    this.ws.send(JSON.stringify({ type: "rpc", id, method, args }));
    setTimeout(() => {
      if (this.pending.delete(id)) entry.reject(new Error(`rpc ${method} timed out`));
    }, 10_000);
    return entry.promise;
  }

  close(): void {
    this.closedForGood = true;
    this.ws?.close();
  }
}

/* ── the durable run-event stream, tapped over SSE ──────────────── */

async function tapRunEvents(runId: string): Promise<void> {
  const res = await fetch(`${ORIGIN}/api/workspaces/${encodeURIComponent(WORKSPACE)}/runs/${encodeURIComponent(runId)}/stream`, {
    headers: { accept: "text/event-stream" },
  });
  if (!res.ok || res.body === null) {
    record("sse-unavailable", String(res.status));
    return;
  }
  const frames = res.body.pipeThrough(new TextDecoderStream());
  void (async () => {
    for await (const chunk of frames) {
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const frame = v.safeParse(RunEventFrameSchema, JSON.parse(line.slice(5).trim()));
        if (frame.success) record("sse", `${frame.output.type ?? "?"}#${String(frame.output.eventIndex)}`);
      }
    }
  })().catch(function onStreamEnd(err: Error): void {
    // The stream ends when the run settles or the tab goes away.
    record("sse-ended", String(err.message).slice(0, 120));
  });
}

/* ── the browser half: wire tap + DOM sampler + the mission ─────── */

declare global {
  interface Window {
    __cap: PageCapture;
  }
}

interface PageCapture {
  wire: { t: number; data: string }[];
  dom: { t: number; runs?: (string | null)[]; nodes?: (string | null)[]; dots: number; regions?: (string | null)[] }[];
  dropped: string[];
}

const PAGE_INSTRUMENT = `
window.__cap = { wire: [], dom: [], dropped: [] };
(() => {
  const NativeWS = WebSocket;
  function PatchedWS(url, protocols) {
    const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    ws.addEventListener("message", (ev) => {
      try {
        const s = typeof ev.data === "string" ? ev.data : "";
        if (s.includes("mcts-progress") || s.includes("head_activity") || s.includes("branch_status")) {
          window.__cap.wire.push({ t: Date.now(), data: s.slice(0, 1200) });
        }
      } catch (err) {
        window.__cap.dropped.push(String(err).slice(0, 120));
      }
    });
    return ws;
  }
  PatchedWS.prototype = NativeWS.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) PatchedWS[k] = NativeWS[k];
  window.WebSocket = PatchedWS;
})();
`;

const DOM_SAMPLER = `
(() => {
  let last = "";
  setInterval(() => {
    const runs = [...document.querySelectorAll("[data-fork-run]")].map((el) => el.getAttribute("data-fork-run"));
    const nodes = [...document.querySelectorAll("[data-run-node]")].map((el) => el.getAttribute("data-run-node"));
    const dots = document.querySelectorAll(".mcts-dot").length;
    const regions = [...document.querySelectorAll("[data-run]")].map((el) => el.getAttribute("data-run"));
    const state = JSON.stringify({ runs, nodes, dots, regions });
    if (state === last) return;
    last = state;
    window.__cap.dom.push({ t: Date.now(), runs, nodes, dots, regions });
  }, 150);
})();
`;

async function launchBrowser(): Promise<{ browser: Browser; page: Page }> {
  const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
  const launchOptions: Parameters<typeof puppeteer.launch>[0] = {
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  };
  if (executablePath !== undefined) launchOptions.executablePath = executablePath;
  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.evaluateOnNewDocument(PAGE_INSTRUMENT);
  return { browser, page };
}

async function sendMission(page: Page): Promise<void> {
  await page.waitForSelector("textarea", { timeout: 60_000 });
  const tabs = await page.$$("button");
  for (const tab of tabs) {
    if ((await tab.evaluate((el) => (el.title ?? el.textContent ?? "").trim())) === "Exploration") {
      await tab.click();
      break;
    }
  }
  await Bun.sleep(500);
  const mission =
    `Run one exploration search now with the agents tool: action "swarm", preset "ideate", `
    + `task "Three genuinely different ways to make a todo app's offline sync merge without losing edits", `
    + `branches ${BRANCHES}, depth 1, budget_tokens ${BUDGET_TOKENS}. Do not ask anything; dispatch it and confirm.`;
  await page.type("textarea", mission);
  await page.keyboard.press("Enter");
  log("mission sent");
}

/* ── the poll loop: read models, timestamped ────────────────────── */

interface PollState {
  targetRoot: string | null;
  runSettled: boolean;
}

async function pollReadModels(driver: DriverSocket, state: PollState): Promise<void> {
  try {
    await pollCanvasAndJournal(driver, state);
  } catch (err) {
    if (!EXPECT_RESTART) throw err;
    record("poll-restarted", String(err instanceof Error ? err.message : err).slice(0, 120));
  }
  try {
    const jobs = v.parse(JobRowsSchema, (await driver.call("listBackgroundJobs", [5])).body);
    for (const job of jobs) record("job", `${job.kind}:${job.id.slice(0, 8)}:${job.status}`);
  } catch (err) {
    // The jobs read is secondary; the canvas carries the verdicts.
    record("jobs-read-skipped", String(err instanceof Error ? err.message : err).slice(0, 120));
  }
}

async function pollCanvasAndJournal(driver: DriverSocket, state: PollState): Promise<void> {
  const canvas = v.parse(CanvasPageSchema, (await driver.call("getExplorationCanvas", [{ limit: 5 }])).body);
  for (const entry of canvas.items) {
    if (state.targetRoot === null && entry.run.status === "running") {
      state.targetRoot = entry.run.id;
      record("canvas-run", entry.run.id);
      log(`target run ${entry.run.id} appeared in the canvas read model`);
    }
    if (entry.run.id !== state.targetRoot) continue;
    for (const n of entry.tree) record("canvas-tree-node", n.id);
    for (const n of entry.head?.nodes ?? []) record("canvas-journal-node", n.id);
    if (entry.run.status !== "running") state.runSettled = true;
  }
  if (state.targetRoot === null) return;
  const view = v.parse(HeadRunViewSchema, (await driver.call("getHeadRun", [state.targetRoot])).body);
  if (view === null) return;
  for (const n of view.nodes) record("journal-node", `${n.id}:${n.status}`);
}

/* ── main ───────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  await ensureWorkspace();
  const driver = new DriverSocket();
  await driver.connect();
  log("driver socket connected");

  const { browser, page } = await launchBrowser();
  try {
    await page.goto(`${ORIGIN}/workspace/${encodeURIComponent(WORKSPACE)}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.evaluate(DOM_SAMPLER);
    log("workspace page open, Exploration surface armed");

    const state: PollState = { targetRoot: null, runSettled: false };
    let sseTapped = false;

    const poller = setInterval(() => {
      void pollReadModels(driver, state)
        .then(() => {
          if (state.targetRoot !== null && !sseTapped) {
            sseTapped = true;
            void tapRunEvents(state.targetRoot);
          }
        })
        .catch(function onPollError(err: Error): void {
          record("poll-cycle-failed", String(err.message).slice(0, 120));
        });
    }, POLL_MS);

    await sendMission(page);

    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      await Bun.sleep(1_000);
      let cap: PageCapture;
      try {
        cap = await page.evaluate(() => window.__cap);
      } catch (err) {
        // The page can be mid-navigation (restart mode); the next tick retries.
        record("page-read-skipped", String(err instanceof Error ? err.message : err).slice(0, 120));
        continue;
      }
      for (const drop of cap.dropped) record("page-instrument-dropped", drop);
      cap.dropped.length = 0;
      for (const w of cap.wire) {
        const frame = v.safeParse(BroadcastFrameSchema, JSON.parse(w.data));
        if (!frame.success) continue;
        if (frame.output.type === "mcts-progress") {
          if (frame.output.rootId !== undefined) record("broadcast-run", frame.output.rootId);
          for (const n of frame.output.nodes ?? []) record("broadcast-node", n.id);
        } else if (frame.output.headId !== undefined) {
          record("broadcast-activity", frame.output.headId);
        }
      }
      cap.wire.length = 0;
      for (const d of cap.dom) {
        for (const r of d.regions ?? []) record("dom-region", String(r));
        for (const r of d.runs ?? []) record("dom-run-row", String(r));
        for (const n of d.nodes ?? []) record("dom-node-row", String(n));
        if (d.dots > 0) record("dom-dots", String(d.dots));
      }
      const journalNodes = [...seen].filter((k) => k.startsWith("journal-node:")).length;
      const agentsJobDone = [...seen].some((k) => k.startsWith("job:agents:") && !k.endsWith(":running") && !k.endsWith(":pending"));
      if (state.runSettled && journalNodes >= BRANCHES && agentsJobDone) break;
    }
    clearInterval(poller);
    emitTimeline(state);
  } finally {
    await browser.close();
    driver.close();
  }
}

function emitTimeline(state: PollState): void {
  events.sort((a, b) => a.t - b.t);
  console.log("\n══ timestamped chain ══");
  for (const e of events) console.log(`${elapsed()}  ${e.kind.padEnd(22)} ${e.detail}`);
  console.log(`\ntarget run: ${state.targetRoot ?? "(none observed)"}`);
  const kinds = new Set(events.map((e) => e.kind));
  const links: [string, boolean][] = [
    ["spawn announced (push/journal)", kinds.has("broadcast-node") || kinds.has("broadcast-activity") || kinds.has("journal-node")],
    ["journal row (getHeadRun)", kinds.has("journal-node")],
    ["canvas read model (getExplorationCanvas)", kinds.has("canvas-journal-node") || kinds.has("canvas-tree-node")],
    ["broadcast arrival (page socket)", kinds.has("broadcast-node") || kinds.has("broadcast-activity")],
    ["rendered DOM change", kinds.has("dom-dots") || kinds.has("dom-node-row") || kinds.has("dom-region")],
  ];
  console.log("\n══ chain verdicts ══");
  for (const [name, ok] of links) console.log(`${ok ? "PROVED " : "MISSING"}  ${name}`);
}

await main().catch(function onFatal(err: Error): void {
  console.error(err);
  process.exit(1);
});
