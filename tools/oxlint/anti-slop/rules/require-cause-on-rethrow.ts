import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/**
 * The catch clause a node sits inside, or null. Walked from the node rather than tracked in
 * rule state: a `createOnce` visitor is reused across files, so any stack it kept would make
 * this rule's verdict depend on which sibling file was linted first.
 */
function enclosingCatch(node: ESTree.Node): ESTree.CatchClause | null {
  let current: ESTree.Node | null = node.parent;
  while (current !== null) {
    if (current.type === "CatchClause") return current;
    current = current.parent;
  }
  return null;
}

function isErrorConstruction(callee: ESTree.Node): boolean {
  const name =
    callee.type === "Identifier"
      ? callee.name
      : callee.type === "MemberExpression" && callee.property.type === "Identifier"
        ? callee.property.name
        : null;
  return name !== null && name.endsWith("Error");
}

/**
 * Whether an argument list attaches a real cause. `{ cause }` and `{ cause: error }` both count;
 * `{ cause: undefined }` does not, because a present-but-empty cause reads as a chain in review
 * and carries nothing at runtime.
 */
function attachesCause(args: readonly ESTree.Node[]): boolean {
  return args.some((argument) => {
    if (argument.type !== "ObjectExpression") return false;
    return argument.properties.some((property) => {
      if (property.type === "SpreadElement") return true;
      const key = property.key;
      const named = property.computed
        ? key.type === "Literal" && key.value === "cause"
        : (key.type === "Identifier" && key.name === "cause") ||
          (key.type === "Literal" && key.value === "cause");
      if (!named) return false;
      const value = property.value;
      if (value.type === "Identifier" && value.name === "undefined") return false;
      return !(value.type === "Literal" && value.value === null);
    });
  });
}

/**
 * Require a rethrown error to carry the one it replaces.
 *
 * `throw new Error(msg)` inside a catch is Go's `return errors.New(...)` where `%w` was meant:
 * the message survives and the chain — the stack, the SQLite code, the HTTP status underneath —
 * is destroyed, so the caller can classify nothing. `new Error(msg, { cause })` is the language's
 * own `%w`, which is why this rule wants that rather than a bespoke wrapper type.
 *
 * A bare `throw error` is untouched: it preserves the chain by definition.
 *
 * A catch with no binding cannot attach a cause at all, so it is reported with a distinct message
 * — the fix is to bind the error, not to invent a cause.
 */
export const requireCauseOnRethrowRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require errors thrown from a catch to chain the caught error through `{ cause }`.",
    },
    messages: {
      missingCause:
        "This throw replaces the caught error instead of wrapping it, destroying the cause chain. Pass it through: `new Error(message, { cause: error })`.",
      unbindableCause:
        "This catch discards its binding, so the error thrown from it cannot chain the one that caused it. Bind the error (`catch (error)`) and pass it as `{ cause: error }`.",
    },
  },
  createOnce(context) {
    return {
      ThrowStatement(node) {
        const thrown = node.argument;
        if (thrown.type !== "NewExpression") return;
        if (!isErrorConstruction(thrown.callee)) return;
        if (attachesCause(thrown.arguments)) return;
        const catchClause = enclosingCatch(node);
        if (catchClause === null) return;
        context.report({
          node,
          messageId: catchClause.param === null ? "unbindableCause" : "missingCause",
        });
      },
    };
  },
});
