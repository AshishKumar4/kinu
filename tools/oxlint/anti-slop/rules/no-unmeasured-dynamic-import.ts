import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import { isWorkerSource } from "../../../../scripts/sources.ts";

/** Whether `filename` is Worker source, by the repository's one classification of it (`scripts/sources.ts`). */
function inWorkerScope(filename: string): boolean {
  const normalized = filename.replaceAll("\\", "/");
  const root = normalized.lastIndexOf("/packages/");

  return root !== -1 && isWorkerSource(normalized.slice(root + 1));
}

/**
 * What a measurement is cited by: an armada run (`20261007182018-643fa40c`), the commit whose body records it (an
 * abbreviated sha, at least nine hex digits with a letter and a digit among them), or the decision-log entry that holds
 * it (`L27`, `D41`).
 */
const CITATION = /\b(?:\d{14}-[0-9a-f]{8}|(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{9,40}|[LD]\d{1,3})\b/u;

/** A citation on the statement that holds the import, or on any declaration around it. */
function cited(sourceCode: SourceCode, node: ESTree.ImportExpression): boolean {
  let current: ESTree.Node = node;

  while (current.type !== "Program") {
    if (sourceCode.getCommentsBefore(current).some((comment) => comment.end <= node.start && CITATION.test(comment.value))) return true;
    current = current.parent;
  }

  return false;
}

/**
 * KINU-LOCAL. Workers compile each uploaded module when it is first imported (`new_module_registry`), so an
 * `import()` there defers a module's compile and evaluation, and that is a memory or startup cut only when it is
 * measured: AGENTS.md, Waste, 2026-10-07. An unmeasured `import()` costs a cycle the bundler cannot see through, a
 * graph `gate:wired` cannot follow, and an await on a path that needed none. Each one in Worker source names its
 * measurement in a comment on its statement or a declaration around it, or the module is imported statically.
 */
export const noUnmeasuredDynamicImportRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Require each dynamic import in Worker source to cite the measurement that makes it a cut.",
    },
    messages: {
      unmeasuredDynamicImport:
        "This `import()` defers a module in Worker source, which is a cut only when measured (AGENTS.md, Waste, 2026-10-07). Cite the measurement in a comment before it, an armada run, the commit that recorded it or its decision-log entry, or import the module statically.",
    },
  },
  createOnce(context) {
    let inScope = false;

    return {
      Program() {
        inScope = inWorkerScope(context.filename);
      },
      ImportExpression(node) {
        if (inScope && !cited(context.sourceCode, node)) context.report({ node, messageId: "unmeasuredDynamicImport" });
      },
    };
  },
});
