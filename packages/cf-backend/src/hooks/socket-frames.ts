import { useEffect, useRef } from "react";
import * as v from "valibot";
import { WorkspaceBroadcastSchema } from "@kinu.run/core";
import { Effect } from "effect";
import { detach, tolerate } from "@kinu.run/core/obs";

/** The socket's frames: the chat transport's own, and the workspace's broadcasts as core decodes them. */
const SocketMessageSchema = v.variant("type", [
  // Arrival is what the chat pane waits on; the payload is the SDK's business.
  v.looseObject({ type: v.literal("cf_agent_chat_messages") }),
  // `reason` only on the runtime's refusal of this tab (`terminalChatError`).
  v.object({
    type: v.literal("cf_agent_use_chat_response"),
    error: v.optional(v.boolean()), done: v.optional(v.boolean()), body: v.optional(v.string()), reason: v.optional(v.string()),
  }),
  WorkspaceBroadcastSchema,
]);

export type SocketFrame = v.InferOutput<typeof SocketMessageSchema>;

/** Which actor a pane speaks for: the workspace's own, or one hosted agent once its id is known. */
export interface PaneIdentity {
  readonly isSubordinate: boolean;
  readonly ownActorId: string | null;
}

function parseSocketMessage(data: MessageEvent["data"]) {
  const text = v.safeParse(v.string(), data);

  if (!text.success) return null;

  // Non-JSON is not ours; any other failure is a real fault, not "no message".
  const decoded = v.safeParse(
    SocketMessageSchema,
    tolerate<unknown>(() => JSON.parse(text.output), "malformed-input"),
  );

  return decoded.success ? decoded.output : null;
}

/**
 * One Durable Object broadcasts to every socket, so hosted actors' frames (`signal_card`,
 * `steer_status`) carry an actor stamp. Unstamped frames are the workspace's own. `provider_wait`'s
 * `actorId` is not ownership. The workspace pane admits no stamped frame; an agent pane admits
 * its own actor's; an unresolved pane admits none.
 */
function admitsActorFrame(msg: SocketFrame, pane: PaneIdentity): boolean {
  if (msg.type !== "signal_card" && msg.type !== "steer_status") return true;

  if (msg.actorId === undefined) return true;

  return pane.isSubordinate && pane.ownActorId === msg.actorId;
}

/** The socket's one reader: one parse per frame, then `paneFrame` only for what the pane may see. Never re-subscribes. */
export function useSocketFrames(socket: EventTarget, pane: () => PaneIdentity, receivers: {
  readonly everyFrame: (frame: SocketFrame) => void;
  readonly paneFrame: (frame: SocketFrame) => Promise<void>;
}): void {
  const latest = useRef({ pane, receivers });
  latest.current = { pane, receivers };

  useEffect(() => {
    const received = (event: Event) => detach(Effect.promise(async () => {
      const frame = event instanceof MessageEvent ? parseSocketMessage(event.data) : null;

      if (frame === null) return;
      const { receivers: now, pane: identity } = latest.current;

      now.everyFrame(frame);

      if (admitsActorFrame(frame, identity())) await now.paneFrame(frame);
    }));

    socket.addEventListener("message", received);

    return () => socket.removeEventListener("message", received);
  }, [socket]);
}
