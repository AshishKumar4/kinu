/**
 * Interactive terminal transport: one WebSocket per attached terminal carrying raw PTY bytes,
 * off the JSON-only chat rail, behind the same auth/ownership/CSRF gates as `/api/workspaces/:agentName/`.
 * Container sessions use native exec PTYs; workspace sessions use workspace-terminal.ts.
 */

import { Hono, type Context } from "hono";
import { getAgentByName } from "agents";
import { diagnostics, renderThrownChain, toKinuError, type KinuError } from "@kinu.run/core/obs";
import type { OrchestratorAgent } from "./orchestrator";

import { objectNamed, err, json } from "@kinu.run/core";
import { DEVICE_PTY_MAX_AXIS, DEVICE_SCREEN_PATH, DEVICE_TERMINAL_PATH } from "@kinu.run/core";
import { terminalLane } from "@kinu.run/core";
import { sandboxIdForWorkspace } from "@kinu.run/core";
import { WORKSPACE_TERMINAL_PATH } from "@kinu.run/core";
import type { FamilyEnv } from "./api/context";
import { LITERAL_WORKSPACE, type WorkspaceVariables } from "./api/workspace";


const DEVICE_EXECUTOR = "device";

const WORKSPACE_EXECUTOR = "workspace";

const COMPUTER_EXECUTOR = "computer";

/** Each lane's report when its executor is not ready for an attach. */
const NOT_READY = {
  device: { event: "terminal.not_ready", doing: "reaching this workspace's machine for a terminal" },
  workspace: { event: "terminal.workspace_not_ready", doing: "composing this workspace's runtime for a terminal" },
  terminal: { event: "terminal.not_ready", doing: "preparing this workspace's computer for a terminal" },
  desktop: { event: "desktop.not_ready", doing: "preparing this workspace's computer for a desktop" },
} as const;

const PREFLIGHT_FAILED = { terminal: "terminal.preflight_failed", desktop: "desktop.preflight_failed" } as const;

const UPGRADE_NOT_RELEASED = {
  terminal: "terminal.abandoned_upgrade_not_released", desktop: "desktop.abandoned_upgrade_not_released",
} as const;

const ATTACH_FAILED = { terminal: "terminal.attach_failed", desktop: "desktop.attach_failed" } as const;

const DEFAULT_WINDOW = { cols: 80, rows: 24 } as const;

interface DeviceHolderNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> };
}

export type TerminalWorkspace = Pick<OrchestratorAgent, 'prepareTerminal' | 'openDeviceTerminal' | 'openDeviceScreen' | 'fetch'>;

interface TerminalSandbox {
  fetch(request: Request): Promise<Response>;
  noteTerminalActivity(): Promise<void>;
  resetShell(session?: string): Promise<void>;
}

export interface TerminalRouteDeps {
  resolveWorkspace(name: string): Promise<TerminalWorkspace>;
  /** Called on the container lane only, so device and workspace terminals mint no container stub. */
  resolveSandbox(name: string): TerminalSandbox | null;
  readonly UserDO: DeviceHolderNamespace;
}

export function terminalRouteDeps(env: Env): TerminalRouteDeps {
  return {
    resolveWorkspace: (name) => getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, name),
    resolveSandbox: (name) => env.KinuDevbox === undefined
      ? null
      : env.KinuDevbox.getByName(sandboxIdForWorkspace(name)),
    UserDO: env.UserDO,
  };
}

/** `Number(null)` and `Number("")` are 0, which the bound rejects, so absence needs no separate arm. */
function paneWindow(url: URL) {
  const axis = (name: "cols" | "rows"): number => {
    const value = Number(url.searchParams.get(name));

    return Number.isInteger(value) && value > 0 && value <= DEVICE_PTY_MAX_AXIS ? value : DEFAULT_WINDOW[name];
  };

  return { cols: axis("cols"), rows: axis("rows") };
}


/**
 * Allowlist: the SDK forwards every header to the container, which runs agent code, so the session
 * cookie and `x-kinu-user-id` must not reach it.
 */
const PTY_UPGRADE_HEADERS = {
  "upgrade": true,
  "connection": true,
  "sec-websocket-key": true,
  "sec-websocket-version": true,
  "sec-websocket-protocol": true,
  "sec-websocket-extensions": true,
};

function ptyUpgradeRequest(request: Request): Request {
  const headers = new Headers(request.headers);

  for (const name of Array.from(headers.keys())) {
    if (!(name in PTY_UPGRADE_HEADERS)) headers.delete(name);
  }

  return new Request(request, { headers });
}

