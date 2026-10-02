/**
 * Interactive terminal transport: one WebSocket per attached terminal carrying raw PTY bytes,
 * off the JSON-only chat rail, behind the same auth/ownership/CSRF gates as `/api/workspaces/:agentName/`.
 * Container sessions use native exec PTYs; workspace sessions use workspace-terminal.ts.
 */

import { Hono, type Context } from "hono";
import { getAgentByName } from "agents";
import { Cause, Effect } from "effect";
import { diagnostics, renderThrownChain, settle, toKinuError, type KinuError, settleLogged } from "@kinu.run/core/obs";
import type { OrchestratorAgent } from "./orchestrator";

import { err, json } from "@kinu.run/core";
import { DEVICE_PTY_MAX_AXIS, DEVICE_TERMINAL_PATH } from "@kinu.run/core";
import { terminalLane } from "@kinu.run/core";
import { sandboxIdForWorkspace } from "@kinu.run/core";
import { WORKSPACE_TERMINAL_PATH } from "@kinu.run/core";
import type { FamilyEnv } from "./api/context";
import { LITERAL_WORKSPACE, type WorkspaceVariables } from "./api/workspace";


const DEVICE_EXECUTOR = "device";

const WORKSPACE_EXECUTOR = "workspace";

const DEFAULT_WINDOW = { cols: 80, rows: 24 } as const;

interface DeviceHolderNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> };
}

export type TerminalWorkspace = Pick<OrchestratorAgent, 'prepareTerminal' | 'openDeviceTerminal' | 'fetch'>;

