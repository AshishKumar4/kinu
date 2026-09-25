import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/** The model SDK: its invoking exports are banned from product code by name, so a runtime load of the module is the way round that ban. */
const MODEL_SDK = "ai";

function literalSpecifier(node: ESTree.Node | null | undefined): string | null {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;

  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? null;

  return null;
}

/**
 * A model call reaches the workspace spend total only through
 * `packages/core/src/providers/model-invocation.ts`; `.oxlintrc.json` refuses a static import of the
 * SDK's invoking exports elsewhere. `await import("ai")` and `require("ai")` load the same exports
 * past that check, so they are refused here.
 */
export const noDynamicModelImportRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow loading the model SDK at runtime, which bypasses the invoking-export ban.",
    },
    messages: {
      dynamicModelImport: "`{{how}}(\"ai\")` loads the model SDK past the invoking-export ban; call a model through packages/core/src/providers/model-invocation.ts.",
    },
  },
  createOnce(context) {
    return {
      ImportExpression(node) {
        if (literalSpecifier(node.source) === MODEL_SDK) context.report({ node, messageId: "dynamicModelImport", data: { how: "import" } });
      },
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "require") return;

        if (literalSpecifier(node.arguments[0]) === MODEL_SDK) context.report({ node, messageId: "dynamicModelImport", data: { how: "require" } });
      },
    };
  },
});