const CLIENT_GONE = Symbol("terminal client went away");

function clientGone(signal: AbortSignal): Promise<typeof CLIENT_GONE> {
  const { promise, resolve } = Promise.withResolvers<typeof CLIENT_GONE>();

  if (signal.aborted) resolve(CLIENT_GONE);
  else signal.addEventListener("abort", () => resolve(CLIENT_GONE), { once: true });

  return promise;
}

function abandonedAttach(surface: TerminalCall["surface"]): Response {
  return err(503, `${surface} attach abandoned: the client disconnected before it opened`);
}

interface TerminalCall {
  readonly request: Request;
  readonly url: URL;
  readonly deps: TerminalRouteDeps;
  readonly agentName: string;
  readonly executor: string;
  readonly verb: "attach" | "keepalive" | "reset";
  /** A desktop (D70) attaches as its machine's terminal does: the computer's container, or a PC's daemon (1014-t). */
  readonly surface: "terminal" | "desktop";
  readonly scope: { readonly workspace: string; readonly executor: string };
}

/** The workspace once its executor is ready for a terminal, or the 503 saying why not. */
async function readyWorkspace(call: TerminalCall, lane: keyof typeof NOT_READY): Promise<TerminalWorkspace | Response> {
  const agent = await call.deps.resolveWorkspace(call.agentName);
  const ready = await agent.prepareTerminal(call.executor, call.surface);

  if (!("error" in ready)) return agent;
  const notReady = NOT_READY[lane];
  diagnostics.failure(notReady.event, toKinuError({ doing: notReady.doing, cause: ready.error, otherwise: "unavailable" }), call.scope);

  return err(503, ready.error);
}

function notAnUpgrade({ request, surface }: TerminalCall): Response | null {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return err(400, `the ${surface} endpoint is a WebSocket; send an Upgrade: websocket request`);
  }

  return null;
}

/** The shell runs on the owner's machine: the upgrade is handed to the DO holding its outbound socket. */
async function deviceTerminal(call: TerminalCall): Promise<Response> {
  const { request, url } = call;

  // Guards only: they keep a device request off the container path, which would beat a foreign lease.
  if (call.verb !== "attach") {
    if (request.method !== "POST") return err(405, "use POST");

    return json({ body: { ok: true } });
  }

  // The pane names its PC and the workspace's session on it (1014-t); one that names no session opens the first.
  const target = { device: url.searchParams.get("device") ?? undefined, session: url.searchParams.get("session") ?? undefined };

  return toDeviceHolder(call, DEVICE_TERMINAL_PATH, (agent) => agent.openDeviceTerminal(paneWindow(url), target));
}

/** A PC's screen, as its shell: opened through the workspace, the viewer's upgrade then handed to the DO holding the
 *  PC's socket (1014-t). */
async function deviceDesktop(call: TerminalCall, device: string): Promise<Response> {
  return toDeviceHolder(call, DEVICE_SCREEN_PATH, (agent) => agent.openDeviceScreen(device));
}

const DEVICE_SURFACE = {
  terminal: { doing: "opening a terminal on this machine", reaching: "reaching this workspace to open a terminal" },
  desktop: { doing: "opening this machine's screen", reaching: "reaching this workspace to open a machine's screen" },
} as const;

const DEVICE_OPEN_FAILED = { terminal: "terminal.device_open_failed", desktop: "desktop.device_open_failed" } as const;

const DEVICE_REFUSED = { terminal: "terminal.device_refused", desktop: "desktop.device_refused" } as const;

async function toDeviceHolder(
  call: TerminalCall,
  path: string,
  open: (agent: TerminalWorkspace) => Promise<{ session: string; user: string } | { error: string }>,
): Promise<Response> {
  const { request, deps, scope } = call;
  const surface = DEVICE_SURFACE[call.surface];
  const refused = notAnUpgrade(call);

  if (refused !== null) return refused;

  let opened: { session: string; user: string } | { error: string };

  try {
    const agent = await readyWorkspace(call, "device");

    if (agent instanceof Response) return agent;
    opened = await open(agent);
  } catch (cause) {
    const error = toKinuError({ doing: surface.reaching, cause, otherwise: "unavailable" });

    diagnostics.failure(DEVICE_OPEN_FAILED[call.surface], error, scope);

    return err(503, renderThrownChain({ cause: error }));
  }

  if ("error" in opened) {
    // Already a rendered chain from the RPC's other side, so it rides as the cause.
    diagnostics.failure(DEVICE_REFUSED[call.surface], toKinuError({ doing: surface.doing, cause: opened.error, otherwise: "unavailable" }), scope);

    return err(503, opened.error);
  }

  if (request.signal.aborted) return abandonedAttach(call.surface);
  // A WebSocket cannot cross an RPC boundary, but an upgrade request can. The session is single-use.
  const socketUrl = new URL(request.url);
  socketUrl.pathname = path;
  socketUrl.search = `?session=${encodeURIComponent(opened.session)}`;

  return objectNamed(deps.UserDO, opened.user).fetch(new Request(socketUrl, request));
}

