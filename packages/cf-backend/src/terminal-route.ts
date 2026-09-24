/**
 * Interactive terminal transport: one WebSocket per attached terminal carrying raw PTY bytes,
 * off the JSON-only chat rail, behind the same auth/ownership/CSRF gates as `/api/workspaces/:agentName/`.
 * The container PTY is the sandbox SDK's (`/ws/pty`); the workspace shell is the runtime's (workspace-terminal.ts).
 */

import type { PtyOptions } from "@cloudflare/sandbox";
import { getAgentByName } from "agents";
import { diagnostics, renderCauseChain, toKinuError } from "@kinu.run/core/obs";
import type { OrchestratorAgent } from "./orchestrator";

import { err, json } from "@kinu.run/core";
import { DEVICE_PTY_MAX_AXIS, DEVICE_TERMINAL_PATH } from "@kinu.run/core";
import { terminalLane } from "@kinu.run/core";
import { sandboxIdForWorkspace } from "@kinu.run/core";
import { WORKSPACE_TERMINAL_PATH } from "@kinu.run/core";
import { openSandbox } from "./sandbox-exec-lane";

/**
 * Optional: `getSession` is added by `getSandbox`'s Proxy, not declared on the class. A property,
 * not a method, since the proxy's entries are closures over the stub. The session sets cwd and env.
 */
type SandboxPty = {
  getSession?: (sessionId: string) => Promise<{ terminal: (request: Request, options?: PtyOptions) => Promise<Response> }>;
};

const DEVICE_EXECUTOR = "device";

const WORKSPACE_EXECUTOR = "workspace";

const DEFAULT_WINDOW = { cols: 80, rows: 24 } as const;

interface DeviceHolderNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> };
}

export type TerminalWorkspace = Pick<OrchestratorAgent, 'prepareTerminal' | 'openDeviceTerminal' | 'fetch'>;

/**
 * `noteTerminalActivity` and `deleteSession` reach the stub through the proxy's fall-through.
 */
export interface TerminalSandbox extends SandboxPty {
  noteTerminalActivity(): Promise<void>;
  deleteSession(sessionId: string): Promise<{ success: boolean }>;
}

/** Seams, not bindings: `getAgentByName` waits on startup and retries, and `getSandbox` returns the PTY proxy. */
export interface TerminalRouteDeps {
  resolveWorkspace(name: string): Promise<TerminalWorkspace>;
  /** Called on the container lane only, so device and workspace terminals mint no container stub. */
  resolveSandbox(name: string): TerminalSandbox | null;
  readonly UserDO: DeviceHolderNamespace;
}

export function terminalRouteDeps(env: Env): TerminalRouteDeps {
  return {
    resolveWorkspace: (name) => getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, name),
    resolveSandbox: (name) => env.Sandbox === undefined
      ? null
      : openSandbox(env.Sandbox, sandboxIdForWorkspace(name), { normalizeId: true }),
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
 * One stable session per workspace, so a reload reattaches; separate from the agent's exec session,
 * which holds one PTY and foreground process and would feed keystrokes into the agent's command.
 */
const TERMINAL_SESSION = "kinu-terminal";

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

function abandonedAttach(): Response {
  return err(503, "terminal attach abandoned: the client disconnected before the shell opened");
}

function terminalVerb(pathname: string, agentName: string): "attach" | "keepalive" | "reset" | null {
  const base = `/api/workspaces/${agentName}/terminal`;

  if (pathname === base) return "attach";

  if (pathname === `${base}/keepalive`) return "keepalive";

  if (pathname === `${base}/reset`) return "reset";

  return null;
}

interface TerminalCall {
  readonly request: Request;
  readonly url: URL;
  readonly deps: TerminalRouteDeps;
  readonly agentName: string;
  readonly executor: string;
  readonly verb: "attach" | "keepalive" | "reset";
  readonly scope: { readonly workspace: string; readonly executor: string };
}

function notAnUpgrade(request: Request): Response | null {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return err(400, "the terminal endpoint is a WebSocket; send an Upgrade: websocket request");
  }

  return null;
}

