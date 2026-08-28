/**
 * The interactive terminal's transport: one WebSocket per attached terminal,
 * carrying raw PTY bytes to and from an environment's shell.
 *
 *   GET /api/workspaces/:agentName/terminal?executor=<id>[&cols=&rows=]
 *   Upgrade: websocket
 *
 * WHY THIS IS ITS OWN SOCKET rather than frames on the agent's chat rail. The
 * client's `rpc(...)` is the agents SDK's chat WebSocket, and it carries JSON
 * text only — every send in `hooks/use-kinu.ts` is a `JSON.stringify`, and the
 * transport's messages are AI-SDK envelopes. `files-routes.ts` records what
 * that rail does to bytes: a 1 MiB frame ceiling against a base64 payload
 * (≈1.37×), which is why file bytes were moved off it and onto HTTP. PTY bytes
 * would need the same base64 inflation plus a demultiplexer inside a
 * vendor-owned protocol, and each keystroke would cross two Durable Objects
 * (orchestrator → container) instead of none. So the terminal follows the
 * precedent this repo already set for bytes: its own endpoint, under the same
 * authentication, ownership and CSRF gates as everything else beneath
 * `/api/workspaces/:agentName/` (server.ts step 10 — a browser WebSocket
 * handshake carries the session cookie and an `Origin`, and
 * `crossSiteRejection` covers upgrades explicitly).
 *
 * The PTY itself is the sandbox SDK's, not ours. `getSandbox(...).terminal()`
 * proxies the upgrade to the container's `/ws/pty`, where a `Bun.Terminal`
 * spawns the shell; the wire protocol is binary frames of PTY bytes each way
 * plus JSON control messages (`{type:'resize'}` in, `ready`/`exit`/`error`
 * out). `@cloudflare/sandbox/xterm`'s `SandboxAddon` is the client half of
 * that same protocol, so the browser speaks it verbatim.
 */

import { getSandbox, type PtyOptions } from "@cloudflare/sandbox";
import { getAgentByName } from "agents";
import { diagnostics, renderCauseChain, toKinuError } from "@kinu.run/core/obs";
import type { OrchestratorAgent } from "./orchestrator";
import type { KinuSandbox } from "./kinu-sandbox";
import { err, json } from "./lib/http";
import { terminalLane } from "./lib/terminal-lane";

/**
 * The PTY entry points the SDK's client proxy adds around the container stub.
 *
 * `PtyOptions` carries `cols`, `rows` and `shell` and nothing else — no cwd, no
 * env — because the container derives both from the SESSION the terminal opens
 * in. `getSession` is a pure wrapper on the container object (no existence
 * check), and the container's PTY handler creates the session it is handed, so
 * naming a session here is how a terminal gets a shell of its own.
 */
type SandboxPty = {
  getSession(sessionId: string): Promise<{ terminal(request: Request, options?: PtyOptions): Promise<Response> }>;
};

/**
 * The session a user's terminal lives in: ONE per workspace, stable, and NOT
 * the session the agent's own exec lane uses.
 *
 * Stable, so a page reload reattaches to the shell that is already there and
 * the container replays its output buffer into it. Separate from the agent's,
 * because a session holds one PTY and one foreground process: on the shared
 * default session a long agent command leaves the user's terminal accepting
 * keystrokes that go into THAT command's stdin — measured, on this route,
 * before it was split. A fresh session also starts where the container says
 * work lives, `/workspace`, rather than wherever the agent last cd'd.
 */
const TERMINAL_SESSION = "kinu-terminal";

/**
 * The handshake, and nothing else, is what the container's PTY endpoint needs.
 *
 * The SDK re-wraps whatever request it is handed (`new Request(ptyUrl, request)`
 * in its `proxyTerminal`), so every header still present at the call below
 * reaches the shell's view of the upgrade — including the browser's
 * `__Host-kinu_session` cookie and the `x-kinu-user-id` header server.ts appends
 * for the DO hop. A container runs agent-chosen code, so it is across a trust
 * boundary from both: an allowlist rather than a strip list, because the set a
 * WebSocket upgrade legitimately carries is closed and the set of credentials a
 * browser might attach is not.
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

/** The client left before the shell opened. A sentinel rather than a rejection:
 *  a departed client is an ordinary outcome, not a failure to classify. */
const CLIENT_GONE = Symbol("terminal client went away");

function clientGone(signal: AbortSignal): Promise<typeof CLIENT_GONE> {
  const { promise, resolve } = Promise.withResolvers<typeof CLIENT_GONE>();
  if (signal.aborted) resolve(CLIENT_GONE);
  else signal.addEventListener("abort", () => resolve(CLIENT_GONE), { once: true });
  return promise;
}