export interface TerminalSandbox {
  fetch(request: Request): Promise<Response>;
  noteTerminalActivity(): Promise<void>;
  resetShell(): Promise<void>;
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

function abandonedAttach(): Response {
  return err(503, "terminal attach abandoned: the client disconnected before the shell opened");
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

function unreachable(doing: string, report: (error: KinuError) => void) {
  return (failed: Cause.Cause<unknown>) => Effect.sync(() => {
    const error = toKinuError({ doing, cause: Cause.squash(failed), otherwise: "unavailable" });

    report(error);

    return err(503, renderThrownChain({ cause: error }));
  });
}

/** The shell runs on the owner's machine: the upgrade is handed to the DO holding its outbound socket. */
function deviceTerminal(call: TerminalCall): Effect.Effect<Response> {
  return Effect.gen(function* () {
    const { request, url, deps, agentName, executor, scope } = call;

    // Guards only: they keep a device request off the container path, which would beat a foreign lease.
    if (call.verb !== "attach") {
      if (request.method !== "POST") return err(405, "use POST");

      return json({ body: { ok: true } });
    }

    const refused = notAnUpgrade(request);

    if (refused !== null) return refused;

    const opened = yield* Effect.catchCause(Effect.gen(function* () {
      const agent = yield* Effect.promise(() => deps.resolveWorkspace(agentName));
      const ready = yield* Effect.promise(() => agent.prepareTerminal(executor));

      if ("error" in ready) {
        diagnostics.failure("terminal.not_ready", toKinuError({
          doing: "reaching this workspace's machine for a terminal",
          cause: ready.error,
          otherwise: "unavailable",
        }), scope);

        return err(503, ready.error);
      }

      return yield* Effect.promise(() => agent.openDeviceTerminal(paneWindow(url)));
    }), unreachable("reaching this workspace to open a terminal", (error) => diagnostics.failure("terminal.device_open_failed", error, scope)));

    if (opened instanceof Response) return opened;

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

    return yield* Effect.promise(() => namespace.get(namespace.idFromName(opened.user)).fetch(new Request(socketUrl, request)));
  });
}

/** The shell is the runtime's, inside the workspace object; keepalive/reset are guards as for a device. */
function workspaceTerminal(call: TerminalCall): Effect.Effect<Response> {
  return Effect.gen(function* () {
    const { request, deps, agentName, executor, scope } = call;

    if (call.verb !== "attach") {
      if (request.method !== "POST") return err(405, "use POST");

      return json({ body: { ok: true } });
    }

    const refused = notAnUpgrade(request);

    if (refused !== null) return refused;

    return yield* Effect.catchCause(Effect.gen(function* () {
      const agent = yield* Effect.promise(() => deps.resolveWorkspace(agentName));
      const ready = yield* Effect.promise(() => agent.prepareTerminal(executor));

      if ("error" in ready) {
        diagnostics.failure("terminal.workspace_not_ready", toKinuError({
          doing: "composing this workspace's runtime for a terminal",
          cause: ready.error,
          otherwise: "unavailable",
        }), scope);

        return err(503, ready.error);
      }

      if (request.signal.aborted) return abandonedAttach();
      // The gate's identity headers ride along: one revocation closes chat and socket.
      const socketUrl = new URL(request.url);
      socketUrl.pathname = WORKSPACE_TERMINAL_PATH;

      return yield* Effect.promise(() => agent.fetch(new Request(socketUrl, request)));
    }), unreachable("reaching this workspace to open its shell", (error) => diagnostics.failure("terminal.workspace_open_failed", error, scope)));
  });
}

/** One sandbox call behind a POST. A failure keeps its whole chain (AGENTS.md § Errors): it is
 *  never broken at a display boundary. */
function sandboxCommand(
  call: TerminalCall,
  run: () => Promise<void>,
  failed: { readonly doing: string; readonly report: (error: KinuError) => void },
): Effect.Effect<Response> {
  if (call.request.method !== "POST") return Effect.succeed(err(405, "use POST"));

  return Effect.catchCause(Effect.as(Effect.promise(run), json({ body: { ok: true } })), (cause) => Effect.sync(() => {
    const error = toKinuError({ doing: failed.doing, cause: Cause.squash(cause), otherwise: "unavailable" });

    failed.report(error);

    return err(503, renderThrownChain({ cause: error }));
  }));
}

/**
 * Same preflight as exec (up, /workspace attached, egress installed), under the attach's diagnostic
 * scope. Not fenced by cancellation: the start is shared and idempotent.
 */
function sandboxPreflight(call: TerminalCall): Effect.Effect<Response | null> {
  const { deps, agentName, executor, scope } = call;

  return Effect.catchCause(Effect.gen(function* () {
    const agent = yield* Effect.promise(() => deps.resolveWorkspace(agentName));
    const ready = yield* Effect.promise(() => agent.prepareTerminal(executor));

    if ("error" in ready) {
      diagnostics.failure("terminal.not_ready", toKinuError({
        doing: "preparing this workspace's container for a terminal",
        cause: ready.error,
        otherwise: "unavailable",
      }), scope);

      return err(503, ready.error);
    }

    return null;
  }), unreachable("reaching this workspace to prepare a terminal", (error) => diagnostics.failure("terminal.preflight_failed", error, scope)));
}

/**
 * Fenced by `request.signal`, not a clock: no single deadline exceeds a cold start yet undercuts an
 * open tab.
 */
function sandboxAttach(sandbox: TerminalSandbox, call: TerminalCall, ctx: Pick<ExecutionContext, 'waitUntil'>): Effect.Effect<Response> {
  const { request, scope } = call;

  if (request.signal.aborted) return Effect.succeed(abandonedAttach());

  return Effect.catchCause(Effect.gen(function* () {
    yield* Effect.promise(() => sandbox.noteTerminalActivity());
    const url = new URL(request.url);
    url.pathname = "/_devbox/terminal";
    const size = paneWindow(call.url);
    url.searchParams.set("cols", String(size.cols));
    url.searchParams.set("rows", String(size.rows));
    const upgrade = sandbox.fetch(new Request(url.toString(), ptyUpgradeRequest(request)));
    const settled = yield* Effect.promise(() => Promise.race([upgrade, clientGone(request.signal)]));

    if (settled === CLIENT_GONE) {
      // Release the orphaned upgrade, else the PTY stream stays open until the edge idle reap
      // (PLATFORM_CATALOG `edge.websocket_idle_reap_ms`). `waitUntil` retains it past the response.
      ctx.waitUntil(settleLogged("terminal.abandoned_upgrade_not_released", { doing: "releasing the terminal upgrade a departed client left behind", otherwise: "unavailable" }, async () => {
        const response = await upgrade;
        response.webSocket?.accept();
        response.webSocket?.close(1001, "terminal client went away");
      }, scope));

      return abandonedAttach();
    }

    return settled;
  }), unreachable("attaching a terminal to the sandbox container", (error) => diagnostics.failure("terminal.attach_failed", error, scope)));
}

function sandboxTerminal(call: TerminalCall, ctx: Pick<ExecutionContext, 'waitUntil'>): Effect.Effect<Response> {
  return Effect.gen(function* () {
    const sandbox = call.deps.resolveSandbox(call.agentName);

    if (sandbox === null) return err(503, "no Sandbox binding is configured on this deployment");

    // Proxied frames renew the platform's activity clock but not the durable lease `Devbox` reads
    // before quiescing; without this beat a container can stop under a typing user.
    if (call.verb === "keepalive") {
      return yield* sandboxCommand(call, () => sandbox.noteTerminalActivity(), {
        doing: "renewing the container's lease for an attached terminal",
        report: (error) => diagnostics.failure("terminal.lease_renewal_failed", error, call.scope),
      });
    }

    // The persistent tmux session goes; the next native PTY attach creates its shell.
    if (call.verb === "reset") {
      return yield* sandboxCommand(call, () => sandbox.resetShell(), {
        doing: "restarting the terminal's shell",
        report: (error) => diagnostics.failure("terminal.reset_failed", error, call.scope),
      });
    }

    const refused = notAnUpgrade(call.request) ?? (yield* sandboxPreflight(call));

    if (refused !== null) return refused;

    return yield* sandboxAttach(sandbox, call, ctx);
  });
}

/** One route per verb; the query names the executor. */
export function terminalRoutes<Bindings extends object>(
  depsFor: (env: Bindings) => TerminalRouteDeps,
): Hono<FamilyEnv<Bindings, WorkspaceVariables>> {
  const routes = new Hono<FamilyEnv<Bindings, WorkspaceVariables>>();

  const terminal = (verb: TerminalCall['verb'], c: Context<FamilyEnv<Bindings, WorkspaceVariables>>): Effect.Effect<Response> => Effect.gen(function* () {
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

    const call: TerminalCall = { request, url, deps: depsFor(c.env), agentName, executor, verb, scope };

    if (executor === DEVICE_EXECUTOR) return yield* deviceTerminal(call);

    if (executor === WORKSPACE_EXECUTOR) return yield* workspaceTerminal(call);

    return yield* sandboxTerminal(call, c.executionCtx);
  });

  routes.all(`${LITERAL_WORKSPACE}/terminal`, (c) => settle(terminal("attach", c)));
  routes.all(`${LITERAL_WORKSPACE}/terminal/keepalive`, (c) => settle(terminal("keepalive", c)));
  routes.all(`${LITERAL_WORKSPACE}/terminal/reset`, (c) => settle(terminal("reset", c)));

  return routes;
}
