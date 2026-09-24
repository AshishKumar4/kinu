import { defineRule } from "@oxlint/plugins";

import { isProductSource } from "../../../../scripts/sources.ts";

/** The AI SDK's per-call output cap. */
const CAP = "maxOutputTokens";

/** Product source by the enumeration's own predicate, asked of the path from its `packages/` root. A
 *  test may name the cap: to assert it is absent from a request, or to bound a live contract call. */
export function inCapScope(filename: string): boolean {
  const normalized = filename.replaceAll("\\", "/");
  const root = normalized.lastIndexOf("/packages/");

  return root !== -1 && isProductSource(normalized.slice(root + 1));
}

/**
 * Ban naming an output-token cap in product source. Owner directive: reasoning models spend their
 * budget thinking, so a cap truncates answers; cost is set by reasoning effort. An adapter that must
 * send `max_tokens` sends the model's own maximum and never names this option.
 */
export const noOutputTokenCapRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow `maxOutputTokens` in product source; bound a call's cost with reasoning effort.",
    },
    messages: {
      outputCap:
        "Remove `maxOutputTokens`. Output is never capped; set the call's cost with its reasoning effort.",
    },
  },
  createOnce(context) {
    let inScope = false;

    return {
      Program() {
        inScope = inCapScope(context.filename);
      },
      Identifier(node) {
        if (inScope && node.name === CAP) context.report({ node, messageId: "outputCap" });
      },
      Literal(node) {
        if (inScope && node.value === CAP) context.report({ node, messageId: "outputCap" });
      },
    };
  },
});
