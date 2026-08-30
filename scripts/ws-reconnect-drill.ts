#!/usr/bin/env bun
/**
 * ws-reconnect-drill — a workspace session survives a deploy supersede, proven at runtime.
 *
 * The incident: an open workspace tab hit a deploy's isolate supersede and showed
 * "Workspace snapshot failed … Showing last known data." forever. A manual reload
 * fixed it; the tab itself never recovered. The production shape that sticks is a
 * CORPSE SOCKET: the browser's WebSocket stays ESTABLISHED against a dead peer, so
 * no close event ever fires, every RPC times out, the banner sets, and nothing on
 * the client ever forces a redial.
 *
 * The drill reproduces that shape honestly and asserts recovery with no reload:
 *
 *   sever    — a local holding proxy accepts the browser's socket and dials the
 *              dev server behind it. Severing closes only the upstream half, so
 *              the browser's socket stays OPEN against a peer that never answers
 *              — the exact corpse. Then SIGKILL the dev server.
 *   banner   — wait for the degraded banner ([role=alert] "Showing last known
 *              data"). On shipped code this arrives once the live-refresh reads
 *              time out (~60s) and NEVER leaves while the corpse holds.
 *   restart  — start the dev server again on the same port, rename the workspace
 *              over a direct WS-RPC (the fresh title is the freshness probe),
 *              then restore the proxy's upstream half.
 *   recover  — assert, within deadline and WITHOUT any page reload (the
 *              window.__wsDrillReloadMarker set before the sever would not
 *              survive one): banner gone, new title rendered.
 *   skew     — mock /api/health (request interception) so the build sha changes,
 *              force two clean reconnects by dropping sockets while the server
 *              is healthy, and assert the "new version" reload affordance shows
 *              EXACTLY ONCE.
 *
 * Conventions follow scripts/history-walk-proof.ts: timestamped stages,
 * env-overridable config, artifacts under scripts/artifacts/ws-reconnect/.
 *
 * Zero product diff: this drives the shipped behaviour with no knobs. Run:
 *   bun scripts/ws-reconnect-drill.ts            (manages its own dev server)
 */

import type { Socket } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { parseJsonValue, type JsonValue } from "@kinu.run/core";
import puppeteer, { type Browser, type HTTPRequest, type Page } from "puppeteer";

/* ── configuration ─────────────────────────────────────────────────────────── */

const UPSTREAM_PORT = Number(process.env.KINU_DRILL_UPSTREAM_PORT ?? 5199);
const PROXY_PORT = Number(process.env.KINU_DRILL_PROXY_PORT ?? 5200);
const UPSTREAM_ORIGIN = `http://127.0.0.1:${UPSTREAM_PORT}`;
const ORIGIN = `http://127.0.0.1:${PROXY_PORT}`;
const WORKSPACE = process.env.KINU_DRILL_WORKSPACE ?? "ws-reconnect-drill";
const ARTIFACTS = process.env.KINU_DRILL_ARTIFACTS ?? "scripts/artifacts/ws-reconnect";
const CF_BACKEND = "packages/cf-backend";
/** How long the degraded banner may take to appear after the sever. */
const BANNER_DEADLINE_MS = Number(process.env.KINU_DRILL_BANNER_MS ?? 180_000);
/** How long recovery (banner gone + fresh title, no reload) may take after restore. */
const RECOVERY_DEADLINE_MS = Number(process.env.KINU_DRILL_RECOVERY_MS ?? 240_000);

const T0 = Date.now();
function log(stage: string): void {
  const s = ((Date.now() - T0) / 1000).toFixed(1).padStart(6);
  console.log(`[${s}s] ${stage}`);
}
function fail(stage: string, detail: string): never {
  log(`FAIL ${stage}: ${detail}`);
  throw new Error(`${stage}: ${detail}`);
}

/* ── the corpse proxy ──────────────────────────────────────────────────────── */

