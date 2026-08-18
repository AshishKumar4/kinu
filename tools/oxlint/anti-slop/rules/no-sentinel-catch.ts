import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/**
 * A value a failing operation can return that a *succeeding* one can return too, so the caller
 * cannot tell the two apart. `workspace_capability` was invisible for months because a read
 * returned `null` for both "table absent" and "holds no token".
 */
function isSentinel(node: ESTree.Expression): boolean {
  switch (node.type) {
    case "ParenthesizedExpression":
      return isSentinel(node.expression);
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
      return isSentinel(node.expression);
    case "Identifier":
      return node.name === "undefined";
    case "UnaryExpression":
      return node.operator === "void";
    case "ArrayExpression":
      return node.elements.length === 0;
    case "ObjectExpression":
      return node.properties.length === 0;
    case "TemplateLiteral":
      return node.expressions.length === 0 && node.quasis.every((q) => q.value.raw === "");
    case "Literal":
      return node.value === null || node.value === false || node.value === 0 || node.value === "";
    default:
      return false;
  }
}

/**
 * Whether a handler body does nothing but produce a sentinel. One statement is the whole test:
 * a body that logs, records, classifies or rethrows has a second statement and is not blind.
 */
function isBlindSentinelBody(body: ESTree.BlockStatement): boolean {
  if (body.body.length === 0) return true;
  if (body.body.length > 1) return false;
  const only = body.body[0];
  if (only?.type !== "ReturnStatement") return false;
  return only.argument === null || isSentinel(only.argument);
}

function rejectionHandlerIsBlind(argument: ESTree.Node): boolean {
  if (argument.type === "ArrowFunctionExpression") {
    return argument.body.type === "BlockStatement"
      ? isBlindSentinelBody(argument.body)
      : isSentinel(argument.body);
  }
  // `body` is null for an overload signature, which cannot be a rejection handler.
  if (argument.type === "FunctionExpression") {
    return argument.body !== null && isBlindSentinelBody(argument.body);
  }
  return false;
}

/**
 * Reject a failure path whose only effect is to hand back an indistinguishable empty value.
 *
 * Covers all three spellings, because they are the same defect and leaving one uncovered makes it
 * the cheap way around the others: `catch { return null }`, `promise.catch(() => null)`, and
 * `promise.then(ok, () => null)` — the last is the easiest to miss in review precisely because the
 * rejection handler is the second argument to a call that reads as a success path.
 *
 * The escape is not an exemption — it is saying which failure you tolerate:
 *
 *   catch (error) {
 *     if (!isMissingTable(error)) throw error;
 *     return null;
 *   }
 *
 * That body has two statements, so this rule is silent, and an unexpected error now propagates.
 */
export const noSentinelCatchRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow failure handlers whose only effect is returning null, undefined, [], {}, false, 0 or an empty string.",
    },
    messages: {
      sentinelCatch:
        "This catch turns every failure into a value a successful call could also return, so the caller cannot tell absence from breakage. Classify the failure you tolerate and rethrow the rest, or record the error before returning.",
      sentinelRejectionHandler:
        "This rejection handler turns every failure into a value a successful call could also return. Classify the rejection you tolerate and rethrow the rest, or record it before returning.",
    },
  },
  createOnce(context) {
    return {
      CatchClause(node) {
        // Length 1 exactly: an empty body is no-empty-catch's finding, and two rules reporting
        // the same node twice trains people to read neither.
        if (node.body.body.length !== 1) return;
        if (!isBlindSentinelBody(node.body)) return;
        context.report({ node, messageId: "sentinelCatch" });
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        const method = callee.computed
          ? callee.property.type === "Literal"
            ? callee.property.value
            : null
          : callee.property.type === "Identifier"
            ? callee.property.name
            : null;
        // `catch` takes the handler first; `then` takes it second, after the fulfilment handler.
        const handler =
          method === "catch" && node.arguments.length === 1
            ? node.arguments[0]
            : method === "then" && node.arguments.length === 2
              ? node.arguments[1]
              : undefined;
        if (handler === undefined || !rejectionHandlerIsBlind(handler)) return;
        context.report({ node, messageId: "sentinelRejectionHandler" });
      },
    };
  },
});
