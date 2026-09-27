import { defineRule } from "@oxlint/plugins";
import { isTestFile } from "../../../../scripts/sources.ts";

/**
 * The source roots whose string and template literals reach a model: prompt assembly, heads,
 * strategies, delegation, compaction, the advisor, tools and skills. Logs and errors written there
 * follow the same rule, because they reach people too and one rule is simpler than a split.
 */
const MODEL_TEXT_ROOTS = [
  "/packages/core/src/prompting/",
  "/packages/core/src/heads/",
  "/packages/core/src/strategy/",
  "/packages/core/src/delegation/",
  "/packages/core/src/advisor/",
  "/packages/core/src/tools/",
  "/packages/core/src/skills/",
  "/packages/core/src/compaction.ts",
  "/packages/compaction/src/",
];

/** A product module under one of {@link MODEL_TEXT_ROOTS}; a test states fixtures, not model text. */
export function inModelTextScope(filename: string): boolean {
  const normalized = filename.replaceAll("\\", "/");

  if (isTestFile(normalized)) return false;

  return MODEL_TEXT_ROOTS.some((root) => normalized.includes(root));
}

const WIDE = /[\u{100}-\u{10ffff}]/u;

/**
 * No character above U+00FF in model-facing literals. One such character anywhere in a request makes
 * V8 store the whole request text two bytes per character: measured 2026-09-26 in workerd, a step
 * parked on the model held 7.3 MB live with one and 4.8 MB without (scripts/worker-heap.ts). Write
 * the sentence without it: a comma, colon or full stop for a dash, a word for an arrow.
 */
export const noWideModelTextRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow characters above U+00FF in string and template literals of model-facing source.",
    },
    messages: {
      wide:
        "`{{character}}` is above U+00FF: any request carrying it is stored two bytes per character. Rewrite the text without it (a colon, comma or full stop for a dash, a word for an arrow, `...` in code).",
    },
  },
  createOnce(context) {
    let inScope = false;

    return {
      Program() {
        inScope = inModelTextScope(context.filename);
      },
      // The source text: an escape (`'\uFEFF'`) says the character is data, not prose.
      Literal(node) {
        if (!inScope || typeof node.value !== "string") return;
        const character = WIDE.exec(node.raw ?? "")?.[0];

        if (character !== undefined) context.report({ node, messageId: "wide", data: { character } });
      },
      TemplateElement(node) {
        if (!inScope) return;
        const character = WIDE.exec(node.value.raw)?.[0];

        if (character !== undefined) context.report({ node, messageId: "wide", data: { character } });
      },
    };
  },
});
