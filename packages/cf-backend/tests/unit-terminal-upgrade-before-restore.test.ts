/**
 * hearthlit-field-04d5879b, 2026-10-25: a computer terminal opened on a box that had to restore sat at a blank handshake
 * for 20 s, then failed in the browser, because the route stamped the box's lease, which waits for its restore, before it
 * passed the upgrade on. The box answers the upgrade at once and tells the pane why it waits (D109).
 */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { serveFamily } from "./helpers/api";
import { mockAgentsSdk } from "./helpers/agents-sdk";
import { jsrpcStub } from "./helpers/jsrpc-stub";
import type { TerminalRouteDeps, TerminalWorkspace } from "../src/terminal-route";
import { attachWhenReady, type TerminalSocketEvents } from "../../devbox/src/terminal";

mockAgentsSdk();

// The SDK imports cloudflare:email, which Bun cannot load: its mock must be installed before loading this route.
const { terminalRoutes } = await import("../src/terminal-route");

test("a computer terminal on a box that must restore is answered at once, told why it waits, then attached", async () => {
  const restored = Promise.withResolvers<void>();
  const blockedLease = Promise.withResolvers<void>();
  const statusSent = Promise.withResolvers<void>();
  const frames: unknown[] = [];
  const reason = "the computer is saving its work and stopping; it starts again as soon as that is done";
  let restoreDone = false;
  let attaching: Promise<TerminalSocketEvents | null> | undefined;
  const events: TerminalSocketEvents = { message: () => {}, close: () => {}, error: () => {} };

  const workspace = jsrpcStub<TerminalWorkspace>({
    prepareTerminal: async () => ({ ok: true }),
    fetch: () => { throw new Error("workspace shell is outside this regression"); },
    openDeviceTerminal: () => { throw new Error("device is outside this regression"); },
    openDeviceScreen: () => { throw new Error("desktop is outside this regression"); },
  });

  const deps: TerminalRouteDeps = {
    resolveSandbox: () => ({
      // As the box's does: it waits for the restore (`Devbox.noteTerminalActivity` awaits `ensureReady`).
      noteTerminalActivity: async () => {
        blockedLease.resolve();
        await restored.promise;
      },
      resetShell: () => { throw new Error("reset is outside this regression"); },
      fetch: async () => {
        // The box's D109 upgrade is independent of its held readiness work. Its real attachWhenReady tells the pane
        // why a stop is pending, then attaches after the next start's onStart has restored the disk.
        attaching = attachWhenReady({
          socket: {
            send: (data) => {
              if (typeof data !== "string") throw new Error("the box sent bytes before it attached");
              frames.push(JSON.parse(data));
              statusSent.resolve();
            },
            close: () => { throw new Error("the terminal unexpectedly closed"); },
          },
          held: () => true,
          ask: async () => restoreDone ? { kind: "restored" } : { kind: "pending", reason, quiescing: true },
          wait: async () => { await restored.promise; },
          now: () => 0,
          attach: () => Effect.sync(() => {
            frames.push({ type: "ready" }, { type: "bytes", data: "root@computer:/workspace# " });

            return events;
          }),
        });

        return new Response(null, { status: 101 });
      },
    }),
    UserDO: {
      idFromName: () => { throw new Error("device is outside this regression"); },
      get: () => { throw new Error("device is outside this regression"); },
    },
  };

  const serve = serveFamily(terminalRoutes(() => deps), {
    workspace: { name: "eval-restoring", agent: workspace },
    ctx: { waitUntil: () => {} },
  });

  const response = serve(new Request("https://app.example/api/workspaces/eval-restoring/terminal?executor=computer", {
    headers: { upgrade: "websocket" },
  }), {});

  try {
    // Whichever comes first: the answer to the upgrade, or a wait for the restore before it.
    const first = await Promise.race([
      response.then((answer) => ({ status: answer?.status })),
      blockedLease.promise.then(() => ({ status: "blocked on restore before upgrade" })),
    ]);

    expect(first).toEqual({ status: 101 });
    await statusSent.promise;
    expect(frames).toEqual([{ type: "status", text: reason }]);
    restoreDone = true;
    restored.resolve();
    expect(await attaching).toBe(events);
    expect(frames).toEqual([
      { type: "status", text: reason },
      { type: "ready" },
      { type: "bytes", data: "root@computer:/workspace# " },
    ]);
  } finally {
    restoreDone = true;
    restored.resolve();
    await response;
    await attaching;
  }
});