interface CorpseProxy {
  /** Client sockets held with no upstream half — the corpse count. */
  severedCount(): number;
  /** Close every upstream half. Client sockets stay ESTABLISHED — the corpse. */
  sever(): void;
  /** Redial upstream for every held client socket and resume piping. */
  restore(): Promise<void>;
  /** Close client AND upstream halves — what the browser sees as a real drop. */
  dropAll(): void;
  stop(): void;
}

/** Client byte-chunks buffered while no upstream exists in pass mode. */
const DIAL_QUEUE_CHUNKS = 256;

interface Pipe {
  client: Socket<unknown>;
  upstream: Socket<unknown> | null;
  /** True while a dial() is in flight — client bytes queue instead of re-dialing. */
  dialing: boolean;
  /** Bytes that arrived while no upstream was attached (cap: DIAL_QUEUE_CHUNKS). */
  queue: Uint8Array[];
  /**
   * How this connection must behave when its upstream dies:
   *   - "agent-ws": the chat websocket. In production a superseded DO's
   *     websocket is dead FOREVER client-side until the client itself
   *     redials — so once its upstream is lost it is a CORPSE: held open,
   *     every byte swallowed, never redialed by the proxy.
   *   - "vite-ping": vite's HMR liveness poll. A built SPA has no such
   *     escape hatch; swallowing it keeps the dev drill as honest as
   *     production about the page not learning that the world changed.
   *   - "http": ordinary traffic. Hold and redial transparently, so idle
   *     keep-alive churn and dev-server restarts do not masquerade as the
   *     incident.
   */
  kind: "agent-ws" | "vite-ping" | "http";
  /** Set when the upstream is lost (or severed). agent-ws pipes never
   *  redial past this point; http pipes queue and redial. */
  upstreamLost: boolean;
}

/** Classify from the request line + headers in the connection's first chunk. */
function classifyPipe(firstChunk: Uint8Array): Pipe["kind"] {
  const head = new TextDecoder("latin1").decode(firstChunk.slice(0, 2048)).toLowerCase();
 const isWebSocket = head.includes("\r\nupgrade: websocket") || head.startsWith("upgrade: websocket");
  if (isWebSocket && head.includes(" /agents/")) return "agent-ws";
  if (head.startsWith("get /__vite_ping")) return "vite-ping";
  return "http";
}

/**
 * Raw TCP forwarder that reproduces, per connection kind, what the browser
 * really experiences when the workspace's isolate is superseded. Ordinary
 * HTTP heals transparently (hold, queue, redial). The chat websocket gets
 * production corpse semantics: its upstream loss holds the socket OPEN and
 * swallows everything — no close event, no redial — until the CLIENT dials
 * again. On sever, upstream sockets close AND nothing is dialed or delivered
 * for any kind; on restore, non-corpse pipes get fresh upstreams.
 */
