import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

import { lexicalTypeParameterNames } from "../shared/lexical-type-parameters.ts";

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

const commentOwnerKinds = new Set([
  "ExpressionStatement",
  "PropertyDefinition",
  "ReturnStatement",
  "ThrowStatement",
  "VariableDeclaration",
]);

function isConstAssertion(node: TypeAssertion): boolean {
  return (
    node.typeAnnotation.type === "TSTypeReference" &&
    node.typeAnnotation.typeName.type === "Identifier" &&
    node.typeAnnotation.typeName.name === "const"
  );
}

function safetyComment(sourceCode: SourceCode, node: TypeAssertion): string | null {
  let current: ESTree.Node = node;
  while (true) {
    const comment = sourceCode
      .getCommentsBefore(current)
      .find((candidate) => candidate.end <= node.start && /\bSAFETY\s*:/u.test(candidate.value));
    if (comment !== undefined) {
      return comment.value;
    }
    if (commentOwnerKinds.has(current.type) || current.parent.type === "Program") return null;
    current = current.parent;
  }
}

function statesConcreteEvidence(comment: string): boolean {
  const reason = comment.match(/\bSAFETY\s*:\s*(?<reason>[\s\S]*)/u)?.groups?.reason ?? "";
  const words = reason.match(/[A-Za-z][A-Za-z0-9_-]*/gu) ?? [];
  return (
    words.length >= 3 &&
    /\b(?:api|builds?|carries|checked|compiler|construct(?:ed|s)?|contract|created|declares?|documents?|established|generated|guarantees?|invariant|library|owns?|parsed|preserves?|provides?|returns?|runtime|schema|sdk|validated|verified)\b/iu.test(
      reason,
    )
  );
}

function assertsCallerSelectedType(sourceCode: SourceCode, node: TypeAssertion): boolean {
  const typeParameters = lexicalTypeParameterNames(node, sourceCode.visitorKeys);
  if (typeParameters.size === 0) return false;
  const identifiers = sourceCode.getText(node.typeAnnotation).match(/[A-Za-z_$][\w$]*/gu) ?? [];
  return identifiers.some((identifier) => typeParameters.has(identifier));
}

function unwrapParentheses(expression: ESTree.Expression): ESTree.Expression {
  let current = expression;
  while (current.type === "ParenthesizedExpression") current = current.expression;
  return current;
}

function assertsUnparsedJson(node: TypeAssertion): boolean {
  const expression = unwrapParentheses(node.expression);
  if (expression.type !== "CallExpression") return false;
  const { callee } = expression;
  if (
    callee.type !== "MemberExpression" ||
    callee.object.type !== "Identifier" ||
    callee.object.name !== "JSON"
  ) {
    return false;
  }
  return callee.computed
    ? callee.property.type === "Literal" && callee.property.value === "parse"
    : callee.property.type === "Identifier" && callee.property.name === "parse";
}

function isUnverifiableAssertion(sourceCode: SourceCode, node: TypeAssertion): boolean {
  return (
    node.typeAnnotation.type === "TSAnyKeyword" ||
    assertsCallerSelectedType(sourceCode, node) ||
    assertsUnparsedJson(node)
  );
}

/**
 * PROTEUS-LOCAL: upstream accepts the mere presence of a `SAFETY:` comment. A comment cannot
 * establish a caller-selected generic, recover evidence from `any`, or validate raw JSON, so those
 * are rejected outright, and a `SAFETY:` note must name concrete evidence rather than assert
 * safety. See tools/oxlint/anti-slop/upstream.json.
 */
/** Require every non-const type assertion to state the invariant TypeScript cannot express. */
export const requireSafetyCommentForTypeAssertionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a nearby SAFETY comment for every TypeScript type assertion except const assertions.",
    },
    messages: {
      missingSafetyComment:
        "This type assertion has no `SAFETY:` justification. State the checked invariant immediately before the assertion or its containing statement.",
      unverifiableAssertion:
        "A comment cannot establish a caller-selected type, recover evidence from `any`, or validate raw JSON. Parse or construct a concrete owner type instead.",
      insufficientSafetyComment:
        "The `SAFETY:` comment states no concrete checked, constructed, or owner-guaranteed invariant. Remove the assertion or name the evidence that makes it sound.",
    },
  },
  createOnce(context) {
    const checkAssertion = (node: TypeAssertion) => {
      if (isConstAssertion(node)) return;
      if (isUnverifiableAssertion(context.sourceCode, node)) {
        context.report({ node, messageId: "unverifiableAssertion" });
        return;
      }
      const comment = safetyComment(context.sourceCode, node);
      if (comment !== null && statesConcreteEvidence(comment)) return;
      if (comment !== null) {
        context.report({ node, messageId: "insufficientSafetyComment" });
        return;
      }
      context.report({ node, messageId: "missingSafetyComment" });
    };

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
});
