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
 * Attach a terminal, or say why this environment has none.
 *
 * Auth, CSRF and workspace ownership are settled by the caller (server.ts);
 * this route is reached only for a workspace the identity owns.
 */
export async function handleTerminalRequest(
  request: Request,
  env: Env,
  agentName: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const attach = url.pathname === `/api/workspaces/${agentName}/terminal`;
  const keepalive = url.pathname === `/api/workspaces/${agentName}/terminal/keepalive`;
  const reset = url.pathname === `/api/workspaces/${agentName}/terminal/reset`;
  if (!attach && !keepalive && !reset) return null;

  const executor = url.searchParams.get("executor");
  if (!executor) return err(400, "executor query parameter required");

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
      diagnostics.failure("terminal.lease_renewal_failed", error, { workspace: agentName, executor });
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
      diagnostics.failure("terminal.reset_failed", error, { workspace: agentName, executor });
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
  const agent = await getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, agentName);
  const ready = await agent.prepareTerminal(executor);
  if ("error" in ready) return err(503, ready.error);

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

  try {
    // `shell` is deliberately not named: the container's default is `bash`, and
    // `PtyOptions.shell` is spawned as ONE argv token (`Bun.spawn([shell])`),
    // so `bash -l` would be an ENOENT rather than a login shell. TERM is
    // xterm-256color either way — the container sets it on the child, which is
    // why `top` and `htop` paint instead of refusing.
    await sandbox.noteTerminalActivity();
    const session = await sandbox.getSession(TERMINAL_SESSION);
    return await session.terminal(request, size);
  } catch (cause) {
    const error = toKinuError({
      doing: "attaching a terminal to the sandbox container",
      cause,
      otherwise: "unavailable",
    });
    diagnostics.failure("terminal.attach_failed", error, { workspace: agentName, executor });
    return err(503, renderCauseChain(error));
  }
}
