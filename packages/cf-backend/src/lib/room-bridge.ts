/**
 * How a part's frame reaches its room: through the live page at the top of its window, which holds the one socket and
 * opens every decision itself (security §6: a decision never opens inside a part's frame, which the slate's code could
 * cover). The frame says hello to the top with the app's own origin as the only one allowed to receive it; the live page
 * answers with a port of a channel of its own, and everything after flows over that port. The slate's page between them
 * has another origin, so it neither receives the hello nor holds the port. Hosted only, so locked in
 * `capability-parity.lock.json`: the local CLI serves no shared slate.
 */
import { Effect } from "effect";
import * as v from "valibot";
import { detach } from "@kinu.run/core/obs";
import { RoomCallSchema, RoomViewSchema, type RoomCall, type RoomView } from "@kinu.run/core";

/** What a part's frame may ask the live page to decide, in the live page. */
const RoomDecisionSchema = v.object({ kind: v.picklist(["show", "allow"] as const), part: v.string() });

export type RoomDecision = v.InferOutput<typeof RoomDecisionSchema>;

const HELLO = "kinu-room-part";

const HelloSchema = v.object({ kind: v.literal(HELLO) });

/** A frame's request over its port; `id` pairs it with its answer. */
const RequestSchema = v.variant("op", [
  v.object({ op: v.literal("call"), id: v.number(), call: RoomCallSchema }),
  v.object({ op: v.literal("decide"), decision: RoomDecisionSchema }),
  v.object({ op: v.literal("sign-in") }),
  v.object({ op: v.literal("connect"), service: v.string() }),
]);

type Request = v.InferOutput<typeof RequestSchema>;

/** What the live page sends a frame: the room's view, or a call's answer. */
const ReplySchema = v.union([
  v.object({ view: v.nullable(RoomViewSchema) }),
  v.object({ id: v.number(), refused: v.nullable(v.string()) }),
]);

type Reply = v.InferOutput<typeof ReplySchema>;

/** What the live page does for its part frames. */
export interface RoomHost {
  readonly view: () => RoomView | null;
  /** A call that decides nothing (open, ask, check, unshow): null when done, else its refusal in the room's words. */
  readonly call: (call: RoomCall) => Promise<string | null>;
  readonly decide: (decision: RoomDecision) => void;
  readonly signIn: () => void;
  readonly connect: (service: string) => void;
}

/** The live page's hold on its part frames. */
export interface RoomFrames {
  /** Sends every frame the room's next view. */
  readonly publish: (view: RoomView | null) => void;
  readonly stop: () => void;
}

/**
 * The live page's side: answers each hello from a frame of the app's own origin with a port, and serves it. Returns the
 * way to send every frame the room's next view, and the way to stop.
 */
export function hostRoomFrames(host: RoomHost): RoomFrames {
  const ports = new Set<MessagePort>();

  /** One request's work: a call answers the frame once the room has; the rest hand the page what the frame asked. */
  const serve = (port: MessagePort, request: Request): Effect.Effect<void> => {
    switch (request.op) {
      case "call": return Effect.map(Effect.promise(() => host.call(request.call)), (refused) => port.postMessage({ id: request.id, refused } satisfies Reply));
      case "decide": return Effect.sync(() => host.decide(request.decision));
      case "sign-in": return Effect.sync(() => host.signIn());
      case "connect": return Effect.sync(() => host.connect(request.service));
    }
  };

  const hello = (event: MessageEvent) => {
    if (event.origin !== window.location.origin || !v.is(HelloSchema, event.data) || event.source === null) return;

    const channel = new MessageChannel();
    const port = channel.port1;

    ports.add(port);
    port.addEventListener("message", (message: MessageEvent) => {
      const request = v.safeParse(RequestSchema, message.data);

      if (!request.success) return;
      detach(serve(port, request.output));
    });
    port.start();
    port.postMessage({ view: host.view() } satisfies Reply);
    event.source.postMessage({ kind: HELLO }, { targetOrigin: window.location.origin, transfer: [channel.port2] });
  };

  window.addEventListener("message", hello);

  return {
    publish: (view) => { for (const port of ports) port.postMessage({ view } satisfies Reply); },
    stop: () => {
      window.removeEventListener("message", hello);

      for (const port of ports) port.close();
      ports.clear();
    },
  };
}

/** A part frame's side of its live page: the room's view as it changes, and the requests a frame may make. */
export interface RoomBridge {
  /** Null when done, else its refusal in the room's words. Never rejects. */
  readonly call: (call: RoomCall) => Promise<string | null>;
  readonly decide: (decision: RoomDecision) => void;
  readonly signIn: () => void;
  readonly connect: (service: string) => void;
  readonly close: () => void;
}

/**
 * Says hello to the live page at the top of this frame's window and, once it answers, hands back the bridge. Null at
 * once when this frame is the top itself, opened on its own; under a top of another origin the hello is never
 * delivered, so nothing is ever read or called.
 */
export function connectRoomBridge(onView: (view: RoomView | null) => void, onBridge: (bridge: RoomBridge) => void): (() => void) | null {
  const top = window.top;

  if (top === null || top === window) return null;

  let port: MessagePort | null = null;
  let next = 0;
  const waiting = new Map<number, (refused: string | null) => void>();

  const answered = (event: MessageEvent) => {
    if (event.origin !== window.location.origin || !v.is(HelloSchema, event.data)) return;

    const given = event.ports[0];

    if (given === undefined || port !== null) return;
    port = given;
    window.removeEventListener("message", answered);
    given.addEventListener("message", (message: MessageEvent) => {
      const reply = v.safeParse(ReplySchema, message.data);

      if (!reply.success) return;

      if ("view" in reply.output) {
        onView(reply.output.view);

        return;
      }

      const answer = waiting.get(reply.output.id);

      waiting.delete(reply.output.id);
      answer?.(reply.output.refused);
    });
    given.start();

    const send = (request: Request) => given.postMessage(request);

    onBridge({
      call: (call) => new Promise<string | null>((resolve) => {
        const id = next++;

        waiting.set(id, resolve);
        send({ op: "call", id, call });
      }),
      decide: (decision) => send({ op: "decide", decision }),
      signIn: () => send({ op: "sign-in" }),
      connect: (service) => send({ op: "connect", service }),
      close: () => given.close(),
    });
  };

  window.addEventListener("message", answered);
  top.postMessage({ kind: HELLO }, window.location.origin);

  return () => {
    window.removeEventListener("message", answered);
    port?.close();
  };
}
