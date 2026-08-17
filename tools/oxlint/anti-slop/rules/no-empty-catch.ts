import { defineRule } from "@oxlint/plugins";

/**
 * Reject a catch block with no statements.
 *
 * A comment is not a statement, so `catch { /* non-fatal *\/ }` is reported exactly like
 * `catch {}`: both discard the error, and the comment is the part a model can emit at will.
 * There is deliberately no exemption. Tolerating an expected failure is expressible in code —
 * classify the error and rethrow what you did not expect — so a genuinely empty catch has
 * nothing left to say.
 */
export const noEmptyCatchRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow catch blocks that discard the error, including comment-only bodies.",
    },
    messages: {
      emptyCatch:
        "This catch discards the error. Record it, rethrow it with `{ cause }`, or classify the failure you tolerate and rethrow the rest — a comment is not a record.",
    },
  },
  createOnce(context) {
    return {
      CatchClause(node) {
        if (node.body.body.length > 0) return;
        context.report({ node, messageId: "emptyCatch" });
      },
    };
  },
});