/** The shell is the runtime's, inside the workspace object; keepalive/reset are guards as for a device. */
async function workspaceTerminal(call: TerminalCall): Promise<Response> {
  const { request, scope } = call;

  if (call.verb !== "attach") {
    if (request.method !== "POST") return err(405, "use POST");

    return json({ body: { ok: true } });
  }

  const refused = notAnUpgrade(call);

  if (refused !== null) return refused;

  try {
    const agent = await readyWorkspace(call, "workspace");

    if (agent instanceof Response) return agent;

    if (request.signal.aborted) return abandonedAttach(call.surface);
    // The gate's identity headers ride along: one revocation closes chat and socket.
    const socketUrl = new URL(request.url);
    socketUrl.pathname = WORKSPACE_TERMINAL_PATH;

    return await agent.fetch(new Request(socketUrl, request));
  } catch (cause) {
    const error = toKinuError({
      doing: "reaching this workspace to open its shell",
      cause,
      otherwise: "unavailable",
    });

    diagnostics.failure("terminal.workspace_open_failed", error, scope);

    return err(503, renderThrownChain({ cause: error }));
  }
}

/** One sandbox call behind a POST. A failure keeps its whole chain (AGENTS.md § Errors): it is
 *  never broken at a display boundary. */
async function sandboxCommand(
  call: TerminalCall,
  run: () => Promise<void>,
  failed: { readonly doing: string; readonly report: (error: KinuError) => void },
): Promise<Response> {
  if (call.request.method !== "POST") return err(405, "use POST");

  try {
    await run();

    return json({ body: { ok: true } });
  } catch (cause) {
    const error = toKinuError({ doing: failed.doing, cause, otherwise: "unavailable" });

    failed.report(error);

    return err(503, renderThrownChain({ cause: error }));
  }
}

/**
 * Same preflight as exec (up, /workspace attached, egress installed), under the attach's diagnostic
 * scope. Not fenced by cancellation: the start is shared and idempotent.
 */
async function sandboxPreflight(call: TerminalCall): Promise<Response | null> {
  const { scope, surface } = call;

  try {
    const agent = await readyWorkspace(call, surface);

    if (agent instanceof Response) return agent;
  } catch (cause) {
    const error = toKinuError({
      doing: `reaching this workspace to prepare a ${surface}`,
      cause,
      otherwise: "unavailable",
    });

    diagnostics.failure(PREFLIGHT_FAILED[surface], error, scope);

    return err(503, renderThrownChain({ cause: error }));
  }

  return null;
}

/**
 * Fenced by `request.signal`, not a clock: no single deadline exceeds a cold start yet undercuts an
 * open tab.
 */
async function sandboxAttach(sandbox: TerminalSandbox, call: TerminalCall, ctx: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  const { request, scope, surface } = call;

  if (request.signal.aborted) return abandonedAttach(surface);

  try {
    await sandbox.noteTerminalActivity();
    const url = new URL(request.url);
    url.pathname = `/_devbox/${surface}`;
    const size = paneWindow(call.url);
    url.searchParams.set("cols", String(size.cols));
    url.searchParams.set("rows", String(size.rows));
    const upgrade = sandbox.fetch(new Request(url.toString(), ptyUpgradeRequest(request)));
    const settled = await Promise.race([upgrade, clientGone(request.signal)]);

    if (settled === CLIENT_GONE) {
      // Release the orphaned upgrade, else the PTY stream stays open until the edge idle reap
      // (PLATFORM_CATALOG `edge.websocket_idle_reap_ms`). `waitUntil` retains it past the response.
      ctx.waitUntil((async () => {
        try {
          const response = await upgrade;
          response.webSocket?.accept();
          response.webSocket?.close(1001, `${surface} client went away`);
        } catch (cause) {
          diagnostics.failure(UPGRADE_NOT_RELEASED[surface], toKinuError({
            doing: `releasing the ${surface} upgrade a departed client left behind`,
            cause,
            otherwise: "unavailable",
          }), scope);
        }
      })());

      return abandonedAttach(surface);
    }

    return settled;
  } catch (cause) {
    const error = toKinuError({
      doing: `attaching a ${surface} to the computer`,
      cause,
      otherwise: "unavailable",
    });

    diagnostics.failure(ATTACH_FAILED[surface], error, scope);

    return err(503, renderThrownChain({ cause: error }));
  }
}

