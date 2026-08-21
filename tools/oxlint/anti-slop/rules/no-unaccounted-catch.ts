import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

/**
 * The empty value no-sentinel-catch already owns: a body whose only act is handing back a
 * value a success could return too. Copied verbatim in shape so the two rules stay a
 * partition — this rule must not double-report what its sibling already reports.
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

/** An empty body is no-empty-catch's finding; one sentinel `return` is no-sentinel-catch's. */
function ownedBySiblingRule(body: ESTree.BlockStatement): boolean {
  if (body.body.length === 0) return true;
  if (body.body.length > 1) return false;
  const only = body.body[0];
  if (only?.type !== "ReturnStatement") return false;
  return only.argument === null || isSentinel(only.argument);
}

/**
 * The obs helpers that NAME a tolerated failure (`classify({ cause })`,
 * `tolerate(op, expected)`): a handler that calls one is declaring which failure it accepts,
 * and anything else rethrows — the doctrine's third shape done properly.
 */
const CLASSIFYING_CALLS: Record<string, true> = {
  classify: true,
  tolerate: true,
  tolerateAsync: true,
};

/**
 * The recording sinks a handled catch says so through, as called-name spellings gathered from
 * the repo's own handlers (`diagnostics.failure`, `log.event`, `logger.warn`, `logActivity`).
 * A level is not an outcome, so every severity counts: what matters is that the failure became
 * a row somewhere, not which row.
 */
const RECORDING_CALLS: Record<string, true> = {
  alert: true,
  critical: true,
  debug: true,
  emit: true,
  error: true,
  event: true,
  exception: true,
  failure: true,
  fail: true,
  fatal: true,
  info: true,
  log: true,
  logActivity: true,
  logEvent: true,
  recordEvent: true,
  recordFailure: true,
  trace: true,
  warn: true,
};

/**
 * The names the handler body CALLS, read off the token stream: an identifier immediately
 * followed by `(` is a call's callee name, whether it is invoked bare (`tolerate(...)`) or as
 * a member (`diagnostics.failure(...)`). Token-level rather than a subtree walk so this rule
 * holds no state and stays in the shape no-ddl-in-catch established — a `createOnce` visitor
 * is reused across files, and a walk kept here would make the verdict depend on lint order.
 */
function calledNames(sourceCode: SourceCode, body: ESTree.BlockStatement): Set<string> {
  const tokens = sourceCode.getTokens(body);
  const names = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i];
    const next = tokens[i + 1];
    if (token.type === "Identifier" && next.type === "Punctuator" && next.value === "(") {
      names.add(token.value);
    }
  }
  return names;
}

/**
 * Reject a catch that neither rethrows, nor classifies the failure it tolerates, nor records
 * the one it handles — the gap between the three shapes AGENTS.md §Errors allows and what
 * no-empty-catch / no-sentinel-catch could see: a body with ONE statement that computes a
 * fallback (`rows = []`, `return String(value)`, `continue`) slipped past both, and the ten
 * production sites doing exactly that were invisible to the gate while the doctrine governed
 * them. The gate set has to equal the governed set.
 *
 * Binding the error without using it does not count — `catch (error) { continue; }` binds and
 * drops. An identifier bearing its name anywhere in the body does: the error reached an
 * observer, which is what "say so" means mechanically here.
 */
export const noUnaccountedCatchRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow catch blocks that neither rethrow, nor classify the tolerated failure, nor record the handled one.",
    },
    messages: {
      unaccountedCatch:
        "This catch drops its error: no rethrow, no named tolerance, no record. Delete the try/catch, rethrow with `{ cause: error }`, classify the expected failure (`classify`/`tolerate`) and rethrow the rest, or record it (`log.warn(message, { event: '...', error })`) and handle it.",
    },
  },
  createOnce(context) {
    return {
      CatchClause(node) {
        // An empty body and a lone sentinel return are the siblings' findings, not this rule's.
        if (ownedBySiblingRule(node.body)) return;
        const sourceCode = context.sourceCode;
        const tokens = sourceCode.getTokens(node.body);
        // A handler that rethrows has said what it does not tolerate; only a terminal one is
        // this rule's subject (require-cause-on-rethrow polices the wrap itself).
        if (tokens.some((token) => token.type === "Keyword" && token.value === "throw")) return;
        const names = calledNames(sourceCode, node.body);
        if ([...names].some((name) => CLASSIFYING_CALLS[name])) return;
        if ([...names].some((name) => RECORDING_CALLS[name])) return;
        const param = node.param;
        if (
          param !== null &&
          param.type === "Identifier" &&
          tokens.some((token) => token.type === "Identifier" && token.value === param.name)
        ) {
          return;
        }
        context.report({ node, messageId: "unaccountedCatch" });
      },
    };
  },
});
