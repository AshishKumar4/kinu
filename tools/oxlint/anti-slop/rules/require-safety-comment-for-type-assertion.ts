import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

import { lexicalTypeParameterNames } from "../shared/lexical-type-parameters.ts";

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

const DEFAULT_SAFETY_MARKERS = ["SAFETY"] as const;

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

function configuredSafetyMarkers(option: unknown): readonly string[] {
  if (typeof option !== "object" || option === null || !("markers" in option)) {
    return DEFAULT_SAFETY_MARKERS;
  }
  const configured = option.markers;
  if (!Array.isArray(configured)) return DEFAULT_SAFETY_MARKERS;
  const markers = configured.flatMap((marker) =>
    typeof marker === "string" && marker.trim().length > 0 ? [marker.trim()] : [],
  );
  return markers.length > 0 ? markers : DEFAULT_SAFETY_MARKERS;
}

function markerPattern(markers: readonly string[]): RegExp {
  const alternation = markers
    .map((marker) => marker.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`))
    .join("|");
  return new RegExp(
    String.raw`(?:^|[^\p{L}\p{N}_])(?:${alternation})\s*:\s*(?<reason>\S[\s\S]*)`,
    "u",
  );
}

function safetyJustificationBefore(
  sourceCode: SourceCode,
  owner: ESTree.Node,
  assertion: TypeAssertion,
  pattern: RegExp,
): string | null {
  for (const comment of sourceCode.getCommentsBefore(owner)) {
    if (comment.end > assertion.start) continue;
    const reason = comment.value.match(pattern)?.groups?.reason;
    if (reason !== undefined) return reason;
  }
  return null;
}

function safetyComment(
  sourceCode: SourceCode,
  node: TypeAssertion,
  pattern: RegExp,
): string | null {
  let current: ESTree.Node = node;
  while (true) {
    const reason = safetyJustificationBefore(sourceCode, current, node, pattern);
    if (reason !== null) return reason;
    if (commentOwnerKinds.has(current.type)) {
      const exportDeclaration = current.parent;
      return exportDeclaration.type === "ExportNamedDeclaration" &&
        exportDeclaration.declaration === current
        ? safetyJustificationBefore(sourceCode, exportDeclaration, node, pattern)
        : null;
    }
    if (current.parent.type === "Program") return null;
    current = current.parent;
  }
}

function statesConcreteEvidence(reason: string): boolean {
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
 * KINU-LOCAL: upstream accepts any non-empty justification after the marker. A comment cannot
 * establish a caller-selected generic, recover evidence from `any`, or validate raw JSON, so those
 * are rejected outright, and a `SAFETY:` note must name concrete evidence rather than assert
 * safety. Upstream's `markers` option and export-declaration comment attachment are vendored
 * as-is. See tools/oxlint/anti-slop/upstream.json.
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
        "This type assertion has no `{{marker}}:` justification. State the checked invariant immediately before the assertion or its containing statement.",
      unverifiableAssertion:
        "A comment cannot establish a caller-selected type, recover evidence from `any`, or validate raw JSON. Parse or construct a concrete owner type instead.",
      insufficientSafetyComment:
        "The `{{marker}}:` comment states no concrete checked, constructed, or owner-guaranteed invariant. Remove the assertion or name the evidence that makes it sound.",
    },
    schema: [
      {
        type: "object",
        properties: {
          markers: {
            type: "array",
            items: { type: "string", minLength: 1 },
            minItems: 1,
            uniqueItems: true,
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ markers: ["SAFETY"] }],
  },
  createOnce(context) {
    const patterns = new Map<string, RegExp>();

    const checkAssertion = (node: TypeAssertion) => {
      if (isConstAssertion(node)) return;
      if (isUnverifiableAssertion(context.sourceCode, node)) {
        context.report({ node, messageId: "unverifiableAssertion" });
        return;
      }
      const markers = configuredSafetyMarkers(context.options?.[0]);
      const patternKey = markers.join("\u0000");
      const pattern = patterns.get(patternKey) ?? markerPattern(markers);
      patterns.set(patternKey, pattern);
      const data = { marker: markers[0] ?? DEFAULT_SAFETY_MARKERS[0] };
      const reason = safetyComment(context.sourceCode, node, pattern);
      if (reason !== null && statesConcreteEvidence(reason)) return;
      context.report({
        node,
        messageId: reason === null ? "missingSafetyComment" : "insufficientSafetyComment",
        data,
      });
    };

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
});
