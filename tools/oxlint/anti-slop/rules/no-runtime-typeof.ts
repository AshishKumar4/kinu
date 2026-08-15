import { defineRule } from "@oxlint/plugins";
import type { ESTree, Scope, SourceCode } from "@oxlint/plugins";

function isGlobalObjectConstructor(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
): boolean {
  if (expression.type !== "Identifier" || expression.name !== "Object") return false;
  if (sourceCode.isGlobalReference(expression)) return true;
  let scope: Scope | null = sourceCode.getScope(expression);
  while (scope !== null) {
    const variable = scope.set.get(expression.name);
    if (variable !== undefined) return variable.defs.length === 0;
    scope = scope.upper;
  }
  return true;
}

/** Disallow runtime typeof checks that narrow unparsed values instead of decoding them. */
export const noRuntimeTypeofRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow runtime typeof checks; external values must be decoded into meaningful types at their I/O boundary.",
    },
    messages: {
      runtimeTypeof:
        "A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.",
      objectInstanceof:
        "`instanceof Object` is not a substitute for boundary parsing: it rejects null and primitives but establishes no object contract.",
    },
  },
  createOnce(context) {
    return {
      BinaryExpression(node) {
        if (
          node.operator === "instanceof" &&
          isGlobalObjectConstructor(context.sourceCode, node.right)
        ) {
          context.report({ node, messageId: "objectInstanceof" });
        }
      },
      UnaryExpression(node) {
        if (node.operator === "typeof") {
          context.report({ node, messageId: "runtimeTypeof" });
        }
      },
    };
  },
});