async function createCorpseProxy(upstreamPort: number, port: number): Promise<CorpseProxy> {
  const pipes = new Set<Pipe>();
  const pipeBySocket = new WeakMap<Socket<unknown>, Pipe>();
  let state: "pass" | "severed" = "pass";

  function endQuietly(why: string, socket: Socket<unknown> | null): void {
    if (!socket) return;
    try {
      socket.end();
    } catch (cause) {
      log(`proxy: end() failed while ${why}: ${String(cause)}`);
    }
  }

  function dropPipe(pipe: Pipe): void {
    pipes.delete(pipe);
    endQuietly("dropping a pipe's upstream", pipe.upstream);
    endQuietly("dropping a pipe's client", pipe.client);
  }

  async function dial(pipe: Pipe): Promise<void> {
    if (pipe.dialing || pipe.upstream) return;
    pipe.dialing = true;
    try {
      const up = await Bun.connect({
        hostname: "127.0.0.1",
        port: upstreamPort,
        socket: {
          data(_upstream, chunk) {
            try {
              pipe.client.write(chunk);
            } catch (cause) {
              log(`proxy: client write failed: ${String(cause)}`);
            }
          },
          close() {
            if (!pipe.upstream) return;
            pipe.upstream = null;
            pipe.upstreamLost = true;
            if (pipe.kind === "agent-ws") {
              log("proxy: AGENT WS upstream lost — socket is now a corpse (no events reach the page)");
              return;
            }
            log(`proxy: ${pipe.kind} upstream closed — client held for redial`);
          },
          error(cause) {
            log(`proxy: upstream socket error: ${String(cause)}`);
          },
        },
      });
      pipe.dialing = false;
      if (state === "severed") {
        // sever() swept while this dial was in flight; cut it too.
        try {
          up.end();
        } catch (cause) {
          log(`proxy: post-sever cut failed: ${String(cause)}`);
        }
        return;
      }
      pipe.upstream = up;
      for (const chunk of pipe.queue.splice(0)) {
        try {
          up.write(chunk);
        } catch (cause) {
          log(`proxy: queued write failed: ${String(cause)}`);
        }
      }
    } catch (cause) {
      pipe.dialing = false;
      // Dial failures are expected while the dev server is down; restore()
      // redials every healable pipe.
      log(`proxy: upstream dial failed (${String(cause)})`);
    }
  }

  /** Whether this pipe may ever receive a fresh upstream after losing one. */
  function isHealable(pipe: Pipe): boolean {
    return pipe.kind === "http";
  }

  const listener = Bun.listen<unknown>({
    hostname: "127.0.0.1",
    port,
    socket: {
      async data(socket, chunk) {
        let pipe = pipeBySocket.get(socket);
        if (!pipe) {
          const fresh: Pipe = {
            client: socket, upstream: null, dialing: false, queue: [],
            kind: classifyPipe(chunk), upstreamLost: false,
          };
          pipeBySocket.set(socket, fresh);
          pipes.add(fresh);
          pipe = fresh;
          if (fresh.kind === "agent-ws") log("proxy: agent websocket classified");
        }
        if (state === "severed") return; // the corpse swallows silently
        if (pipe.upstream) {
          try {
            pipe.upstream.write(chunk);
          } catch (cause) {
            log(`proxy: upstream write failed: ${String(cause)}`);
          }
          return;
        }
        // No upstream attached.
        if (pipe.kind === "agent-ws" && pipe.upstreamLost) return; // CORPSE: swallow forever
        if (pipe.kind === "vite-ping") return; // production has no HMR escape hatch
        if (pipe.queue.length < DIAL_QUEUE_CHUNKS) pipe.queue.push(chunk);
        await dial(pipe);
      },
      close(socket) {
        const pipe = pipeBySocket.get(socket);
        if (!pipe) return;
        pipes.delete(pipe);
        endQuietly("a client close", pipe.upstream);
      },
      error(cause) {
        log(`proxy: client socket error: ${String(cause)}`);
      },
    },
  });

  return {
    severedCount() {
      let held = 0;
      for (const pipe of pipes) if (!pipe.upstream) held += 1;
      return held;
    },
    sever() {
      state = "severed";
      for (const pipe of pipes) {
        endQuietly("severing", pipe.upstream);
        pipe.upstream = null;
        pipe.upstreamLost = true;
      }
    },
    async restore(): Promise<void> {
      state = "pass";
      await Promise.all(
        Array.from(pipes, (pipe) =>
          !pipe.upstream && isHealable(pipe) ? dial(pipe) : undefined,
        ),
      );
    },
    dropAll() {
      // dropPipe removes from `pipes`; iterate a copy.
      for (const pipe of Array.from(pipes)) dropPipe(pipe);
    },
    stop() {
      for (const pipe of Array.from(pipes)) dropPipe(pipe);
      listener.stop(true);
    },
  };
}

/* ── direct WS-RPC mini-client (drill-side control channel) ────────────────── */

const RPC_FRAME_SCHEMA = v.object({
  type: v.optional(v.string()),
  id: v.optional(v.string()),
  success: v.optional(v.boolean()),
  error: v.optional(v.string()),
});

interface RpcReply { success: boolean; error?: string }

type RpcFrame = v.InferOutput<typeof RPC_FRAME_SCHEMA>;

/** A parsed rpc-shaped frame, or null for anything else on the wire. */
function parseRpcFrame(text: string): RpcFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    return null;
  }
  const parsed = v.safeParse(RPC_FRAME_SCHEMA, value);
  return parsed.success ? parsed.output : null;
}

