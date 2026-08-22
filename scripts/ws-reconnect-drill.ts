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
  restore(): void;
  /** Close client AND upstream halves — what the browser sees as a real drop. */
  dropAll(): void;
  stop(): void;
}

interface Pipe {
  client: Socket<unknown>;
  upstream: Socket<unknown> | null;
}

/**
 * Raw TCP forwarder with hold-the-client-open semantics. Bytes pipe both ways
 * while an upstream socket lives. On sever, upstream sockets close (the dev
 * server dies believing its clients left); client sockets stay open and every
 * byte they send is discarded. On restore, each held client gets a fresh
 * upstream dial and piping resumes.
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

  function dial(pipe: Pipe): void {
    Bun.connect({
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
          // A genuine upstream death while passing through propagates to the
          // client; only a deliberate sever holds the corpse open.
          if (state === "pass") {
            log("proxy: upstream died mid-session — dropping the client with it");
            dropPipe(pipe);
          }
        },
        error(cause) {
          log(`proxy: upstream socket error: ${String(cause)}`);
        },
      },
    }).then((up) => {
      if (state === "severed") {
        endQuietly("severing a just-dialed upstream", up);
        return;
      }
      pipe.upstream = up;
    }).catch((cause: Error) => {
      // Dial failures are expected while the dev server is down; restore()
      // redials every held pipe.
      log(`proxy: upstream dial failed (${String(cause)})`);
    });
  }

  const listener = Bun.listen<unknown>({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(socket, chunk) {
        let pipe = pipeBySocket.get(socket);
        if (!pipe) {
          const fresh: Pipe = { client: socket, upstream: null };
          pipeBySocket.set(socket, fresh);
          pipes.add(fresh);
          dial(fresh);
          return;
        }
        if (state === "pass" && pipe.upstream) {
          try {
            pipe.upstream.write(chunk);
          } catch (cause) {
            log(`proxy: upstream write failed: ${String(cause)}`);
          }
        }
        // severed, or upstream not yet dialed: discard — the corpse swallows silently.
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
      }
    },
    restore() {
      state = "pass";
      for (const pipe of pipes) if (!pipe.upstream) dial(pipe);
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
async function callAgentRpc(name: string, method: string, args: unknown[]): Promise<void> {
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

async function startDevServer(label: string): Promise<DevServer> {
  log(`starting dev server (${label}) on :${UPSTREAM_PORT}`);
  // A previous crashed run leaves an orphaned `vite` child holding the port;
  // clear it so this bind succeeds.
  Bun.spawnSync(["pkill", "-f", `port ${UPSTREAM_PORT}`]);
  await Bun.sleep(500);
  const proc = Bun.spawn(
    ["bun", "x", "vite", "dev", "--host", "127.0.0.1", "--port", String(UPSTREAM_PORT), "--strictPort"],
    { cwd: CF_BACKEND, stdin: "ignore", stdout: "ignore", stderr: "inherit" },
  );
  const healthAt = `${UPSTREAM_ORIGIN}/api/health`;
  const started = Date.now();
  for (;;) {
    if (proc.exitCode !== null) fail("dev-server", `${label} exited early with code ${proc.exitCode}`);
    if (Date.now() - started > 180_000) fail("dev-server", `${label} never answered /api/health`);
    try {
      const res = await fetch(healthAt, { signal: AbortSignal.timeout(2_000) });
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

/** What the page surface says right now: alerts, statuses, body text, marker.
 *  The marker reads 0 when absent — which is exactly the reload signal. */
interface PageProbe {
  alerts: string[];
  statuses: string[];
  bodyText: string;
  marker: number;
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
    if (Date.now() - started > deadlineMs) fail(what, `deadline ${deadlineMs}ms exceeded`);
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
    await page.setViewport({ width: 1568, height: 900 });
    await page.setRequestInterception(true);
    page.on("request", (req: HTTPRequest) => {
      if (new URL(req.url()).pathname === "/api/health") {
        void req.respond({
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
      void req.continue();
    });

    // ── stage 1: connect through the proxy ────────────────────────────────
    await page.goto(`${ORIGIN}/workspace/${WORKSPACE}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.evaluate("window.__wsDrillReloadMarker = 1");
    await waitFor("client connected (no Connecting/Reconnecting)", 90_000, 500, async () => {
      const p = await probe(page);
      return !p.bodyText.includes("Connecting...") && !p.bodyText.includes("Reconnecting...");
    });
    const sane = await probe(page);
    if (hasDegradedBanner(sane)) fail("baseline", "degraded banner present on a healthy session");
    if (sane.marker !== 1) fail("baseline", "reload marker missing");
    await page.screenshot({ path: join(ARTIFACTS, "1-connected.png") });
    log("stage 1 complete: healthy session through the proxy");

    // ── stage 2: sever — the corpse ────────────────────────────────────────
    proxy.sever();
    await server.kill(); // upstream is already cut; the kill never reaches the browser
    log(`stage 2: corpse established (${proxy.severedCount()} client socket[s] held open)`);
    await waitFor("degraded banner appeared", BANNER_DEADLINE_MS, 2_000, async () =>
      hasDegradedBanner(await probe(page)));
    await page.screenshot({ path: join(ARTIFACTS, "2-degraded.png") });

    // ── stage 3: fresh server, renamed workspace, restore ─────────────────
    server = await startDevServer("second boot");
    await ensureWorkspace();
    const newTitle = `Renamed ${new Date().toLocaleTimeString()}`;
    await callAgentRpc(WORKSPACE, "setDisplayName", [newTitle]);
    log(`workspace renamed to "${newTitle}" on the fresh server`);
    proxy.restore();
    log("stage 3: proxy restored — upstream alive again");

    // ── stage 4: recovery, no reload ──────────────────────────────────────
    await waitFor("recovered: degraded banner cleared", RECOVERY_DEADLINE_MS, 2_000, async () =>
      !hasDegradedBanner(await probe(page)));
    await waitFor("fresh data flowing: new title visible", 60_000, 1_000, async () => {
      const p = await probe(page);
      return p.bodyText.includes(newTitle);
    });
    const recovered = await probe(page);
    if (recovered.marker !== 1) fail("recovery", "page reloaded mid-drill (marker lost) — recovery must be seamless");
    await page.screenshot({ path: join(ARTIFACTS, "3-recovered.png") });
    log("stage 4 complete: banner gone, fresh title, no reload");

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
    await browser.close().catch((cause: Error) => log(`cleanup: browser close failed: ${String(cause)}`));
    await server.kill().catch((cause: Error) => log(`cleanup: dev server kill failed: ${String(cause)}`));
    proxy.stop();
  }
}

main().then(() => process.exit(0), (cause: Error) => {
  console.error(cause.message);
  process.exit(1);
});
