import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

const schemaStatement = /\b(?:create|alter|drop)\s+(?:table|index|view|trigger)\b/iu;

/**
 * Whether a subtree contains a schema statement, read from its string and template tokens.
 *
 * Token-level rather than text-level so a comment that merely mentions `ALTER TABLE` is not a
 * finding, and rather than a subtree walk so this rule holds no state: a `createOnce` visitor is
 * reused across files, and a dedupe set kept here would make the verdict depend on lint order.
 */
function containsSchemaStatement(sourceCode: SourceCode, node: ESTree.Node): boolean {
  return sourceCode
    .getTokens(node)
    .some(
      (token) =>
        (token.type === "String" || token.type === "Template") && schemaStatement.test(token.value),
    );
}

/**
 * Reject deciding a schema question by catching the failure of a schema statement.
 *
 * `try { execRaw('ALTER TABLE t ADD COLUMN c') } catch { /* exists *\/ }` cannot tell "the column is
 * already there" from "the table is locked", "the database is read-only" or "the table was never
 * created" — so the migration reports success in every one of those cases and the next read fails
 * somewhere unrelated. This is how `workspace_capability` came to exist in production only as a
 * side effect of a call that failed on its way down.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so the escape is to ask instead of to guess, and to say
 * so in code: read `PRAGMA table_info(t)` and add the column when it is absent. `CREATE TABLE IF NOT
 * EXISTS` needs no guard at all. Where the exception genuinely is the only signal, the catch must
 * classify it and rethrow what it did not expect — which is why a handler containing a `throw` is
 * accepted here and a silent one is not.
 */
export const noDdlInCatchRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow schema statements whose outcome is decided by a catch clause that cannot classify the failure.",
    },
    messages: {
      schemaByException:
        "This catch decides a schema question by swallowing the failure, so a locked table, a read-only database and an absent table all read as success. Ask instead: check `PRAGMA table_info(...)` before `ADD COLUMN`, use `CREATE TABLE IF NOT EXISTS`, or classify the error here and rethrow what you did not expect.",
    },
  },
  createOnce(context) {
    return {
      TryStatement(node) {
        const handler = node.handler;
        if (handler === null) return;
        const sourceCode = context.sourceCode;
        // A handler that rethrows has classified the failure; only a terminal one is the defect.
        if (sourceCode.getTokens(handler).some((t) => t.type === "Keyword" && t.value === "throw")) {
          return;
        }
        if (
          !containsSchemaStatement(sourceCode, node.block) &&
          !containsSchemaStatement(sourceCode, handler)
        ) {
          return;
        }
        context.report({ node: handler, messageId: "schemaByException" });
      },
    };
  },
});