/** The shell runs on the owner's machine: the upgrade is handed to the DO holding its outbound socket. */
async function deviceTerminal(call: TerminalCall): Promise<Response> {
  const { request, url, deps, agentName, executor, scope } = call;

  // Guards only: they keep a device request off the container path, which would beat a foreign lease.
  if (call.verb !== "attach") {
    if (request.method !== "POST") return err(405, "use POST");

    return json({ body: { ok: true } });
  }

  const refused = notAnUpgrade(request);

  if (refused !== null) return refused;

  let opened: { session: string; user: string } | { error: string };

  try {
    const agent = await deps.resolveWorkspace(agentName);
    const ready = await agent.prepareTerminal(executor);

    if ("error" in ready) {
      diagnostics.failure("terminal.not_ready", toKinuError({
        doing: "reaching this workspace's machine for a terminal",
        cause: ready.error,
        otherwise: "unavailable",
      }), scope);

      return err(503, ready.error);
    }

    opened = await agent.openDeviceTerminal(paneWindow(url));
  } catch (cause) {
    const error = toKinuError({
      doing: "reaching this workspace to open a terminal",
      cause,
      otherwise: "unavailable",
    });

    diagnostics.failure("terminal.device_open_failed", error, scope);

    return err(503, renderCauseChain(error));
  }

  if ("error" in opened) {
    // Already a rendered chain from the RPC's other side, so it rides as the cause.
    diagnostics.failure("terminal.device_refused", toKinuError({
      doing: "opening a terminal on this machine",
      cause: opened.error,
      otherwise: "unavailable",
    }), scope);

    return err(503, opened.error);
  }

  if (request.signal.aborted) return abandonedAttach();
  // A WebSocket cannot cross an RPC boundary, but an upgrade request can. The session is single-use.
  const socketUrl = new URL(request.url);
  socketUrl.pathname = DEVICE_TERMINAL_PATH;
  socketUrl.search = `?session=${encodeURIComponent(opened.session)}`;
  const namespace = deps.UserDO;

  return namespace.get(namespace.idFromName(opened.user)).fetch(new Request(socketUrl, request));
}

/** The shell is the runtime's, inside the workspace object; keepalive/reset are guards as for a device. */
async function workspaceTerminal(call: TerminalCall): Promise<Response> {
  const { request, deps, agentName, executor, scope } = call;

  if (call.verb !== "attach") {
    if (request.method !== "POST") return err(405, "use POST");

    return json({ body: { ok: true } });
  }

  const refused = notAnUpgrade(request);

  if (refused !== null) return refused;

  try {
    const agent = await deps.resolveWorkspace(agentName);
    const ready = await agent.prepareTerminal(executor);

    if ("error" in ready) {
      diagnostics.failure("terminal.workspace_not_ready", toKinuError({
        doing: "composing this workspace's runtime for a terminal",
        cause: ready.error,
        otherwise: "unavailable",
      }), scope);

      return err(503, ready.error);
    }

    if (request.signal.aborted) return abandonedAttach();
    // server.ts identity headers ride along, so the socket is closed by the same revocation as chat.
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

    return err(503, renderCauseChain(error));
  }
}

/**
 * Proxied frames renew the SDK's activity clock but not the durable lease `Devbox` reads before
 * quiescing; without this beat a container can stop under a typing user.
 */
async function sandboxKeepalive(sandbox: TerminalSandbox, call: TerminalCall): Promise<Response> {
  if (call.request.method !== "POST") return err(405, "use POST");

  try {
    await sandbox.noteTerminalActivity();

    return json({ body: { ok: true } });
  } catch (cause) {
    // The whole chain (AGENTS.md § Errors): it is never broken at a display boundary.
    const error = toKinuError({
      doing: "renewing the container's lease for an attached terminal",
      cause,
      otherwise: "unavailable",
    });

    diagnostics.failure("terminal.lease_renewal_failed", error, call.scope);

    return err(503, renderCauseChain(error));
  }
}

/**
 * The container reuses a session's cached PTY even after its shell exits; deleting the session
 * destroys it so the next attach opens a fresh shell without recycling the container.
 */
async function sandboxReset(sandbox: TerminalSandbox, call: TerminalCall): Promise<Response> {
  if (call.request.method !== "POST") return err(405, "use POST");

  try {
    // A missing session is reported, not thrown, and already satisfies a reset.
    const deleted = await sandbox.deleteSession(TERMINAL_SESSION);

    return json({ body: { ok: true, existed: deleted.success } });
  } catch (cause) {
    const error = toKinuError({
      doing: "restarting the terminal's shell",
      cause,
      otherwise: "unavailable",
    });

    diagnostics.failure("terminal.reset_failed", error, call.scope);

    return err(503, renderCauseChain(error));
  }
}

/** Bounded: these reach `Bun.Terminal` directly. */
function ptySize(url: URL): PtyOptions {
  const size: PtyOptions = {};

  for (const axis of ["cols", "rows"] as const) {
    const value = Number(url.searchParams.get(axis));

    if (Number.isInteger(value) && value > 0 && value <= DEVICE_PTY_MAX_AXIS) size[axis] = value;
  }

  return size;
}