async function sandboxTerminal(call: TerminalCall, ctx: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  const sandbox = call.deps.resolveSandbox(call.agentName);

  if (sandbox === null) return err(503, "this deployment has no computer configured");

  // Proxied frames renew the platform's activity clock but not the durable lease `Devbox` reads
  // before quiescing; without this beat a container can stop under a typing user.
  if (call.verb === "keepalive") {
    return sandboxCommand(call, () => sandbox.noteTerminalActivity(), {
      doing: "renewing the computer's lease for an attached terminal",
      report: (error) => diagnostics.failure("terminal.lease_renewal_failed", error, call.scope),
    });
  }

  // The session's tmux session goes; the next native PTY attach creates its shell, in the session's folder.
  if (call.verb === "reset") {
    return sandboxCommand(call, () => sandbox.resetShell(call.url.searchParams.get("session") ?? undefined), {
      doing: "restarting the terminal's shell",
      report: (error) => diagnostics.failure("terminal.reset_failed", error, call.scope),
    });
  }

  const refused = notAnUpgrade(call) ?? await sandboxPreflight(call);

  if (refused !== null) return refused;

  return sandboxAttach(sandbox, call, ctx);
}

/** One route per verb; the query names the executor. */
export function terminalRoutes<Bindings extends object>(
  depsFor: (env: Bindings) => TerminalRouteDeps,
): Hono<FamilyEnv<Bindings, WorkspaceVariables>> {
  const routes = new Hono<FamilyEnv<Bindings, WorkspaceVariables>>();

  const terminal = (verb: TerminalCall['verb']) => async (c: Context<FamilyEnv<Bindings, WorkspaceVariables>>): Promise<Response> => {
    const { name: agentName, request } = c.get('workspace');
    const url = new URL(request.url);
    const executor = url.searchParams.get("executor");

    if (!executor) return err(400, "executor query parameter required");

    // One scope for every failure below, including readiness refusals.
    const scope = { workspace: agentName, executor };

    const lane = terminalLane(executor);

    // Rendered as a labelled mode, not a failure.
    if (lane.mode === "line") {
      return json({ body: { error: `${executor} has no terminal`, lane: "line" } }, { status: 409 });
    }

    const call: TerminalCall = { request, url, deps: depsFor(c.env), agentName, executor, verb, scope, surface: "terminal" };

    if (executor === DEVICE_EXECUTOR) return deviceTerminal(call);

    if (executor === WORKSPACE_EXECUTOR) return workspaceTerminal(call);

    return sandboxTerminal(call, c.executionCtx);
  };

  routes.all(`${LITERAL_WORKSPACE}/terminal`, terminal("attach"));
  routes.all(`${LITERAL_WORKSPACE}/terminal/keepalive`, terminal("keepalive"));
  routes.all(`${LITERAL_WORKSPACE}/terminal/reset`, terminal("reset"));

  routes.all(`${LITERAL_WORKSPACE}/devices/:device{[^/%]+}/desktop`, async (c) => {
    const { name: agentName, request } = c.get('workspace');
    const scope = { workspace: agentName, executor: DEVICE_EXECUTOR };

    return deviceDesktop({
      request, url: new URL(request.url), deps: depsFor(c.env), agentName, executor: DEVICE_EXECUTOR, verb: "attach", scope, surface: "desktop",
    }, c.req.param('device'));
  });

  routes.all(`${LITERAL_WORKSPACE}/desktop`, async (c) => {
    const { name: agentName, request } = c.get('workspace');
    const scope = { workspace: agentName, executor: COMPUTER_EXECUTOR };

    return sandboxTerminal({
      request, url: new URL(request.url), deps: depsFor(c.env), agentName, executor: COMPUTER_EXECUTOR, verb: "attach", scope, surface: "desktop",
    }, c.executionCtx);
  });

  return routes;
}
