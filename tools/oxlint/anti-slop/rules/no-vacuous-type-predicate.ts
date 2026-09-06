import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/** A literal true guard narrows its caller without checking its input. */
export const noVacuousTypePredicateRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Reject type predicates whose entire implementation returns literal true." },
    messages: {
      vacuous: "This type predicate accepts every input without checking it. Validate the input before narrowing the caller's type.",
    },
  },
  createOnce(context) {
    const check = (node: ESTree.ArrowFunctionExpression | ESTree.Function) => {
      if (node.returnType?.typeAnnotation.type !== "TSTypePredicate") return;
      const body = node.body;
      if (body === null) return;
      let value: ESTree.Node | null = body;
      if (body.type === "BlockStatement") {
        const [statement, next] = body.body;
        if (next !== undefined || statement?.type !== "ReturnStatement") return;
        value = statement.argument;
      }
      while (value?.type === "ParenthesizedExpression") value = value.expression;
      if (value?.type === "Literal" && value.value === true) {
        context.report({ node, messageId: "vacuous" });
      }
    };
    return {
      ArrowFunctionExpression: check,
      FunctionDeclaration: check,
      FunctionExpression: check,
    };
  },
});
