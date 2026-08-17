import { defineRule } from "@oxlint/plugins";

import type { ESTree, Scope, SourceCode } from "@oxlint/plugins";

type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.Function;

function isRuntimeFunction(node: ESTree.Node): node is RuntimeFunction {
	return (
		node.type === "ArrowFunctionExpression" ||
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression"
	);
}

function isInsideTypeGuard(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (isRuntimeFunction(current)) {
			return current.returnType?.typeAnnotation.type === "TSTypePredicate";
		}
		current = current.parent;
	}
	return false;
}

/**
 * PROTEUS-LOCAL: `instanceof Object` is the same evasion as `typeof`, so it is rejected here too.
 * Upstream has never carried this check; see tools/oxlint/anti-slop/upstream.json.
 */
function isGlobalObjectConstructor(
	sourceCode: SourceCode,
	expression: ESTree.Expression,
): boolean {
	if (expression.type !== "Identifier" || expression.name !== "Object") return false;
	if (sourceCode.isGlobalReference(expression)) return true;
	let scope: Scope | null = sourceCode.getScope(expression);
	while (scope !== null) {
		const variable = scope.set.get(expression.name);
		if (variable !== undefined) return variable.defs.length === 0;
		scope = scope.upper;
	}
	return true;
}

/** Disallow runtime typeof checks that narrow unparsed values instead of decoding them. */
export const noRuntimeTypeofRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow runtime typeof checks; external values must be decoded into meaningful types at their I/O boundary.",
		},
		messages: {
			runtimeTypeof:
				"A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.",
			objectInstanceof:
				"`instanceof Object` is not a substitute for boundary parsing: it rejects null and primitives but establishes no object contract.",
		},
		schema: [
			{
				type: "object",
				properties: {
					allowInTypeGuards: { type: "boolean" },
				},
				additionalProperties: false,
			},
		],
		defaultOptions: [{ allowInTypeGuards: false }],
	},
	createOnce(context) {
		return {
			BinaryExpression(node) {
				if (
					node.operator === "instanceof" &&
					isGlobalObjectConstructor(context.sourceCode, node.right)
				) {
					context.report({ node, messageId: "objectInstanceof" });
				}
			},
			UnaryExpression(node) {
				const option = context.options?.[0];
				const allowInTypeGuards =
					typeof option === "object" &&
					option !== null &&
					!Array.isArray(option) &&
					option.allowInTypeGuards === true;
				if (
					node.operator === "typeof" &&
					(!allowInTypeGuards || !isInsideTypeGuard(node))
				) {
					context.report({ node, messageId: "runtimeTypeof" });
				}
			},
		};
	},
});
