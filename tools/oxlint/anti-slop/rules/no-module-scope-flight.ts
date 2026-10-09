import { defineRule } from "@oxlint/plugins";
import { isAbsolute, relative } from "node:path";

import type { ESTree } from "@oxlint/plugins";

import { isShippedSource } from "../../../../scripts/sources.ts";

/**
 * A flight held at module scope in shipped source: one module-level read in flight, joined by every request that
 * finds it.
 *
 * In a stateless Worker the module is shared by every request its isolate serves, and a request that awaits I/O
 * another request started waits on that request's life: workerd drops a cancelled request's subrequests, so the
 * joined promise never settles. Measured in workerd 2026-09-30 (packages/cf-backend/tests/unit-models-dev-workerd
 * .test.ts, 2026-10-09): one cancelled request left the models.dev catalog read it owned unsettled, every request on
 * the isolate that joined it hung, and a request that came after joined the same dead read and never reached
 * models.dev at all. On staging d930f2537 that held creates and model menus up to 270 s. A flight inside a Durable
 * Object instance or a function's own scope is that instance's or that call's, and is fine.
 *
 * Reported: a `flight(…)` call with no enclosing function, or in a static class field; a module-scope binding whose
 * type, or whose `new` type arguments, name `Flight`.
 *
 * KNOWN MISSED: a flight reached through another name (`const f = flight`), a module-scope holder of a bare `Promise`
 * (a cache of a promise is the same hazard, and is not this rule's), and a flight a module-scope factory returns.
 */

/** Shipped source by the enumeration's own predicate, asked of the repo-relative path: `filename` is absolute against
 *  `cwd` under the binary and relative under `RuleTester`. */
function inScope(filename: string, cwd: string): boolean {
	return isShippedSource((isAbsolute(filename) ? relative(cwd, filename) : filename).replaceAll("\\", "/"));
}

/** Whether `node` is at module scope: no function encloses it, and a class field that does is static. */
function atModuleScope(node: ESTree.Node): boolean {
	for (let at: ESTree.Node | null = node.parent; at !== null; at = at.parent) {
		if (at.type === "FunctionDeclaration" || at.type === "FunctionExpression" || at.type === "ArrowFunctionExpression") return false;

		if (at.type === "PropertyDefinition") return at.static;
	}

	return true;
}

/** Whether a type node names `Flight` anywhere within it. */
function namesFlight(node: ESTree.Node | null | undefined): boolean {
	if (node === null || node === undefined) return false;

	if (node.type === "TSTypeReference" && node.typeName.type === "Identifier" && node.typeName.name === "Flight") return true;

	for (const value of Object.values(node)) {
		if (Array.isArray(value)) {
			if (value.some((each: unknown) => isNode(each) && namesFlight(each))) return true;
		} else if (isNode(value) && value !== node.parent && namesFlight(value)) {
			return true;
		}
	}

	return false;
}

function isNode(value: unknown): value is ESTree.Node {
	return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

export const noModuleScopeFlightRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Disallow a flight at module scope in shipped source: in a Worker it joins one request to I/O another request owns.",
		},
		messages: {
			moduleFlight:
				"A flight at module scope joins every request on the isolate to a read another request started. In a Worker, a cancelled request's subrequests are dropped and the joined promise never settles: one cancelled request poisons the isolate (workerd 2026-09-30; staging d930f2537 held creates up to 270 s). Share only settled data at module scope, and let each request read for itself (through the edge cache, `cf: { cacheTtl }`), or hold the flight in a Durable Object instance or a call's own scope.",
		},
	},
	createOnce(context) {
		let governed = false;

		return {
			Program() {
				governed = inScope(context.filename, context.cwd);
			},
			CallExpression(node) {
				if (!governed || node.callee.type !== "Identifier" || node.callee.name !== "flight") return;

				if (atModuleScope(node)) context.report({ node, messageId: "moduleFlight" });
			},
			VariableDeclarator(node) {
				if (!governed || !atModuleScope(node)) return;
				const typed = node.id.type === "Identifier" ? node.id.typeAnnotation?.typeAnnotation : undefined;
				const made = node.init?.type === "NewExpression" ? node.init.typeArguments : undefined;

				if (namesFlight(typed) || namesFlight(made)) context.report({ node, messageId: "moduleFlight" });
			},
		};
	},
});