/** Nobody reads this: the connection it would travel on is already gone. It
 *  exists because a handler must answer, and it says what happened for a log
 *  reader who finds it. */
function abandonedAttach(): Response {
  return err(503, "terminal attach abandoned: the client disconnected before the shell opened");
}

/**
 * Attach a terminal, or say why this environment has none.
 *
 * Auth, CSRF and workspace ownership are settled by the caller (server.ts);
 * this route is reached only for a workspace the identity owns.
 */
export async function handleTerminalRequest(
  request: Request,
  env: Env,
  agentName: string,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const attach = url.pathname === `/api/workspaces/${agentName}/terminal`;
  const keepalive = url.pathname === `/api/workspaces/${agentName}/terminal/keepalive`;
  const reset = url.pathname === `/api/workspaces/${agentName}/terminal/reset`;
  if (!attach && !keepalive && !reset) return null;

  const executor = url.searchParams.get("executor");
  if (!executor) return err(400, "executor query parameter required");

  // ONE diagnostic scope for this request, and every failure below carries it.
  // These two tags are what make a terminal failure answerable at all: whose
  // container, and which environment it was asked for. They used to be spelled
  // at the attach, lease and reset sites only, so a readiness refusal — the most
  // common way a terminal does not open — reached the fleet with neither.
  const scope = { workspace: agentName, executor };

  const lane = terminalLane(executor);
  // A refusal a UI can render as a labelled mode rather than as a failure: it
  // names the environment's missing primitive, which is what the pane shows
  // instead of pretending to be a shell.
  if (lane.mode === "line") {
    return json({ error: `${executor} has no terminal`, lane: "line", missing: lane.missing }, { status: 409 });
  }
  if (!env.Sandbox) return err(503, "no Sandbox binding is configured on this deployment");

  // `{ normalizeId: true, transport: "rpc" }` verbatim from runtime.ts and
  // orchestrator.ts. The SDK drops in-flight requests when transport changes
  // mid-life for an id, and it persists the value, so every call site for one
  // sandbox passes the same options.
  //
  // SAFETY: `getSandbox` is DECLARED to return the Durable Object class, but it
  // returns a Proxy around that stub whose `enhancedMethods` add the session and
  // PTY surface — verified in the shipped bundle (`getSession`, `terminal`,
  // `wsConnect` on the proxy; `terminal` absent from the class), and the SDK's
  // own bridge declares exactly this pair and narrows once at acquisition
  // (packages/sandbox/src/bridge/routes.ts, `BridgeSandbox`). Every member used
  // below is therefore reachable: `getSession` and `terminal` from the proxy,
  // `deleteSession` from the class, and `noteTerminalActivity` from KinuSandbox
  // through the same proxy's fall-through to the stub — which is how
  // `runtime.ts` already calls `configureEgress`. The narrowing is done here, at
  // the one acquisition point, so every call site below is type-checked.
  const sandbox = getSandbox(env.Sandbox, `kinu-${agentName}`, {
    normalizeId: true,
    transport: "rpc",
  }) as KinuSandbox & SandboxPty;

  // A terminal's own frames renew the SDK's activity clock — the container
  // proxy calls `renewActivityTimeout()` on every forwarded message — but they
  // never reach the DURABLE lease that `Devbox`'s heartbeat reads to decide
  // whether to quiesce, because a proxied frame is not an operation on the
  // object. Without this beat a container can take its final checkpoint and
  // stop under a user who is typing. The client sends it while a terminal is
  // attached, which is the only evidence that anybody is.
  if (keepalive) {
    if (request.method !== "POST") return err(405, "use POST");
    try {
      await sandbox.noteTerminalActivity();
      return json({ ok: true });
    } catch (cause) {
      // The whole chain, not the outermost message: a terminal that says only
      // "renewing the lease failed" leaves the user without the one fact that
      // explains it (the container is gone, the attach failed, the snapshot is
      // missing). AGENTS.md § Errors — the chain is never broken at a display
      // boundary.
      const error = toKinuError({
        doing: "renewing the container's lease for an attached terminal",
        cause,
        otherwise: "unavailable",
      });
      diagnostics.failure("terminal.lease_renewal_failed", error, scope);
      return err(503, renderCauseChain(error));
    }
  }

  // A new shell.
  //
  // The container keeps ONE PTY per session and hands the cached one to every
  // later attach without asking whether it is still alive, so a shell that
  // exited — `exit`, or a program that took the terminal down with it — leaves
  // a session whose every future attach reports `ready` onto a dead shell.
  // Deleting the session destroys its PTY (the container's own
  // `session.destroy()` does), and the next attach opens a fresh one. This is
  // the only way back that does not recycle the whole container.
  if (reset) {
    if (request.method !== "POST") return err(405, "use POST");
    try {
      // `deleteSession` REPORTS rather than throws for a session that is not
      // there, and that state already satisfies a reset — the next attach opens
      // a fresh shell either way. So the outcome is stated (`existed`) instead
      // of being flattened into a failure or hidden behind a true.
      const deleted = await sandbox.deleteSession(TERMINAL_SESSION);
      return json({ ok: true, existed: deleted.success });
    } catch (cause) {
      const error = toKinuError({
        doing: "restarting the terminal's shell",
        cause,
        otherwise: "unavailable",
      });
      diagnostics.failure("terminal.reset_failed", error, scope);
      return err(503, renderCauseChain(error));
    }
  }

  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return err(400, "the terminal endpoint is a WebSocket; send an Upgrade: websocket request");
  }

  // The container has to be up and its /workspace attached before a shell opens
  // onto it, and the workspace that owns the egress grants is the only thing
  // that may install them. Both are the sandbox lane's own preflight, so a
  // terminal waits on exactly what an exec waits on — never a second start
  // path, and never a container whose network is still unconfigured.
  //
  // Both halves run inside the SAME tagged scope the attach uses. Routing and
  // the preflight are how a terminal most often fails to open, and they used to
  // be the only failures on this route that reached the fleet with no workspace
  // and no executor: the refusal was rendered to the pane and recorded nowhere,
  // and an unreachable workspace object escaped the handler with no cause chain
  // either. The scope stops at the preflight, deliberately — everything past it
  // is the attach's own, under the attach's own cancellation fence.
  try {
    const agent = await getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, agentName);
    const ready = await agent.prepareTerminal(executor);
    if ("error" in ready) {
      // The refusal is ALREADY a rendered chain from the other side of the RPC,
      // so it rides as the cause rather than being restated. The pane shows what
      // it always showed; the fleet row is the part that did not exist.
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

  // Geometry from the client, so the first frame the shell paints already fits.
  // Bounded: these reach `Bun.Terminal` directly, and a query string is a
  // caller's to write. `Number(null)` and `Number("")` are 0, which the same
  // bound rejects, so an absent parameter needs no separate arm.
  //
  // Typed as the SDK's own `PtyOptions` rather than an anonymous restatement of
  // two of its fields: this value IS that contract, and naming it means a
  // change to the option surface reaches here instead of being absorbed by a
  // local shape that happens to still fit.
  const size: PtyOptions = {};
  for (const axis of ["cols", "rows"] as const) {
    const value = Number(url.searchParams.get(axis));
    if (Number.isInteger(value) && value > 0 && value <= 1000) size[axis] = value;
  }

  // ONE OWNER, AND IT IS THIS REQUEST — for everything from here down, which is
  // everything that creates container-side state a client has to be present to
  // want: a lease beat, a shell session, a PTY. The fence is the platform's own
  // cancellation rather than a clock: `request.signal` aborts when the client
  // goes away, and an outer deadline would have to be both longer than a cold
  // container start and shorter than a browser tab left open, which is not one
  // number. The preflight above is NOT fenced, deliberately: the container is
  // the Durable Object's to start, that start is shared and idempotent, and
  // cancelling it would abandon work another attach is already waiting on.
  if (request.signal.aborted) return abandonedAttach();

  try {
    // `shell` is deliberately not named: the container's default is `bash`, and
    // `PtyOptions.shell` is spawned as ONE argv token (`Bun.spawn([shell])`),
    // so `bash -l` would be an ENOENT rather than a login shell. TERM is
    // xterm-256color either way — the container sets it on the child, which is
    // why `top` and `htop` paint instead of refusing.
    await sandbox.noteTerminalActivity();
    const session = await sandbox.getSession(TERMINAL_SESSION);
    const upgrade = session.terminal(ptyUpgradeRequest(request), size);
    const settled = await Promise.race([upgrade, clientGone(request.signal)]);
    if (settled === CLIENT_GONE) {
      // The upgrade is still in flight and nobody wants its socket, so it is
      // released rather than left pending: a 101 whose WebSocket is never
      // accepted and never returned leaves the container's end of the PTY
      // holding an open stream until the edge reaps it for idleness
      // (PLATFORM_CATALOG `edge.websocket_idle_reap_ms`). `accept()` first
      // because ownership has to be taken before it can be released.
      // The response returns NOW, while the container-side upgrade can settle
      // later. Retain its one cleanup promise in this request's execution
      // context so isolate teardown cannot discard the only owner of that late
      // socket. `waitUntil` is retention, not a second owner: the cleanup still
      // accepts and closes exactly this abandoned upgrade and every failure is
      // recorded inside the promise rather than left unhandled.
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