/** Send ONE rpc frame over the agents-SDK websocket protocol and await its reply. */
async function callAgentRpc(name: string, method: string, args: JsonValue[]): Promise<void> {
  const url = `ws://127.0.0.1:${UPSTREAM_PORT}/agents/orchestrator-agent/${encodeURIComponent(name)}`;
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("rpc socket: open timeout")), 15_000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("rpc socket: error")); };
  });
  try {
    const reply = await new Promise<RpcReply>((resolve, reject) => {
      const id = `drill-${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => reject(new Error(`rpc ${method}: reply timeout`)), 20_000);
      ws.onmessage = (ev) => {
        const frame = parseRpcFrame(String(ev.data));
        if (!frame || frame.type !== "rpc" || frame.id !== id) return;
        clearTimeout(timer);
        resolve({ success: frame.success === true, error: frame.error });
      };
      ws.send(JSON.stringify({ type: "rpc", id, method, args }));
    });
    if (!reply.success) throw new Error(`rpc ${method} failed: ${reply.error ?? "no error given"}`);
  } finally {
    ws.close();
  }
}

/* ── dev-server lifecycle ──────────────────────────────────────────────────── */

const DEV_VARS_PATH = join(CF_BACKEND, ".dev.vars");

function ensureDevVars(): void {
  const existing = existsSync(DEV_VARS_PATH) ? readFileSync(DEV_VARS_PATH, "utf8") : "";
  if (existing.includes("DEV_USER_EMAIL=")) return;
  if (existing.trim()) {
    throw new Error(`${DEV_VARS_PATH} exists without DEV_USER_EMAIL — add it or move the file aside`);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = btoa(String.fromCharCode(...bytes));
  writeFileSync(DEV_VARS_PATH, `DEV_USER_EMAIL=drill@local.test\nCREDENTIAL_ENCRYPTION_KEY=${key}\n`);
  log(`wrote ${DEV_VARS_PATH} (dev identity + encryption key)`);
}

interface DevServer {
  kill(): Promise<void>;
}

function isStartupProbeFailure<ErrorValue>(cause: ErrorValue): boolean {
  return cause instanceof TypeError || cause instanceof DOMException;
}

/** The port must be genuinely bindable before vite spawns: a name-based
 *  pkill cannot catch every orphan shape, and a ghost answering /api/health
 *  makes the readiness poll pass against the WRONG server. Probe-bind until
 *  the port is free, sweeping hard between attempts. */
async function waitForPortFree(port: number): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const probe = Bun.listen({
        hostname: "127.0.0.1",
        port,
        socket: { data() {}, close() {}, error() {} },
      });
      probe.stop(true);
      return;
    } catch (cause) {
      if (!(cause instanceof Error) || !cause.message.includes("EADDRINUSE")) throw cause;
      log(`port ${port} still held (${cause.message}) — sweeping again`);
      Bun.spawnSync(["pkill", "-9", "-f", `port ${port}`]);
      await Bun.sleep(1_000);
    }
  }
  fail("dev-server", `port ${port} never became free`);
}

async function spawnDevServerOnce(): Promise<ReturnType<typeof Bun["spawn"]>> {
  // A previous crashed run leaves an orphaned `vite` child holding the port;
  // clear it so this bind succeeds.
  Bun.spawnSync(["pkill", "-f", `port ${UPSTREAM_PORT}`]);
  await waitForPortFree(UPSTREAM_PORT);
  return Bun.spawn(
    ["bun", "x", "vite", "dev", "--host", "127.0.0.1", "--port", String(UPSTREAM_PORT), "--strictPort"],
    { cwd: CF_BACKEND, stdin: "ignore", stdout: "ignore", stderr: "inherit" },
  );
}

async function startDevServer(label: string): Promise<DevServer> {
  log(`starting dev server (${label}) on :${UPSTREAM_PORT}`);
  let proc: ReturnType<typeof Bun["spawn"]> | null = null;
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > 300_000) fail("dev-server", `${label} never answered /api/health`);
    if (proc === null || proc.exitCode !== null) {
      if (proc !== null) {
        log(`dev server (${label}) exited with code ${proc.exitCode} before answering — sweeping and retrying`);
        Bun.spawnSync(["pkill", "-9", "-f", `port ${UPSTREAM_PORT}`]);
        await Bun.sleep(3_000);
      }
      proc = await spawnDevServerOnce();
    }
    try {
      const res = await fetch(`${UPSTREAM_ORIGIN}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) break;
    } catch (cause) {
      if (!isStartupProbeFailure(cause)) throw cause;
    }
    await Bun.sleep(500);
  }
  log(`dev server up (${label})`);
  return {
    async kill() {
      proc.kill(9);
      await proc.exited;
      // bunx parents the real vite process; SIGKILLing the parent orphans the
      // child, so sweep by port too before the next bind.
      Bun.spawnSync(["pkill", "-f", `port ${UPSTREAM_PORT}`]);
      await Bun.sleep(500);
      log(`dev server killed (${label})`);
    },
  };
}

