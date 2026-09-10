import { defineRule } from "@oxlint/plugins";

import { resolveVariable } from "../shared/scope.ts";

import type { ESTree, SourceCode } from "@oxlint/plugins";

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
 * KINU-LOCAL: `instanceof Object` is the same evasion as `typeof`, so it is rejected here too.
 * Upstream has never carried this check, and its `typeof x === "undefined"` existence-probe
 * exemption is not vendored: a binding whose presence is unknown is boundary input, and
 * `globalThis.x === undefined` probes it without a typeof. See tools/oxlint/anti-slop/upstream.json.
 */
function isGlobalObjectConstructor(
	sourceCode: SourceCode,
	expression: ESTree.Expression,
): boolean {
	if (expression.type !== "Identifier" || expression.name !== "Object") return false;
	if (sourceCode.isGlobalReference(expression)) return true;
	const variable = resolveVariable(sourceCode, expression);
	return variable === null || variable.defs.length === 0;
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