/**
 * Same preflight as exec (up, /workspace attached, egress installed), under the attach's diagnostic
 * scope. Not fenced by cancellation: the start is shared and idempotent.
 */
async function sandboxPreflight(call: TerminalCall): Promise<Response | null> {
  const { deps, agentName, executor, scope } = call;

  try {
    const agent = await deps.resolveWorkspace(agentName);
    const ready = await agent.prepareTerminal(executor);

    if ("error" in ready) {
      // Already a rendered chain from the RPC's other side, so it rides as the cause.
      diagnostics.failure("terminal.not_ready", toKinuError({
        doing: "preparing this workspace's container for a terminal",
        cause: ready.error,
        otherwise: "unavailable",
      }), scope);

      return err(503, ready.error);
    }
  } catch (cause) {
    const error = toKinuError({
      doing: "reaching this workspace to prepare a terminal",
      cause,
      otherwise: "unavailable",
    });

    diagnostics.failure("terminal.preflight_failed", error, scope);

    return err(503, renderCauseChain(error));
  }

  return null;
}

/**
 * Fenced by `request.signal`, not a clock: no single deadline exceeds a cold start yet undercuts an
 * open tab.
 */
async function sandboxAttach(sandbox: TerminalSandbox, call: TerminalCall, ctx: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  const { request, scope } = call;

  if (request.signal.aborted) return abandonedAttach();

  const openSession = sandbox.getSession;

  if (openSession === undefined) {
    return err(503, "the installed Sandbox SDK adds no PTY session surface to the container stub");
  }

  try {
    // `shell` is unnamed: `PtyOptions.shell` is spawned as one argv token, so `bash -l` would ENOENT.
    await sandbox.noteTerminalActivity();
    const session = await openSession(TERMINAL_SESSION);
    const upgrade = session.terminal(ptyUpgradeRequest(request), ptySize(call.url));
    const settled = await Promise.race([upgrade, clientGone(request.signal)]);

    if (settled === CLIENT_GONE) {
      // Release the orphaned upgrade, else the PTY stream stays open until the edge idle reap
      // (PLATFORM_CATALOG `edge.websocket_idle_reap_ms`). `waitUntil` retains it past the response.
      ctx.waitUntil((async () => {
        try {
          const response = await upgrade;
          response.webSocket?.accept();
          response.webSocket?.close(1001, "terminal client went away");
        } catch (cause) {
          diagnostics.failure("terminal.abandoned_upgrade_not_released", toKinuError({
            doing: "releasing the terminal upgrade a departed client left behind",
            cause,
            otherwise: "unavailable",
          }), scope);
        }
      })());

      return abandonedAttach();
    }

    return settled;
  } catch (cause) {
    const error = toKinuError({
      doing: "attaching a terminal to the sandbox container",
      cause,
      otherwise: "unavailable",
    });

    diagnostics.failure("terminal.attach_failed", error, scope);

    return err(503, renderCauseChain(error));
  }
}

async function sandboxTerminal(call: TerminalCall, ctx: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  const sandbox = call.deps.resolveSandbox(call.agentName);

  if (sandbox === null) return err(503, "no Sandbox binding is configured on this deployment");

  if (call.verb === "keepalive") return sandboxKeepalive(sandbox, call);

  if (call.verb === "reset") return sandboxReset(sandbox, call);

  const refused = notAnUpgrade(call.request) ?? await sandboxPreflight(call);

  if (refused !== null) return refused;

  return sandboxAttach(sandbox, call, ctx);
}

/** Auth, CSRF and ownership are settled by server.ts before this route. */
export async function handleTerminalRequest(
  request: Request,
  deps: TerminalRouteDeps,
  agentName: string,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const verb = terminalVerb(url.pathname, agentName);

  if (verb === null) return null;

  const executor = url.searchParams.get("executor");

  if (!executor) return err(400, "executor query parameter required");

  // One scope for every failure below, including readiness refusals.
  const scope = { workspace: agentName, executor };

  const lane = terminalLane(executor);

  // Rendered as a labelled mode, not a failure.
  if (lane.mode === "line") {
    return json({ body: { error: `${executor} has no terminal`, lane: "line" } }, { status: 409 });
  }

  const call: TerminalCall = { request, url, deps, agentName, executor, verb, scope };

  if (executor === DEVICE_EXECUTOR) return deviceTerminal(call);

  if (executor === WORKSPACE_EXECUTOR) return workspaceTerminal(call);

  return sandboxTerminal(call, ctx);
}
