/**
 * How a personal part's frame reaches the viewer's account (docs/SLATE-SHARING-NIMBUS.md §3): through the app page at the
 * top of its window, which frames the slate's page. A cross-site page sits between the part frame and the top, so the
 * frame's own requests carry no session: the top runs the part as the signed-in viewer, and opens every decision itself,
 * where the slate's script cannot cover it. The frame says hello to the top with the app's own origin as the only one
 * allowed to receive it; the top answers only a frame inside a slate frame it hosts, for that slate, with a port of a
 * channel of its own, and everything after flows over that port. The slate's page has another origin: it neither
 * receives the hello nor holds the port. Hosted only, so locked in `capability-parity.lock.json`: the local CLI serves no
 * shared slate.
 */
import { Effect } from "effect";
import * as v from "valibot";
import { detach } from "@kinu.run/core/obs";
import {
  JsonValueSchema, PartRunAnswerSchema, type JsonValue, type PartRunAnswer, type PartRunRequest,
} from "@kinu.run/core";

/** One part as its frame's address names it: whose slate, which part, and the page's public input to it. */
export interface PartAddress {
  readonly workspace: string;
  readonly slate: string;
  readonly part: string;
  readonly args: readonly JsonValue[];
}

/** The answer the top last gave one frame: a decision opens on it, never on what the frame says. */
interface LastAnswer {
  answer: PartRunAnswer | null;
}

/** What a decision the frame asked for came to; `approval`, the effect the viewer let run once. */
export type Decided = { readonly kind: "consented" | "shown" | "declined" } | { readonly kind: "approved"; readonly approval: string };

const DecidedSchema = v.variant("kind", [
  v.object({ kind: v.picklist(["consented", "shown", "declined"] as const) }),
  v.object({ kind: v.literal("approved"), approval: v.string() }),
]);

/** The decisions a frame may ask the top for: each opens on the answer the top last gave that frame. */
const DecisionKindSchema = v.picklist(["consent", "approval", "show"] as const);

export type DecisionKind = v.InferOutput<typeof DecisionKindSchema>;

const HELLO = "kinu-part";

const HelloSchema = v.object({
  kind: v.literal(HELLO), workspace: v.string(), slate: v.string(), part: v.string(), args: v.array(JsonValueSchema),
});

/** A frame's request over its port; `id` pairs a run with its answer. */
const RequestSchema = v.variant("op", [
  v.object({ op: v.literal("run"), id: v.number(), action: v.nullable(v.object({ id: v.string(), input: JsonValueSchema })), approval: v.nullable(v.string()) }),
  v.object({ op: v.literal("decide"), kind: DecisionKindSchema }),
  v.object({ op: v.literal("sign-in") }),
]);

type Request = v.InferOutput<typeof RequestSchema>;

const ReplySchema = v.union([
  v.object({ id: v.number(), answer: PartRunAnswerSchema }),
  v.object({ id: v.number(), refused: v.string() }),
  v.object({ decided: DecidedSchema }),
]);

type Reply = v.InferOutput<typeof ReplySchema>;

/** What the top does for one hosted slate's part frames. */
export interface PartHost {
  readonly workspace: string;
  readonly slate: string;
  /** The slate's title, which a part frame names it by: the frame knows only its id. */
  readonly title: string;
  /** The window of the slate's frame: a part frame is answered only when it is that frame's child. */
  readonly slateWindow: () => Window | null;
  /** Runs the part as the signed-in viewer: its answer, or the refusal in the app's words. Never rejects. */
  readonly run: (address: PartAddress, request: PartRunRequest) => Promise<PartRunAnswer | string>;
  /** Opens the decision on the answer this frame last had; settles when the viewer has decided. */
  readonly decide: (address: PartAddress, kind: DecisionKind, last: PartRunAnswer) => Promise<Decided>;
  readonly signIn: () => void;
}

/**
 * The top's side: answers each hello from a frame of the app's own origin that sits in the hosted slate's frame and names
 * that slate, with a port, and serves it. Returns the way to stop.
 */
