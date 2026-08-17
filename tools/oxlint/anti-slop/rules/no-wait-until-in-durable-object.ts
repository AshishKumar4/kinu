import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/**
 * Reject `ctx.waitUntil` on a Durable Object's own state handle.
 *
 * `DurableObjectState.waitUntil` exists only for API compatibility with `ExecutionContext`, and
 * Cloudflare documents that it "has no effect in Durable Objects. It does not extend the lifetime of
 * a Durable Object or affect when a request or RPC completes." workerd says why: `waitUntil` lands in
 * `IoContext::addWaitUntil`, and `IoContext::addTask` notes "In Actors, we treat all tasks as
 * wait-until tasks" — so inside an actor the call takes the same code path as a bare floating
 * promise, and `drain()` cancels both on actor shutdown with the exception explicitly swallowed. A
 * deployed probe confirmed it: a write in flight across `ctx.abort()` is lost identically with and
 * without `waitUntil`, and nothing observes the loss.
 *
 * So the call cannot make work durable, and its presence claims otherwise. Work that must land is
 * awaited inside the invocation that requested it, where the output gate holds the response until the
 * storage write commits and a failure reaches the caller. Work that is genuinely best-effort stays a
 * plain promise and says so.
 *
 * The matcher is the receiver rather than the class heritage: `this.ctx` and `this.state` are the two
 * spellings of `DurableObjectState` on an instance, and keying on them means a Durable Object written
 * against a base class nobody has thought of yet is still caught. There is deliberately no exemption
 * list. The one class where `this.ctx` is an `ExecutionContext` instead is `WorkerEntrypoint`, which
 * this repository does not subclass; if it ever does, exempting it is a visible edit here and not a
 * suppression comment. An aliased receiver (`const c = this.ctx; c.waitUntil(p)`) is outside the
 * matcher — the gate beside this rule is what asserts the Durable Object corpus it runs over is not
 * empty.
 */
export const noWaitUntilInDurableObjectRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow ctx.waitUntil inside a Durable Object class, where it has no effect.",
    },
    messages: {
      waitUntilInDurableObject:
        "`{{receiver}}.waitUntil` has no effect in a Durable Object — it neither extends the object's lifetime nor delays the response, and the work is cancelled silently on eviction or reset. Await the promise inside this invocation so the output gate makes the write durable and a failure reaches the caller.",
    },
  },
  createOnce(context) {
    /** `this` only means an instance inside a class body. Reset per file, because `createOnce`
     *  reuses one visitor set across every file the linter walks. */
    let classDepth = 0;

    /** `this.ctx` / `this.state` — the two spellings of the state handle on an instance. */
    const stateReceiver = (node: ESTree.Node): string | null => {
      if (node.type !== "MemberExpression" || node.computed) return null;
      if (node.object.type !== "ThisExpression") return null;
      if (node.property.type !== "Identifier") return null;
      const { name } = node.property;
      return name === "ctx" || name === "state" ? `this.${name}` : null;
    };

    const enterClass = (): void => { classDepth += 1; };
    const exitClass = (): void => { classDepth -= 1; };

    return {
      Program() { classDepth = 0; },
      ClassDeclaration: enterClass,
      "ClassDeclaration:exit": exitClass,
      ClassExpression: enterClass,
      "ClassExpression:exit": exitClass,
      CallExpression(node) {
        if (classDepth === 0) return;
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed) return;
        if (callee.property.type !== "Identifier" || callee.property.name !== "waitUntil") return;
        const receiver = stateReceiver(callee.object);
        if (receiver === null) return;
        context.report({ node, messageId: "waitUntilInDurableObject", data: { receiver } });
      },
    };
  },
});
