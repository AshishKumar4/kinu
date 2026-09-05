/**
 * The gadget bridge — the ONE seam between a gadget iframe and the host page.
 *
 * The iframe hands over a MessagePort with its `"handshake"` post; this
 * module opens the Cap'n Web session on it and exposes a forwarding target
 * whose every unknown property is a gadget server method. A call the client
 * makes as `gadget.echo('ping')` arrives here as `('echo', 'ping')` and
 * leaves as the workspace RPC `gadgetCall(slug, name, args)`, whose
 * GadgetCallResult unwraps to its value — or throws its `reason: error`,
 * which is what the client sees as the rejection.
 *
 * Trust nothing about the sender except the two checks the reference draws:
 * the message comes from this iframe's window, and from the `null` origin a
 * sandboxed srcdoc document has. The console envelope is validated, because
 * the client is agent-authored text and the boundary is untrusted. Anything
 * else is ignored. The returned dispose removes the listener and closes the
 * handed port, which ends the session.
 */

import { RpcTarget, newMessagePortRpcSession } from "capnweb";
import * as v from "valibot";
import type { GadgetCallResult, JsonValue } from "@kinu.run/core";
import type { Rpc } from "@/lib/protocol";

/** The console levels a gadget client can forward — the set the injected
 *  prefix monkey-patches, so a level outside it never reaches the host. */
const GADGET_CONSOLE_LEVELS = ["debug", "info", "log", "warn", "error"] as const;
export type GadgetConsoleLevel = typeof GADGET_CONSOLE_LEVELS[number];

/** One console line a gadget client forwarded to its host page. */
export interface GadgetConsoleMessage {
  level: GadgetConsoleLevel;
  message: string[];
}

const GadgetConsoleMessageSchema = v.object({
  type: v.literal("console"),
  level: v.picklist(GADGET_CONSOLE_LEVELS),
  message: v.array(v.string()),
});

/** Everything the iframe may post: the handshake carrying its port, or one
 *  console line. Anything else is ignored. */
const GadgetInboundMessageSchema = v.union([v.literal("handshake"), GadgetConsoleMessageSchema]);

export function attachGadgetBridge({ iframe, slug, rpc, onConsole }: {
  iframe: HTMLIFrameElement;
  slug: string;
  rpc: Rpc;
  /** Where the client's console lines and uncaught errors go. */
  onConsole: (message: GadgetConsoleMessage) => void;
}): () => void {
  let port: MessagePort | null = null;

  const closeSession = (): void => {
    // Closing the handed port ends the session: no call the parent ever made
    // can pend on this side (the parent only exposes, never calls), and the
    // iframe's own pending calls die with its document on unmount.
    port?.close();
    port = null;
  };

  const onMessage = (event: MessageEvent): void => {
    // Only this iframe speaks, and only from the null origin — the string
    // value "null", not the JS null — which is the extra paranoia for a
    // frame that somehow browsed away, though the sandbox blocks that.
    if (event.source !== iframe.contentWindow || event.origin !== "null") return;
    const parsed = v.safeParse(GadgetInboundMessageSchema, event.data);
    if (!parsed.success) return;
    const inbound = parsed.output;
    if (inbound === "handshake") {
      const next = event.ports[0];
      if (!next) return;
      closeSession();
      port = next;
      const forwardingTarget = new Proxy(new RpcTarget(), {
        get: (target, property) => {
          if (property in target) {
            // SAFETY: the `in` guard above checked that this property is one
            // the RpcTarget instance or its prototype carries, so indexing
            // reads that existing member rather than inventing one.
            return target[property as keyof RpcTarget];
          }
          if (!v.is(v.string(), property)) return undefined;
          const method = property;
          return (...args: JsonValue[]) =>
            rpc<GadgetCallResult>("gadgetCall", [slug, method, args]).then((result) =>
              result.ok ? result.value : Promise.reject(new Error(`${result.reason}: ${result.error}`)),
            );
        },
      });
      newMessagePortRpcSession(port, forwardingTarget);
      return;
    }
    onConsole({ level: inbound.level, message: inbound.message });
  };

  window.addEventListener("message", onMessage);
  return () => {
    window.removeEventListener("message", onMessage);
    closeSession();
  };
}