export function hostPartFrames(host: PartHost): () => void {
  const ports = new Set<MessagePort>();

  const serve = (port: MessagePort, address: PartAddress, last: LastAnswer, request: Request): Effect.Effect<void> => {
    switch (request.op) {
      case "run": {
        // A rerun after a decision resumes the run that asked it: the top attaches its continuation, never the frame.
        const paused = last.answer?.kind === "needs-consent" || last.answer?.kind === "needs-approval" ? last.answer.continuation : null;
        const asked: PartRunRequest = { args: [...address.args], action: request.action, continuation: paused };

        return Effect.map(Effect.promise(() => host.run(address, asked)), (answer) => {
          if (typeof answer === "string") return port.postMessage({ id: request.id, refused: answer } satisfies Reply);
          last.answer = answer;
          port.postMessage({ id: request.id, answer } satisfies Reply);
        });
      }

      case "decide": {
        const answer = last.answer;

        // Nothing to decide on: the frame asked before any answer, or after one that asks nothing.
        if (answer === null) return Effect.void;

        return Effect.map(Effect.promise(() => host.decide(address, request.kind, answer)), (decided) => port.postMessage({ decided } satisfies Reply));
      }

      case "sign-in": return Effect.sync(() => host.signIn());
    }
  };

  const hello = (event: MessageEvent) => {
    const slateWindow = host.slateWindow();
    const said = v.safeParse(HelloSchema, event.data);

    const source = event.source;

    if (event.origin !== window.location.origin || !said.success || slateWindow === null || source === null || !("parent" in source)) return;

    // Its own slate's frame, and that slate by name: a page cannot hand its parts to another slate's host.
    if (source.parent !== slateWindow) return;

    if (said.output.workspace !== host.workspace || said.output.slate !== host.slate) return;

    const address: PartAddress = { workspace: said.output.workspace, slate: said.output.slate, part: said.output.part, args: said.output.args };
    const last: LastAnswer = { answer: null };
    const channel = new MessageChannel();
    const port = channel.port1;

    ports.add(port);
    port.addEventListener("message", (message: MessageEvent) => {
      const request = v.safeParse(RequestSchema, message.data);

      if (!request.success) return;
      detach(serve(port, address, last, request.output));
    });
    port.start();
    source.postMessage({ kind: HELLO, title: host.title }, { targetOrigin: window.location.origin, transfer: [channel.port2] });
  };

  window.addEventListener("message", hello);

  return () => {
    window.removeEventListener("message", hello);

    for (const port of ports) port.close();
    ports.clear();
  };
}

/** A part frame's side: its runs and decisions through the top. */
export interface PartBridge {
  /** The slate's title, as the top names it. */
  readonly title: string;
  /** The part's answer, or the refusal in the app's words. Never rejects. */
  readonly run: (action: { id: string; input: JsonValue } | null, approval: string | null) => Promise<PartRunAnswer | string>;
  /** Asks the top to open a decision on the last answer; settles with what the viewer decided. */
  readonly decide: (kind: DecisionKind) => Promise<Decided>;
  readonly signIn: () => void;
  readonly close: () => void;
}

/**
 * Says hello to the app page at the top of this frame's window and, once it answers, hands back the bridge. Null at once
 * when this frame is the top itself, opened on its own; under a top that does not host its slate, the hello is never
 * answered, so nothing is ever run.
 */
export function connectPartBridge(address: PartAddress, onBridge: (bridge: PartBridge) => void): (() => void) | null {
  const top = window.top;

  if (top === null || top === window) return null;

  let port: MessagePort | null = null;
  let next = 0;
  const runs = new Map<number, (answer: PartRunAnswer | string) => void>();
  const decisions: ((decided: Decided) => void)[] = [];

  const answered = (event: MessageEvent) => {
    const hello = v.safeParse(v.object({ kind: v.literal(HELLO), title: v.string() }), event.data);

    if (event.origin !== window.location.origin || !hello.success) return;

    const given = event.ports[0];

    if (given === undefined || port !== null) return;
    port = given;
    window.removeEventListener("message", answered);
    given.addEventListener("message", (message: MessageEvent) => {
      const reply = v.safeParse(ReplySchema, message.data);

      if (!reply.success) return;

      if ("decided" in reply.output) {
        decisions.shift()?.(reply.output.decided);

        return;
      }

      const settle = runs.get(reply.output.id);

      runs.delete(reply.output.id);
      settle?.("answer" in reply.output ? reply.output.answer : reply.output.refused);
    });
    given.start();
    onBridge({
      title: hello.output.title,
      run: (action, approval) => new Promise((resolve) => {
        next += 1;
        runs.set(next, resolve);
        given.postMessage({ op: "run", id: next, action, approval } satisfies Request);
      }),
      decide: (kind) => new Promise((resolve) => {
        decisions.push(resolve);
        given.postMessage({ op: "decide", kind } satisfies Request);
      }),
      signIn: () => given.postMessage({ op: "sign-in" } satisfies Request),
      close: () => given.close(),
    });
  };

  window.addEventListener("message", answered);
  top.postMessage({ kind: HELLO, ...address, args: [...address.args] }, window.location.origin);

  return () => {
    window.removeEventListener("message", answered);
    port?.close();
  };
}