/**
 * A stand-in for the deploy DRAIN WINDOW: a server that completes the
 * websocket handshake and answers every rpc frame immediately with the
 * platform's connection-lost failure — which is exactly what a superseding
 * isolate surfaces while its cross-DO calls are dying. Fast, repeated,
 * protocol-level failures; the shape that sets the degraded banner before
 * the world goes quiet.
 */
interface FailureServer {
  stop(): Promise<void>;
}

function startFailureServer(port: number): Promise<FailureServer> {
  const server = Bun.serve({
    port,
    async fetch(request, sup) {
      if (new URL(request.url).pathname.startsWith("/agents/") && sup.upgrade(request)) {
        return undefined;
      }
      return new Response("draining", { status: 503 });
    },
    websocket: {
      message(ws, raw) {
        const frame = parseRpcFrame(String(raw));
        if (!frame || frame.type !== "rpc" || frame.id === undefined) return;
        ws.send(JSON.stringify({
          type: "rpc",
          id: frame.id,
          success: false,
          error: "Network connection lost.",
        }));
      },
    },
  });
  return Promise.resolve({
    async stop() {
      await server.stop(true);
      await Bun.sleep(300);
    },
  });
}

/* ── REST helpers (direct to upstream — never through the proxy) ───────────── */

async function api(path: string, init?: RequestInit): Promise<JsonValue | undefined> {
  const res = await fetch(`${UPSTREAM_ORIGIN}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? parseJsonValue(text) : undefined;
}

const WORKSPACE_LIST_SCHEMA = v.object({
  entries: v.optional(v.array(v.object({ name: v.optional(v.string()) }))),
});

async function ensureWorkspace(): Promise<void> {
  const raw: unknown = await api("/api/user/workspaces");
  const parseWorkspaceList = v.parser(WORKSPACE_LIST_SCHEMA);
  const list = parseWorkspaceList(raw);
  const names = new Set((list.entries ?? []).map((w) => w.name));
  if (names.has(WORKSPACE)) {
    log(`workspace "${WORKSPACE}" exists`);
    return;
  }
  // Workspace creation refuses without a resolvable default model, and the
  // create route's schema admits only name/displayName/purpose — so the
  // default goes through the product's own config surface first.
  await api("/api/user/config/default_model", {
    method: "PUT",
    body: JSON.stringify({ value: "ai-gateway/workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813" }),
  });
  await api("/api/user/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: WORKSPACE, purpose: "ws-reconnect drill" }),
  });
  log(`workspace "${WORKSPACE}" created`);
}

/* ── browser probes ────────────────────────────────────────────────────────── */

const MOCK_SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MOCK_SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
let mockedSha = MOCK_SHA_A;

/** Rolling capture of what the browser said — dumped on every failure. */
class BrowserLog {
  private lines: string[] = [];
  record(kind: string, text: string): void {
    this.lines.push(`${kind}: ${text}`.slice(0, 400));
    if (this.lines.length > 200) this.lines.shift();
  }
  dump(): string {
    return this.lines.slice(-30).join("\n  ");
  }
}
const browserLog = new BrowserLog();

/** What the page surface says right now: alerts, statuses, body text, marker.
 *  The marker reads 0 when absent — which is exactly the reload signal. */
interface PageProbe {
  alerts: string[];
  statuses: string[];
  bodyText: string;
  marker: number;
  /** The composer's textarea — the positive "the app rendered" signal. */
  hasComposer: boolean;
}

async function probe(page: Page): Promise<PageProbe> {
  // The reload marker is read as an expression string on purpose: the drill
  // assigned window.__wsDrillReloadMarker itself right after navigation, and
  // a plain evaluate keeps that handoff free of a type assertion.
  const marker = Number(await page.evaluate("window.__wsDrillReloadMarker ?? 0"));
  return page.evaluate((reloadMarker: number) => ({
    alerts: [...document.querySelectorAll('[role="alert"]')].map((el) => el.textContent ?? ""),
    statuses: [...document.querySelectorAll('[role="status"]')].map((el) => el.textContent ?? ""),
    bodyText: document.body.innerText,
    marker: reloadMarker,
    hasComposer: document.querySelector("textarea") !== null,
  }), marker);
}

const hasDegradedBanner = (p: PageProbe): boolean =>
  p.alerts.some((t) => t.includes("Showing last known data"));
const newVersionAffordances = (p: PageProbe): string[] =>
  p.statuses.filter((t) => t.toLowerCase().includes("new version"));


async function waitFor(
  what: string, deadlineMs: number, pollMs: number,
  predicate: () => Promise<boolean>,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await predicate()) {
      log(`${what} ✓ (after ${((Date.now() - started) / 1000).toFixed(1)}s)`);
      return;
    }
    if (Date.now() - started > deadlineMs) {
      log(`browser said, last words first:\n  ${browserLog.dump()}`);
      fail(what, `deadline ${deadlineMs}ms exceeded`);
    }
    await Bun.sleep(pollMs);
  }
}

/* ── main ──────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  mkdirSync(ARTIFACTS, { recursive: true });
  ensureDevVars();

  const proxy = await createCorpseProxy(UPSTREAM_PORT, PROXY_PORT);
  log(`corpse proxy listening on :${PROXY_PORT} → :${UPSTREAM_PORT}`);

  let server = await startDevServer("first boot");
  await ensureWorkspace();

  const browser: Browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    page.on("console", (msg) => browserLog.record(`console.${msg.type()}`, msg.text()));
    page.on("pageerror", (err) => browserLog.record("pageerror", String(err)));
    page.on("requestfailed", (req) => browserLog.record("requestfailed", `${req.url()} — ${req.failure()?.errorText ?? "?"}`));
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) browserLog.record("nav", frame.url());
    });
    await page.setViewport({ width: 1568, height: 900 });
    await page.setRequestInterception(true);
    page.on("request", async (req: HTTPRequest) => {
      if (new URL(req.url()).pathname === "/api/health") {
        await req.respond({
          status: 200,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify({
            ok: true,
            build: { version: "0.0.0-drill", sha: mockedSha, builtAt: new Date().toISOString() },
            features: { builtinTools: 0, swarmPresets: 0, namedSearches: 0 },
            endpoints: {},
            timestamp: new Date().toISOString(),
          }),
        });
        return;
      }
      await req.continue();
    });

    // ── stage 1: connect through the proxy ────────────────────────────────
    await page.goto(`${ORIGIN}/workspace/${WORKSPACE}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.evaluate("window.__wsDrillReloadMarker = 1");
    await waitFor("client connected (composer rendered, no reconnect strip)", 120_000, 500, async () => {
      const p = await probe(page);
      return p.hasComposer && !p.bodyText.includes("Reconnecting...");
    });
    const sane = await probe(page);
    if (hasDegradedBanner(sane)) fail("baseline", "degraded banner present on a healthy session");
    if (sane.marker !== 1) fail("baseline", "reload marker missing");
    await page.screenshot({ path: join(ARTIFACTS, "1-connected.png") });
    log("stage 1 complete: healthy session through the proxy");

    // ── stage 2: the drain window — the banner sets ───────────────────────
    // The real server dies; a stand-in takes the port and answers every rpc
    // immediately with the platform's connection-lost failure — the shape a
    // superseding isolate surfaces while its calls are dying. Fast, repeated
    // failures land while they are still current, so the degraded banner
    // sets, worded exactly as the incident's.
    await server.kill();
    const draining = await startFailureServer(UPSTREAM_PORT);
    proxy.dropAll(); // a client-VISIBLE close: partysocket redials into the stand-in
    await waitFor("degraded banner appeared", BANNER_DEADLINE_MS, 1_000, async () =>
      hasDegradedBanner(await probe(page)));
    await page.screenshot({ path: join(ARTIFACTS, "2-degraded.png") });

    // ── stage 3: the world heals; the healthy path must clear the banner ──
    // The stand-in going away is ALSO client-visible (a supersede resets the
    // socket): close it so the page redials into the healed server instead of
    // holding a corpse through the transition.
    await draining.stop();
    proxy.dropAll();
    server = await startDevServer("second boot");
    await ensureWorkspace();
    await waitFor("banner cleared after clean reconnect", 180_000, 2_000, async () =>
      !hasDegradedBanner(await probe(page)));
    await page.screenshot({ path: join(ARTIFACTS, "3-banner-cleared.png") });
    log("stage 3 complete: banner gone after the clean reconnect");

    // ── stage 4: THE CORPSE — the eventless supersede ─────────────────────
    // sever() holds the browser's sockets OPEN with no upstream, so no close
    // or open event ever reaches the page. The fresh server renames the
    // workspace; a session that cannot see the world change stays frozen on
    // the old title forever.
    proxy.sever();
    await server.kill();
    server = await startDevServer("third boot");
    await ensureWorkspace();
    const newTitle = `Renamed ${new Date().toLocaleTimeString()}`;
    await callAgentRpc(WORKSPACE, "setDisplayName", [newTitle]);
    log(`workspace renamed to "${newTitle}" behind the corpse`);
    await proxy.restore();
    log("stage 4: corpse established, world healed behind it");
    await waitFor("fresh data flowing: new title visible", RECOVERY_DEADLINE_MS, 2_000, async () => {
      const p = await probe(page);
      return p.bodyText.includes(newTitle);
    });
    // The title renders from the snapshot success; the per-source errors the
    // corpse left behind clear on the next live-refresh tick. Recovery is
    // complete only when BOTH have settled.
    await waitFor("recovered: degraded banner cleared", 90_000, 1_000, async () =>
      !hasDegradedBanner(await probe(page)));
    const recovered = await probe(page);
    if (recovered.marker !== 1) fail("recovery", "page reloaded mid-drill (marker lost) — recovery must be seamless");
    await page.screenshot({ path: join(ARTIFACTS, "4-recovered.png") });
    log("stage 4 complete: session caught up without a reload");

    // ── stage 5: version skew → reload affordance exactly once ────────────
    mockedSha = MOCK_SHA_B;
    proxy.dropAll(); // clean reconnect #1
    await Bun.sleep(8_000);
    proxy.dropAll(); // clean reconnect #2 — latching must keep it at one
    await waitFor("version-skew affordance shown", 120_000, 1_000, async () =>
      newVersionAffordances(await probe(page)).length > 0);
    await page.screenshot({ path: join(ARTIFACTS, "4-version-affordance.png") });
    await Bun.sleep(10_000);
    const final = await probe(page);
    const affordances = newVersionAffordances(final);
    if (affordances.length !== 1) fail("version-skew", `expected exactly 1 affordance, found ${affordances.length}`);
    if (final.marker !== 1) fail("version-skew", "page reloaded during skew phase");
    log("stage 5 complete: reload affordance shown exactly once");
    log("DRILL GREEN — session survived the supersede without a reload");
  } finally {
    try {
      await browser.close();
    } catch (cause) {
      log(`cleanup: browser close failed: ${String(cause)}`);
    }
    try {
      await server.kill();
    } catch (cause) {
      log(`cleanup: dev server kill failed: ${String(cause)}`);
    }
    proxy.stop();
  }
}

try {
  await main();
  process.exit(0);
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
}
